export type WSClientMessageHandler = (msg: { type: string; payload: unknown }) => void;

export interface WSClientOptions {
  /** WebSocket URL (e.g., 'ws://localhost:3001/ws') */
  url: string;
  /** Max reconnection attempts (default: 10, 0 = unlimited) */
  maxAttempts?: number;
  /** Max backoff delay in ms (default: 30000) */
  maxBackoffMs?: number;
  /** Max queued messages while disconnected (default: 10) */
  maxQueueSize?: number;
}

/**
 * WebSocket client with exponential backoff reconnection,
 * message queue for offline buffering, and listener-based pub/sub.
 *
 * Works in both browser (native WebSocket) and Node.js (ws package) environments.
 */
export class WSClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<WSClientMessageHandler>();
  private queue: string[] = [];
  private attempts = 0;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly url: string;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly maxQueueSize: number;

  constructor(options: WSClientOptions) {
    this.url = options.url;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.maxQueueSize = options.maxQueueSize ?? 10;
  }

  /**
   * Subscribe to messages. Returns an unsubscribe function.
   * Connects lazily on first subscriber.
   */
  subscribe(handler: WSClientMessageHandler): () => void {
    this.listeners.add(handler);
    this.ensureConnection();

    return () => {
      this.listeners.delete(handler);
      if (this.listeners.size === 0) {
        this.dispose();
      }
    };
  }

  /** Send a message, queuing if disconnected. */
  send(message: { type: string; payload?: unknown }): void {
    const data = JSON.stringify(message);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      if (this.queue.length >= this.maxQueueSize) {
        this.queue.shift();
      }
      this.queue.push(data);
    }
  }

  /** Close the connection and stop reconnecting. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.queue = [];
  }

  /** Whether the WebSocket is currently connected. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private ensureConnection(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.attempts = 0;
      this.flushQueue();
    };

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const raw = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
        if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return;
        // Prototype pollution protection
        if ('__proto__' in raw || 'constructor' in raw || 'prototype' in raw) return;
        this.listeners.forEach((fn) => fn(raw));
      } catch { /* ignore malformed */ }
    };

    this.ws.onclose = () => {
      if (!this.disposed && this.listeners.size > 0) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // Don't call ws.close() here — Node 22's native WebSocket fires
      // another error if close() is called during error handling.
      // The onclose handler will fire automatically after onerror.
    };
  }

  private scheduleReconnect(): void {
    if (this.maxAttempts > 0 && this.attempts >= this.maxAttempts) return;

    // Exponential backoff with jitter to prevent thundering herd
    const base = Math.min(1000 * Math.pow(2, this.attempts), this.maxBackoffMs);
    const jitter = base * (0.7 + Math.random() * 0.6);
    const delay = Math.min(jitter, this.maxBackoffMs);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private flushQueue(): void {
    while (this.queue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.queue.shift()!);
    }
  }
}
