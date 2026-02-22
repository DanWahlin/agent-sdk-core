import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import WebSocket from 'ws';
import { createWSServer, broadcast, createHeartbeat } from '../src/ws/server.ts';

describe('createWSServer', () => {
  it('should create a WebSocket server on an HTTP server', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    const { wss, cleanup } = createWSServer({ server: httpServer, path: '/ws' });
    assert.ok(wss);

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    assert.equal(ws.readyState, WebSocket.OPEN);

    ws.close();
    cleanup();
    httpServer.close();
  });

  it('should call onConnection when a client connects', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    let connected = false;
    const { wss, cleanup } = createWSServer({
      server: httpServer,
      path: '/ws',
      onConnection: () => { connected = true; },
    });

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>(r => ws.on('open', r));
    // Give the server a tick to process
    await new Promise(r => setTimeout(r, 50));
    assert.equal(connected, true);

    ws.close();
    cleanup();
    httpServer.close();
  });

  it('should call onMessage with parsed JSON', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    let received: unknown = null;
    const { wss, cleanup } = createWSServer({
      server: httpServer,
      path: '/ws',
      onMessage: (_ws, data) => { received = data; },
    });

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'test', payload: 'hello' }));
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(received, { type: 'test', payload: 'hello' });

    ws.close();
    cleanup();
    httpServer.close();
  });
});

describe('broadcast', () => {
  it('should send message to all connected clients', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    const { wss, cleanup } = createWSServer({ server: httpServer, path: '/ws' });

    const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
    const ws2 = new WebSocket(`ws://localhost:${port}/ws`);
    await Promise.all([
      new Promise<void>(r => ws1.on('open', r)),
      new Promise<void>(r => ws2.on('open', r)),
    ]);

    const messages1: string[] = [];
    const messages2: string[] = [];
    ws1.on('message', (d) => messages1.push(d.toString()));
    ws2.on('message', (d) => messages2.push(d.toString()));

    broadcast(wss, { type: 'test', payload: { data: 42 } });
    await new Promise(r => setTimeout(r, 100));

    assert.equal(messages1.length, 1);
    assert.equal(messages2.length, 1);
    assert.deepEqual(JSON.parse(messages1[0]), { type: 'test', payload: { data: 42 } });

    ws1.close();
    ws2.close();
    cleanup();
    httpServer.close();
  });

  it('should not fail with no connected clients', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));

    const { wss, cleanup } = createWSServer({ server: httpServer, path: '/ws' });

    // Should not throw
    broadcast(wss, { type: 'test', payload: null });

    cleanup();
    httpServer.close();
  });
});
