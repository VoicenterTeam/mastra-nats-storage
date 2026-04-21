import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NatsKVWorkflowsStorage } from '../../src/index.js';
import { createTestSnapshot } from '../helpers.js';

describe('CRUD operations (real NATS)', () => {
  let adapter: NatsKVWorkflowsStorage;
  const bucket = `test-crud-${randomUUID()}`;

  beforeAll(async () => {
    adapter = new NatsKVWorkflowsStorage({
      servers: [process.env.NATS_URL || 'nats://localhost:4222'],
      bucket,
      replicas: 1,
      ttlSeconds: 120,
    });
    await adapter.init();
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('should persist a snapshot and load it back identically', async () => {
    const snapshot = createTestSnapshot({ runId: 'run-1', status: 'suspended' });
    await adapter.persistWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'run-1',
      snapshot,
    });
    const loaded = await adapter.loadWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'run-1',
    });
    expect(loaded).toEqual(snapshot);
  });

  it('should return null for a non-existent runId', async () => {
    const loaded = await adapter.loadWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'does-not-exist',
    });
    expect(loaded).toBeNull();
  });

  it('should overwrite an existing snapshot with the same runId', async () => {
    const v1 = createTestSnapshot({ runId: 'run-overwrite', status: 'suspended' });
    const v2 = createTestSnapshot({ runId: 'run-overwrite', status: 'success' });
    await adapter.persistWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'run-overwrite',
      snapshot: v1,
    });
    await adapter.persistWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'run-overwrite',
      snapshot: v2,
    });
    const loaded = await adapter.loadWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'run-overwrite',
    });
    expect(loaded?.status).toBe('success');
  });

  it('should delete a snapshot so load returns null', async () => {
    const snapshot = createTestSnapshot({ runId: 'run-delete', status: 'suspended' });
    await adapter.persistWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'run-delete',
      snapshot,
    });
    await adapter.deleteWorkflowRunById({
      workflowName: 'test-wf',
      runId: 'run-delete',
    });
    const loaded = await adapter.loadWorkflowSnapshot({
      workflowName: 'test-wf',
      runId: 'run-delete',
    });
    expect(loaded).toBeNull();
  });

  it('should not error when deleting a non-existent key', async () => {
    await expect(
      adapter.deleteWorkflowRunById({
        workflowName: 'test-wf',
        runId: 'non-existent',
      }),
    ).resolves.not.toThrow();
  });

  it('should list all persisted snapshots', async () => {
    // Use a separate workflow name to avoid collision with other tests
    const wfName = `list-wf-${randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      await adapter.persistWorkflowSnapshot({
        workflowName: wfName,
        runId: `list-run-${i}`,
        snapshot: createTestSnapshot({ runId: `list-run-${i}` }),
      });
    }
    const result = await adapter.listWorkflowRuns({ workflowName: wfName });
    expect(result.runs.length).toBe(5);
    expect(result.total).toBe(5);
  });

  it('should filter by status', async () => {
    const wfName = `status-wf-${randomUUID()}`;
    await adapter.persistWorkflowSnapshot({
      workflowName: wfName,
      runId: 'status-1',
      snapshot: createTestSnapshot({ runId: 'status-1', status: 'suspended' }),
    });
    await adapter.persistWorkflowSnapshot({
      workflowName: wfName,
      runId: 'status-2',
      snapshot: createTestSnapshot({ runId: 'status-2', status: 'success' }),
    });
    const result = await adapter.listWorkflowRuns({
      workflowName: wfName,
      status: 'suspended',
    });
    expect(result.runs.length).toBe(1);
    expect(result.runs[0]!.runId).toBe('status-1');
  });

  it('should paginate with page and perPage', async () => {
    const wfName = `page-wf-${randomUUID()}`;
    for (let i = 0; i < 10; i++) {
      await adapter.persistWorkflowSnapshot({
        workflowName: wfName,
        runId: `page-run-${i}`,
        snapshot: createTestSnapshot({ runId: `page-run-${i}` }),
      });
    }
    const result = await adapter.listWorkflowRuns({
      workflowName: wfName,
      page: 1,
      perPage: 3,
    });
    expect(result.runs.length).toBe(3);
    expect(result.total).toBe(10);
  });

  it('should get a workflow run by ID', async () => {
    const wfName = `getby-wf-${randomUUID()}`;
    const snapshot = createTestSnapshot({ runId: 'getby-1', status: 'running' });
    await adapter.persistWorkflowSnapshot({
      workflowName: wfName,
      runId: 'getby-1',
      snapshot,
    });
    const run = await adapter.getWorkflowRunById({
      runId: 'getby-1',
      workflowName: wfName,
    });
    expect(run).not.toBeNull();
    expect(run!.runId).toBe('getby-1');
    expect(run!.workflowName).toBe(wfName);
  });

  it('should return null for non-existent workflow run by ID', async () => {
    const run = await adapter.getWorkflowRunById({
      runId: 'non-existent',
      workflowName: 'non-existent-wf',
    });
    expect(run).toBeNull();
  });

  it('should update workflow state', async () => {
    const wfName = `state-wf-${randomUUID()}`;
    const snapshot = createTestSnapshot({ runId: 'state-1', status: 'running' });
    await adapter.persistWorkflowSnapshot({
      workflowName: wfName,
      runId: 'state-1',
      snapshot,
    });
    const updated = await adapter.updateWorkflowState({
      workflowName: wfName,
      runId: 'state-1',
      opts: { status: 'suspended', suspendedPaths: { step1: [0] } },
    });
    expect(updated?.status).toBe('suspended');
    expect(updated?.suspendedPaths).toEqual({ step1: [0] });
  });

  it('should update workflow results', async () => {
    const wfName = `results-wf-${randomUUID()}`;
    const snapshot = createTestSnapshot({ runId: 'results-1', status: 'running' });
    await adapter.persistWorkflowSnapshot({
      workflowName: wfName,
      runId: 'results-1',
      snapshot,
    });
    const ctx = await adapter.updateWorkflowResults({
      workflowName: wfName,
      runId: 'results-1',
      stepId: 'step1',
      result: { status: 'success', output: { data: 42 } } as any,
      requestContext: {},
    });
    expect(ctx.step1).toEqual({ status: 'success', output: { data: 42 } });
  });
});

describe('Concurrent writes (real NATS)', () => {
  let adapter: NatsKVWorkflowsStorage;
  const bucket = `test-concurrent-${randomUUID()}`;

  beforeAll(async () => {
    adapter = new NatsKVWorkflowsStorage({
      servers: [process.env.NATS_URL || 'nats://localhost:4222'],
      bucket,
      replicas: 1,
      ttlSeconds: 120,
    });
    await adapter.init();
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('should handle 50 concurrent writes without data loss', async () => {
    const wfName = `concurrent-wf-${randomUUID()}`;
    const promises = Array.from({ length: 50 }, (_, i) =>
      adapter.persistWorkflowSnapshot({
        workflowName: wfName,
        runId: `concurrent-${i}`,
        snapshot: createTestSnapshot({ runId: `concurrent-${i}` }),
      }),
    );
    await Promise.all(promises);
    const result = await adapter.listWorkflowRuns({ workflowName: wfName });
    expect(result.runs.length).toBe(50);
    expect(result.total).toBe(50);
  });
});
