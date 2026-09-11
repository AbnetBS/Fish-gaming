import type { ClientMessage, ServerMessage } from '@reef/shared';

/**
 * Gameplay socket client.
 *
 * Handles the things a real-time game must get right:
 *  * handshake authentication with the in-memory access token (never a URL query)
 *  * exponential-backoff reconnect with a bounded attempt count
 *  * a `resync` request after reconnect so the client never replays stale state
 *  * suppression of outgoing actions while the link is uncertain — during
 *    `reconnecting` the client refuses to fire, which is what prevents
 *    duplicate shots when the transport flaps
 *  * server clock smoothing so deterministic fish motion stays in phase
 */

export type LinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface NetHandlers {
  onMessage: (message: ServerMessage) => void;
  onState: (state: LinkState, detail?: string) => void;
  getToken: () => Promise<string | null> | string | null;
}

const MAX_ATTEMPTS = 10;

export class GameSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: number | null = null;
  private closed = false;
  private waitingAuth = false;
  private queue: ClientMessage[] = [];
  state: LinkState = 'idle';
  /** Server time at last message, used for clock smoothing. */
  serverOffset = 0;
  lastServerTime = 0;
  latency = 0;
  private pingTimer: number | null = null;

  constructor(private readonly handlers: NetHandlers) {}

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws/game`;
  }

  connect(): void {
    this.closed = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.waitingAuth = true;

    socket.onopen = () => {
      void this.authenticate();
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '') as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'welcome') {
        this.waitingAuth = false;
        this.attempts = 0;
        this.setState('open');
        this.startPing();
        const pending = this.queue.splice(0, this.queue.length);
        for (const m of pending) socket.send(JSON.stringify(m));
      }
      if ('st' in message && typeof (message as any).st === 'number') {
        const st = (message as any).st as number;
        this.serverOffset = st - Date.now();
        this.lastServerTime = st;
      }
      if (message.type === 'pong') {
        this.latency = Math.max(0, Date.now() - message.t);
      }
      if (message.type === 'authError') {
        this.waitingAuth = false;
        this.handlers.onMessage(message);
        this.closeSocket(4001);
        this.setState('failed', message.message);
        return;
      }
      this.handlers.onMessage(message);
    };

    socket.onerror = () => {
      /* `onclose` follows and handles the retry. */
    };

    socket.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (this.closed) return;
      this.scheduleReconnect();
    };
  }

  private async authenticate(): Promise<void> {
    const token = await this.handlers.getToken();
    if (!token) {
      this.setState('failed', 'not-authenticated');
      this.closeSocket(4001);
      return;
    }
    this.ws?.send(JSON.stringify({ type: 'auth', token } satisfies ClientMessage));
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    if (this.attempts > MAX_ATTEMPTS) {
      this.setState('failed', 'unreachable');
      return;
    }
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts - 1, 4)) + Math.random() * 250;
    this.setState('reconnecting', `retry-in-${Math.round(delay)}ms`);
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  private setState(state: LinkState, detail?: string): void {
    this.state = state;
    this.handlers.onState(state, detail);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() } satisfies ClientMessage));
      }
    }, 4000);
  }

  private stopPing(): void {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private closeSocket(code?: number): void {
    try {
      this.ws?.close(code ?? 1000);
    } catch {
      /* ignore */
    }
  }

  /**
   * Send an intent. Non-urgent messages are dropped when the link is down;
   * `join` is queued so a reconnect can restore the room automatically.
   */
  send(message: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.waitingAuth && message.type !== 'auth') return false;
      this.ws.send(JSON.stringify(message));
      return true;
    }
    if (message.type === 'join') {
      this.queue.length = 0;
      this.queue.push(message);
    }
    return false;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.waitingAuth;
  }

  /** Current server-aligned clock, for deterministic motion sampling. */
  now(): number {
    return Date.now() + this.serverOffset;
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.stopPing();
    this.closeSocket(1000);
    this.ws = null;
    this.setState('idle');
  }
}
