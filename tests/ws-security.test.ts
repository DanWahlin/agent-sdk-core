import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { broadcast } from '../src/ws/server.ts';
import { connectForResult, createTestWSServer, settleWebSockets, waitForOpen } from './helpers/ws.ts';

describe('WS security: origin validation', () => {
  it('should reject connections from disallowed origins', async () => {
    const server = await createTestWSServer({ allowedOrigins: ['http://localhost:4175'] });
    try {
      const result = await connectForResult(server.url, { origin: 'http://evil.example.com' });
      assert.equal(result, 'rejected');
    } finally {
      await settleWebSockets();
      await server.close();
    }
  });

  it('should accept connections from allowed origins', async () => {
    const server = await createTestWSServer({ allowedOrigins: ['http://localhost:4175'] });
    try {
      const result = await connectForResult(server.url, { origin: 'http://localhost:4175' });
      assert.equal(result, 'connected');
    } finally {
      await settleWebSockets();
      await server.close();
    }
  });

  it('should accept all origins when allowedOrigins is not set', async () => {
    const server = await createTestWSServer();
    try {
      const result = await connectForResult(server.url, { origin: 'http://any-origin.example.com' });
      assert.equal(result, 'connected');
    } finally {
      await settleWebSockets();
      await server.close();
    }
  });
});

describe('WS security: connection limits', () => {
  it('should reject connections when limit is reached', async () => {
    const server = await createTestWSServer({ maxConnections: 2 });
    const ws1 = new WebSocket(server.url);
    const ws2 = new WebSocket(server.url);
    try {
      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);
      const result = await connectForResult(server.url, undefined, false);
      assert.ok(result.startsWith('closed:'), `Expected close, got: ${result}`);
    } finally {
      ws1.close();
      ws2.close();
      await settleWebSockets();
      await server.close();
    }
  });
});

describe('WS security: prototype pollution', () => {
  it('should strip __proto__ from parsed messages', async () => {
    let received: any = null;
    const server = await createTestWSServer({
      onMessage: (_ws, data) => { received = data; },
    });
    const ws = new WebSocket(server.url);
    try {
      await waitForOpen(ws);

      // Send raw JSON string with __proto__ (JSON.stringify would strip it).
      ws.send('{"type":"test","__proto__":{"isAdmin":true},"data":{"nested":true,"__proto__":{"evil":true}}}');
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.ok(received);
      assert.equal(received.type, 'test');
      assert.equal(received.__proto__?.isAdmin, undefined);
      assert.equal(received.data?.nested, true);
      assert.equal(received.data?.__proto__?.evil, undefined);
      assert.equal(({} as any).isAdmin, undefined);
      assert.equal(({} as any).evil, undefined);
    } finally {
      ws.close();
      await settleWebSockets();
      await server.close();
    }
  });
});

describe('WS security: broadcast size limit', () => {
  it('should reject oversized broadcast messages', async () => {
    const server = await createTestWSServer();
    const ws = new WebSocket(server.url);
    try {
      await waitForOpen(ws);
      const messages: string[] = [];
      ws.on('message', data => messages.push(data.toString()));

      broadcast(server.wss, { type: 'small', payload: 'hello' });
      await settleWebSockets();
      assert.equal(messages.length, 1);

      const huge = 'x'.repeat(2 * 1024 * 1024);
      broadcast(server.wss, { type: 'huge', payload: huge });
      await settleWebSockets();
      assert.equal(messages.length, 1);
    } finally {
      ws.close();
      await settleWebSockets();
      await server.close();
    }
  });
});
