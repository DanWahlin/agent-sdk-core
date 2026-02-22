import type { AgentEvent, AgentEventType } from '../types/events.js';
import { basename } from 'path';

/** Event kinds used by the aggregator for grouping. */
type ProgressKind = 'file_read' | 'file_write' | 'command' | 'command_output' | 'test_result' | 'thinking' | 'error' | 'complete';

/**
 * Batches AgentEvents over a time interval and produces human-readable
 * summaries suitable for TTS narration or status displays.
 *
 * Usage:
 *   const agg = new ProgressAggregator((summary, events) => speak(summary));
 *   // Feed events as they arrive:
 *   agg.push(event);
 *   // When done:
 *   agg.stop();
 */
export class ProgressAggregator {
  private buffer: AgentEvent[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private onSummary: (summary: string, events: AgentEvent[]) => void;
  private maxBufferSize: number;

  constructor(
    onSummary: (summary: string, events: AgentEvent[]) => void,
    intervalMs = 12_000,
    maxBufferSize = 1000,
  ) {
    this.onSummary = onSummary;
    this.maxBufferSize = maxBufferSize;
    this.interval = setInterval(() => this.flush(), intervalMs);
  }

  push(event: AgentEvent): void {
    this.buffer.push(event);
    // Prevent unbounded growth — flush early if buffer is full
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer.slice();
    this.buffer = [];
    const summary = this.summarize(events);
    if (summary) {
      this.onSummary(summary, events);
    }
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.flush();
  }

  private summarize(events: AgentEvent[]): string {
    const grouped = this.groupByKind(events);
    const parts: string[] = [];

    if (grouped.file_read.length === 1) {
      const file = grouped.file_read[0].metadata?.file;
      parts.push(file ? `Reading ${basename(file)}` : 'Reading file');
    } else if (grouped.file_read.length > 1) {
      parts.push(`Reading ${grouped.file_read.length} files`);
    }

    if (grouped.file_write.length === 1) {
      const file = grouped.file_write[0].metadata?.file;
      parts.push(file ? `Modified ${basename(file)}` : 'Modifying file');
    } else if (grouped.file_write.length > 1) {
      const withFiles = grouped.file_write.filter(e => e.metadata?.file);
      if (withFiles.length > 0) {
        const names = withFiles.slice(0, 3).map(e => basename(e.metadata!.file!)).join(', ');
        const suffix = grouped.file_write.length > 3 ? '...' : '';
        parts.push(`Modified ${grouped.file_write.length} files: ${names}${suffix}`);
      } else {
        parts.push(`Modifying ${grouped.file_write.length} files`);
      }
    }

    if (grouped.command.length > 0) {
      const latest = grouped.command[grouped.command.length - 1];
      const cmd = latest.metadata?.command || latest.content;
      const short = cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
      parts.push(`Running ${short}`);
    }

    const testResults = this.extractTestResults(grouped.command_output);
    if (testResults) {
      parts.push(testResults);
    }

    if (grouped.error.length > 0) {
      const latest = grouped.error[grouped.error.length - 1];
      const msg = latest.content.split('\n')[0];
      parts.push(`Error: ${msg.length > 50 ? msg.substring(0, 47) + '...' : msg}`);
    }

    if (grouped.complete.length > 0) {
      const doneParts = ['Finished'];
      if (grouped.file_write.length > 0) {
        const n = grouped.file_write.length;
        doneParts.push(`${n} file${n !== 1 ? 's' : ''} modified`);
      }
      if (testResults) {
        doneParts.push(testResults.toLowerCase());
      }
      return doneParts.join('. ') + '.';
    }

    return parts.join(', ');
  }

  private groupByKind(events: AgentEvent[]): Record<ProgressKind, AgentEvent[]> {
    const grouped: Record<ProgressKind, AgentEvent[]> = {
      file_read: [], file_write: [], command: [], command_output: [],
      test_result: [], thinking: [], error: [], complete: [],
    };
    for (const event of events) {
      const kind = this.mapToProgressKind(event.type);
      if (kind) grouped[kind].push(event);
    }
    return grouped;
  }

  private mapToProgressKind(type: AgentEventType): ProgressKind | null {
    switch (type) {
      case 'file_read': return 'file_read';
      case 'file_write': case 'file_edit': return 'file_write';
      case 'command': case 'tool_call': return 'command';
      case 'command_output': case 'output': return 'command_output';
      case 'test_result': return 'test_result';
      case 'thinking': return 'thinking';
      case 'error': return 'error';
      case 'complete': return 'complete';
      default: return null;
    }
  }

  private extractTestResults(outputs: AgentEvent[]): string | null {
    for (const output of outputs) {
      // Truncate to prevent ReDoS on large command output
      const text = output.content.length > 10_000 ? output.content.substring(0, 10_000) : output.content;

      // Jest-style: "Tests: X passed, Y total"
      let match = text.match(/Tests?:\s*(\d+)\s*passed.*?(\d+)\s*total/i);
      if (match) {
        const [, passed, total] = match;
        if (passed === total) return `All ${total} tests passing`;
        const failing = parseInt(total) - parseInt(passed);
        return `${failing} test${failing !== 1 ? 's' : ''} failing`;
      }

      // Mocha-style: "X passing", "Y failing"
      match = text.match(/(\d+)\s*passing/i);
      const failMatch = text.match(/(\d+)\s*failing/i);
      if (match) {
        const passing = parseInt(match[1]);
        if (failMatch) {
          const failing = parseInt(failMatch[1]);
          return `${failing} test${failing !== 1 ? 's' : ''} failing`;
        }
        return `${passing} test${passing !== 1 ? 's' : ''} passing`;
      }

      if (/\bPASS\b/.test(text) && !/\bFAIL/.test(text)) return 'Tests passing';
      if (/\bFAIL/.test(text)) return 'Tests failing';
    }
    return null;
  }
}
