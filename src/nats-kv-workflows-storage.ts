import { WorkflowsStorage } from '@mastra/core/storage';
import type {
  WorkflowRun,
  WorkflowRuns,
  StorageListWorkflowRunsInput,
  UpdateWorkflowStateOptions,
} from '@mastra/core/storage';
import type { WorkflowRunState, StepResult } from '@mastra/core/workflows';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { Kvm, type KV, type KvOptions } from '@nats-io/kv';

import type { NatsKVStorageConfig, ResolvedNatsKVStorageConfig } from './types.js';
import { snapshotKey, indexKey, indexPrefix } from './keys.js';
import {
  serializeSnapshot,
  deserializeSnapshot,
  serializeIndexEntry,
  deserializeIndexEntry,
  indexEntryToWorkflowRun,
  type IndexEntry,
} from './serialization.js';
import { NatsConnectionError, NatsNotInitializedError, isKeyNotFoundError } from './errors.js';

export class NatsKVWorkflowsStorage extends WorkflowsStorage {
  private config: ResolvedNatsKVStorageConfig;
  private connection: NatsConnection | null = null;
  private kv: KV | null = null;

  constructor(config: NatsKVStorageConfig) {
    super();
    this.config = {
      servers: config.servers,
      bucket: config.bucket ?? 'mastra-workflows',
      replicas: config.replicas ?? 3,
      ttlSeconds: config.ttlSeconds ?? 300,
      credentials: config.credentials ?? {},
    };
  }

  supportsConcurrentUpdates(): boolean {
    return false;
  }

  async init(): Promise<void> {
    try {
      this.connection = await connect({
        servers: this.config.servers,
        ...this.config.credentials,
      });
    } catch (err) {
      throw new NatsConnectionError(
        `Failed to connect to NATS at ${this.config.servers.join(', ')}`,
        err,
      );
    }

    const kvm = new Kvm(this.connection);
    const kvOpts: Partial<KvOptions> = {
      replicas: this.config.replicas,
      history: 1,
      ttl: this.config.ttlSeconds * 1000,
    };
    this.kv = await kvm.create(this.config.bucket, kvOpts);
  }

  private ensureKv(): KV {
    if (!this.kv) throw new NatsNotInitializedError();
    return this.kv;
  }

  async persistWorkflowSnapshot({
    workflowName,
    runId,
    resourceId,
    snapshot,
    createdAt,
    updatedAt,
  }: {
    workflowName: string;
    runId: string;
    resourceId?: string;
    snapshot: WorkflowRunState;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<void> {
    const kv = this.ensureKv();
    const now = new Date();
    const data = serializeSnapshot(snapshot);
    await kv.put(snapshotKey(workflowName, runId), data);

    const idxEntry: IndexEntry = {
      workflowName,
      runId,
      resourceId,
      status: snapshot.status,
      createdAt: (createdAt ?? now).toISOString(),
      updatedAt: (updatedAt ?? now).toISOString(),
    };
    await kv.put(indexKey(workflowName, runId), serializeIndexEntry(idxEntry));
  }

  async loadWorkflowSnapshot({
    workflowName,
    runId,
  }: {
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    const kv = this.ensureKv();
    try {
      const entry = await kv.get(snapshotKey(workflowName, runId));
      if (!entry || entry.length === 0) return null;
      return deserializeSnapshot(entry.string());
    } catch (error) {
      if (isKeyNotFoundError(error)) return null;
      throw error;
    }
  }

  async updateWorkflowResults({
    workflowName,
    runId,
    stepId,
    result,
    requestContext,
  }: {
    workflowName: string;
    runId: string;
    stepId: string;
    result: StepResult<any, any, any, any>;
    requestContext: Record<string, any>;
  }): Promise<Record<string, StepResult<any, any, any, any>>> {
    const kv = this.ensureKv();
    const snapshot = await this.loadWorkflowSnapshot({ workflowName, runId });
    if (!snapshot) {
      return { [stepId]: result };
    }

    snapshot.context = snapshot.context ?? { input: {} };
    snapshot.context[stepId] = result;
    if (requestContext) {
      snapshot.requestContext = requestContext;
    }

    await kv.put(
      snapshotKey(workflowName, runId),
      serializeSnapshot(snapshot),
    );

    return snapshot.context as Record<string, StepResult<any, any, any, any>>;
  }

  async updateWorkflowState({
    workflowName,
    runId,
    opts,
  }: {
    workflowName: string;
    runId: string;
    opts: UpdateWorkflowStateOptions;
  }): Promise<WorkflowRunState | undefined> {
    const kv = this.ensureKv();
    const snapshot = await this.loadWorkflowSnapshot({ workflowName, runId });
    if (!snapshot) return undefined;

    snapshot.status = opts.status;
    if (opts.result !== undefined) {
      snapshot.result = opts.result;
    }
    if (opts.error !== undefined) {
      snapshot.error = opts.error;
    }
    if (opts.suspendedPaths !== undefined) {
      snapshot.suspendedPaths = opts.suspendedPaths;
    }

    await kv.put(
      snapshotKey(workflowName, runId),
      serializeSnapshot(snapshot),
    );

    // Update index entry status
    try {
      const idxEntry = await kv.get(indexKey(workflowName, runId));
      if (idxEntry && idxEntry.length > 0) {
        const idx = deserializeIndexEntry(idxEntry.string());
        idx.status = opts.status;
        idx.updatedAt = new Date().toISOString();
        await kv.put(indexKey(workflowName, runId), serializeIndexEntry(idx));
      }
    } catch {
      // Index update is best-effort
    }

    return snapshot;
  }

  async listWorkflowRuns(
    args?: StorageListWorkflowRunsInput,
  ): Promise<WorkflowRuns> {
    const kv = this.ensureKv();
    const prefix = indexPrefix(args?.workflowName);
    const results: WorkflowRun[] = [];

    const keys = await kv.keys(prefix);
    for await (const key of keys) {
      try {
        const entry = await kv.get(key);
        if (!entry || entry.length === 0) continue;
        const idx = deserializeIndexEntry(entry.string());

        if (args?.status && idx.status !== args.status) continue;
        if (args?.resourceId && idx.resourceId !== args.resourceId) continue;

        const created = new Date(idx.createdAt);
        if (args?.fromDate && created < args.fromDate) continue;
        if (args?.toDate && created > args.toDate) continue;

        results.push(indexEntryToWorkflowRun(idx));
      } catch {
        continue;
      }
    }

    results.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    const total = results.length;

    if (args?.page !== undefined && args?.perPage !== undefined && args.perPage !== false) {
      const offset = args.page * args.perPage;
      return {
        runs: results.slice(offset, offset + args.perPage),
        total,
      };
    }

    return { runs: results, total };
  }

  async getWorkflowRunById({
    runId,
    workflowName,
  }: {
    runId: string;
    workflowName?: string;
  }): Promise<WorkflowRun | null> {
    const kv = this.ensureKv();

    if (workflowName) {
      try {
        const entry = await kv.get(indexKey(workflowName, runId));
        if (!entry || entry.length === 0) return null;
        const idx = deserializeIndexEntry(entry.string());

        const snapshot = await this.loadWorkflowSnapshot({ workflowName, runId });
        return indexEntryToWorkflowRun(idx, snapshot ?? undefined);
      } catch (error) {
        if (isKeyNotFoundError(error)) return null;
        throw error;
      }
    }

    // Without workflowName, scan index keys
    const keys = await kv.keys('wf-idx.');
    for await (const key of keys) {
      if (key.endsWith(`.${runId}`)) {
        try {
          const entry = await kv.get(key);
          if (!entry || entry.length === 0) continue;
          const idx = deserializeIndexEntry(entry.string());
          if (idx.runId === runId) {
            const snapshot = await this.loadWorkflowSnapshot({
              workflowName: idx.workflowName,
              runId,
            });
            return indexEntryToWorkflowRun(idx, snapshot ?? undefined);
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  async deleteWorkflowRunById({
    runId,
    workflowName,
  }: {
    runId: string;
    workflowName: string;
  }): Promise<void> {
    const kv = this.ensureKv();
    await kv.delete(snapshotKey(workflowName, runId)).catch(() => {});
    await kv.delete(indexKey(workflowName, runId)).catch(() => {});
  }

  async dangerouslyClearAll(): Promise<void> {
    const kv = this.ensureKv();
    const keys = await kv.keys();
    for await (const key of keys) {
      await kv.delete(key).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.drain();
      await this.connection.close();
      this.connection = null;
      this.kv = null;
    }
  }
}
