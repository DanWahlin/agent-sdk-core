import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import WebSocket from 'ws';
import { createWSServer, broadcast } from '../src/ws/server.ts';

describe('WS security: origin validation', () => {
  it('should reject connections from disallowed origins', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    const { wss, cleanup } = createWSServer({
      server: httpServer,
      path: '/ws',
      allowedOrigins: ['http://localhost:4175'],
    });

    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: { origin: 'http://evil.example.com' },
    });

    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('connected'));
      ws.on('error', () => resolve('rejected'));
      ws.on('unexpected-response', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });

    assert.equal(result, 'rejected');
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    httpServer.close();
  });

  it('should accept connections from allowed origins', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    const { wss, cleanup } = createWSServer({
      server: httpServer,
      path: '/ws',
      allowedOrigins: ['http://localhost:4175'],
    });

    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: { origin: 'http://localhost:4175' },
    });

    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => { resolve('connected'); ws.close(); });
      ws.on('error', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });

    assert.equal(result, 'connected');
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    httpServer.close();
  });

  it('should accept all origins when allowedOrigins is not set', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    const { wss, cleanup } = createWSServer({ server: httpServer, path: '/ws' });

    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: { origin: 'http://any-origin.example.com' },
    });

    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => { resolve('connected'); ws.close(); });
      ws.on('error', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });

    assert.equal(result, 'connected');
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    httpServer.close();
  });
});

describe('WS security: connection limits', () => {
  it('should reject connections when limit is reached', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    const { wss, cleanup } = createWSServer({
      server: httpServer,
      path: '/ws',
      maxConnections: 2,
    });

    const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
    const ws2 = new WebSocket(`ws://localhost:${port}/ws`);
    await Promise.all([
      new Promise<void>(r => ws1.on('open', r)),
      new Promise<void>(r => ws2.on('open', r)),
    ]);

    // Third connection should be rejected
    const ws3 = new WebSocket(`ws://localhost:${port}/ws`);
    const result = await new Promise<string>((resolve) => {
      ws3.on('close', (code) => resolve(`closed:${code}`));
      ws3.on('open', () => {
        // Might briefly open before server closes it
        ws3.on('close', (code) => resolve(`closed:${code}`));
      });
      setTimeout(() => resolve('timeout'), 3000);
    });

    assert.ok(result.startsWith('closed:'), `Expected close, got: ${result}`);

    ws1.close();
    ws2.close();
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    httpServer.close();
  });
});

describe('WS security: prototype pollution', () => {
  it('should strip __proto__ from parsed messages', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as any).port;

    let received: any = null;
    const { wss, cleanup } = createWSServer({
      server: httpServer,
      path: '/ws',
      onMessage: (_ws, data) => { received = data; },
    });

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>(r => ws.on('open', r));

    // Send raw JSON string with __proto__ (JSON.stringify would strip it)
    ws.send('{"type":"test","__proto__":{"isAdmin":true},"data":{"nested":true,"__proto__":{"evil":true}}}');

    await new Promise(r => setTimeout(r, 100));

    assert.ok(received);
    assert.equal(received.type, 'test');
    assert.equal(received.__proto__?.isAdmin, undefined);
    assert.equal(received.data?.nested, true);
    assert.equal(received.data?.__proto__?.evil, undefined);
    // Global prototype not polluted
    assert.equal(({} as any).isAdmin, undefined);
    assert.equal(({} as any).evil, undefined);

    ws.close();
    await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    httpServer.close();
  });
});

describe('WS security: broadcast size limit', () => {
  it('should reject oversized broadcast messages', async () => {
    const httpServer = createServer();
    await new Promise<void>(r => httpServer.listen(0, r));

    const { wss, cleanup } = createWSServer({ server: httpServer, path: '/ws' });

    const ws = new WebSocket(`ws://localhost:${(httpServer.address() as any).port}/ws`);
    await new Promise<void>(r => ws.on('open', r));

    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));

    // Normal message should be received
    broadcast(wss, { type: 'small', payload: 'hello' });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(messages.length, 1);

    // Oversized message (>1MB) should be dropped
    const huge = 'x'.repeat(2 * 1024 * 1024);
    broadcast(wss, { type: 'huge', payload: huge });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(messages.length, 1); // Still 1 — oversized was dropped

    ws.close();
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    httpServer.close();
  });
});
