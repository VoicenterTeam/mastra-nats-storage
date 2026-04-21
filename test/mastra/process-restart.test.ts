import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NatsKVWorkflowsStorage } from '../../src/index.js';
import { createTestSnapshot } from '../helpers.js';

describe('Process restart durability', () => {
  const bucket = `test-restart-${randomUUID()}`;
  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  it('should resume a snapshot after adapter is destroyed and recreated', async () => {
    // Instance A: create adapter, persist snapshot
    const adapterA = new NatsKVWorkflowsStorage({
      servers: [natsUrl],
      bucket,
      replicas: 1,
      ttlSeconds: 120,
    });
    await adapterA.init();

    const snapshot = createTestSnapshot({
      runId: 'restart-run-1',
      status: 'suspended',
      context: {
        input: { query: 'test question' },
        step1: { status: 'success', output: { data: 'step1-result' } } as any,
      },
      suspendedPaths: { 'step2': [0, 1] },
    });

    await adapterA.persistWorkflowSnapshot({
      workflowName: 'restart-wf',
      runId: 'restart-run-1',
      snapshot,
    });

    // Verify snapshot exists
    const loaded = await adapterA.loadWorkflowSnapshot({
      workflowName: 'restart-wf',
      runId: 'restart-run-1',
    });
    expect(loaded).toEqual(snapshot);

    // DESTROY instance A (simulate process crash)
    await adapterA.close();

    // Instance B: create NEW adapter, SAME config
    const adapterB = new NatsKVWorkflowsStorage({
      servers: [natsUrl],
      bucket,
      replicas: 1,
      ttlSeconds: 120,
    });
    await adapterB.init();

    // Resume: load snapshot from instance B
    const resumed = await adapterB.loadWorkflowSnapshot({
      workflowName: 'restart-wf',
      runId: 'restart-run-1',
    });

    // Verify snapshot survived the restart
    expect(resumed).not.toBeNull();
    expect(resumed!.runId).toBe('restart-run-1');
    expect(resumed!.status).toBe('suspended');
    expect((resumed!.context.step1 as any).output.data).toBe('step1-result');
    expect(resumed!.suspendedPaths).toEqual({ 'step2': [0, 1] });

    // Clean up: update state to completed and delete
    await adapterB.updateWorkflowState({
      workflowName: 'restart-wf',
      runId: 'restart-run-1',
      opts: { status: 'success' },
    });

    const completed = await adapterB.loadWorkflowSnapshot({
      workflowName: 'restart-wf',
      runId: 'restart-run-1',
    });
    expect(completed!.status).toBe('success');

    await adapterB.deleteWorkflowRunById({
      workflowName: 'restart-wf',
      runId: 'restart-run-1',
    });

    const deleted = await adapterB.loadWorkflowSnapshot({
      workflowName: 'restart-wf',
      runId: 'restart-run-1',
    });
    expect(deleted).toBeNull();

    await adapterB.close();
  });
});
