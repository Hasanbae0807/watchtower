import {
  ModelContext,
  SemanticEvent,
  createAgent,
  createHuman,
  defineRuntime,
} from '@mozaik-ai/core';
import type { Agent, Human, SituationHandler } from '@mozaik-ai/core';
import { EV, OnAnyEvent, OnEvent, publish as busPublish } from './bus.js';
import { EvidenceGate } from './gate.js';
import { DeterministicRunner } from './runner.js';
import { WatchtowerState, type Order } from './state.js';
import { auditorTools, flagTool, lookupTools, recordLedgerTool, refundTools, voidTool } from './tools.js';

export type Mode = 'deterministic' | 'llm';
export type Publish = (producerId: string, type: string, payload: Record<string, unknown>) => void;

export interface TapEvent {
  type: string;
  producer: string;
  payload: any;
  at: string;
}

export interface Room {
  state: WatchtowerState;
  runtime: { publish: (event: SemanticEvent) => void };
  publish: Publish;
  gate: EvidenceGate;
  mode: Mode;
  model: string;
  feedId: string;
  operatorId: string;
  agentNames: string[];
  streamOrders: (orders: Order[], intervalMs: number, onDone?: () => void) => void;
  injectRefundRequest: (requestId: string) => void;
  decide: (orderId: string, approved: boolean) => void;
}

const CONTRACT_NOTE =
  'Every number you state must cite its source (order id, ledger line id, or request id). ' +
  'All data is SYNTHETIC. This system is an operations demo, not financial advice.';

export function buildRoom(mode: Mode, opts: { onTap?: (e: TapEvent) => void; onAudit?: (line: string) => void } = {}): Room {
  const state = new WatchtowerState();
  const { initializeRuntime, join, runLoop } = defineRuntime<WatchtowerState>();

  const runtime = initializeRuntime(
    mode === 'deterministic'
      ? { state, inferenceRunnerConfig: { runner: new DeterministicRunner(state) } }
      : { state },
  );
  const model = mode === 'deterministic' ? 'deterministic' : (process.env.MOZAIK_MODEL ?? 'deepseek-v4-flash');

  const publish: Publish = (producerId, type, payload) => {
    runtime.publish(SemanticEvent.create(type, producerId, payload));
  };
  const gate = new EvidenceGate(state, publish);
  const deps = { state, publish };

  const wake = (agent: Agent, task: string) => {
    runLoop(
      agent.getId(),
      task,
      { model, context: ModelContext.create(), tools: agent.getTools(), streaming: false },
      gate,
    );
  };
  const task = (kind: string, payload: Record<string, unknown>) => `TASK ${kind} ${JSON.stringify(payload)}`;

  // ---------------- OrderFeed (data feed participant) ----------------
  const feed = createAgent({
    name: 'OrderFeed',
    capabilities: ['feed', 'order-intake'],
    instruction: 'Streams synthetic Black Friday orders into the room. Owns intake into the shared order book.',
    tools: [],
    handlers: [],
  });

  // ---------------- Watchtower (fraud flagger) ----------------
  const watchtower = createAgent({
    name: 'Watchtower',
    capabilities: ['inference', 'fraud-detection'],
    instruction:
      `You are the Watchtower, the fraud flagger for a synthetic Black Friday store. For each order you are woken with, ` +
      `call get_order, evaluate it, and call flag_order if any fraud rule hits; otherwise answer with a CLEAR: line. ` +
      `Your final message for a flagged order must start with "FLAG:" and cite rule ids and the exact source fields. ${CONTRACT_NOTE}`,
    tools: [...lookupTools(deps), flagTool(deps, () => watchtower.getId())],
    handlers: [
      {
        specification: new OnEvent(EV.ORDER_RECEIVED, { fromOthersOnly: true }),
        processor: {
          apply({ event }: any) {
            wake(watchtower, task('score-order', { orderId: event.payload.order.id }));
          },
        },
      },
    ] as SituationHandler[],
  });

  // ---------------- LedgerKeeper ----------------
  const ledgerKeeper = createAgent({
    name: 'LedgerKeeper',
    capabilities: ['inference', 'ledger'],
    instruction:
      `You keep the shared ledger. For each order you are woken with, call record_ledger_entry. For a high-severity ` +
      `flagged order you may be woken to void it: call void_order — the EvidenceGate will block you until the evidence ` +
      `is sufficient; that block is the system working as designed. ${CONTRACT_NOTE}`,
    tools: [...lookupTools(deps), recordLedgerTool(deps, () => ledgerKeeper.getId()), voidTool(deps, () => ledgerKeeper.getId())],
    handlers: [
      {
        specification: new OnEvent(EV.ORDER_RECEIVED, { fromOthersOnly: true }),
        processor: {
          apply({ event }: any) {
            wake(ledgerKeeper, task('record-ledger', { orderId: event.payload.order.id }));
          },
        },
      },
      {
        specification: new OnEvent(EV.ORDER_FLAGGED, { fromOthersOnly: true }),
        processor: {
          apply({ event }: any) {
            if (event.payload.severity === 'high') {
              wake(ledgerKeeper, task('void-order', { orderId: event.payload.orderId }));
            }
          },
        },
      },
      {
        specification: new OnEvent(EV.AUDIT_PASSED, { fromOthersOnly: true }),
        processor: {
          apply({ event }: any) {
            const order = state.orderBook.get(event.payload.orderId);
            const flag = state.flags.get(event.payload.orderId);
            if (order && flag?.severity === 'high' && order.status === 'flagged') {
              wake(ledgerKeeper, task('void-order', { orderId: order.id }));
            }
          },
        },
      },
    ] as SituationHandler[],
  });
  // ---------------- RefundClerk ----------------
  const refundClerk = createAgent({
    name: 'RefundClerk',
    capabilities: ['inference', 'refunds', 'customer-replies'],
    instruction:
      `You handle refund and chargeback requests. For each request you are woken with, call draft_reply, then ` +
      `issue_refund. issue_refund is intercepted by the EvidenceGate: with fewer than 2 independent confirmed evidence ` +
      `sources you will be BLOCKED, and above $500 you will be ESCALATED for human approval. Do not argue with the gate; ` +
      `the room retries you when the Auditor confirms evidence or the operator decides. Your proposal message must start ` +
      `with "REFUND:" and cite the request id and order id. ${CONTRACT_NOTE}`,
    tools: [...lookupTools(deps), ...refundTools(deps, () => refundClerk.getId())],
    handlers: [
      {
        // includeSelf: the clerk re-publishes refund.requested for its own
        // retries (after an audit pass or a human decision) — those must
        // wake the clerk too. The loop itself never publishes this event,
        // so there is no self-trigger cycle.
        specification: new OnEvent(EV.REFUND_REQUESTED, { includeSelf: true }),
        processor: {
          apply({ event }: any) {
            const req = state.refundRequests.get(event.payload.requestId);
            if (!req) return;
            const prop = state.proposals.get(req.orderId);
            if (prop) {
              prop.attempts += 1;
              prop.status = 'proposed';
            }
            wake(refundClerk, task('propose-refund', { requestId: req.id, orderId: req.orderId, amount: req.amount }));
          },
        },
      },
      {
        specification: new OnEvent(EV.GUARD_BLOCKED),
        processor: {
          apply({ event }: any) {
            const prop = state.proposals.get(event.payload.orderId);
            if (prop && prop.status !== 'executed') prop.status = 'blocked';
          },
        },
      },
      {
        specification: new OnEvent(EV.GUARD_ESCALATED),
        processor: {
          apply({ event }: any) {
            const prop = state.proposals.get(event.payload.orderId);
            if (prop && prop.status !== 'executed') prop.status = 'escalated';
          },
        },
      },
      {
        specification: new OnEvent(EV.AUDIT_PASSED, { fromOthersOnly: true }),
        processor: {
          apply({ event }: any) {
            const prop = state.proposals.get(event.payload.orderId);
            if (prop && prop.status === 'blocked') {
              const req = state.refundRequests.get(prop.requestId);
              if (req) {
                publish(refundClerk.getId(), EV.REFUND_REQUESTED, {
                  requestId: req.id,
                  orderId: req.orderId,
                  text: `REFUND: retry for ${req.orderId} after Auditor confirmed evidence (request ${req.id})`,
                });
              }
            }
          },
        },
      },
      {
        specification: new OnEvent(EV.HUMAN_DECISION, { fromOthersOnly: true }),
        processor: {
          apply({ event }: any) {
            const prop = state.proposals.get(event.payload.orderId);
            if (prop && event.payload.approved && (prop.status === 'escalated' || prop.status === 'blocked')) {
              const req = state.refundRequests.get(prop.requestId);
              if (req) {
                publish(refundClerk.getId(), EV.REFUND_REQUESTED, {
                  requestId: req.id,
                  orderId: req.orderId,
                  text: `REFUND: retry for ${req.orderId} after human-operator decision (request ${req.id})`,
                });
              }
            }
            if (prop && !event.payload.approved) prop.status = 'rejected';
          },
        },
      },
    ] as SituationHandler[],
  });
  // ---------------- Auditor (independent checker) ----------------
  const auditor = createAgent({
    name: 'Auditor',
    capabilities: ['inference', 'verification'],
    instruction:
      `You are the independent Auditor. You read the bus and the sources — never the flagger's private reasoning. ` +
      `For each FLAG you are woken with, call get_order and get_ledger_line, recompute the rules from the source fields, ` +
      `then either call confirm_evidence (the flag checks out) or raise_hold (evidence missing or too weak), saying exactly ` +
      `what is missing. Your messages use the EVIDENCE: and HOLD: tokens. ${CONTRACT_NOTE}`,
    tools: [...lookupTools(deps), ...auditorTools(deps, () => auditor.getId())],
    handlers: [
      {
        specification: new OnEvent(EV.ORDER_FLAGGED, { fromOthersOnly: true }),
        processor: {
          apply({ event }: any) {
            wake(auditor, task('audit-flag', { orderId: event.payload.orderId }));
          },
        },
      },
    ] as SituationHandler[],
  });
  // ---------------- Scribe (pure observer) ----------------
  const LOGGABLE = new Set<string>([
    ...Object.values(EV),
    'participant.joined',
    'participant.left',
    'model.answer',
  ]);
  const TOKEN_START = /^(FLAG:|HOLD:|REFUND:|EVIDENCE:|BLOCKED:|ESCALATED:|ALLOWED:|VOID:|CLEAR:|LEDGER:|AUDIT-PASS:)/;
  const scribe = createAgent({
    name: 'Scribe',
    capabilities: ['observer'],
    instruction: 'Pure observer: writes the live timeline and audit trail. Never acts.',
    tools: [],
    handlers: [
      {
        specification: new OnAnyEvent(),
        processor: {
          apply({ event }: any) {
            if (!LOGGABLE.has(event.type)) return;
            const producer =
              state.getParticipant(event.producerId)?.getManifest().name ?? event.producerId;
            let text: string | undefined = event.payload?.text;
            if (event.type === 'model.answer') {
              const t: string | undefined = event.payload?.answer?.content?.text;
              if (!t || !TOKEN_START.test(t)) return;
              text = t;
            }
            if (event.type === 'participant.joined') text = `${event.payload.name} joined the room`;
            if (event.type === 'participant.left') text = `${event.payload.name} left the room`;
            if (!text) return;
            const entry = { ts: new Date().toISOString(), actor: producer, text };
            state.auditTrail.push(entry);
            opts.onAudit?.(`[${entry.ts.slice(11, 19)}] ${producer}: ${text}`);
            opts.onTap?.({ type: event.type, producer, payload: event.payload, at: entry.ts });
          },
        },
      },
    ] as SituationHandler[],
  });

  // ---------------- Operator (human) ----------------
  const operator: Human = createHuman({ name: 'Operator', capabilities: ['approve-refund'], handlers: [] });

  for (const p of [feed, watchtower, ledgerKeeper, refundClerk, auditor, scribe, operator]) join(p);

  // ---------------- Room operations ----------------

  const streamOrders = (orders: Order[], intervalMs: number, onDone?: () => void) => {
    let i = 0;
    const tick = () => {
      if (i >= orders.length) {
        onDone?.();
        return;
      }
      const order = orders[i++];
      state.orderBook.set(order.id, { ...order, status: 'received' });
      state.counters.ordersReceived += 1;
      publish(feed.getId(), EV.ORDER_RECEIVED, {
        order,
        text: `ORDER: ${order.id} ${order.customerName} — ${order.items.map((it) => `${it.qty}x ${it.name}`).join(', ')} = $${order.total.toFixed(2)} via ${order.paymentMethod} (source: order ${order.id})`,
      });
      setTimeout(tick, intervalMs);
    };
    tick();
  };

  const injectRefundRequest = (requestId: string) => {
    const req = state.refundRequests.get(requestId);
    if (!req) throw new Error(`unknown refund request ${requestId}`);
    if (!state.proposals.has(req.orderId)) {
      state.proposals.set(req.orderId, {
        requestId: req.id,
        orderId: req.orderId,
        amount: req.amount,
        reason: req.reason,
        attempts: 0,
        status: 'proposed',
      });
    }
    publish(operator.getId(), EV.REFUND_PROPOSED, {
      requestId: req.id,
      orderId: req.orderId,
      text: `REFUND: request ${req.id} asks ${req.amount.toFixed(2)} for ${req.orderId} — ${req.reason} (source: request ${req.id}, order ${req.orderId})`,
    });
    publish(operator.getId(), EV.REFUND_REQUESTED, { requestId: req.id, orderId: req.orderId });
  };

  const decide = (orderId: string, approved: boolean) => {
    if (approved) {
      const rec = {
        id: `EV-${orderId}-human`,
        orderId,
        source: 'human-operator',
        detail: `Human operator approved the action for ${orderId} in the console`,
        ts: new Date().toISOString(),
      };
      state.addEvidence(rec);
      publish(operator.getId(), EV.EVIDENCE_CONFIRMED, {
        orderId,
        source: rec.source,
        text: `EVIDENCE: ${rec.id} source=human-operator — ${rec.detail}`,
      });
    }
    publish(operator.getId(), EV.HUMAN_DECISION, {
      orderId,
      approved,
      text: approved
        ? `Operator APPROVED the pending action for ${orderId}`
        : `Operator REJECTED the pending action for ${orderId}`,
    });
  };

  return {
    state,
    runtime,
    publish,
    gate,
    mode,
    model,
    feedId: feed.getId(),
    operatorId: operator.getId(),
    agentNames: ['OrderFeed', 'Watchtower', 'LedgerKeeper', 'RefundClerk', 'Auditor', 'Scribe', 'Operator'],
    streamOrders,
    injectRefundRequest,
    decide,
  };
}
