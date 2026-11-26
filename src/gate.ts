import { ModelMessageItem } from '@mozaik-ai/core';
import type { ExecutableTransition, InterceptionHandler } from '@mozaik-ai/core';
import { EV } from './bus.js';
import { money, type WatchtowerState } from './state.js';

export const HUMAN_APPROVAL_THRESHOLD = 500;
export const REQUIRED_EVIDENCE_SOURCES = 2;

const GATED_TOOLS = new Set(['issue_refund', 'void_order']);

/**
 * The EvidenceGate — a Mozaik InterceptionHandler attached to agent loops.
 *
 * It inspects every pending function_call transition for the state-changing
 * tools (issue_refund, void_order) BEFORE the tool executes:
 *  - fewer than 2 independent confirmed evidence sources in shared state
 *      -> BLOCKED: the transition is rewritten to a model_message, the tool
 *         never runs, and a guard.blocked event is published.
 *  - refund above $500 without a human-operator evidence record
 *      -> ESCALATED: same rewrite; a human must approve in the console.
 *  - otherwise -> ALLOWED: the transition passes through untouched.
 *
 * Evidence lives in RuntimeState (room knowledge). No agent can add evidence
 * for its own proposal: the flag is not evidence, the proposal is not
 * evidence — only the ledger, the independent Auditor, and the human count.
 */
export class EvidenceGate implements InterceptionHandler {
  constructor(
    private state: WatchtowerState,
    private publish: (producerId: string, type: string, payload: Record<string, unknown>) => void,
  ) {}

  isSatisfiedBy(transition: ExecutableTransition): boolean {
    if (transition.nextStateId !== 'function_call') return false;
    const call = (transition.input as any)?.call;
    return !!call && GATED_TOOLS.has(call.name);
  }

  async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
    const call = (transition.input as any).call as { name: string; args: string };
    let args: any = {};
    try {
      args = JSON.parse(call.args || '{}');
    } catch {
      args = {};
    }
    const orderId = String(args.orderId ?? 'unknown');
    const order = this.state.orderBook.get(orderId);
    const amount =
      call.name === 'issue_refund' ? Math.abs(Number(args.amount ?? 0)) : (order?.total ?? 0);
    const sources = this.state.evidenceFor(orderId).map((e) => e.source);
    const sourceCount = this.state.evidenceSourceCount(orderId);
    const ts = new Date().toISOString();

    const rewrite = (verdict: 'BLOCKED' | 'ESCALATED', text: string, evType: string) => {
      this.state.guardLog.push({ ts, tool: call.name, orderId, verdict, detail: text });
      if (verdict === 'BLOCKED') this.state.counters.guardBlocked += 1;
      else this.state.counters.guardEscalated += 1;
      this.publish('evidence-gate', evType, { orderId, tool: call.name, amount, text });
      return {
        nextStateId: 'model_message',
        input: { answer: ModelMessageItem.rehydrate({ text }) },
      } as unknown as ExecutableTransition;
    };

    if (sourceCount < REQUIRED_EVIDENCE_SOURCES) {
      return rewrite(
        'BLOCKED',
        `BLOCKED: ${call.name} for ${orderId} (${money(amount)}) was NOT executed — only ${sourceCount} confirmed evidence source(s) [${sources.join(', ') || 'none'}]; ${REQUIRED_EVIDENCE_SOURCES} independent sources are required (sources: order ${orderId}, shared evidence register).`,
        EV.GUARD_BLOCKED,
      );
    }

    if (call.name === 'issue_refund' && amount > HUMAN_APPROVAL_THRESHOLD && !this.state.hasHumanApproval(orderId)) {
      return rewrite(
        'ESCALATED',
        `ESCALATED: refund of ${money(amount)} for ${orderId} exceeds the ${money(HUMAN_APPROVAL_THRESHOLD)} human-approval threshold and was NOT executed. Evidence is sufficient (${sources.join(', ')}); a human operator must approve it in the console (source: order ${orderId}).`,
        EV.GUARD_ESCALATED,
      );
    }

    this.state.guardLog.push({
      ts,
      tool: call.name,
      orderId,
      verdict: 'ALLOWED',
      detail: `${call.name} ${orderId} ${money(amount)} — evidence sources: ${sources.join(', ')}`,
    });
    this.state.counters.guardAllowed += 1;
    this.publish('evidence-gate', EV.GUARD_ALLOWED, {
      orderId,
      tool: call.name,
      amount,
      text: `ALLOWED: ${call.name} for ${orderId} (${money(amount)}) — evidence sources: ${sources.join(', ')}`,
    });
    return transition;
  }
}
