import { describe, it, expect } from 'vitest';
import {
  serializeSnapshot,
  deserializeSnapshot,
  serializeIndexEntry,
  deserializeIndexEntry,
  indexEntryToWorkflowRun,
  type IndexEntry,
} from '../../src/serialization.js';
import { createTestSnapshot } from '../helpers.js';

describe('serializeSnapshot / deserializeSnapshot', () => {
  it('should round-trip a full WorkflowRunState with all fields', () => {
    const snapshot = createTestSnapshot({
      runId: 'run-123',
      status: 'suspended',
      result: { step1: { status: 'success', output: { data: 42 } } },
      value: { step1: 'done' },
      context: { input: { query: 'test' }, step1: { status: 'success', output: { data: 42 } } as any },
      suspendedPaths: { 'step2': [0, 1] },
      timestamp: 1713700000000,
    });
    const serialized = serializeSnapshot(snapshot);
    const deserialized = deserializeSnapshot(serialized);
    expect(deserialized).toEqual(snapshot);
  });

  it('should produce deterministic output for the same input', () => {
    const snapshot = createTestSnapshot({ runId: 'deterministic-test' });
    const a = serializeSnapshot(snapshot);
    const b = serializeSnapshot(snapshot);
    expect(a).toBe(b);
  });

  it('should handle Unicode (Hebrew) strings in snapshot data', () => {
    const snapshot = createTestSnapshot({
      runId: 'hebrew-test',
      context: { input: { query: 'שלום עולם' } },
    });
    const deserialized = deserializeSnapshot(serializeSnapshot(snapshot));
    expect((deserialized.context.input as any).query).toBe('שלום עולם');
  });

  it('should handle empty context and value fields', () => {
    const snapshot = createTestSnapshot({
      value: {},
      context: { input: {} },
    });
    const deserialized = deserializeSnapshot(serializeSnapshot(snapshot));
    expect(deserialized.value).toEqual({});
    expect(deserialized.context.input).toEqual({});
  });

  it('should handle a large payload (~50KB) without error', () => {
    const largeData: Record<string, any> = {};
    for (let i = 0; i < 500; i++) {
      largeData[`key-${i}`] = 'x'.repeat(100);
    }
    const snapshot = createTestSnapshot({
      context: { input: largeData },
    });
    const serialized = serializeSnapshot(snapshot);
    expect(serialized.length).toBeGreaterThan(50000);
    const deserialized = deserializeSnapshot(serialized);
    expect(deserialized.context.input).toEqual(largeData);
  });

  it('should handle nested objects in result', () => {
    const snapshot = createTestSnapshot({
      result: {
        step1: {
          status: 'success',
          output: {
            nested: { deeply: { nested: { value: 'found' } } },
          },
        },
      },
    });
    const deserialized = deserializeSnapshot(serializeSnapshot(snapshot));
    expect(deserialized.result).toEqual(snapshot.result);
  });
});

describe('serializeIndexEntry / deserializeIndexEntry', () => {
  it('should round-trip an index entry', () => {
    const entry: IndexEntry = {
      workflowName: 'my-workflow',
      runId: 'run-456',
      resourceId: 'res-1',
      status: 'running',
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:00:00.000Z',
    };
    const deserialized = deserializeIndexEntry(serializeIndexEntry(entry));
    expect(deserialized).toEqual(entry);
  });

  it('should handle undefined resourceId', () => {
    const entry: IndexEntry = {
      workflowName: 'wf',
      runId: 'run',
      status: 'suspended',
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:00:00.000Z',
    };
    const deserialized = deserializeIndexEntry(serializeIndexEntry(entry));
    expect(deserialized.resourceId).toBeUndefined();
  });
});

describe('indexEntryToWorkflowRun', () => {
  it('should convert an index entry to a WorkflowRun', () => {
    const entry: IndexEntry = {
      workflowName: 'my-workflow',
      runId: 'run-789',
      resourceId: 'res-1',
      status: 'completed',
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:30:00.000Z',
    };
    const run = indexEntryToWorkflowRun(entry);
    expect(run.workflowName).toBe('my-workflow');
    expect(run.runId).toBe('run-789');
    expect(run.resourceId).toBe('res-1');
    expect(run.createdAt).toEqual(new Date('2026-04-21T12:00:00.000Z'));
    expect(run.updatedAt).toEqual(new Date('2026-04-21T12:30:00.000Z'));
  });

  it('should include snapshot when provided', () => {
    const entry: IndexEntry = {
      workflowName: 'wf',
      runId: 'run',
      status: 'running',
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:00:00.000Z',
    };
    const snapshot = createTestSnapshot({ runId: 'run' });
    const run = indexEntryToWorkflowRun(entry, snapshot);
    expect(run.snapshot).toEqual(snapshot);
  });

  it('should use status as snapshot fallback when no snapshot provided', () => {
    const entry: IndexEntry = {
      workflowName: 'wf',
      runId: 'run',
      status: 'failed',
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:00:00.000Z',
    };
    const run = indexEntryToWorkflowRun(entry);
    expect(run.snapshot).toBe('failed');
  });
});
