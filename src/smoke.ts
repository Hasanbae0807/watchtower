/**
 * G0 smoke test: proves the Mozaik v4 mechanics this project stands on —
 * defineRuntime + injected deterministic InferenceRunner + runLoop tool call
 * + InterceptionHandler BLOCK (tool never executes) and ALLOW (tool executes).
 * Run: npm run smoke
 */
import { ModelContext, SemanticEvent, SituationSpecification, createAgent, defineRuntime } from '@mozaik-ai/core';
import type { SituationHandler } from '@mozaik-ai/core';
import { EvidenceGate } from './gate.js';
import { DeterministicRunner } from './runner.js';
import { WatchtowerState } from './state.js';
import { refundTools } from './tools.js';

const state = new WatchtowerState();
const { initializeRuntime, join, runLoop, resolveRuntime } = defineRuntime<WatchtowerState>();
const runtime = initializeRuntime({ state, inferenceRunnerConfig: { runner: new DeterministicRunner(state) } });
const publish = (producerId: string, type: string, payload: Record<string, unknown>) => {
  runtime.publish(SemanticEvent.create(type, producerId, payload));
};

// Seed one order + its refund request directly in shared state.
state.orderBook.set('ORD-1', {
  id: 'ORD-1', ts: new Date().toISOString(), customerId: 'CUS-1', customerName: 'Smoke Test',
  email: 'smoke@example.test', items: [{ sku: 'X', name: 'X', qty: 1, price: 100 }], total: 100,
  paymentMethod: 'card-visa', billingCity: 'Jakarta', shippingCity: 'Jakarta',
  deviceId: 'DEV-1', priorOrders: 2, priorChargebacks: 0, status: 'received',
});
state.refundRequests.set('REQ-1', { id: 'REQ-1', orderId: 'ORD-1', amount: 100, reason: 'smoke', channel: 'test' });
state.proposals.set('ORD-1', { requestId: 'REQ-1', orderId: 'ORD-1', amount: 100, reason: 'smoke', attempts: 0, status: 'proposed' });

const gate = new EvidenceGate(state, publish);
const deps = { state, publish };
const clerk = createAgent({
  name: 'SmokeClerk',
  capabilities: ['refunds'],
  instruction: 'smoke',
  tools: refundTools(deps, 'smoke-clerk'),
  handlers: [] as SituationHandler[],
});
join(clerk);

const answers: string[] = [];
class OnModelAnswer extends SituationSpecification {
  isSatisfiedBy({ event }: any) {
    return event.type === 'model.answer';
  }
}
const watcher = createAgent({
  name: 'SmokeWatcher',
  capabilities: [],
  instruction: 'smoke',
  tools: [],
  handlers: [
    {
      specification: new OnModelAnswer(),
      processor: {
        apply({ event }: any) {
          answers.push(event.payload?.answer?.content?.text ?? JSON.stringify(event.payload).slice(0, 200));
        },
      },
    },
  ] as SituationHandler[],
});
join(watcher);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('— Attempt 1: no evidence -> expect BLOCKED, refund tool must NOT run');
runLoop(clerk.getId(), 'TASK propose-refund {"requestId":"REQ-1","orderId":"ORD-1","amount":100}', {
  model: 'deterministic',
  context: ModelContext.create(),
  tools: clerk.getTools(),
}, gate);
await sleep(600);
const blockedOk = state.counters.guardBlocked === 1 && state.counters.refundsExecuted === 0;
console.log('guardBlocked =', state.counters.guardBlocked, '| refundsExecuted =', state.counters.refundsExecuted, blockedOk ? 'PASS' : 'FAIL');

console.log('— Attempt 2: two evidence sources -> expect ALLOWED, refund executes');
state.addEvidence({ id: 'EV-1', orderId: 'ORD-1', source: 'ledger:L-1', detail: 'smoke ledger', ts: new Date().toISOString() });
state.addEvidence({ id: 'EV-2', orderId: 'ORD-1', source: 'auditor', detail: 'smoke audit', ts: new Date().toISOString() });
runLoop(clerk.getId(), 'TASK propose-refund {"requestId":"REQ-1","orderId":"ORD-1","amount":100}', {
  model: 'deterministic',
  context: ModelContext.create(),
  tools: clerk.getTools(),
}, gate);
await sleep(600);
const allowedOk = state.counters.guardAllowed === 1 && state.counters.refundsExecuted === 1 && state.balance === -100;
console.log('guardAllowed =', state.counters.guardAllowed, '| refundsExecuted =', state.counters.refundsExecuted, '| balance =', state.balance, allowedOk ? 'PASS' : 'FAIL');
console.log('model answers seen:', answers.length);
console.log(blockedOk && allowedOk ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(blockedOk && allowedOk ? 0 : 1);
