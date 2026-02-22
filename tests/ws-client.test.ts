import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WSClient } from '../src/ws/client.ts';

describe('WSClient', () => {
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
    client.send({ type: 'test', payload: 'msg1' });
    client.send({ type: 'test', payload: 'msg2' });
    client.send({ type: 'test', payload: 'msg3' });
    client.send({ type: 'test', payload: 'msg4' });
    client.dispose();
  });

  it('should return unsubscribe from subscribe and clean up', async () => {
    const client = new WSClient({
      url: 'ws://localhost:9999/ws',
      maxAttempts: 1,
    });
    const unsub = client.subscribe(() => {});
    assert.equal(typeof unsub, 'function');
    // Dispose immediately to prevent reconnect attempts leaking
    client.dispose();
    assert.equal(client.connected, false);
    // Wait for any async cleanup
    await new Promise(r => setTimeout(r, 100));
  });
});
