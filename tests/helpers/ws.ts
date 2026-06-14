import { createServer } from 'http';
import WebSocket from 'ws';
import { createWSServer } from '../../src/ws/server.ts';

export type TestWSServer = Awaited<ReturnType<typeof createTestWSServer>>;

export async function createTestWSServer(options: Omit<Parameters<typeof createWSServer>[0], 'server' | 'path'> = {}) {
  const httpServer = createServer();
  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const { wss, cleanup } = createWSServer({ server: httpServer, path: '/ws', ...options });
  const port = (httpServer.address() as { port: number }).port;

  return {
    wss,
    url: `ws://localhost:${port}/ws`,
    async close(): Promise<void> {
      cleanup();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
  };
}

export async function connectForResult(
  url: string,
  headers?: Record<string, string>,
  closeOnOpen = true,
): Promise<string> {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  let opened = false;
  return new Promise<string>(resolve => {
    ws.on('open', () => {
      opened = true;
      if (closeOnOpen) {
        resolve('connected');
        ws.close();
      }
    });
    ws.on('close', code => resolve(opened && closeOnOpen ? 'connected' : `closed:${code}`));
    ws.on('error', () => resolve('rejected'));
    ws.on('unexpected-response', () => resolve('rejected'));
    setTimeout(() => resolve(ws.readyState === WebSocket.OPEN ? 'connected' : 'timeout'), 3000);
  });
}

export async function waitForOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>(resolve => ws.on('open', resolve));
}

export async function settleWebSockets(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50));
}
