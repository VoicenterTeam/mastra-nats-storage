# @voicenter/mastra-nats-storage — Full Implementation Specification

> **Package:** @voicenter/mastra-nats-storage
> **Repository:** GitHub (PUBLIC — open source)
> **License:** MIT
> **Owner:** Voicenter AI Team
> **Status:** Restart — full reimplementation

---

## ⚠️ PUBLIC REPOSITORY — SECURITY RULES

This is an **open-source project published on GitHub**. The following rules are absolute:

1. **NEVER** commit credentials, API keys, tokens, passwords, or connection strings
2. **NEVER** commit `.env` files — only `.env.example` with placeholder values
3. **NEVER** reference internal Voicenter infrastructure (server names, IPs, internal URLs)
4. **NEVER** include customer data, account IDs, or any PII in test fixtures
5. **NEVER** reference internal codenames (Assistent CENTER, EcoCenter, etc.) in the code — the README can mention Voicenter as the maintainer, but the code and tests must be generic
6. **ALL** test data must be synthetic — generated specifically for testing
7. **ALL** configuration comes from environment variables or constructor parameters — nothing hardcoded
8. The `.gitignore` MUST include: `.env`, `*.local`, `node_modules/`, `dist/`, `.DS_Store`
9. The `.env.example` MUST use obvious placeholder values: `nats://localhost:4222`
10. CI secrets are stored in GitHub Actions secrets — NEVER in the repo

**Before every commit, verify:** `git diff --cached` contains zero secrets.

---

## 1. What This Is

A Mastra storage adapter that implements Mastra's storage interface using NATS JetStream Key-Value store as the backend. It enables Mastra's native workflow and tool suspension persistence to operate over NATS KV instead of PostgreSQL, MongoDB, or other databases.

This package is useful for any Mastra user who already has NATS JetStream in their infrastructure and doesn't want to add a separate database for Mastra's storage needs.

---

## 2. Why It Exists

Mastra persists workflow snapshots (including tool suspension state) through its storage system. Out of the box, it supports PostgreSQL, LibSQL, MongoDB, and DynamoDB. This package adds NATS JetStream KV as a backend option.

NATS JetStream KV is a distributed, replicated key-value store built into NATS. If you already run NATS for messaging, you get KV storage for free — no additional database infrastructure needed.

**Use cases:**
- Mastra tool suspension/resume that survives process restarts
- Workflow state persistence in NATS-based architectures
- Minimal infrastructure deployments that want to avoid adding PostgreSQL

---

## 3. Scope

The adapter implements Mastra's storage interface for the **workflows domain** only. It does NOT implement the full storage interface (memory, agents, scores, etc.). Use Mastra's `MastraCompositeStore` to route the workflows domain to this adapter while other domains use a different backend:

```typescript
import { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { NatsKVWorkflowsStorage } from "@voicenter/mastra-nats-storage";

const storage = new MastraCompositeStore({
  id: "my-app",
  default: new LibSQLStore({ url: "file:./mastra.db" }),
  domains: {
    workflows: new NatsKVWorkflowsStorage({
      servers: [process.env.NATS_URL || "nats://localhost:4222"],
      bucket: "mastra-workflows",
      replicas: 3,
    }),
  },
});
```

---

## 4. Mastra Storage Interface

### 4.1 First Task: Read the Actual Interface

Before writing any code, the developer MUST:

1. Query the Mastra MCP server for current storage interface documentation
2. Read `packages/core/src/storage/types.ts` from the Mastra source
3. Read existing adapter implementations (e.g., `@mastra/pg`, `@mastra/libsql`) to understand the contract
4. Document every method signature, input type, output type, and expected behavior
5. Identify which methods the workflows domain actually uses (not all methods may apply)

**The interface described below is our best understanding as of spec writing. It MUST be verified against the actual Mastra source before implementation.**

### 4.2 Expected Interface

```typescript
interface WorkflowsStorage {
  /** Initialize storage backend (create bucket, verify connectivity) */
  init(): Promise<void>;

  /** Persist a workflow run snapshot (called on suspend) */
  persistWorkflowSnapshot(params: {
    runId: string;
    snapshot: WorkflowRunSnapshot;
  }): Promise<void>;

  /** Load a workflow run snapshot by runId (called on resume) */
  loadWorkflowSnapshot(params: {
    runId: string;
  }): Promise<WorkflowRunSnapshot | null>;

  /** List workflow runs with optional filtering */
  listWorkflowRuns(params?: {
    workflowId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<WorkflowRunListItem[]>;

  /** Delete a workflow run snapshot (called after completion/cancellation) */
  deleteWorkflowSnapshot(params: {
    runId: string;
  }): Promise<void>;
}

interface WorkflowRunSnapshot {
  runId: string;
  workflowId: string;
  status: 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  snapshot: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

interface WorkflowRunListItem {
  runId: string;
  workflowId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### 4.3 Open Questions to Resolve

These MUST be answered by reading Mastra source and querying MCP before coding:

1. **Exact interface shape** — does `WorkflowsStorage` have additional methods? Does it extend a base class?
2. **Snapshot serializability** — is the `snapshot` field pure JSON, or can it contain non-serializable types (functions, Buffers)?
3. **Concurrent resume** — can two HTTP requests attempt to resume the same runId? Do we need atomic read-and-delete?
4. **Cleanup responsibility** — does Mastra call `deleteWorkflowSnapshot()` after resume, or must we rely on TTL?
5. **Error contract** — when `loadWorkflowSnapshot()` returns null, does Mastra handle gracefully or throw?
6. **List pagination** — does anything in Mastra call `listWorkflowRuns()` with large offsets?

---

## 5. NATS KV Design

### 5.1 Bucket Configuration

```
Bucket name:    configurable (default: "mastra-workflows")
Replicas:       configurable (default: 3)
History:        1 (only latest version needed)
Max value size: 1MB (default — snapshots are typically 5-50KB)
TTL:            configurable (default: 300 seconds / 5 minutes)
```

### 5.2 Key Schema

| Key Pattern | Content | Lifecycle |
|---|---|---|
| `wf:{runId}` | Serialized WorkflowRunSnapshot (JSON) | Created on persist, deleted on completion, TTL safety net |
| `wf-idx:{workflowId}:{runId}` | Minimal index entry for listing | Created/deleted alongside snapshot |

### 5.3 Serialization

- JSON with deterministic key ordering (sorted keys)
- Date fields serialized as ISO 8601 strings, parsed back to Date on read
- UTF-8 encoding via TextEncoder/TextDecoder

---

## 6. Implementation

### 6.1 Project Structure

```
@voicenter/mastra-nats-storage/
├── .github/
│   └── workflows/
│       ├── ci.yml                      # Build + test on every PR
│       ├── release.yml                 # Publish to npm on tag
│       └── nightly.yml                 # Extended integration tests
│
├── src/
│   ├── index.ts                        # Public exports
│   ├── nats-kv-workflows-storage.ts    # Main adapter class
│   ├── serialization.ts                # serialize/deserialize helpers
│   ├── errors.ts                       # Custom error types
│   └── types.ts                        # Config types
│
├── test/
│   ├── unit/
│   │   ├── serialization.test.ts
│   │   ├── key-format.test.ts
│   │   └── filter-logic.test.ts
│   │
│   ├── integration/
│   │   ├── setup.ts                    # Docker NATS cluster setup/teardown
│   │   ├── crud.test.ts                # Basic CRUD operations
│   │   ├── concurrency.test.ts         # Concurrent writes and reads
│   │   ├── ttl.test.ts                 # TTL expiry behavior
│   │   └── durability.test.ts          # Node failure and recovery
│   │
│   └── mastra/
│       ├── composite-store.test.ts     # MastraCompositeStore integration
│       ├── tool-suspension.test.ts     # Real Mastra suspend/resume
│       └── process-restart.test.ts     # Survive process restart
│
├── docker-compose.test.yml             # 3-node NATS cluster for testing
├── .env.example                        # Placeholder env vars
├── .gitignore
├── .npmignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── LICENSE                             # MIT
├── CONTRIBUTING.md
├── CHANGELOG.md
└── README.md
```

### 6.2 Configuration

```typescript
export interface NatsKVStorageConfig {
  /** NATS server URLs */
  servers: string[];
  /** KV bucket name (default: "mastra-workflows") */
  bucket?: string;
  /** Number of replicas (default: 3, use 1 for single-node dev) */
  replicas?: number;
  /** TTL in seconds for snapshot keys (default: 300) */
  ttlSeconds?: number;
  /** NATS authentication (all optional) */
  credentials?: {
    user?: string;
    pass?: string;
    token?: string;
    nkey?: string;
  };
}
```

### 6.3 Main Class

```typescript
import { type KV } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";

export class NatsKVWorkflowsStorage {
  private config: Required<NatsKVStorageConfig>;
  private connection: NatsConnection | null = null;
  private kv: KV | null = null;

  constructor(config: NatsKVStorageConfig) {
    this.config = {
      servers: config.servers,
      bucket: config.bucket ?? "mastra-workflows",
      replicas: config.replicas ?? 3,
      ttlSeconds: config.ttlSeconds ?? 300,
      credentials: config.credentials ?? {},
    };
  }

  async init(): Promise<void> {
    this.connection = await connect({
      servers: this.config.servers,
      ...this.config.credentials,
    });

    const js = this.connection.jetstream();
    this.kv = await js.views.kv(this.config.bucket, {
      replicas: this.config.replicas,
      history: 1,
      ttl: this.config.ttlSeconds * 1000,
    });
  }

  async persistWorkflowSnapshot(params: {
    runId: string;
    snapshot: WorkflowRunSnapshot;
  }): Promise<void> {
    const { runId, snapshot } = params;
    const data = serialize(snapshot);
    await this.kv!.put(`wf:${runId}`, data);

    // Index entry for listWorkflowRuns
    const indexData = JSON.stringify({
      runId,
      workflowId: snapshot.workflowId,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    });
    await this.kv!.put(`wf-idx:${snapshot.workflowId}:${runId}`, indexData);
  }

  async loadWorkflowSnapshot(params: {
    runId: string;
  }): Promise<WorkflowRunSnapshot | null> {
    try {
      const entry = await this.kv!.get(`wf:${params.runId}`);
      if (!entry || !entry.value) return null;
      return deserialize(new TextDecoder().decode(entry.value));
    } catch (error) {
      if (isKeyNotFoundError(error)) return null;
      throw error;
    }
  }

  async listWorkflowRuns(params?: {
    workflowId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<WorkflowRunListItem[]> {
    const prefix = params?.workflowId
      ? `wf-idx:${params.workflowId}:`
      : "wf-idx:";

    const results: WorkflowRunListItem[] = [];
    const keys = await this.kv!.keys(prefix);

    for await (const key of keys) {
      try {
        const entry = await this.kv!.get(key);
        if (!entry || !entry.value) continue;
        const item = JSON.parse(new TextDecoder().decode(entry.value));
        if (params?.status && item.status !== params.status) continue;
        results.push({
          runId: item.runId,
          workflowId: item.workflowId,
          status: item.status,
          createdAt: new Date(item.createdAt),
          updatedAt: new Date(item.updatedAt),
        });
      } catch {
        continue; // Skip corrupted/expired entries
      }
    }

    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  async deleteWorkflowSnapshot(params: {
    runId: string;
  }): Promise<void> {
    try {
      const entry = await this.kv!.get(`wf:${params.runId}`);
      if (entry?.value) {
        const snapshot = deserialize(new TextDecoder().decode(entry.value));
        await this.kv!.delete(`wf-idx:${snapshot.workflowId}:${params.runId}`).catch(() => {});
      }
    } catch { /* already gone */ }
    await this.kv!.delete(`wf:${params.runId}`).catch(() => {});
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
```

### 6.4 Serialization Module

```typescript
// src/serialization.ts

export function serialize(snapshot: WorkflowRunSnapshot): string {
  return JSON.stringify(snapshot, Object.keys(snapshot).sort());
}

export function deserialize(data: string): WorkflowRunSnapshot {
  const parsed = JSON.parse(data);
  parsed.createdAt = new Date(parsed.createdAt);
  parsed.updatedAt = new Date(parsed.updatedAt);
  return parsed;
}

export function isKeyNotFoundError(error: unknown): boolean {
  // NATS KV throws specific errors for missing keys
  // Verify exact error type from @nats-io/kv source
  return (
    error instanceof Error &&
    (error.message.includes("no such key") ||
     error.message.includes("not found"))
  );
}
```

---

## 7. Error Handling

| Error | Behavior | Rationale |
|---|---|---|
| NATS connection failure on `init()` | Throw | Consumer cannot start without storage |
| NATS connection lost mid-operation | Auto-reconnect (NATS client built-in), retry once | Transient failures should not crash |
| Key not found on `load` | Return `null` | Snapshot expired or never existed |
| Serialization failure | Throw | Indicates a bug — should never happen |
| Bucket creation failure | Throw | NATS misconfigured |
| Value > 1MB | Throw | Unusually large snapshot — investigate |

**Do NOT implement custom reconnection logic.** The `@nats-io/transport-node` client handles reconnection automatically with exponential backoff and jitter.

---

## 8. Docker Compose for Testing

```yaml
# docker-compose.test.yml
services:
  nats-1:
    image: nats:2.11-alpine
    command: >
      --name nats-1
      --cluster_name test-cluster
      --cluster nats://0.0.0.0:6222
      --routes nats://nats-2:6222,nats://nats-3:6222
      --js
      --sd /data
    ports: ["4222:4222"]

  nats-2:
    image: nats:2.11-alpine
    command: >
      --name nats-2
      --cluster_name test-cluster
      --cluster nats://0.0.0.0:6222
      --routes nats://nats-1:6222,nats://nats-3:6222
      --js
      --sd /data

  nats-3:
    image: nats:2.11-alpine
    command: >
      --name nats-3
      --cluster_name test-cluster
      --cluster nats://0.0.0.0:6222
      --routes nats://nats-1:6222,nats://nats-2:6222
      --js
      --sd /data
```

---

## 9. Testing Specification

### 9.1 Testing Framework

Vitest. ESM-native, same API as Jest, works with @nats-io/kv and @mastra/core without transform issues.

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
```

### 9.2 Unit Tests (No NATS Required)

**test/unit/serialization.test.ts:**
- Round-trip: create snapshot → serialize → deserialize → deep equal
- Date precision: Date → ISO string → Date preserves milliseconds
- Deterministic: same object serialized twice → byte-identical
- Unicode: Hebrew strings in snapshot metadata survive round-trip
- Edge cases: empty snapshot field, null metadata, very large snapshot (~50KB)

**test/unit/key-format.test.ts:**
- `wf:{uuid}` format for standard runIds
- `wf-idx:{workflowId}:{runId}` format
- Special characters: verify runIds with dashes, underscores work
- Reject empty strings

**test/unit/filter-logic.test.ts:**
- 20 fixtures, filter by workflowId → correct subset
- Filter by status → correct subset
- Filter by both → intersection
- Pagination: offset=5, limit=3 → correct 3 items
- Sort: descending by createdAt

### 9.3 Integration Tests (Real NATS Cluster)

All integration tests start the Docker Compose NATS cluster in `beforeAll` and tear it down in `afterAll`. Each test gets a fresh bucket (unique name per test).

**test/integration/crud.test.ts:**
- `init()` creates bucket with correct replicas and history
- Persist then load → identical snapshot returned
- Delete then load → returns null
- List after 5 persists → returns 5 items in correct order
- Overwrite (same runId, updated status) → load returns updated version
- Delete non-existent key → no error (idempotent)
- **50 concurrent writes (Promise.all)** → all 50 readable afterward with correct data

**test/integration/concurrency.test.ts:**
- 20 parallel persist + 20 parallel load (interleaved) → no corruption
- Persist from "process A" + load from "process B" (two separate NatsKVWorkflowsStorage instances, same NATS cluster) → works correctly
- List while persists are happening → returns consistent snapshot (no partial reads)

**test/integration/ttl.test.ts:**
- Configure TTL = 5 seconds
- Persist → wait 3s → load → snapshot present
- Wait 3 more seconds → load → null (expired)
- Persist → delete → wait 6s → no resurrection
- Index key also expires when snapshot expires

**test/integration/durability.test.ts:**
- Persist with R=3 → stop nats-3 → load → snapshot available
- Persist → stop nats-2 AND nats-3 → attempt load → verify behavior (quorum loss)
- Persist → restart all 3 nodes → load → snapshot survived restart
- Connection drop during persist → auto-reconnect → retry succeeds

### 9.4 Mastra Integration Tests (Real Mastra + Real NATS)

These tests verify the adapter works inside Mastra's actual execution flow, not just our isolated logic.

**test/mastra/composite-store.test.ts:**
- Configure MastraCompositeStore: workflows → our adapter, default → LibSQL
- Initialize Mastra → no errors
- Call Mastra internal API that exercises workflow storage → routes to our adapter
- Other storage domains (memory, agents) → route to LibSQL, not our adapter

**test/mastra/tool-suspension.test.ts:**

This is the critical test. Create a real Mastra agent with a tool that suspends:

```typescript
const testTool = createTool({
  id: "test-suspend-tool",
  description: "Test tool that suspends and waits for callback",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  suspendSchema: z.object({ correlationId: z.string() }),
  resumeSchema: z.object({ result: z.string() }),
  execute: async (input, { agent }) => {
    const { resumeData, suspend } = agent ?? {};
    if (!resumeData) {
      return suspend?.({ correlationId: `corr-${Date.now()}` });
    }
    return { result: resumeData.result };
  },
});
```

Test flow:
1. Create agent with test tool + our storage adapter
2. Call `agent.generate()` with prompt triggering the tool
3. Verify response: `finishReason === 'suspended'`
4. Verify NATS KV contains snapshot at `wf:{runId}`
5. Call `agent.resumeToolCall({ runId, resumeData: { result: "callback-data" } })`
6. Verify agent completes with the tool result
7. Verify NATS KV snapshot cleaned up

**test/mastra/process-restart.test.ts:**

The durability test — proves snapshots survive process death:

1. Create Mastra instance A with our adapter
2. Trigger tool suspension (agent.generate → tool suspends)
3. Verify snapshot in NATS KV
4. **Destroy** instance A (close connections, null all references)
5. Create Mastra instance B with **same** config, same NATS cluster
6. Call `agent.resumeToolCall()` on instance B
7. Verify tool resumes correctly with the data from step 2
8. Verify snapshot cleaned up

This test proves the core value proposition: suspension state survives process restarts via NATS KV.

---

## 10. Epic Plan — Test-Driven Development

### 10.1 TDD Discipline

Every implementation task follows this cycle:

```
1. WRITE THE FAILING TEST — describe what the code should do before writing the code
2. RUN IT — watch it fail (red)
3. IMPLEMENT — the minimum code to make the test pass
4. RUN IT — watch it pass (green)
5. REFACTOR — clean up, no new behavior
6. COMMIT — tests + implementation together, never one without the other
```

**If a commit has implementation code but no corresponding test, it's wrong.** If a commit has a test but no implementation yet, that's fine — it's a "red" commit that the next commit will turn green.

### 10.2 Sprint Overview

| Sprint | Focus | Days | Deliverable |
|---|---|---|---|
| S1 | Setup + Interface Discovery | 2-3 | Repo, CI green, confirmed Mastra interface |
| S2 | TDD: Serialization + Connection | 2-3 | Tests + implementation for types, serialization, init/close |
| S3 | TDD: Core CRUD | 2-3 | Tests + implementation for persist/load/delete/list |
| S4 | TDD: Integration Tests | 2-3 | Real NATS cluster tests: concurrency, TTL, durability |
| S5 | TDD: Mastra Integration | 2-3 | Suspend/resume round-trip, process restart, composite store |
| S6 | Polish + Release | 2-3 | README, coverage audit, security audit, npm publish |

---

### 10.3 Sprint 1: Setup + Interface Discovery

**No implementation code in this sprint.** This sprint produces a repo scaffold and a confirmed Mastra interface.

**S1.1: Repository initialization**
- Create GitHub repo: `VoicenterTeam/mastra-nats-storage`
- FIRST COMMIT: `.gitignore` only (with the full list from Section 0). Nothing else.
- Second commit: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`, `LICENSE` (MIT), `CONTRIBUTING.md`
- Third commit: `docker-compose.test.yml` (Section 8), `.github/workflows/ci.yml` (Section 11.1)
- Verify: `pnpm install && pnpm build` succeeds (with empty `src/index.ts` exporting nothing)
- Verify: CI triggers on push, goes green

**S1.2: Mastra interface research**
- Query Mastra MCP (`https://mcp.mastra.ai/mcp`) for: `WorkflowsStorage` interface, `WorkflowRunSnapshot` type, `MastraCompositeStore` configuration, `createTool` suspend/resume pattern
- Read Mastra source on GitHub: `packages/core/src/storage/types.ts`
- Write a throwaway Mastra test script: create a workflow with suspension, log the snapshot object. Confirm:
  - Exact method signatures and parameter types
  - Is `snapshot.snapshot` plain JSON or does it contain non-serializable types?
  - Are dates Date objects or ISO strings?
  - What status values does Mastra actually set?
  - Does Mastra call `deleteWorkflowSnapshot()` after resume, or must we rely on TTL?
  - Does `init()` exist on the interface?
- **Deliverable: update Section 4 of this spec** with the confirmed interface. Note any differences from assumptions.

**S1.3: Source skeleton**
- `src/index.ts` — exports `NatsKVWorkflowsStorage` (stub class)
- `src/types.ts` — `NatsKVWorkflowsStorageConfig` interface
- `src/serialization.ts` — `serialize()` / `deserialize()` stubs that throw `new Error("Not implemented")`
- `src/errors.ts` — custom error types
- `src/nats-kv-workflows-storage.ts` — class with every method throwing `new Error("Not implemented")`
- Verify: `pnpm build` produces `dist/` with `.js` and `.d.ts` files
- Verify: CI still green

**Acceptance:** Repo public. CI green. Mastra interface confirmed. Every method is a stub. Zero implementation code. Zero credentials anywhere.

---

### 10.4 Sprint 2: TDD — Serialization + Connection

Every task starts with writing the test, THEN implementing.

**S2.1: Serialization tests FIRST**

Write all tests in `test/unit/serialization.test.ts` BEFORE implementing serialization:

```typescript
describe('serialize / deserialize', () => {
  it('should round-trip a full WorkflowRunSnapshot with all fields', () => {
    const snapshot = createTestSnapshot(); // helper with all fields populated
    const serialized = serialize(snapshot);
    const deserialized = deserialize(serialized);
    expect(deserialized).toEqual(snapshot);
  });

  it('should preserve Date precision through ISO 8601 round-trip', () => {
    const now = new Date('2026-04-21T12:30:45.123Z');
    const snapshot = createTestSnapshot({ createdAt: now, updatedAt: now });
    const deserialized = deserialize(serialize(snapshot));
    expect(deserialized.createdAt.getTime()).toBe(now.getTime());
  });

  it('should produce deterministic output for the same input', () => {
    const snapshot = createTestSnapshot();
    const a = serialize(snapshot);
    const b = serialize(snapshot);
    expect(a).toEqual(b); // byte-identical
  });

  it('should handle Hebrew string values in metadata', () => { ... });
  it('should handle undefined vs null in optional fields', () => { ... });
  it('should handle a ~50KB payload without error', () => { ... });
});
```

Run: `pnpm test:unit` → ALL FAIL (red). Good.

Now implement `serialize()` and `deserialize()` in `src/serialization.ts` until all tests pass (green).

Commit: tests + implementation together.

**S2.2: Key format tests FIRST**

Write `test/unit/key-format.test.ts`:

```typescript
describe('key format', () => {
  it('should format main key as wf:{runId}', () => { ... });
  it('should format index key as wf-idx:{workflowId}:{runId}', () => { ... });
  it('should reject empty string runId', () => { ... });
  it('should handle UUID runIds correctly', () => { ... });
  it('should handle runIds with dots and dashes', () => { ... });
});
```

Run: all fail. Implement key helpers. Run: all pass. Commit.

**S2.3: Connection lifecycle tests FIRST**

Write `test/unit/connection.test.ts` (with mocked NATS):

```typescript
describe('connection lifecycle', () => {
  it('should connect to NATS and create bucket on init()', () => { ... });
  it('should not fail init() if bucket already exists', () => { ... });
  it('should throw on init() if NATS is unreachable', () => { ... });
  it('should close connection and nullify references on close()', () => { ... });
  it('should throw if operating after close()', () => { ... });
});
```

Run: all fail. Implement `init()` and `close()`. Run: all pass. Commit.

**S2.4: Filter and pagination tests FIRST**

Write `test/unit/filter-logic.test.ts`:

```typescript
describe('list filtering and pagination', () => {
  it('should filter by workflowId', () => { ... });
  it('should filter by status', () => { ... });
  it('should apply both filters as intersection', () => { ... });
  it('should paginate with offset and limit', () => { ... });
  it('should sort descending by createdAt', () => { ... });
  it('should return empty array for no matches', () => { ... });
});
```

Run: all fail. Implement filter/sort/paginate helpers. Run: all pass. Commit.

**Acceptance:** `pnpm test:unit` all green. Coverage > 90% on serialization, keys, filters. CI green. NO integration tests yet — that's Sprint 3-4.

---

### 10.5 Sprint 3: TDD — Core CRUD Operations

Now tests run against real NATS. Docker Compose must be running.

**S3.1: Write the persist + load integration test FIRST**

Write `test/integration/crud.test.ts`:

```typescript
describe('persist and load (real NATS)', () => {
  let adapter: NatsKVWorkflowsStorage;

  beforeAll(async () => {
    adapter = new NatsKVWorkflowsStorage({
      servers: [process.env.NATS_URL || 'nats://localhost:4222'],
      bucket: `test-${randomUUID()}`,  // unique bucket per test run
      replicas: 1,
    });
    await adapter.init();
  });

  afterAll(async () => { await adapter.close(); });

  it('should persist a snapshot and load it back identically', async () => {
    const snapshot = createTestSnapshot({ runId: 'run-1' });
    await adapter.persistWorkflowSnapshot({ runId: 'run-1', snapshot });
    const loaded = await adapter.loadWorkflowSnapshot({ runId: 'run-1' });
    expect(loaded).toEqual(snapshot);
  });

  it('should return null for a non-existent runId', async () => {
    const loaded = await adapter.loadWorkflowSnapshot({ runId: 'does-not-exist' });
    expect(loaded).toBeNull();
  });

  it('should overwrite an existing snapshot with the same runId', async () => {
    const v1 = createTestSnapshot({ runId: 'run-2', status: 'suspended' });
    const v2 = createTestSnapshot({ runId: 'run-2', status: 'completed' });
    await adapter.persistWorkflowSnapshot({ runId: 'run-2', snapshot: v1 });
    await adapter.persistWorkflowSnapshot({ runId: 'run-2', snapshot: v2 });
    const loaded = await adapter.loadWorkflowSnapshot({ runId: 'run-2' });
    expect(loaded?.status).toBe('completed');
  });
});
```

Run: tests fail because `persistWorkflowSnapshot` throws "Not implemented". Good.

Implement `persistWorkflowSnapshot()` and `loadWorkflowSnapshot()` in the adapter class.

Run: tests pass. Commit.

**S3.2: Write the delete integration test FIRST**

Add to `crud.test.ts`:

```typescript
it('should delete a snapshot so load returns null', async () => { ... });
it('should not error when deleting a non-existent key', async () => { ... });
```

Run: fail. Implement `deleteWorkflowSnapshot()`. Run: pass. Commit.

**S3.3: Write the list integration test FIRST**

Add to `crud.test.ts` or new file `test/integration/list.test.ts`:

```typescript
it('should list all persisted snapshots', async () => {
  // persist 5 snapshots with different workflowIds
  // list without filters → expect 5
});
it('should filter by workflowId', async () => { ... });
it('should filter by status', async () => { ... });
it('should paginate with offset and limit', async () => { ... });
it('should return empty array for empty bucket', async () => { ... });
```

Run: fail. Implement `listWorkflowRuns()`. Run: pass. Commit.

**S3.4: Write the 50-concurrent-writes test FIRST**

Write `test/integration/concurrency.test.ts`:

```typescript
it('should handle 50 concurrent writes without data loss', async () => {
  const promises = Array.from({ length: 50 }, (_, i) =>
    adapter.persistWorkflowSnapshot({
      runId: `concurrent-${i}`,
      snapshot: createTestSnapshot({ runId: `concurrent-${i}` }),
    })
  );
  await Promise.all(promises);
  const list = await adapter.listWorkflowRuns();
  expect(list.length).toBe(50);
});
```

Run: should pass if implementation is correct. If not — fix. Commit.

**Acceptance:** `pnpm test:integration` all green against Docker NATS. CRUD, list, concurrency all verified. CI integration job green.

---

### 10.6 Sprint 4: TDD — TTL + Durability

**S4.1: Write the TTL test FIRST**

Write `test/integration/ttl.test.ts`:

```typescript
describe('TTL expiry', () => {
  let adapter: NatsKVWorkflowsStorage;

  beforeAll(async () => {
    adapter = new NatsKVWorkflowsStorage({
      servers: ['nats://localhost:4222'],
      bucket: `test-ttl-${randomUUID()}`,
      replicas: 1,
      ttlSeconds: 3,  // short TTL for testing
    });
    await adapter.init();
  });

  it('should return snapshot before TTL expires', async () => {
    await adapter.persistWorkflowSnapshot({ runId: 'ttl-1', snapshot: createTestSnapshot() });
    await sleep(1000);
    const loaded = await adapter.loadWorkflowSnapshot({ runId: 'ttl-1' });
    expect(loaded).not.toBeNull();
  });

  it('should return null after TTL expires', async () => {
    await adapter.persistWorkflowSnapshot({ runId: 'ttl-2', snapshot: createTestSnapshot() });
    await sleep(4000); // past 3s TTL
    const loaded = await adapter.loadWorkflowSnapshot({ runId: 'ttl-2' });
    expect(loaded).toBeNull();
  });
});
```

Run: should pass if TTL is correctly configured in bucket. If not — fix init(). Commit.

**S4.2: Write the durability test FIRST**

Write `test/integration/durability.test.ts`:

```typescript
describe('durability (R=3)', () => {
  let adapter: NatsKVWorkflowsStorage;

  beforeAll(async () => {
    adapter = new NatsKVWorkflowsStorage({
      servers: ['nats://localhost:4222', 'nats://localhost:4223', 'nats://localhost:4224'],
      bucket: `test-durable-${randomUUID()}`,
      replicas: 3,
    });
    await adapter.init();
  });

  it('should survive one NATS node stopping', async () => {
    await adapter.persistWorkflowSnapshot({ runId: 'dur-1', snapshot: createTestSnapshot() });
    // Stop node 3 (docker compose stop nats-3)
    await exec('docker compose -f docker-compose.test.yml stop nats-3');
    await sleep(2000);
    const loaded = await adapter.loadWorkflowSnapshot({ runId: 'dur-1' });
    expect(loaded).not.toBeNull();
    // Restart
    await exec('docker compose -f docker-compose.test.yml start nats-3');
    await sleep(3000);
  });

  it('should survive full cluster restart', async () => {
    await adapter.persistWorkflowSnapshot({ runId: 'dur-2', snapshot: createTestSnapshot() });
    await exec('docker compose -f docker-compose.test.yml restart');
    await sleep(5000);
    // Reconnect
    const adapter2 = new NatsKVWorkflowsStorage({ /* same config */ });
    await adapter2.init();
    const loaded = await adapter2.loadWorkflowSnapshot({ runId: 'dur-2' });
    expect(loaded).not.toBeNull();
    await adapter2.close();
  });
});
```

Run: verify. Fix connection recovery if needed. Commit.

**Acceptance:** TTL and durability tests pass. CI nightly job green.

---

### 10.7 Sprint 5: TDD — Mastra Integration

The most important sprint. These tests prove the adapter works inside Mastra's real execution flow.

**S5.1: Write the MastraCompositeStore test FIRST**

Write `test/mastra/composite-store.test.ts`:

```typescript
import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { NatsKVWorkflowsStorage } from '../src';

describe('MastraCompositeStore integration', () => {
  it('should start Mastra without errors using our adapter', async () => {
    const storage = new MastraCompositeStore({
      id: 'test',
      default: new LibSQLStore({ url: 'file::memory:' }),
      domains: {
        workflows: new NatsKVWorkflowsStorage({
          servers: ['nats://localhost:4222'],
          bucket: `test-composite-${randomUUID()}`,
        }),
      },
    });

    const mastra = new Mastra({ storage });
    // If this doesn't throw, routing is working
    expect(mastra).toBeDefined();
  });

  it('should route workflow operations to NATS, not LibSQL', async () => {
    // Persist a snapshot via Mastra's storage API
    // Verify it appears in NATS KV, not in LibSQL
  });
});
```

Run: fail (or pass if routing works). Fix any issues. Commit.

**S5.2: Write the tool suspension round-trip test FIRST**

This is the critical test. Write it BEFORE worrying about whether it passes:

Write `test/mastra/tool-suspension.test.ts`:

```typescript
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

describe('Mastra tool suspension via NATS KV', () => {
  let mastra: Mastra;
  let adapter: NatsKVWorkflowsStorage;

  beforeAll(async () => {
    adapter = new NatsKVWorkflowsStorage({
      servers: ['nats://localhost:4222'],
      bucket: `test-suspend-${randomUUID()}`,
    });

    const storage = new MastraCompositeStore({
      id: 'test',
      default: new LibSQLStore({ url: 'file::memory:' }),
      domains: { workflows: adapter },
    });

    mastra = new Mastra({ storage });
  });

  afterAll(async () => { await adapter.close(); });

  const suspendTool = createTool({
    id: 'test-suspend-tool',
    description: 'Tool that suspends and waits for callback',
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ result: z.string() }),
    suspendSchema: z.object({ correlationId: z.string() }),
    resumeSchema: z.object({ answer: z.string() }),
    execute: async ({ context, suspend, resumeData }) => {
      if (!resumeData) {
        return suspend({ correlationId: `corr-${Date.now()}` });
      }
      return { result: `Answer: ${resumeData.answer}` };
    },
  });

  it('should suspend and persist snapshot to NATS KV', async () => {
    // Trigger tool suspension
    // Verify NATS KV has a snapshot
    // Verify the snapshot contains valid workflow state
  });

  it('should resume from NATS KV and complete the tool', async () => {
    // Resume with answer data
    // Verify the tool returns the expected result
    // Verify NATS KV snapshot is cleaned up
  });

  it('should complete a full suspend → resume cycle end-to-end', async () => {
    // Full cycle: call agent → tool suspends → snapshot in NATS →
    // resume tool → agent completes → snapshot cleaned up
    // This is the definitive test.
  });
});
```

Run: these will fail initially — possibly because the Mastra integration details aren't right, or the tool test harness needs adjustment. THIS IS THE POINT. The failing test forces you to understand exactly how Mastra's suspension flow works.

Fix and iterate until all pass. Commit.

**S5.3: Write the process restart test FIRST**

Write `test/mastra/process-restart.test.ts`:

```typescript
describe('process restart durability', () => {
  it('should resume a suspended tool after Mastra instance is destroyed and recreated', async () => {
    // Instance A: create adapter, Mastra, trigger suspension
    const adapterA = new NatsKVWorkflowsStorage({ /* config */ });
    const mastraA = new Mastra({ storage: compositeStore(adapterA) });

    // Trigger tool suspension → get runId
    // Verify snapshot exists in NATS KV

    // DESTROY instance A (simulate crash)
    await adapterA.close();
    // mastraA is now dead — no references, no connections

    // Instance B: create NEW adapter, NEW Mastra, SAME config
    const adapterB = new NatsKVWorkflowsStorage({ /* same config */ });
    const mastraB = new Mastra({ storage: compositeStore(adapterB) });

    // Resume tool on instance B using the runId from instance A
    // Verify: tool completes successfully
    // Verify: snapshot cleaned up

    await adapterB.close();
  });
});
```

This test is the core value proposition. If it passes, the adapter works. If it doesn't, nothing else matters.

Run: fail → fix → pass. Commit.

**Acceptance:** ALL Mastra tests pass. The full cycle works: suspend → NATS KV → (crash) → new instance → resume → complete. CI Mastra job green.

---

### 10.8 Sprint 6: Polish + Release

**S6.1: Coverage audit**
- Run `pnpm test -- --coverage`
- Coverage must be > 85% on statements, branches, functions, lines
- Identify and fill gaps — write additional edge case tests for any uncovered paths
- Common gaps: error handling paths, reconnection logic, edge cases in serialization

**S6.2: README**
- Installation, quick start, full API reference
- MastraCompositeStore example (copy-pasteable)
- Configuration reference table
- Docker Compose example
- Contributing guidelines
- **ZERO Voicenter-specific details in examples** — all localhost, generic names
- **Verify: a random Mastra user can follow the README and use the adapter**

**S6.3: Security audit**
- `git log --all --diff-filter=A -- '*env*' '*secret*' '*password*' '*token*'` — must return nothing
- Review every file for: internal IPs, internal hostnames, credentials, Voicenter-proprietary references
- Check `.npmignore` / `files` field: only `dist/`, `package.json`, `README.md`, `LICENSE` are published
- Run `npm pack --dry-run` and inspect the file list

**S6.4: Publish v0.1.0**
- `git tag v0.1.0`
- Push tag → GitHub Actions builds, tests (full suite), publishes to npm
- Verify: `npm info @voicenter/mastra-nats-storage` shows the package
- Verify: `npm install @voicenter/mastra-nats-storage` works in a fresh project
- Smoke test: create a throwaway project, import the adapter, run against local NATS

**Acceptance:** Published on npm. CI fully green. README is clear. Definition of Done (Section 17) fully checked.

---

## 11. GitHub Actions CI/CD

### 11.1 CI Pipeline (Every PR)

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    services:
      nats:
        image: nats:2.11-alpine
        options: >-
          --health-cmd "wget -q --spider http://localhost:8222/healthz || exit 1"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
        ports:
          - 4222:4222
        # Single node for PR tests (fast startup)
        # Full cluster in nightly pipeline
        env:
          NATS_ARGS: "--js --sd /tmp/nats"

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm typecheck

      - name: Unit tests
        run: pnpm test:unit -- --reporter=junit --outputFile=junit-unit.xml

      - name: Integration tests
        run: pnpm test:integration -- --reporter=junit --outputFile=junit-integration.xml
        env:
          NATS_URL: nats://localhost:4222

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: junit-*.xml

      - name: Coverage
        run: pnpm test:unit -- --coverage
```

### 11.2 Nightly Pipeline (Full Cluster + Mastra Tests)

```yaml
# .github/workflows/nightly.yml
name: Nightly

on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:

jobs:
  full-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Start 3-node NATS cluster
        run: docker compose -f docker-compose.test.yml up -d
      - name: Wait for cluster
        run: npx wait-on tcp:localhost:4222 --timeout 30000

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      - name: All tests (unit + integration + mastra)
        run: pnpm test
        env:
          NATS_URL: nats://localhost:4222

      - name: Teardown
        if: always()
        run: docker compose -f docker-compose.test.yml down
```

### 11.3 Release Pipeline (Publish to npm)

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*.*.*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      # Run full test suite before publishing
      - name: Start NATS
        run: docker compose -f docker-compose.test.yml up -d
      - name: Wait for cluster
        run: npx wait-on tcp:localhost:4222 --timeout 30000
      - run: pnpm test
        env:
          NATS_URL: nats://localhost:4222

      # Verify no secrets in package
      - name: Audit package contents
        run: |
          npm pack --dry-run 2>&1 | tee pack-contents.txt
          if grep -i -E '\.env$|secret|credential|password' pack-contents.txt; then
            echo "ERROR: Potential secrets in package!"
            exit 1
          fi

      - run: pnpm publish --no-git-checks --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Teardown
        if: always()
        run: docker compose -f docker-compose.test.yml down
```

---

## 12. Package Configuration

### 12.1 package.json

```json
{
  "name": "@voicenter/mastra-nats-storage",
  "version": "1.0.0",
  "description": "NATS JetStream KV storage adapter for Mastra workflows",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/voicenter/mastra-nats-storage"
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "scripts": {
    "build": "tsc",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run test/unit/",
    "test:integration": "vitest run test/integration/",
    "test:mastra": "vitest run test/mastra/",
    "test:watch": "vitest watch",
    "prepublishOnly": "pnpm build"
  },
  "peerDependencies": {
    "@mastra/core": "^1.0.0"
  },
  "dependencies": {
    "@nats-io/kv": "^3.0.0",
    "@nats-io/transport-node": "^3.0.0"
  },
  "devDependencies": {
    "@mastra/core": "^1.0.0",
    "@mastra/libsql": "^1.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=20"
  },
  "keywords": ["mastra", "nats", "jetstream", "kv", "storage", "workflow", "ai"]
}
```

### 12.2 .gitignore

```
node_modules/
dist/
.env
.env.local
.env.*.local
*.local
.DS_Store
coverage/
junit-*.xml
*.tgz
```

### 12.3 .npmignore

```
test/
src/
.github/
docker-compose*.yml
.env*
.gitignore
.eslintrc*
vitest.config.ts
tsconfig.json
coverage/
junit-*.xml
CONTRIBUTING.md
```

### 12.4 .env.example

```env
# NATS connection (for local development and testing)
NATS_URL=nats://localhost:4222

# No credentials needed for local Docker NATS
# In production, set these as needed:
# NATS_USER=
# NATS_PASS=
# NATS_TOKEN=
```

---

## 13. README Template

The README must include:

1. **One-line description** — what it does
2. **Installation** — `npm install @voicenter/mastra-nats-storage`
3. **Quick Start** — minimal working example with MastraCompositeStore
4. **Prerequisites** — Node.js 20+, NATS Server 2.11+ with JetStream
5. **Configuration Reference** — table of all options with types and defaults
6. **Usage with MastraCompositeStore** — full example
7. **Standalone Usage** — using the adapter without CompositeStore
8. **Running Tests Locally** — Docker Compose + pnpm test
9. **API Reference** — init, persist, load, list, delete, close
10. **Contributing** — link to CONTRIBUTING.md
11. **License** — MIT

**Do not include** Voicenter-specific infrastructure details, internal project names, or usage patterns specific to Assistent CENTER. The README is for any Mastra user who wants NATS KV storage.

---

## 14. Configuration Reference

| Config | Type | Default | Description |
|---|---|---|---|
| `servers` | `string[]` | (required) | NATS server URLs |
| `bucket` | `string` | `"mastra-workflows"` | KV bucket name |
| `replicas` | `number` | `3` | NATS KV replicas (use 1 for single-node dev) |
| `ttlSeconds` | `number` | `300` | TTL safety net for snapshots |
| `credentials.user` | `string` | — | NATS username |
| `credentials.pass` | `string` | — | NATS password |
| `credentials.token` | `string` | — | NATS token |
| `credentials.nkey` | `string` | — | NATS NKey |

---

## 15. Maintenance

### 15.1 Mastra Version Updates

1. Check if storage interface changed in new Mastra release
2. Unchanged → bump peer dependency, release patch
3. Changed → implement new methods, release minor
4. Breaking changes produce TypeScript compile errors — no silent failures

### 15.2 NATS Compatibility

Standard KV operations (put/get/delete/keys) are stable across NATS 2.9+. Pin to 2.11+ for TTL and metadata improvements.

---

## 16. Coding Agent Instructions

If a coding agent (Claude Code, Cursor, etc.) is building this project:

1. **TDD is mandatory.** Every task starts with writing the failing test. Implementation comes second. A commit with code but no test is wrong. A commit with a failing test and no implementation yet is fine.
2. **Query the Mastra MCP before writing any Mastra-specific code.** Don't assume the interface matches this spec. Verify.
3. **Never hardcode credentials.** All connection details from config or environment variables.
4. **The `.gitignore` is the first file in the first commit.** Period. Before package.json, before anything.
5. **Never use `console.log` in production code.** Errors are thrown or returned. Tests can use console during development but clean before merge.
6. **Run `pnpm lint && pnpm typecheck` before every commit.**
7. **Run `pnpm test:unit` before every push.**
8. **Run `pnpm test:integration` (with Docker NATS) before every PR.**
9. **Read CI logs after pushing.** If CI fails, fix and push again. Don't move to the next task with red CI.
10. **Every test file uses a unique NATS bucket** (`test-${randomUUID()}`) to avoid collisions between test runs.
11. **Use descriptive test names:** `it("should return null when loading a non-existent snapshot")` not `it("works")`.
12. **Follow the sprint order.** Don't skip to Sprint 5 because it's "more interesting." The sprints are ordered by dependency.

---

## 17. Definition of Done

The project is done when ALL of the following are true:

- [ ] GitHub repo is public at `VoicenterTeam/mastra-nats-storage`
- [ ] `.gitignore` was the first file committed — verify with `git log --reverse --oneline | head -1`
- [ ] No credentials, internal URLs, or proprietary details anywhere in git history
- [ ] MIT license file present
- [ ] TDD approach followed: every implementation commit has corresponding tests
- [ ] CI passes: lint, typecheck, unit tests, integration tests, Mastra integration tests
- [ ] Unit test coverage > 85% on `src/`
- [ ] Integration tests verified against real 3-node NATS cluster
- [ ] Tool suspension round-trip: suspend → persist to NATS KV → resume → complete
- [ ] Process restart durability: suspend → crash → new instance → resume → complete
- [ ] MastraCompositeStore routing verified: workflows → NATS, others → LibSQL
- [ ] README has installation, quick start, API reference, and copy-pasteable examples
- [ ] Published to npm as `@voicenter/mastra-nats-storage`
- [ ] `npm pack --dry-run` shows only: dist/, package.json, README.md, LICENSE
- [ ] Fresh `npm install` + minimal usage example works without errors
- [ ] CHANGELOG.md documents v0.1.0

---

*This document is the complete specification for building @voicenter/mastra-nats-storage as a public open-source package. The TDD epic plan (Section 10) defines the execution order — tests first, implementation second, every sprint. The security rules (Section 0) are non-negotiable. When all items in the Definition of Done (Section 17) are checked, the project is complete.*
