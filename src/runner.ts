import { FunctionCallItem, ModelMessageItem } from '@mozaik-ai/core';
import type { InferenceInput, InferenceOutput, InferenceRunner, SemanticEvent } from '@mozaik-ai/core';
import { auditVerdict, scoreOrder } from './data.js';
import { money, type WatchtowerState } from './state.js';

/**
 * DeterministicRunner — the demo's no-API-key inference engine.
 *
 * Mozaik lets you inject any InferenceRunner. In LLM mode the runtime uses
 * its default runner and a real model drives the agents. In deterministic
 * mode (the default, so judges can run the repo with zero keys) this runner
 * plays the model's role with explicit, inspectable policies: given the task
 * message an agent was woken with, it decides the next tool call — or the
 * final contract-token message — from the shared state and the tool outputs
 * already in the loop context.
 *
 * Everything the policies "decide" is recomputed from source data (the
 * order book, the rules, the ledger). The EvidenceGate interception applies
 * identically in both modes, because it sits on the loop, not on the model.
 */
export class DeterministicRunner implements InferenceRunner {
  private seq = 0;

  constructor(private state: WatchtowerState) {}

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const items = input.context.getItems();
    let lastUserIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it: any = items[i];
      if (it.type === 'message' && it.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    const taskText: string = lastUserIdx >= 0 ? (items[lastUserIdx] as any).content.text : '';
    const after = items.slice(lastUserIdx + 1);
    const callsMade = after.filter((i: any) => i.type === 'function_call').map((i: any) => i.name as string);

    const m = taskText.match(/^TASK\s+(\S+)\s+(\{.*\})$/s);
    if (!m) {
      return this.message(`Deterministic mode: unrecognized task "${taskText.slice(0, 80)}"`);
    }
    const kind = m[1];
    const payload = JSON.parse(m[2]);

    switch (kind) {
      case 'score-order':
        return this.scoreOrderPolicy(payload, callsMade);
      case 'record-ledger':
        return this.recordLedgerPolicy(payload, callsMade);
      case 'audit-flag':
        return this.auditFlagPolicy(payload, callsMade);
      case 'propose-refund':
        return this.proposeRefundPolicy(payload, callsMade);
      case 'void-order':
        return this.voidOrderPolicy(payload, callsMade);
      default:
        return this.message(`Deterministic mode: no policy for task kind "${kind}"`);
    }
  }

  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> {
    throw new Error('DeterministicRunner does not stream; streaming is disabled in deterministic mode.');
  }

  // ---------- helpers ----------

  private call(name: string, args: Record<string, unknown>): InferenceOutput {
    this.seq += 1;
    return {
      items: [
        FunctionCallItem.rehydrate({
          callId: `det-call-${this.seq}`,
          name,
          args: JSON.stringify(args),
        }),
      ],
      tokenUsage: undefined,
      rowResponse: null,
    };
  }

  private message(text: string): InferenceOutput {
    return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: null };
  }

  private priorsOf(orderId: string) {
    const order = this.state.orderBook.get(orderId);
    if (!order) return { order: undefined, prior: [] as never[] };
    const prior = [...this.state.orderBook.values()].filter((o) => o.id !== orderId && o.ts < order.ts);
    return { order, prior };
  }

  // ---------- policies ----------

  private scoreOrderPolicy(p: { orderId: string }, callsMade: string[]): InferenceOutput {
    const { order, prior } = this.priorsOf(p.orderId);
    if (!order) return this.message(`CLEAR: ${p.orderId} not in the order book`);
    if (!callsMade.includes('get_order')) return this.call('get_order', { orderId: p.orderId });
    const hits = scoreOrder(order, prior as any);
    if (hits.length > 0 && !callsMade.includes('flag_order')) {
      return this.call('flag_order', { orderId: p.orderId });
    }
    if (hits.length > 0) {
      return this.message(
        `FLAG: ${order.id} ${hits.map((h) => `${h.ruleId} — ${h.detail}`).join(' | ')}`,
      );
    }
    return this.message(
      `CLEAR: ${order.id} no rule hits — total ${money(order.total)}, ${order.items.length} item(s), customer ${order.customerId} priorOrders=${order.priorOrders} (source: order ${order.id})`,
    );
  }

  private recordLedgerPolicy(p: { orderId: string }, callsMade: string[]): InferenceOutput {
    if (!callsMade.includes('record_ledger_entry')) {
      return this.call('record_ledger_entry', { orderId: p.orderId });
    }
    const line = this.state.ledgerLineFor(p.orderId, 'SALE');
    return this.message(
      line
        ? `LEDGER: ${p.orderId} recorded as ${line.id} — balance ${money(line.balanceAfter)} (source: ledger line ${line.id})`
        : `LEDGER: ${p.orderId} could not be recorded`,
    );
  }

  private auditFlagPolicy(p: { orderId: string }, callsMade: string[]): InferenceOutput {
    const { order, prior } = this.priorsOf(p.orderId);
    if (!order) return this.message(`HOLD: ${p.orderId} — order not found in the order book`);
    if (!callsMade.includes('get_order')) return this.call('get_order', { orderId: p.orderId });
    if (!callsMade.includes('get_ledger_line')) return this.call('get_ledger_line', { orderId: p.orderId });
    const hits = scoreOrder(order, prior as any);
    const verdict = auditVerdict(hits);
    const line = this.state.ledgerLineFor(p.orderId, 'SALE');
    if (verdict.pass && !callsMade.includes('confirm_evidence')) {
      return this.call('confirm_evidence', {
        orderId: p.orderId,
        detail: `Auditor recomputed the flag from source: ${hits.map((h) => `${h.ruleId} — ${h.detail}`).join(' | ')}; ledger line ${line?.id ?? 'missing'} confirms ${money(order.total)} (sources: order ${order.id}, ledger ${line?.id ?? 'n/a'})`,
      });
    }
    if (!verdict.pass && !callsMade.includes('raise_hold')) {
      return this.call('raise_hold', { orderId: p.orderId, missing: verdict.missing });
    }
    return this.message(
      verdict.pass
        ? `EVIDENCE: auditor verified FLAG on ${order.id} against order + ledger (sources: order ${order.id}, ledger ${line?.id ?? 'n/a'})`
        : `HOLD: ${order.id} — ${verdict.missing}`,
    );
  }

  private proposeRefundPolicy(
    p: { requestId: string; orderId: string; amount: number },
    callsMade: string[],
  ): InferenceOutput {
    if (!callsMade.includes('draft_reply')) return this.call('draft_reply', { requestId: p.requestId });
    if (!callsMade.includes('issue_refund')) {
      return this.call('issue_refund', { orderId: p.orderId, amount: p.amount, requestId: p.requestId });
    }
    const line = this.state.ledgerLineFor(p.orderId, 'REFUND');
    return this.message(
      `REFUND: ${p.orderId} ${money(p.amount)} executed as ledger line ${line?.id ?? 'n/a'} (sources: request ${p.requestId}, order ${p.orderId})`,
    );
  }

  private voidOrderPolicy(p: { orderId: string }, callsMade: string[]): InferenceOutput {
    if (!callsMade.includes('void_order')) return this.call('void_order', { orderId: p.orderId });
    const line = this.state.ledgerLineFor(p.orderId, 'VOID');
    return this.message(
      `VOID: ${p.orderId} voided as ledger line ${line?.id ?? 'n/a'} (source: order ${p.orderId})`,
    );
  }
}
