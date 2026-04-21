import { describe, it, expect } from 'vitest';
import { snapshotKey, indexKey, indexFilter } from '../../src/keys.js';

describe('snapshotKey', () => {
  it('should format as wf.{workflowName}.{runId}', () => {
    expect(snapshotKey('my-workflow', 'run-123')).toBe('wf.my-workflow.run-123');
  });

  it('should handle UUID runIds', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(snapshotKey('wf', uuid)).toBe(`wf.wf.${uuid}`);
  });

  it('should handle runIds with dots and dashes', () => {
    expect(snapshotKey('wf', 'run-1.2.3')).toBe('wf.wf.run-1.2.3');
  });

  it('should handle underscores in workflow name', () => {
    expect(snapshotKey('my_workflow', 'run_1')).toBe('wf.my_workflow.run_1');
  });

  it('should throw for empty workflowName', () => {
    expect(() => snapshotKey('', 'run-1')).toThrow('workflowName must not be empty');
  });

  it('should throw for empty runId', () => {
    expect(() => snapshotKey('wf', '')).toThrow('runId must not be empty');
  });
});

describe('indexKey', () => {
  it('should format as wf-idx.{workflowName}.{runId}', () => {
    expect(indexKey('my-workflow', 'run-123')).toBe('wf-idx.my-workflow.run-123');
  });

  it('should throw for empty workflowName', () => {
    expect(() => indexKey('', 'run-1')).toThrow('workflowName must not be empty');
  });

  it('should throw for empty runId', () => {
    expect(() => indexKey('wf', '')).toThrow('runId must not be empty');
  });
});

describe('indexFilter', () => {
  it('should return wf-idx.{workflowName}.> when workflowName is provided', () => {
    expect(indexFilter('my-workflow')).toBe('wf-idx.my-workflow.>');
  });

  it('should return wf-idx.> when no workflowName is provided', () => {
    expect(indexFilter()).toBe('wf-idx.>');
  });

  it('should return wf-idx.> when workflowName is undefined', () => {
    expect(indexFilter(undefined)).toBe('wf-idx.>');
  });
});
