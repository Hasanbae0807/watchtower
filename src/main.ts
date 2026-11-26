import { buildRoom, type Mode, type TapEvent } from './agents.js';
import { generateDataset, writeDataFiles } from './data.js';
import { runScenario, summarize } from './scenario.js';
import { startConsole } from './server.js';

const args = new Set(process.argv.slice(2));
const cli = args.has('--cli');
const selftest = args.has('--selftest');
const port = Number(process.env.PORT ?? 8788);
const mode: Mode = process.env.WATCHTOWER_MODE === 'llm' ? 'llm' : 'deterministic';

// Agent loops are fire-and-forget by design (Mozaik rule). If a provider call
// fails in LLM mode, log it and keep the room alive instead of crashing.
process.on('unhandledRejection', (err) => {
  console.error(`[inference error — loop aborted, room stays up] ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
});

const ds = generateDataset();
writeDataFiles(new URL('../data', import.meta.url).pathname, ds);

let broadcast: (e: TapEvent) => void = () => {};
const room = buildRoom(mode, {
  onAudit: (line) => {
    if (cli || selftest) console.log(line);
  },
  onTap: (e) => broadcast(e),
});

console.log('BlackFriday Watchtower — SYNTHETIC data only. Not financial advice.');
console.log(`Mode: ${mode}${mode === 'llm' ? ` (model: ${room.model})` : ' (no API key needed)'}`);
console.log(
  `Dataset: ${ds.orders.length} synthetic orders, ${ds.refundRequests.length} refund requests (seeded, see data/ + SYNTHETIC-DATA.md)`,
);
console.log('Agents in the room: ' + room.agentNames.join(', '));

if (!cli && !selftest) {
  broadcast = startConsole(room, port).broadcast;
  void runScenario(room, ds, { autoApprove: false, note: (s) => console.log(s) });
  console.log('Scenario streaming. Open the console to watch the room work; escalations wait for your click.');
} else {
  const result = await runScenario(room, ds, {
    autoApprove: true,
    timeoutMs: selftest ? 90_000 : 120_000,
    note: (s) => console.log(s),
  });
  for (const line of summarize(room)) console.log(line);

  if (selftest) {
    const s = room.state;
    const H = ds.highlights;
    const recomputed = Math.round(s.ledger.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    const checks: [string, boolean][] = [
      ['all 26 demo orders received', s.counters.ordersReceived === 26],
      ['weak flag HOLD by Auditor', s.counters.holds >= 1],
      ['strong flag order voided after audit pass', s.orderBook.get(H.strongFlagOrderId)?.status === 'voided'],
      ['gate BLOCKED at least once', s.counters.guardBlocked >= 1],
      ['gate ESCALATED the $1,232 refund', s.counters.guardEscalated >= 1],
      ['gate ALLOWED at least twice', s.counters.guardAllowed >= 2],
      ['refund REQ-501 executed', s.proposals.get(H.refundOrderId)?.status === 'executed'],
      ['big refund REQ-502 executed after human approval', s.proposals.get(H.bigRefundOrderId)?.status === 'executed'],
      ['ledger balance recomputes exactly', s.balance === recomputed],
      ['scenario arc finished', result.finished],
    ];
    let failed = 0;
    for (const [name, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
      if (!ok) failed += 1;
    }
    console.log(failed === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failed} checks)`);
    process.exit(failed === 0 ? 0 : 1);
  }
  process.exit(0);
}
