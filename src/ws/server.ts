import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { WSMessage } from '../types/messages.js';
import { sanitizeJson } from './sanitize.js';

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
}

/** Maximum broadcast message size (1MB) */
const MAX_BROADCAST_SIZE = 1 * 1024 * 1024;

export interface WSServerOptions {
  /** Attach to an existing HTTP server (mutually exclusive with port) */
  server?: Server;
  /** Listen on a standalone port (mutually exclusive with server) */
  port?: number;
  /** WebSocket path (default: '/ws') */
  path?: string;
  /** Max payload size in bytes (default: 10MB) */
  maxPayload?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
  /** Maximum concurrent connections (default: 100, 0 = unlimited) */
  maxConnections?: number;
  /** Allowed origins for CORS validation (default: accept all — set this in production!) */
  allowedOrigins?: string[];
  /** Custom connection verifier for authentication (return false to reject) */
  verifyClient?: (request: IncomingMessage) => boolean;
  /** Called when a client connects */
  onConnection?: (ws: WebSocket) => void;
  /** Called when a client sends a message */
  onMessage?: (ws: WebSocket, data: unknown) => void;
}

/**
 * Start heartbeat ping/pong on an existing WebSocketServer.
 * Returns a cleanup function that clears the interval.
 */
export function createHeartbeat(wss: WebSocketServer, intervalMs = 30_000): () => void {
  const interval = setInterval(() => {
    wss.clients.forEach((rawWs) => {
      const ws = rawWs as AliveWebSocket;
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, intervalMs);

  wss.on('connection', (rawWs) => {
    const ws = rawWs as AliveWebSocket;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  return () => clearInterval(interval);
}

/**
 * Broadcast a WSMessage to all connected clients in OPEN state.
 * Messages exceeding 1MB are rejected with a warning.
 */
export function broadcast<T>(wss: WebSocketServer, message: WSMessage<T>): void {
  const data = JSON.stringify(message);
  if (data.length > MAX_BROADCAST_SIZE) {
    console.warn(`[ws-server] broadcast message too large (${(data.length / 1024).toFixed(0)}KB), skipping`);
    return;
  }
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

/**
 * Create a WebSocketServer with heartbeat, connection tracking, and optional message routing.
 * Returns the WebSocketServer instance and a cleanup function.
 */
export function createWSServer(options: WSServerOptions): { wss: WebSocketServer; cleanup: () => void } {
  const {
    server,
    port,
    path = '/ws',
    maxPayload = 10 * 1024 * 1024,
    heartbeatInterval = 30_000,
    maxConnections = 100,
    allowedOrigins,
    verifyClient,
    onConnection,
    onMessage,
  } = options;

  const wssOptions: Record<string, unknown> = { path, maxPayload };
  if (server) {
    wssOptions.server = server;
  } else if (port) {
    wssOptions.port = port;
  }

  // Origin and auth verification
  if (allowedOrigins || verifyClient) {
    wssOptions.verifyClient = (info: { origin: string; req: IncomingMessage }) => {
      if (allowedOrigins && allowedOrigins.length > 0) {
        if (!allowedOrigins.includes(info.origin)) {
          console.warn(`[ws-server] rejected connection from origin: ${info.origin}`);
          return false;
        }
      }
      if (verifyClient && !verifyClient(info.req)) {
        console.warn('[ws-server] rejected connection by verifyClient');
        return false;
      }
      return true;
    };
  }

  const wss = new WebSocketServer(wssOptions as ConstructorParameters<typeof WebSocketServer>[0]);

  const cleanupHeartbeat = createHeartbeat(wss, heartbeatInterval);

  wss.on('connection', (ws) => {
    // Connection limit
    if (maxConnections > 0 && wss.clients.size > maxConnections) {
      console.warn(`[ws-server] connection limit reached (${maxConnections}), rejecting`);
      ws.close(1013, 'Max connections reached');
      return;
    }

    onConnection?.(ws);

    ws.on('message', (raw) => {
      if (!onMessage) return;
      try {
        const parsed = sanitizeJson(JSON.parse(String(raw)));
        onMessage(ws, parsed);
      } catch { /* ignore malformed */ }
    });

    ws.on('error', (err) => {
      console.error('[ws-server] client error:', err.message);
    });
  });

  const cleanup = () => {
    cleanupHeartbeat();
    wss.close();
  };

  return { wss, cleanup };
}
