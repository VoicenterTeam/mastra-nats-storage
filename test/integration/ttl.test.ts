import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NatsKVWorkflowsStorage } from '../../src/index.js';
import { createTestSnapshot } from '../helpers.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TTL expiry (real NATS)', () => {
  let adapter: NatsKVWorkflowsStorage;
  const bucket = `test-ttl-${randomUUID()}`;

  beforeAll(async () => {
    adapter = new NatsKVWorkflowsStorage({
      servers: [process.env.NATS_URL || 'nats://localhost:4222'],
      bucket,
      replicas: 1,
      ttlSeconds: 3,
    });
    await adapter.init();
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('should return snapshot before TTL expires', async () => {
    await adapter.persistWorkflowSnapshot({
      workflowName: 'ttl-wf',
      runId: 'ttl-1',
      snapshot: createTestSnapshot({ runId: 'ttl-1' }),
    });
    await sleep(1000);
    const loaded = await adapter.loadWorkflowSnapshot({
      workflowName: 'ttl-wf',
      runId: 'ttl-1',
    });
    expect(loaded).not.toBeNull();
  });

  it('should return null after TTL expires', async () => {
    await adapter.persistWorkflowSnapshot({
      workflowName: 'ttl-wf',
      runId: 'ttl-2',
      snapshot: createTestSnapshot({ runId: 'ttl-2' }),
    });
    await sleep(4000);
    const loaded = await adapter.loadWorkflowSnapshot({
      workflowName: 'ttl-wf',
      runId: 'ttl-2',
    });
    expect(loaded).toBeNull();
  });

  it('should not resurrect deleted keys after TTL', async () => {
    await adapter.persistWorkflowSnapshot({
      workflowName: 'ttl-wf',
      runId: 'ttl-3',
      snapshot: createTestSnapshot({ runId: 'ttl-3' }),
    });
    await adapter.deleteWorkflowRunById({
      workflowName: 'ttl-wf',
      runId: 'ttl-3',
    });
    await sleep(4000);
    const loaded = await adapter.loadWorkflowSnapshot({
      workflowName: 'ttl-wf',
      runId: 'ttl-3',
    });
    expect(loaded).toBeNull();
  });
});
