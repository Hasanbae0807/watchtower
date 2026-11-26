import type { Dataset } from './data.js';
import type { Room } from './agents.js';

export interface ScenarioResult {
  finished: boolean;
  elapsedMs: number;
}

/**
 * The deterministic demo arc — one story that exercises every rubric point:
 *
 *  1. The feed streams 26 synthetic Black Friday orders; Watchtower scores
 *     each one, LedgerKeeper books each one (concurrently, same bus).
 *  2. Weak flag (address mismatch only) -> Auditor HOLDs it: one weak signal
 *     is not evidence.
 *  3. Strong flag (velocity + chargeback history) -> LedgerKeeper tries to
 *     void immediately -> gate BLOCKED (only the ledger evidence exists) ->
 *     Auditor verifies -> void retry -> ALLOWED -> order voided.
 *  4. Refund REQ-501 (flagged order, $238) -> clerk races the Auditor ->
 *     BLOCKED or direct pass -> after audit pass -> ALLOWED -> refunded.
 *  5. Refund REQ-502 ($1,232) -> evidence sufficient but above the $500
 *     threshold -> ESCALATED -> human approves -> ALLOWED -> refunded.
 *
 * In web mode step 5 waits for a real click on the console's Approve card.
 * In CLI/selftest mode the scenario auto-approves after a pause and says so
 * on the record — it simulates the operator, it does not hide the gate.
 */
export function runScenario(
  room: Room,
  ds: Dataset,
  opts: { autoApprove: boolean; intervalMs?: number; timeoutMs?: number; note?: (s: string) => void },
): Promise<ScenarioResult> {
  const state = room.state;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  for (const req of ds.refundRequests) state.refundRequests.set(req.id, req);

  const H = ds.highlights;
  const injected = new Set<string>();
  let autoApproved = false;
  let streamDone = false;

  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const elapsed = Date.now() - started;

      if (
        opts.autoApprove &&
        !autoApproved &&
        state.proposals.get(H.bigRefundOrderId)?.status === 'escalated'
      ) {
        autoApproved = true;
        opts.note?.(
          `Operator decision needed for ${H.bigRefundOrderId} — CLI demo auto-approves in 1.5s (web mode: a human clicks Approve).`,
        );
        setTimeout(() => room.decide(H.bigRefundOrderId, true), 1500);
      }

      const refundDone = state.proposals.get(H.refundOrderId)?.status === 'executed';
      const bigDone = state.proposals.get(H.bigRefundOrderId)?.status === 'executed';
      const strongVoided = state.orderBook.get(H.strongFlagOrderId)?.status === 'voided';
      const weakHeld = state.counters.holds >= 1;

      if ((streamDone && refundDone && bigDone && strongVoided && weakHeld) || elapsed > timeoutMs) {
        clearInterval(poll);
        // Let in-flight loops settle before the summary is read.
        setTimeout(
          () =>
            resolve({
              finished: refundDone && bigDone && strongVoided && weakHeld,
              elapsedMs: Date.now() - started,
            }),
          1200,
        );
      }
    }, 250);

    room.streamOrders(
      ds.demoOrderIds.map((id) => ds.orders.find((o) => o.id === id)!),
      opts.intervalMs ?? 450,
      () => {
        streamDone = true;
      },
    );

    // Inject each refund request as soon as its order is flagged — the clerk
    // then races the Auditor, which is exactly the concurrency being demoed.
    const flagPoll = setInterval(() => {
      for (const req of ds.refundRequests) {
        if (
          (req.orderId === H.refundOrderId || req.orderId === H.bigRefundOrderId) &&
          state.flags.has(req.orderId) &&
          !injected.has(req.id)
        ) {
          injected.add(req.id);
          room.injectRefundRequest(req.id);
        }
      }
      if (Date.now() - started > timeoutMs) clearInterval(flagPoll);
    }, 120);
  });
}

export function summarize(room: Room): string[] {
  const s = room.state;
  const lines: string[] = [];
  lines.push('— Summary (every figure sourced from shared state) —');
  lines.push(`orders received: ${s.counters.ordersReceived} (source: OrderFeed intake counter)`);
  lines.push(`orders flagged: ${s.counters.ordersFlagged} | audit HOLDs: ${s.counters.holds} | audit passes: ${s.counters.auditPasses}`);
  lines.push(`guard: BLOCKED ${s.counters.guardBlocked} | ESCALATED ${s.counters.guardEscalated} | ALLOWED ${s.counters.guardAllowed} (source: EvidenceGate log, ${s.guardLog.length} entries)`);
  lines.push(`refunds executed: ${s.counters.refundsExecuted} | voids executed: ${s.counters.voidsExecuted}`);
  const recomputed = Math.round(s.ledger.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  lines.push(
    `ledger: ${s.ledger.length} lines, final balance $${s.balance.toFixed(2)} — recomputed from lines: $${recomputed.toFixed(2)} — ${s.balance === recomputed ? 'MATCH' : 'MISMATCH'}`,
  );
  lines.push(`audit trail entries: ${s.auditTrail.length} (source: Scribe)`);
  return lines;
}
