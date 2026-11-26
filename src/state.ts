import { RuntimeState } from '@mozaik-ai/core';

// ---------- Domain types (all data is SYNTHETIC — see SYNTHETIC-DATA.md) ----------

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  ts: string;
  customerId: string;
  customerName: string;
  email: string;
  items: OrderItem[];
  total: number;
  paymentMethod: string;
  billingCity: string;
  shippingCity: string;
  deviceId: string;
  priorOrders: number;
  priorChargebacks: number;
}

export type OrderStatus =
  | 'received'
  | 'flagged'
  | 'cleared'
  | 'voided'
  | 'refunded'
  | 'refund-blocked';

export interface TrackedOrder extends Order {
  status: OrderStatus;
}

export interface FraudRule {
  id: string;
  name: string;
  description: string;
}

export interface RuleHit {
  ruleId: string;
  detail: string;
}

export interface RefundRequest {
  id: string;
  orderId: string;
  amount: number;
  reason: string;
  channel: string;
}

export interface LedgerLine {
  id: string;
  ts: string;
  orderId: string;
  kind: 'SALE' | 'REFUND' | 'VOID';
  amount: number; // signed: SALE +, REFUND -, VOID -
  balanceAfter: number;
  source: string; // who/what produced this line
}

export interface EvidenceRecord {
  id: string;
  orderId: string;
  /** Independent source of this evidence, e.g. "ledger:L-1007", "auditor", "human-operator". */
  source: string;
  detail: string;
  ts: string;
}

export interface FlagRecord {
  orderId: string;
  hits: RuleHit[];
  severity: 'low' | 'high';
  flaggedBy: string;
  ts: string;
}

export interface RefundProposal {
  requestId: string;
  orderId: string;
  amount: number;
  reason: string;
  attempts: number;
  status: 'proposed' | 'blocked' | 'escalated' | 'executed' | 'rejected';
}

export interface AuditEntry {
  ts: string;
  actor: string;
  text: string;
}

export interface GuardEntry {
  ts: string;
  tool: string;
  orderId: string;
  verdict: 'BLOCKED' | 'ALLOWED' | 'ESCALATED';
  detail: string;
}

/**
 * Shared runtime state — the single store every agent reads and writes.
 * Evidence lives here (room knowledge), never in a private agent memory,
 * so no agent can authorize its own action.
 */
export class WatchtowerState extends RuntimeState {
  orderBook = new Map<string, TrackedOrder>();
  ledger: LedgerLine[] = [];
  balance = 0;
  confirmedEvidence = new Map<string, EvidenceRecord[]>();
  flags = new Map<string, FlagRecord>();
  refundRequests = new Map<string, RefundRequest>();
  proposals = new Map<string, RefundProposal>(); // keyed by orderId
  auditTrail: AuditEntry[] = [];
  guardLog: GuardEntry[] = [];
  counters = {
    ordersReceived: 0,
    ordersFlagged: 0,
    ordersCleared: 0,
    holds: 0,
    auditPasses: 0,
    refundsExecuted: 0,
    voidsExecuted: 0,
    guardBlocked: 0,
    guardAllowed: 0,
    guardEscalated: 0,
  };

  addEvidence(rec: EvidenceRecord): void {
    const list = this.confirmedEvidence.get(rec.orderId) ?? [];
    if (!list.some((e) => e.source === rec.source)) list.push(rec);
    this.confirmedEvidence.set(rec.orderId, list);
  }

  evidenceFor(orderId: string): EvidenceRecord[] {
    return this.confirmedEvidence.get(orderId) ?? [];
  }

  /** Distinct evidence sources — the gate counts sources, not records. */
  evidenceSourceCount(orderId: string): number {
    return new Set(this.evidenceFor(orderId).map((e) => e.source.split(':')[0])).size;
  }

  hasHumanApproval(orderId: string): boolean {
    return this.evidenceFor(orderId).some((e) => e.source === 'human-operator');
  }

  ledgerLineFor(orderId: string, kind: LedgerLine['kind'] = 'SALE'): LedgerLine | undefined {
    return this.ledger.find((l) => l.orderId === orderId && l.kind === kind);
  }

  appendLedger(line: Omit<LedgerLine, 'id' | 'balanceAfter'>): LedgerLine {
    this.balance = Math.round((this.balance + line.amount) * 100) / 100;
    const full: LedgerLine = {
      ...line,
      id: `L-${1001 + this.ledger.length}`,
      balanceAfter: this.balance,
    };
    this.ledger.push(full);
    return full;
  }
}

export const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
