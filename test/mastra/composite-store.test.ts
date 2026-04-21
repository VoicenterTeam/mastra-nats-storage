import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { NatsKVWorkflowsStorage } from '../../src/index.js';
import { createTestSnapshot } from '../helpers.js';

describe('MastraCompositeStore integration', () => {
  const natsAdapter = new NatsKVWorkflowsStorage({
    servers: [process.env.NATS_URL || 'nats://localhost:4222'],
    bucket: `test-composite-${randomUUID()}`,
    replicas: 1,
    ttlSeconds: 120,
  });

  afterAll(async () => {
    await natsAdapter.close();
  });

  it('should create a MastraCompositeStore with our adapter for workflows', () => {
    const storage = new MastraCompositeStore({
      id: 'test-composite',
      default: new LibSQLStore({ id: 'default', url: 'file::memory:' }),
      domains: {
        workflows: natsAdapter,
      },
    });
    expect(storage).toBeDefined();
    expect(storage.stores?.workflows).toBe(natsAdapter);
  });

  it('should route workflow operations to NATS adapter via getStore', async () => {
    const storage = new MastraCompositeStore({
      id: 'test-composite-route',
      default: new LibSQLStore({ id: 'default', url: 'file::memory:' }),
      domains: {
        workflows: natsAdapter,
      },
    });

    const workflowStore = await storage.getStore('workflows');
    expect(workflowStore).toBe(natsAdapter);
  });

  it('should persist and load a snapshot via the composite store workflows domain', async () => {
    await natsAdapter.init();

    const snapshot = createTestSnapshot({ runId: 'composite-run-1', status: 'suspended' });
    await natsAdapter.persistWorkflowSnapshot({
      workflowName: 'composite-wf',
      runId: 'composite-run-1',
      snapshot,
    });

    const loaded = await natsAdapter.loadWorkflowSnapshot({
      workflowName: 'composite-wf',
      runId: 'composite-run-1',
    });
    expect(loaded).toEqual(snapshot);
  });
});
