import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WSClient } from '../src/ws/client.ts';

// WSClient uses global WebSocket (available in Node 21+, all modern browsers)
const hasGlobalWebSocket = typeof globalThis.WebSocket !== 'undefined';

describe('WSClient', { skip: !hasGlobalWebSocket && 'No global WebSocket (Node < 21)' }, () => {
  it('should construct with default options', () => {
    const client = new WSClient({ url: 'ws://localhost:9999/ws' });
    assert.equal(client.connected, false);
    client.dispose();
  });

  it('should accept custom options', () => {
    const client = new WSClient({
      url: 'ws://localhost:9999/ws',
      maxAttempts: 5,
      maxBackoffMs: 10_000,
      maxQueueSize: 20,
    });
    assert.equal(client.connected, false);
    client.dispose();
  });

  it('should queue messages when not connected', () => {
    const client = new WSClient({
      url: 'ws://localhost:9999/ws',
      maxQueueSize: 3,
    });
    // These should be queued, not throw
    client.send({ type: 'test', payload: 'msg1' });
    client.send({ type: 'test', payload: 'msg2' });
    client.send({ type: 'test', payload: 'msg3' });
    // Fourth should evict oldest (FIFO)
    client.send({ type: 'test', payload: 'msg4' });
    client.dispose();
  });

  it('should return unsubscribe from subscribe', () => {
    const client = new WSClient({ url: 'ws://localhost:9999/ws' });
    const unsub = client.subscribe(() => {});
    assert.equal(typeof unsub, 'function');
    unsub();
    client.dispose();
  });

  it('should clean up on dispose', () => {
    const client = new WSClient({ url: 'ws://localhost:9999/ws' });
    client.subscribe(() => {});
    client.dispose();
    assert.equal(client.connected, false);
  });
});
