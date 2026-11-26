import { SemanticEvent, SituationSpecification } from '@mozaik-ai/core';
import type { Participant } from '@mozaik-ai/core';

/** Domain event types carried on the shared Mozaik bus. */
export const EV = {
  ORDER_RECEIVED: 'order.received',
  ORDER_FLAGGED: 'order.flagged',
  ORDER_CLEARED: 'order.cleared',
  ORDER_VOIDED: 'order.voided',
  LEDGER_UPDATED: 'ledger.updated',
  EVIDENCE_CONFIRMED: 'evidence.confirmed',
  AUDIT_HOLD: 'audit.hold',
  AUDIT_PASSED: 'audit.passed',
  REFUND_REQUESTED: 'refund.requested',
  REFUND_PROPOSED: 'refund.proposed',
  REFUND_EXECUTED: 'refund.executed',
  GUARD_BLOCKED: 'guard.blocked',
  GUARD_ALLOWED: 'guard.allowed',
  GUARD_ESCALATED: 'guard.escalated',
  HUMAN_DECISION: 'human.decision',
  SCENARIO_NOTE: 'scenario.note',
} as const;

export type BusEvent = SemanticEvent<string, any>;

/** SituationSpecification that fires when an event of `type` arrives. */
export class OnEvent extends SituationSpecification {
  constructor(
    private type: string,
    private opts: { includeSelf?: boolean; fromOthersOnly?: boolean } = {},
  ) {
    super();
  }
  isSatisfiedBy({ event, participant }: { event: BusEvent; participant: Participant }): boolean {
    if (event.type !== this.type) return false;
    if (this.opts.fromOthersOnly && event.producerId === participant.getId()) return false;
    if (!this.opts.includeSelf && event.producerId === participant.getId()) return false;
    return true;
  }
}

/** Specification that fires on every event (pure observers: Scribe, console tap). */
export class OnAnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

export function publish(
  runtime: { publish: (e: BusEvent) => void },
  producerId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  runtime.publish(SemanticEvent.create(type, producerId, payload));
}
