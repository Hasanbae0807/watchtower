import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FraudRule, Order, RefundRequest, RuleHit } from './state.js';

/**
 * Deterministic synthetic data generator.
 * Same seed -> same dataset, every run. Everything here is SYNTHETIC:
 * no real customers, no real money. See SYNTHETIC-DATA.md.
 */
export const SEED = 20261127;

/** mulberry32 — small deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RULES: FraudRule[] = [
  {
    id: 'R1',
    name: 'VELOCITY',
    description:
      '4 or more orders from the same device within a 10-minute window. Detail cites the order ids counted.',
  },
  {
    id: 'R2',
    name: 'ADDRESS_MISMATCH',
    description:
      'Billing city differs from shipping city. Weak signal on its own (could be a gift) — the Auditor requires corroboration.',
  },
  {
    id: 'R3',
    name: 'HIGH_VALUE_NEW_CUSTOMER',
    description:
      'Order total above $900 from a customer with 0 prior orders. Hard signal: backed by the customer history fields on the order itself.',
  },
  {
    id: 'R4',
    name: 'CHARGEBACK_HISTORY',
    description:
      'Customer has 1 or more prior chargebacks in the synthetic history. Hard signal: backed by the customer history fields on the order itself.',
  },
];

const FIRST = ['Alya', 'Bimo', 'Citra', 'Dimas', 'Eka', 'Fajar', 'Gita', 'Hendra', 'Intan', 'Joko', 'Kirana', 'Lutfi', 'Maya', 'Nanda', 'Oscar', 'Putri', 'Raka', 'Sari', 'Teguh', 'Utami', 'Vina', 'Wahyu', 'Yoga', 'Zahra', 'Andre', 'Bella', 'Candra', 'Dewi', 'Erlang', 'Fitri'];
const LAST = ['Pratama', 'Saputra', 'Wulandari', 'Nugroho', 'Sari', 'Hidayat', 'Nugraha', 'Putri', 'Ramadhan', 'Utama', 'Lestari', 'Firmansyah', 'Anggraini', 'Setiawan', 'Maharani', 'Kusuma', 'Rahmawati', 'Prasetyo', 'Handayani', 'Wibowo'];
const CITIES = ['Jakarta', 'Bandung', 'Surabaya', 'Semarang', 'Medan', 'Makassar', 'Yogyakarta', 'Denpasar', 'Palembang', 'Batam'];
const PAYMENTS = ['card-visa', 'card-mastercard', 'ewallet-ovo', 'ewallet-gopay', 'bank-transfer', 'card-amex'];

const CATALOG: { sku: string; name: string; price: number }[] = [
  { sku: 'SKU-TV55', name: 'LED TV 55in 4K', price: 549.0 },
  { sku: 'SKU-LAP14', name: 'Laptop 14in 16GB', price: 899.0 },
  { sku: 'SKU-PHN13', name: 'Smartphone 13 Pro', price: 749.0 },
  { sku: 'SKU-HDPX', name: 'Noise-Cancel Headphones', price: 129.0 },
  { sku: 'SKU-WATCH', name: 'Smartwatch Series 8', price: 249.0 },
  { sku: 'SKU-TAB11', name: 'Tablet 11in', price: 329.0 },
  { sku: 'SKU-CAM', name: 'Mirrorless Camera', price: 679.0 },
  { sku: 'SKU-CONSOLE', name: 'Game Console', price: 499.0 },
  { sku: 'SKU-SPK', name: 'Soundbar Speaker', price: 159.0 },
  { sku: 'SKU-KBD', name: 'Mechanical Keyboard', price: 89.0 },
  { sku: 'SKU-MOUSE', name: 'Wireless Mouse', price: 45.0 },
  { sku: 'SKU-MON27', name: 'Monitor 27in QHD', price: 279.0 },
  { sku: 'SKU-SSD1T', name: 'SSD 1TB NVMe', price: 109.0 },
  { sku: 'SKU-DRONE', name: 'Camera Drone Mini', price: 399.0 },
  { sku: 'SKU-VAC', name: 'Robot Vacuum', price: 299.0 },
  { sku: 'SKU-AIRFRY', name: 'Air Fryer XL', price: 119.0 },
  { sku: 'SKU-SHOES', name: 'Running Shoes', price: 95.0 },
  { sku: 'SKU-BAG', name: 'Travel Backpack', price: 75.0 },
  { sku: 'SKU-LAMP', name: 'Smart Lamp Duo', price: 39.0 },
  { sku: 'SKU-CHAIR', name: 'Ergonomic Chair', price: 219.0 },
];

export interface Dataset {
  orders: Order[];
  refundRequests: RefundRequest[];
  /** Orders the demo scenario is built around (all inside the first 26 streamed). */
  highlights: {
    weakFlagOrderId: string;
    strongFlagOrderId: string;
    refundOrderId: string;
    bigRefundOrderId: string;
  };
  /** Stream order for the demo: the first N orders of the dataset (chronological). */
  demoOrderIds: string[];
}

export function generateDataset(seed = SEED): Dataset {
  const rand = rng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const orders: Order[] = [];
  let clock = new Date('2026-11-27T00:05:00Z').getTime();
  let seq = 1000;

  const mkCustomer = () => {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    return {
      customerId: `CUS-${100 + Math.floor(rand() * 60)}`,
      customerName: name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.test`,
    };
  };

  const mkOrder = (over: Partial<Order> & { items: Order['items'] }): Order => {
    clock += Math.floor(20 + rand() * 130) * 1000;
    seq += 1;
    const c = mkCustomer();
    const city = pick(CITIES);
    const { items, ...rest } = over;
    const total = Math.round(items.reduce((s, i) => s + i.qty * i.price, 0) * 100) / 100;
    return {
      id: `ORD-${seq}`,
      ts: new Date(clock).toISOString(),
      customerId: c.customerId,
      customerName: c.customerName,
      email: c.email,
      items,
      total,
      paymentMethod: pick(PAYMENTS),
      billingCity: city,
      shippingCity: city,
      deviceId: `DEV-${1000 + Math.floor(rand() * 400)}`,
      priorOrders: Math.floor(rand() * 12),
      priorChargebacks: 0,
      ...rest,
    };
  };

  const someItems = (maxTotal: number): Order['items'] => {
    const items: Order['items'] = [];
    let sum = 0;
    while (items.length === 0 || (sum < maxTotal * 0.6 && items.length < 3 && rand() > 0.45)) {
      const p = pick(CATALOG);
      if (sum + p.price > maxTotal) break;
      items.push({ sku: p.sku, name: p.name, qty: 1, price: p.price });
      sum += p.price;
    }
    if (items.length === 0) {
      const p = CATALOG.find((c) => c.price <= maxTotal) ?? CATALOG[17];
      items.push({ sku: p.sku, name: p.name, qty: 1, price: p.price });
    }
    return items;
  };

  const highlights = { weakFlagOrderId: '', strongFlagOrderId: '', refundOrderId: '', bigRefundOrderId: '' };

  // --- First 26 orders: the demo sequence, with the four story orders planted. ---
  for (let i = 0; i < 26; i++) {
    if (i === 5) {
      // Weak flag: address mismatch ONLY (gift-plausible) -> Auditor HOLD.
      const o = mkOrder({ items: someItems(220) });
      o.shippingCity = CITIES.find((c) => c !== o.billingCity) ?? 'Medan';
      highlights.weakFlagOrderId = o.id;
      orders.push(o);
    } else if (i >= 9 && i <= 13) {
      // Velocity cluster: 5 orders, one device, tight timestamps.
      const o = mkOrder({ items: someItems(300) });
      o.deviceId = 'DEV-VEL1';
      o.customerId = 'CUS-VEL';
      o.customerName = 'Rudi Hartono';
      o.email = 'rudi.hartono@example.test';
      if (i === 12) {
        o.priorChargebacks = 1; // 4th in window + chargeback history -> strong flag (R1+R4)
        highlights.strongFlagOrderId = o.id;
      }
      orders.push(o);
    } else if (i === 16) {
      // Refund arc: chargeback-history customer (R4 hard signal), modest total <= $500.
      const o = mkOrder({ items: [{ sku: 'SKU-HDPX', name: 'Noise-Cancel Headphones', qty: 1, price: 129.0 }, { sku: 'SKU-SSD1T', name: 'SSD 1TB NVMe', qty: 1, price: 109.0 }] });
      o.priorChargebacks = 1;
      o.priorOrders = 3;
      highlights.refundOrderId = o.id;
      orders.push(o);
    } else if (i === 19) {
      // Big refund arc: brand-new customer, total $1,248 (R3 hard signal) -> refund > $500 -> human escalation.
      const o = mkOrder({
        items: [
          { sku: 'SKU-LAP14', name: 'Laptop 14in 16GB', qty: 1, price: 899.0 },
          { sku: 'SKU-WATCH', name: 'Smartwatch Series 8', qty: 1, price: 249.0 },
          { sku: 'SKU-MOUSE', name: 'Wireless Mouse', qty: 1, price: 45.0 },
          { sku: 'SKU-LAMP', name: 'Smart Lamp Duo', qty: 1, price: 39.0 },
        ],
      });
      o.priorOrders = 0;
      o.total = 1232.0;
      o.items = o.items.map((it) => ({ ...it }));
      highlights.bigRefundOrderId = o.id;
      orders.push(o);
    } else {
      orders.push(mkOrder({ items: someItems(420), priorChargebacks: 0 }));
    }
  }
  // Fix the big-refund order total to the exact sum of its items (source of truth = items).
  const big = orders.find((o) => o.id === highlights.bigRefundOrderId)!;
  big.total = Math.round(big.items.reduce((s, i) => s + i.qty * i.price, 0) * 100) / 100;

  // --- Remaining orders to 300: mostly clean, with planted patterns sprinkled in. ---
  while (orders.length < 300) {
    const i = orders.length;
    const o = mkOrder({ items: someItems(650) });
    if (i % 23 === 0) o.shippingCity = CITIES.find((c) => c !== o.billingCity) ?? 'Medan'; // R2
    if (i % 31 === 0) o.priorChargebacks = 1; // R4
    if (i % 41 === 0) {
      o.priorOrders = 0;
      o.items = [{ sku: 'SKU-LAP14', name: 'Laptop 14in 16GB', qty: 1, price: 899.0 }, { sku: 'SKU-HDPX', name: 'Noise-Cancel Headphones', qty: 1, price: 129.0 }];
      o.total = 1028.0;
    } // R3
    if (i % 37 === 0) o.deviceId = 'DEV-BURST'; // recurring burst device -> R1 hits accumulate
    orders.push(o);
  }

  const byId = new Map(orders.map((o) => [o.id, o]));
  const refundRequests: RefundRequest[] = [
    {
      id: 'REQ-501',
      orderId: highlights.refundOrderId,
      amount: byId.get(highlights.refundOrderId)!.total,
      reason: 'Customer reports the SSD was dead on arrival; asks for a refund instead of a replacement.',
      channel: 'email',
    },
    {
      id: 'REQ-502',
      orderId: highlights.bigRefundOrderId,
      amount: byId.get(highlights.bigRefundOrderId)!.total,
      reason: 'Customer says the laptop was ordered twice by mistake and asks to refund the full order.',
      channel: 'chat',
    },
  ];
  // Ten more requests against ordinary orders (documented in the data file; the demo injects REQ-501/502).
  let n = 503;
  for (const o of orders.slice(30, 90)) {
    if (refundRequests.length >= 12) break;
    if (o.id === highlights.strongFlagOrderId) continue;
    refundRequests.push({
      id: `REQ-${n++}`,
      orderId: o.id,
      amount: o.total,
      reason: 'Customer refund request (synthetic).',
      channel: pick(['email', 'chat', 'phone']),
    });
  }

  return { orders, refundRequests, highlights, demoOrderIds: orders.slice(0, 26).map((o) => o.id) };
}

/**
 * The fraud rule engine. Every hit cites its source: order fields and,
 * for velocity, the exact prior order ids counted. `prior` = orders that
 * arrived before this one (the room's shared order book).
 */
export function scoreOrder(order: Order, prior: Order[]): RuleHit[] {
  const hits: RuleHit[] = [];

  const windowStart = new Date(order.ts).getTime() - 10 * 60 * 1000;
  const sameDevice = prior.filter(
    (o) => o.deviceId === order.deviceId && new Date(o.ts).getTime() >= windowStart,
  );
  if (sameDevice.length + 1 >= 4) {
    hits.push({
      ruleId: 'R1',
      detail: `${sameDevice.length + 1} orders from device ${order.deviceId} within 10 min: ${[...sameDevice.map((o) => o.id), order.id].join(', ')}`,
    });
  }

  if (order.billingCity !== order.shippingCity) {
    hits.push({
      ruleId: 'R2',
      detail: `billing city ${order.billingCity} != shipping city ${order.shippingCity} (order ${order.id})`,
    });
  }

  if (order.total > 900 && order.priorOrders === 0) {
    hits.push({
      ruleId: 'R3',
      detail: `total $${order.total.toFixed(2)} > $900 with priorOrders=0 (order ${order.id}, customer ${order.customerId})`,
    });
  }

  if (order.priorChargebacks >= 1) {
    hits.push({
      ruleId: 'R4',
      detail: `priorChargebacks=${order.priorChargebacks} (order ${order.id}, customer ${order.customerId})`,
    });
  }

  return hits;
}

/** Auditor's independent verification standard — applied to source data, not to the flagger's word. */
export function auditVerdict(hits: RuleHit[]): { pass: boolean; missing: string } {
  const hard = hits.some((h) => h.ruleId === 'R3' || h.ruleId === 'R4');
  if (hits.length >= 2 || hard) return { pass: true, missing: '' };
  if (hits.length === 1) {
    return {
      pass: false,
      missing: `only one weak signal (${hits[0].ruleId}) and no corroborating evidence — a second independent source is required`,
    };
  }
  return { pass: false, missing: 'no rule hits to verify' };
}

export function writeDataFiles(dir: string, ds: Dataset): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'orders.json'), JSON.stringify(ds.orders, null, 2));
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(RULES, null, 2));
  writeFileSync(join(dir, 'refund_requests.json'), JSON.stringify(ds.refundRequests, null, 2));
}
