import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { KodiRpcError, KodiTimeoutError, KodiUnavailableError } from './kodi.errors.js';
import type {
  KodiClientEvents,
  KodiClientOptions,
  KodiConnectionState,
  KodiNotification,
} from './kodi.types.js';

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULTS = {
  requestTimeoutMs: 5_000,
  reconnectInitialDelayMs: 500,
  reconnectMaxDelayMs: 10_000,
  unreachableAfterFailures: 3,
};

/**
 * JSON-RPC 2.0 client for Kodi's WebSocket endpoint. Matches responses to requests by id,
 * times requests out, reconnects with exponential backoff and re-emits notifications.
 * It knows nothing about Kodi methods; see `KodiCommands` for the fixed command set.
 */
export class KodiClient extends EventEmitter {
  private readonly options: Required<KodiClientOptions>;
  private socket: WebSocket | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private failures = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private running = false;
  private _state: KodiConnectionState = 'unreachable';

  constructor(options: KodiClientOptions) {
    super();
    this.options = { ...DEFAULTS, ...options };
  }

  get state(): KodiConnectionState {
    return this._state;
  }

  override on<E extends keyof KodiClientEvents>(event: E, listener: KodiClientEvents[E]): this {
    return super.on(event, listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.setState('reconnecting');
    this.connect();
  }

  /** Stops reconnecting, closes the socket and rejects in-flight requests. */
  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.on('error', () => undefined); // terminate() on a connecting socket emits 'error'
    socket?.terminate();
    this.rejectAll(new KodiUnavailableError('Kodi client stopped'));
    this.setState('unreachable');
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const socket = this.socket;
    if (this._state !== 'connected' || socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new KodiUnavailableError(`Kodi is ${this._state}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KodiTimeoutError(method, this.options.requestTimeoutMs));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      const body = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
      socket.send(JSON.stringify(body), (err) => {
        if (!err) return;
        this.settle(id)?.reject(new KodiUnavailableError(`Send failed: ${err.message}`));
      });
    });
  }

  private connect(): void {
    if (!this.running) return;
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.on('open', () => {
      this.failures = 0;
      this.setState('connected');
    });
    socket.on('message', (data) => this.onMessage(data.toString()));
    // 'error' is always followed by 'close'; handling it here only prevents an unhandled event.
    socket.on('error', () => undefined);
    socket.on('close', () => this.onClose(socket));
  }

  private onClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    const wasConnected = this._state === 'connected';
    this.rejectAll(new KodiUnavailableError('Connection to Kodi closed'));
    if (!this.running) return;
    this.failures = wasConnected ? 0 : this.failures + 1;
    this.setState(
      this.failures >= this.options.unreachableAfterFailures ? 'unreachable' : 'reconnecting',
    );
    const delay = Math.min(
      this.options.reconnectInitialDelayMs * 2 ** this.failures,
      this.options.reconnectMaxDelayMs,
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      return; // not JSON: ignore rather than crash on a misbehaving peer
    }
    if (typeof msg.id === 'number') {
      const pending = this.settle(msg.id);
      if (!pending) return; // late answer to a request that already timed out
      if (msg.error) {
        pending.reject(new KodiRpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const notification: KodiNotification = { method: msg.method, params: msg.params };
      this.emit('notification', notification);
    }
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private rejectAll(reason: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(reason);
  }

  private setState(state: KodiConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }
}
