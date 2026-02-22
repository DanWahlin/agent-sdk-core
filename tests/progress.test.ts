import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressAggregator } from '../src/providers/progress.ts';
import type { AgentEvent } from '../src/types/events.ts';

function makeEvent(type: AgentEvent['type'], content: string, metadata?: AgentEvent['metadata']): AgentEvent {
  return { id: `test-${Date.now()}`, contextId: 'ctx', type, content, timestamp: Date.now(), metadata };
}

describe('ProgressAggregator', () => {
  it('should flush on stop()', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('file_read', 'Reading file', { file: '/src/app.ts' }));
    agg.stop();
    assert.ok(summary.includes('Reading'));
  });

  it('should not emit summary for empty buffer', () => {
    let called = false;
    const agg = new ProgressAggregator(() => { called = true; }, 60_000);
    agg.stop();
    assert.equal(called, false);
  });

  it('should handle single file_read', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('file_read', 'Read', { file: '/src/settings.ts' }));
    agg.stop();
    assert.equal(summary, 'Reading settings.ts');
  });

  it('should handle multiple file_reads', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('file_read', 'Read', { file: '/a.ts' }));
    agg.push(makeEvent('file_read', 'Read', { file: '/b.ts' }));
    agg.push(makeEvent('file_read', 'Read', { file: '/c.ts' }));
    agg.stop();
    assert.equal(summary, 'Reading 3 files');
  });

  it('should handle single file_write', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('file_write', 'Write', { file: '/src/app.tsx' }));
    agg.stop();
    assert.equal(summary, 'Modified app.tsx');
  });

  it('should handle multiple file_writes with basenames', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('file_write', 'Write', { file: '/a.ts' }));
    agg.push(makeEvent('file_write', 'Write', { file: '/b.ts' }));
    agg.stop();
    assert.ok(summary.includes('Modified 2 files'));
    assert.ok(summary.includes('a.ts'));
    assert.ok(summary.includes('b.ts'));
  });

  it('should truncate long file lists', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    for (let i = 0; i < 5; i++) {
      agg.push(makeEvent('file_write', 'Write', { file: `/file${i}.ts` }));
    }
    agg.stop();
    assert.ok(summary.includes('Modified 5 files'));
    assert.ok(summary.includes('...'));
  });

  it('should handle command events', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('command', 'Running npm test', { command: 'npm test' }));
    agg.stop();
    assert.ok(summary.includes('Running'));
  });

  it('should detect Jest test results in command_output', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('command_output', 'Tests: 5 passed, 5 total'));
    agg.stop();
    assert.equal(summary, 'All 5 tests passing');
  });

  it('should detect failing tests', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('command_output', 'Tests: 3 passed, 5 total'));
    agg.stop();
    assert.equal(summary, '2 tests failing');
  });

  it('should detect Mocha-style passing tests', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('command_output', '  8 passing (2s)'));
    agg.stop();
    assert.equal(summary, '8 tests passing');
  });

  it('should handle errors', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('error', 'Something went wrong'));
    agg.stop();
    assert.ok(summary.includes('Error:'));
    assert.ok(summary.includes('Something went wrong'));
  });

  it('should handle done/complete with comprehensive summary', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('file_write', 'Write', { file: '/a.ts' }));
    agg.push(makeEvent('file_write', 'Write', { file: '/b.ts' }));
    agg.push(makeEvent('command_output', 'Tests: 5 passed, 5 total'));
    agg.push(makeEvent('complete', 'Done'));
    agg.stop();
    assert.ok(summary.startsWith('Finished'));
    assert.ok(summary.includes('2 files modified'));
    assert.ok(summary.toLowerCase().includes('tests passing'));
  });

  it('should handle mixed events', () => {
    let summary = '';
    const agg = new ProgressAggregator((s) => { summary = s; }, 60_000);
    agg.push(makeEvent('file_read', 'Read', { file: '/src/index.ts' }));
    agg.push(makeEvent('command', 'npm install', { command: 'npm install' }));
    agg.push(makeEvent('file_write', 'Write', { file: '/package.json' }));
    agg.stop();
    assert.ok(summary.includes('Reading'));
    assert.ok(summary.includes('Running'));
    assert.ok(summary.includes('Modified'));
  });

  it('should batch events within interval window', async () => {
    let summaries: string[] = [];
    const agg = new ProgressAggregator((s) => { summaries.push(s); }, 200);
    agg.push(makeEvent('file_read', 'Read', { file: '/a.ts' }));
    await new Promise(r => setTimeout(r, 350));
    agg.push(makeEvent('file_write', 'Write', { file: '/b.ts' }));
    agg.stop();
    assert.equal(summaries.length, 2);
  });

  it('should pass events array to callback', () => {
    let receivedEvents: AgentEvent[] = [];
    const agg = new ProgressAggregator((_s, events) => { receivedEvents = events; }, 60_000);
    agg.push(makeEvent('file_read', 'Read', { file: '/a.ts' }));
    agg.push(makeEvent('file_write', 'Write', { file: '/b.ts' }));
    agg.stop();
    assert.equal(receivedEvents.length, 2);
    assert.equal(receivedEvents[0].type, 'file_read');
    assert.equal(receivedEvents[1].type, 'file_write');
  });
});
