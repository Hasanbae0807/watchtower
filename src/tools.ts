import type { Tool } from '@mozaik-ai/core';
import { EV, publish } from './bus.js';
import { scoreOrder } from './data.js';
import { money, type WatchtowerState } from './state.js';

type Publish = (producerId: string, type: string, payload: Record<string, unknown>) => void;
type ProducerId = string | (() => string);
const pid = (p: ProducerId): string => (typeof p === 'function' ? p() : p);

export interface ToolDeps {
  state: WatchtowerState;
  publish: Publish;
}

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  invoke: (args: any) => Promise<any>,
): Tool => ({
  type: 'function',
  name,
  description,
  parameters: { type: 'object', properties, additionalProperties: false, required },
  strict: false,
  invoke,
});

const str = { type: 'string' };
const num = { type: 'number' };

/** Read-only lookup tools — usable by any agent, never gated. */
export function lookupTools({ state }: ToolDeps): Tool[] {
  return [
    fn(
      'search_orders',
      'Search the shared order book by order id, customer id, or device id. Returns matching orders as JSON.',
      { query: str },
      ['query'],
      async ({ query }) => {
        const q = String(query).toLowerCase();
        const out = [...state.orderBook.values()].filter(
          (o) =>
            o.id.toLowerCase().includes(q) ||
            o.customerId.toLowerCase().includes(q) ||
            o.deviceId.toLowerCase().includes(q),
        );
        return JSON.stringify(out.slice(0, 10));
      },
    ),
    fn(
      'get_order',
      'Get one order from the shared order book by id, with all fields (items, total, cities, device, customer history).',
      { orderId: str },
      ['orderId'],
      async ({ orderId }) => {
        const o = state.orderBook.get(String(orderId));
        return o ? JSON.stringify(o) : `Error: order ${orderId} not found in the order book`;
      },
    ),
    fn(
      'get_ledger_line',
      'Get the SALE ledger line for an order (id, amount, balance after) — the ledger source of truth for amounts.',
      { orderId: str },
      ['orderId'],
      async ({ orderId }) => {
        const line = state.ledgerLineFor(String(orderId), 'SALE');
        return line ? JSON.stringify(line) : `Error: no SALE ledger line for ${orderId}`;
      },
    ),
  ];
}

/** Watchtower's flag tool. Hits are recomputed from source data inside the tool — never taken on trust. */
export function flagTool({ state, publish: pub }: ToolDeps, producerId: ProducerId): Tool {
  return fn(
    'flag_order',
    'Flag an order as suspicious. The fraud rules are re-run against the order book inside this tool; the published FLAG cites rule ids and the exact fields/order ids behind each hit.',
    { orderId: str },
    ['orderId'],
    async ({ orderId }) => {
      const order = state.orderBook.get(String(orderId));
      if (!order) return `Error: order ${orderId} not found`;
      const prior = [...state.orderBook.values()].filter((o) => o.id !== order.id && o.ts < order.ts);
      const hits = scoreOrder(order, prior);
      if (hits.length === 0) return `No rule hits for ${orderId}; nothing to flag.`;
      // 'high' severity = 2+ independent rule hits. Only high-severity flags
      // are void candidates; a single hard signal (e.g. R4 alone) is not
      // enough to void an order — it goes through audit + refund handling.
      const severity = hits.length >= 2 ? 'high' : 'low';
      state.flags.set(order.id, {
        orderId: order.id,
        hits,
        severity,
        flaggedBy: 'Watchtower',
        ts: new Date().toISOString(),
      });
      order.status = 'flagged';
      state.counters.ordersFlagged += 1;
      const text = `FLAG: ${order.id} ${hits.map((h) => `${h.ruleId} — ${h.detail}`).join(' | ')}`;
      pub(pid(producerId), EV.ORDER_FLAGGED, { orderId: order.id, hits, severity, text });
      return text;
    },
  );
}

/** LedgerKeeper's recording tool. Recording a SALE line also registers the ledger as evidence source #1. */
export function recordLedgerTool({ state, publish: pub }: ToolDeps, producerId: ProducerId): Tool {
  return fn(
    'record_ledger_entry',
    'Record the SALE ledger line for an order and register the ledger line as confirmed evidence (source: ledger).',
    { orderId: str },
    ['orderId'],
    async ({ orderId }) => {
      const order = state.orderBook.get(String(orderId));
      if (!order) return `Error: order ${orderId} not found`;
      if (state.ledgerLineFor(order.id, 'SALE')) return `Ledger line already exists for ${orderId}`;
      const line = state.appendLedger({
        ts: new Date().toISOString(),
        orderId: order.id,
        kind: 'SALE',
        amount: order.total,
        source: `order ${order.id}`,
      });
      pub(pid(producerId), EV.LEDGER_UPDATED, {
        orderId: order.id,
        lineId: line.id,
        kind: line.kind,
        amount: line.amount,
        balanceAfter: line.balanceAfter,
        text: `LEDGER: ${line.id} SALE ${money(line.amount)} for ${order.id} — balance ${money(line.balanceAfter)} (source: order ${order.id})`,
      });
      const rec = {
        id: `EV-${order.id}-ledger`,
        orderId: order.id,
        source: `ledger:${line.id}`,
        detail: `SALE line ${line.id} records ${money(order.total)} for order ${order.id}`,
        ts: new Date().toISOString(),
      };
      state.addEvidence(rec);
      pub(pid(producerId), EV.EVIDENCE_CONFIRMED, {
        orderId: order.id,
        source: rec.source,
        text: `EVIDENCE: ${rec.id} source=${rec.source} — ${rec.detail}`,
      });
      return `Recorded ${line.id}: SALE ${money(line.amount)} for ${order.id}; balance ${money(line.balanceAfter)}`;
    },
  );
}

/** Auditor tools: confirm evidence (pass) or raise a HOLD. The Auditor reads the bus + sources, never the flagger's memory. */
export function auditorTools({ state, publish: pub }: ToolDeps, producerId: ProducerId): Tool[] {
  return [
    fn(
      'confirm_evidence',
      'Confirm, as an independent evidence source, that a flag checks out against the order and the ledger. Publishes EVIDENCE + audit.passed.',
      { orderId: str, detail: str },
      ['orderId', 'detail'],
      async ({ orderId, detail }) => {
        const rec = {
          id: `EV-${orderId}-auditor`,
          orderId: String(orderId),
          source: 'auditor',
          detail: String(detail),
          ts: new Date().toISOString(),
        };
        state.addEvidence(rec);
        state.counters.auditPasses += 1;
        pub(pid(producerId), EV.EVIDENCE_CONFIRMED, {
          orderId: rec.orderId,
          source: rec.source,
          text: `EVIDENCE: ${rec.id} source=auditor — ${rec.detail}`,
        });
        pub(pid(producerId), EV.AUDIT_PASSED, {
          orderId: rec.orderId,
          text: `AUDIT-PASS: ${rec.orderId} verified against order + ledger sources`,
        });
        return `Evidence confirmed for ${orderId} (source: auditor)`;
      },
    ),
    fn(
      'raise_hold',
      'Hold a flag that cannot be verified: the evidence is missing or too weak. Publishes HOLD with what is missing.',
      { orderId: str, missing: str },
      ['orderId', 'missing'],
      async ({ orderId, missing }) => {
        state.counters.holds += 1;
        const text = `HOLD: ${orderId} — ${missing}`;
        pub(pid(producerId), EV.AUDIT_HOLD, { orderId: String(orderId), missing: String(missing), text });
        return text;
      },
    ),
  ];
}

/** RefundClerk tools. issue_refund is STATE-CHANGING and passes through the EvidenceGate interception. */
export function refundTools({ state, publish: pub }: ToolDeps, producerId: ProducerId): Tool[] {
  return [
    fn(
      'draft_reply',
      'Draft the customer-facing reply for a refund request. Does not move money.',
      { requestId: str },
      ['requestId'],
      async ({ requestId }) => {
        const req = state.refundRequests.get(String(requestId));
        if (!req) return `Error: refund request ${requestId} not found`;
        return `Draft reply for ${req.id}: "We are reviewing your refund of ${money(req.amount)} for order ${req.orderId}. Reason noted: ${req.reason}" (source: request ${req.id}, order ${req.orderId})`;
      },
    ),
    fn(
      'issue_refund',
      'STATE-CHANGING: issue a refund for an order. This call is intercepted by the EvidenceGate — it only executes with at least 2 independent confirmed evidence sources (and human approval above $500).',
      { orderId: str, amount: num, requestId: str },
      ['orderId', 'amount', 'requestId'],
      async ({ orderId, amount, requestId }) => {
        const order = state.orderBook.get(String(orderId));
        if (!order) return `Error: order ${orderId} not found`;
        const line = state.appendLedger({
          ts: new Date().toISOString(),
          orderId: order.id,
          kind: 'REFUND',
          amount: -Math.abs(Number(amount)),
          source: `refund request ${requestId}`,
        });
        order.status = 'refunded';
        const prop = state.proposals.get(order.id);
        if (prop) prop.status = 'executed';
        state.counters.refundsExecuted += 1;
        pub(pid(producerId), EV.LEDGER_UPDATED, {
          orderId: order.id,
          lineId: line.id,
          kind: line.kind,
          amount: line.amount,
          balanceAfter: line.balanceAfter,
          text: `LEDGER: ${line.id} REFUND ${money(line.amount)} for ${order.id} — balance ${money(line.balanceAfter)} (source: request ${requestId})`,
        });
        pub(pid(producerId), EV.REFUND_EXECUTED, {
          orderId: order.id,
          amount: Math.abs(Number(amount)),
          requestId: String(requestId),
          lineId: line.id,
          text: `REFUND: ${order.id} ${money(Math.abs(Number(amount)))} executed as ledger line ${line.id} (sources: request ${requestId}, order ${order.id}, ledger ${line.id})`,
        });
        return `Refund of ${money(Math.abs(Number(amount)))} for ${order.id} recorded as ${line.id}`;
      },
    ),
  ];
}

/** LedgerKeeper's void tool — also state-changing and gated. */
export function voidTool({ state, publish: pub }: ToolDeps, producerId: ProducerId): Tool {
  return fn(
    'void_order',
    'STATE-CHANGING: void an order (reverses its SALE ledger line). Intercepted by the EvidenceGate — only executes with at least 2 independent confirmed evidence sources.',
    { orderId: str },
    ['orderId'],
    async ({ orderId }) => {
      const order = state.orderBook.get(String(orderId));
      if (!order) return `Error: order ${orderId} not found`;
      const sale = state.ledgerLineFor(order.id, 'SALE');
      if (!sale) return `Error: no SALE line to void for ${orderId}`;
      const line = state.appendLedger({
        ts: new Date().toISOString(),
        orderId: order.id,
        kind: 'VOID',
        amount: -sale.amount,
        source: `void of ${sale.id}`,
      });
      order.status = 'voided';
      state.counters.voidsExecuted += 1;
      pub(pid(producerId), EV.LEDGER_UPDATED, {
        orderId: order.id,
        lineId: line.id,
        kind: line.kind,
        amount: line.amount,
        balanceAfter: line.balanceAfter,
        text: `LEDGER: ${line.id} VOID ${money(line.amount)} for ${order.id} — balance ${money(line.balanceAfter)} (source: ${sale.id})`,
      });
      pub(pid(producerId), EV.ORDER_VOIDED, {
        orderId: order.id,
        lineId: line.id,
        text: `VOID: ${order.id} voided as ledger line ${line.id}, reversing ${sale.id} (${money(sale.amount)})`,
      });
      return `Order ${order.id} voided as ${line.id}`;
    },
  );
}
