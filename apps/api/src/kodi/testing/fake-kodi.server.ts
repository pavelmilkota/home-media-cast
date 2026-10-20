import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

interface Introspect {
  methods: Record<string, { params: { name: string; required?: boolean }[] }>;
}

const INTROSPECT_PATH = new URL('../../../../../docs/kodi/introspect-21.3.json', import.meta.url);

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * A stand-in for Kodi's JSON-RPC WebSocket. Method names and required parameters are checked
 * against the Introspect recorded from the real Kodi 21.3, so a typo in the client fails here
 * the way it would fail against Kodi (-32601 / -32602).
 */
export class FakeKodiServer {
  private readonly introspect = JSON.parse(readFileSync(INTROSPECT_PATH, 'utf8')) as Introspect;
  private readonly handlers = new Map<string, Handler>();
  private server: WebSocketServer | undefined;
  private silent = false;
  /** Every request received, in order (including the ones answered with an error). */
  readonly requests: { method: string; params: unknown }[] = [];

  get port(): number {
    return (this.server?.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/jsonrpc`;
  }

  get connectionCount(): number {
    return this.server?.clients.size ?? 0;
  }

  /** Listens on `port` (0 = pick a free one). */
  async start(port = 0): Promise<void> {
    const server = new WebSocketServer({ host: '127.0.0.1', port });
    this.server = server;
    server.on('connection', (socket) => {
      socket.on('message', (data) => this.onMessage(socket, data.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }

  /** Answers `method` with a fixed `result`. */
  on(method: string, result: unknown): this {
    this.handlers.set(method, () => result);
    return this;
  }

  /** Answers `method` with whatever `handler` returns for the request params. */
  onCall(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  notify(method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const client of this.server?.clients ?? []) client.send(message);
  }

  /** Stops answering without closing the socket (a hung Kodi). */
  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  /** Drops every client connection but keeps listening (a Kodi restart's first half). */
  dropConnections(): void {
    for (const client of this.server?.clients ?? []) client.terminate();
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onMessage(socket: WebSocket, raw: string): void {
    const req = JSON.parse(raw) as { id: number; method: string; params?: unknown };
    this.requests.push({ method: req.method, params: req.params });
    if (this.silent) return;
    const reply = (body: object) =>
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));

    const spec = this.introspect.methods[req.method];
    if (!spec) return reply({ error: { code: -32601, message: 'Method not found.' } });
    const params = (req.params ?? {}) as Record<string, unknown>;
    const missing = spec.params.find((p) => p.required && !(p.name in params));
    if (missing) {
      return reply({
        error: { code: -32602, message: `Invalid params. Missing ${missing.name}` },
      });
    }
    const handler = this.handlers.get(req.method);
    if (!handler) return reply({ result: 'OK' });
    try {
      reply({ result: handler(params) });
    } catch (e) {
      reply({ error: { code: -32100, message: e instanceof Error ? e.message : 'failed' } });
    }
  }
}
