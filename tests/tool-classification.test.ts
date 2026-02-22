import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolKind, getToolDisplayName } from '../src/providers/tool-classification.ts';

describe('classifyToolKind', () => {
  it('should return file_read for read-like tools', () => {
    assert.equal(classifyToolKind('Read'), 'file_read');
    assert.equal(classifyToolKind('View'), 'file_read');
    assert.equal(classifyToolKind('cat'), 'file_read');
    assert.equal(classifyToolKind('grep'), 'file_read');
  });

  it('should return file_write for write-like tools', () => {
    assert.equal(classifyToolKind('Write'), 'file_write');
    assert.equal(classifyToolKind('Edit'), 'file_write');
    assert.equal(classifyToolKind('MultiEdit'), 'file_write');
    assert.equal(classifyToolKind('patch'), 'file_write');
    assert.equal(classifyToolKind('insert'), 'file_write');
  });

  it('should return command for shell-like tools', () => {
    assert.equal(classifyToolKind('Bash'), 'command');
    assert.equal(classifyToolKind('bash'), 'command');
    assert.equal(classifyToolKind('shell'), 'command');
  });

  it('should return command for unknown tools', () => {
    assert.equal(classifyToolKind('SomeNewTool'), 'command');
    assert.equal(classifyToolKind(''), 'command');
  });

  it('should return command for undefined', () => {
    assert.equal(classifyToolKind(undefined), 'command');
  });

  it('should be case insensitive', () => {
    assert.equal(classifyToolKind('READ'), 'file_read');
    assert.equal(classifyToolKind('write'), 'file_write');
    assert.equal(classifyToolKind('EDIT'), 'file_write');
  });
});

describe('getToolDisplayName', () => {
  it('should format command_execution items', () => {
    assert.equal(getToolDisplayName({ type: 'command_execution', command: 'npm test' }), 'Running: npm');
    assert.equal(getToolDisplayName({ type: 'command_execution' }), 'Running: command');
  });

  it('should format file_change items', () => {
    assert.equal(getToolDisplayName({ type: 'file_change' }), 'Editing files');
  });

  it('should format reasoning items', () => {
    assert.equal(getToolDisplayName({ type: 'reasoning' }), 'Thinking...');
  });

  it('should format mcp_tool_call items', () => {
    assert.equal(getToolDisplayName({ type: 'mcp_tool_call', tool: 'search' }), 'MCP: search');
    assert.equal(getToolDisplayName({ type: 'mcp_tool_call' }), 'MCP: tool');
  });

  it('should format web_search items', () => {
    assert.equal(getToolDisplayName({ type: 'web_search' }), 'Searching the web');
  });

  it('should return type name for unknown items', () => {
    assert.equal(getToolDisplayName({ type: 'custom_thing' }), 'custom_thing');
  });
});
