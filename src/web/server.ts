import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Store } from '../store';
import type { Daemon } from '../daemon';
import { AgentRegistry } from '../agents';
import { SqliteMailbox } from '../mailbox';
import { readLog } from '../turns/log';
import { storedError } from '../store/errors';
import { recoveryReport } from '../boot/report';
import { schemas, type Kind, type RecordEntry } from '../workspace/records';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const kinds: Kind[] = ['task', 'routine', 'connector', 'approval', 'memory', 'skill'];
const configSchema = z.object({
  cwd: z.string().min(1).nullable().optional(), model: z.string().min(1).nullable().optional(), instructions: z.string().max(6500).optional(),
  promptProfile: z.enum(['minimal', 'coding', 'full']).optional(), paused: z.boolean().optional(),
  dailyTokens: z.number().int().min(0).nullable().optional(), dailyUsd: z.number().min(0).nullable().optional(),
  permissions: z.object({ sandbox: z.enum(['read-only', 'workspace-write']).optional(), approvalPolicy: z.enum(['on-request', 'never']).optional(), writableRoots: z.array(z.string().min(1)).max(20).optional() }).strict().optional(),
  browser: z.object({ enabled: z.boolean(), permission: z.enum(['ask', 'allow']) }).strict().optional(),
}).strict();
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };

/** Loopback-only operator API. No cross-origin access or unauthenticated agent actions. */
export function createWebServer(options: { store: Store; daemon: Daemon; port?: number }) {
  const { store, daemon } = options, workspace = daemon.workspace;
  if (daemon.connectionsEnabled) daemon.connections.start();
  const agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store);
  const token = randomBytes(32).toString('hex');
  const assets = new Map([
    ['/navigation.css', { body: readFileSync(new URL('./public/navigation.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
    ['/work.js', { body: readFileSync(new URL('./public/work.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
    ['/work.css', { body: readFileSync(new URL('./public/work.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
    ['/app.js', { body: readFileSync(new URL('./public/app.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
    ['/style.css', { body: readFileSync(new URL('./public/style.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
  ]);
  const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8').replace('__KRU_TOKEN__', token);
  const security = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: security });
  const requireAgent = (id: string) => { const a = agents.get(id); if (!a) throw new HttpError(404, 'Agent not found'); return a; };
  const requireRecord = (kind: Kind, id: string) => { const r = workspace.records.get(kind, id); if (!r) throw new HttpError(404, `${kind} not found`); return r; };
  const approvalView = (entry: RecordEntry<'approval'>) => ({ ...entry, laneId: store.db.query<{ lane_id: string | null }, [string, string | null]>('SELECT lane_id FROM deliveries WHERE batch_id=? AND recipient_id=? LIMIT 1').get(entry.data.executionId, entry.agentId)?.lane_id ?? null });
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const broadcast = (event: string, value: unknown) => {
    const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    for (const client of clients) { try { if ((client.desiredSize ?? 0) > 0) client.enqueue(frame); } catch { clients.delete(client); } }
  };
  const unsubscribe = workspace.onEvent(event => broadcast('turn', event));
  const unsubscribeStore = store.onChange(() => broadcast('change', {}));
  const unsubscribeConnections = daemon.connections.onChange(() => broadcast('change', {}));
  const heartbeat = setInterval(() => broadcast('change', {}), 5000); heartbeat.unref();

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 64 * 1024) throw new HttpError(413, 'Request is too large');
    try { return z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(bytes))); }
    catch { throw new HttpError(400, 'Expected a JSON object'); }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1', port: options.port ?? 4310, maxRequestBodySize: 64 * 1024, idleTimeout: 60, development: false,
    async fetch(request, server): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port || 80) !== server.port) throw new HttpError(403, 'Invalid host');
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin requests are not allowed');
        if (request.method === 'GET' && url.pathname === '/') return new Response(html, { headers: { ...security, 'Content-Type': 'text/html; charset=utf-8' } });
        if (request.method === 'GET' && url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers: security });
        const asset = assets.get(url.pathname);
        if (request.method === 'GET' && asset) return new Response(asset.body, { headers: { ...security, 'Content-Type': asset.type } });
        const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (path[0] !== 'api') throw new HttpError(404, 'Not found');
        if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed');
        // Webhooks authenticate using a per-routine token, never the operator token.
        if (request.method === 'POST' && path[1] === 'webhooks' && path.length === 3) {
          const supplied = request.headers.get('authorization')?.replace(/^Bearer /i, '');
          if (!supplied) throw new HttpError(401, 'Webhook bearer token required');
          const input = await body(request);
          try {
            return json(workspace.routines.trigger(path[2]!, { token: supplied, eventId: request.headers.get('idempotency-key') ?? '', payload: JSON.stringify(input) }), 202);
          } catch (error) { throw new HttpError(error instanceof Error && error.message === 'Invalid webhook token' ? 401 : 400, error instanceof Error ? error.message : 'Webhook rejected'); }
        }
        if (!equal(request.headers.get('x-kru-token') ?? '', token)) throw new HttpError(401, 'Open the KRU UI to authenticate');
        if (path[1] === 'work') {
          const work = workspace.work;
          work.importTasks();
          if (request.method === 'GET' && path.length === 2) return json({ projects: work.projects(), items: work.list() });
          if (path[2] === 'projects') {
            if (request.method === 'POST' && path.length === 3) return json(work.saveProject(await body(request)), 201);
            if (request.method === 'PATCH' && path.length === 4) return json(work.saveProject(await body(request), path[3]!));
          }
          if (path[2] === 'items') {
            if (request.method === 'POST' && path.length === 3) return json(work.create(await body(request)), 201);
            const id = path[3]!;
            if (request.method === 'GET' && path.length === 4) return json(work.detail(id));
            if (request.method === 'PATCH' && path.length === 4) {
              const { revision, ...input } = await body(request);
              return json(work.update(id, input, z.number().int().positive().parse(revision)));
            }
            if (request.method === 'POST' && path[4] === 'comments' && path.length === 5) {
              const input = z.object({ body: z.string().trim().min(1).max(12000) }).strict().parse(await body(request));
              const key = z.string().min(1).max(200).parse(request.headers.get('idempotency-key'));
              return json(work.comment(id, input.body, key), 201);
            }
            if (request.method === 'POST' && path.length === 5 && ['archive', 'restore', 'resume'].includes(path[4]!)) {
              const input = z.object({ revision: z.number().int().positive() }).strict().parse(await body(request));
              return json(path[4] === 'resume' ? work.resume(id, input.revision) : work.archive(id, input.revision, path[4] === 'restore'));
            }
          }
          throw new HttpError(404, 'Unknown work route');
        }
        if (path[1] === 'providers') {
          if (request.method === 'GET' && path.length === 2) return json({ providers: daemon.connections.snapshot() });
          const id = z.enum(['codex', 'claude']).parse(path[2]);
          if (request.method === 'POST' && path.length === 4) {
            if (path[3] === 'refresh') return json(await daemon.connections.refresh(id));
            if (path[3] === 'install' || path[3] === 'login') return json(await daemon.connections.begin(id, path[3]), 202);
            if (path[3] === 'cancel') { await daemon.connections.cancel(id); return json({ cancelled: true }); }
            if (path[3] === 'code') {
              const input = z.object({ code: z.string().trim().min(1).max(4096) }).strict().parse(await body(request));
              daemon.connections.submitCode(id, input.code); return json({ submitted: true });
            }
          }
          throw new HttpError(404, 'Unknown provider action');
        }
        if (request.method === 'GET' && path[1] === 'events' && path.length === 2) {
          if (clients.size >= 16) throw new HttpError(429, 'Too many event streams');
          server.timeout(request, 0);
          let controller: ReadableStreamDefaultController<Uint8Array>;
          const cleanup = () => { if (controller) clients.delete(controller); request.signal.removeEventListener('abort', abort); };
          const abort = () => { try { controller.close(); } catch {} cleanup(); };
          const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; clients.add(c); c.enqueue(encoder.encode('event: ready\ndata: {}\n\n')); request.signal.addEventListener('abort', abort, { once: true }); }, cancel: cleanup });
          return new Response(stream, { headers: { ...security, 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' } });
        }
        if (request.method === 'GET' && path[1] === 'state' && path.length === 2) {
          const allAgents = agents.list();
          return json({ agents: allAgents, providers: daemon.connections.snapshot(), lanes: daemon.scheduler.status(), activeTurns: daemon.scheduler.activeTurns,
            recovery: recoveryReport(store),
            records: Object.fromEntries(kinds.filter(kind => kind !== 'memory').map(kind => [kind, workspace.records.list(kind).slice(-500).map(entry => kind === 'routine' ? { ...entry, data: { ...entry.data, tokenHash: undefined } } : kind === 'approval' ? approvalView(entry as RecordEntry<'approval'>) : entry)])),
            browsers: Object.fromEntries(allAgents.map(agent => [agent.id, workspace.browser.status(agent.id)])),
            usage: store.db.query('SELECT agent_id AS agentId,sum(coalesce(input_total,0)+coalesce(output,0)) AS tokens,sum(cost_usd) AS usd,count(*) AS turns,sum(CASE WHEN complete=0 THEN 1 ELSE 0 END) AS incomplete FROM usage_records GROUP BY agent_id').all(),
            activity: store.db.query('SELECT id,agent_id,lane_key,provider,model,status,error,started_at,duration_ms FROM turns ORDER BY started_at DESC LIMIT 100').all(),
          });
        }
        if (path[1] === 'agents') {
          if (request.method === 'POST' && path.length === 2) {
            const input = z.object({ name: z.string().trim().min(1).max(80), provider: z.enum(['fake', 'codex', 'claude']), config: configSchema.default({}) }).strict().parse(await body(request));
            return json(agents.create({ ...input, config: Object.fromEntries(Object.entries(input.config).filter(([, value]) => value !== null)) }), 201);
          }
          const agent = requireAgent(path[2] ?? '');
          if (request.method === 'PATCH' && path.length === 3) {
            const input = z.object({ provider: z.enum(['fake', 'codex', 'claude']).optional(), config: configSchema.optional() }).strict().parse(await body(request));
            const updated = agents.update(agent.id, { ...(input.provider ? { provider: input.provider } : {}), ...(input.config ? { config: input.config } : {}) });
            if (input.config?.browser?.enabled === false) await workspace.browser.stop(agent.id);
            return json(updated);
          }
          if (request.method === 'POST' && path[3] === 'messages' && path.length === 4) {
            const input = z.object({ text: z.string().trim().min(1).max(20000), laneId: z.string().max(200).nullable().optional() }).strict().parse(await body(request));
            return json(mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [agent.id], text: input.text, laneId: input.laneId ?? null, ...(request.headers.get('idempotency-key') ? { idempotencyKey: request.headers.get('idempotency-key')! } : {}) }), 202);
          }
          if (request.method === 'GET' && path[3] === 'messages' && path.length === 4) {
            const lane = url.searchParams.get('lane') || null;
            const entries = readLog(store, agent.id, lane, true).slice(-200);
            for (const [turnId, live] of workspace.live) if (live.agentId === agent.id && live.laneId === lane) for (const item of live.items.values()) {
              const id = `item:${turnId}:${item.id}`, old = entries.find(e => e.id === id);
              if (old) { old.text = item.text ?? null; old.details = item.details; }
              else entries.push({ id, agentId: agent.id, laneId: lane, role: item.type === 'agentMessage' ? 'assistant' : item.type, text: item.text ?? null, details: item.details, turnId, timestamp: new Date().toISOString(), partial: true });
            }
            const approvals = workspace.records.list('approval', agent.id).map(approvalView).filter(entry => entry.laneId === lane).slice(-200);
            return json({ entries, approvals, deliveries: mailbox.listQueue(agent.id, lane).slice(-100), lanes: store.db.query('SELECT DISTINCT lane_id AS id FROM deliveries WHERE recipient_id=?').all(agent.id) });
          }
          if (path[3] === 'browser') {
            if (request.method === 'GET' && path[4] === 'screenshot') return new Response(await workspace.browser.screenshot(agent.id), { headers: { ...security, 'Content-Type': 'image/png' } });
            if (request.method === 'POST' && path[4] === 'start') {
              if (!(agent.config.browser as { enabled?: boolean } | undefined)?.enabled) throw new HttpError(409, 'Enable browser access in agent settings');
              const input = z.object({ headed: z.boolean().default(false) }).strict().parse(await body(request));
              await workspace.browser.start(agent.id, input.headed); return json(workspace.browser.status(agent.id));
            }
            if (request.method === 'POST' && path[4] === 'stop') { await workspace.browser.stop(agent.id); return json({ stopped: true }); }
            if (request.method === 'POST' && path[4] === 'action') {
              if (!(agent.config.browser as { enabled?: boolean } | undefined)?.enabled) throw new HttpError(409, 'Browser access is disabled');
              return json(await workspace.browser.act(agent.id, await body(request), request.signal));
            }
          }
        }
        if (path[1] === 'records') {
          const kind = path[2] as Kind;
          if (!kinds.includes(kind)) throw new HttpError(404, 'Unknown record kind');
          if (request.method === 'POST' && path.length === 3) {
            if (kind === 'approval') throw new HttpError(405, 'Approvals originate from an active execution');
            const input = z.object({ agentId: z.string(), data: z.unknown() }).strict().parse(await body(request));
            const agent = requireAgent(input.agentId);
            if (kind === 'task') return json(workspace.tasks.create(agent.id, input.data), 201);
            if (kind === 'routine') return json(workspace.routines.save(agent.id, input.data), 201);
            return json(workspace.records.put(kind, agent.id, schemas[kind].parse(input.data)), 201);
          }
          const record = requireRecord(kind, path[3] ?? '');
          if (request.method === 'DELETE' && path.length === 4 && (kind === 'memory' || kind === 'skill')) {
            workspace.records.remove(kind, record.id); return json({ removed: true });
          }
          if (request.method === 'PATCH' && path.length === 4) {
            if (kind === 'approval' || kind === 'task') throw new HttpError(405, 'Use the task or approval action');
            const input = await body(request);
            const data = schemas[kind].parse({ ...record.data, ...input });
            if (kind === 'routine') return json(workspace.routines.save(record.agentId!, data, record.id));
            const saved = workspace.records.put(kind, record.agentId, data, record.id);
            if (kind === 'connector') await workspace.integrations.invalidate(record.id);
            return json(saved);
          }
          if (request.method === 'POST' && path.length === 5) {
            const action = path[4];
            if (kind === 'approval' && action === 'decide') {
              const input = z.object({ decision: z.enum(['accept', 'decline']) }).strict().parse(await body(request));
              return json(workspace.approvals.decide(record.id, input.decision));
            }
            if (kind === 'task' && action === 'resume') return json(workspace.tasks.resume(record.id));
            if (kind === 'task' && action === 'cancel') { const saved = workspace.tasks.cancel(record.id); daemon.scheduler.cancelLane(record.agentId!, `task:${record.id}`); return json(saved); }
            if (kind === 'routine' && action === 'run') return json(workspace.routines.trigger(record.id), 202);
            if (kind === 'routine' && action === 'token') return json({ token: workspace.routines.rotateToken(record.id), path: `/api/webhooks/${record.id}` });
            if (kind === 'connector' && action === 'tools') return json({ tools: await workspace.integrations.tools(record.id, record.agentId!) });
          }
        }
        if (path[1] === 'deliveries' && request.method === 'POST' && path.length === 4) {
          const delivery = mailbox.get(path[2]!); if (!delivery) throw new HttpError(404, 'Delivery not found');
          if (path[3] === 'retry') return json(mailbox.retry(delivery.id), 202);
          if (path[3] === 'cancel') {
            if (delivery.status === 'queued') mailbox.cancel(delivery.id);
            else if (['starting', 'running'].includes(delivery.status)) daemon.scheduler.cancelLane(delivery.recipientAgentId, delivery.laneId);
            else throw new HttpError(409, 'Delivery already ended');
            return json({ cancelled: true });
          }
        }
        throw new HttpError(404, 'Not found');
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 409;
        return json({ error: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : storedError(error instanceof Error ? error.message : 'Request failed') }, status);
      }
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, token,
    async close() { unsubscribe(); unsubscribeStore(); unsubscribeConnections(); clearInterval(heartbeat); for (const c of clients) { try { c.close(); } catch {} } clients.clear(); await server.stop(true); },
  };
}
