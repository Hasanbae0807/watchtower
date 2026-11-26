import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Room, TapEvent } from './agents.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One-port web console (SSE). The console is a second frontend over the same
 * Mozaik bus: the Scribe's tap streams every domain event to browsers, and
 * the escalation cards POST human decisions back into the room.
 */
export function startConsole(room: Room, port: number): { broadcast: (e: TapEvent) => void } {
  const clients = new Set<ServerResponse>();
  const backlog: TapEvent[] = [];

  const broadcast = (e: TapEvent) => {
    backlog.push(e);
    if (backlog.length > 500) backlog.shift();
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(data);
  };

  const html = readFileSync(join(here, '..', 'web', 'index.html'), 'utf8');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const e of backlog) res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/state') {
      const s = room.state;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          balance: s.balance,
          ledger: s.ledger,
          counters: s.counters,
          guardLog: s.guardLog,
          proposals: [...s.proposals.values()],
          flags: [...s.flags.values()],
          orders: [...s.orderBook.values()].map((o) => ({ id: o.id, status: o.status, total: o.total, customerName: o.customerName })),
        }),
      );
      return;
    }
    if (req.url === '/decide' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      req.on('end', () => {
        try {
          const { orderId, approved } = JSON.parse(body);
          room.decide(String(orderId), Boolean(approved));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  server.listen(port, () => {
    console.log(`Web console: http://localhost:${port}`);
  });

  return { broadcast };
}
