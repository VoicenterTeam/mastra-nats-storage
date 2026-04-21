# @voicenter/mastra-nats-storage

NATS JetStream KV storage adapter for [Mastra](https://mastra.ai) workflows. Enables workflow state persistence (including tool suspension/resume) using NATS KV instead of a separate database.

## Installation

```bash
npm install @voicenter/mastra-nats-storage
```

## Prerequisites

- Node.js 20+
- NATS Server 2.11+ with JetStream enabled
- `@mastra/core` ^1.0.0

## Quick Start

Use with `MastraCompositeStore` to route only the workflows domain to NATS KV:

```typescript
import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { NatsKVWorkflowsStorage } from '@voicenter/mastra-nats-storage';

const storage = new MastraCompositeStore({
  id: 'my-app',
  default: new LibSQLStore({ id: 'default', url: 'file:./mastra.db' }),
  domains: {
    workflows: new NatsKVWorkflowsStorage({
      servers: [process.env.NATS_URL || 'nats://localhost:4222'],
      bucket: 'mastra-workflows',
      replicas: 3,
    }),
  },
});

const mastra = new Mastra({ storage });
```

## Standalone Usage

```typescript
import { NatsKVWorkflowsStorage } from '@voicenter/mastra-nats-storage';

const workflows = new NatsKVWorkflowsStorage({
  servers: ['nats://localhost:4222'],
  bucket: 'my-workflows',
  replicas: 1,
  ttlSeconds: 600,
});

await workflows.init();

// Persist a workflow snapshot
await workflows.persistWorkflowSnapshot({
  workflowName: 'my-workflow',
  runId: 'run-123',
  snapshot: workflowState,
});

// Load it back
const state = await workflows.loadWorkflowSnapshot({
  workflowName: 'my-workflow',
  runId: 'run-123',
});

// List runs
const { runs, total } = await workflows.listWorkflowRuns({
  workflowName: 'my-workflow',
  status: 'suspended',
});

// Clean up
await workflows.close();
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `servers` | `string[]` | (required) | NATS server URLs |
| `bucket` | `string` | `"mastra-workflows"` | KV bucket name |
| `replicas` | `number` | `3` | NATS KV replicas (use 1 for single-node dev) |
| `ttlSeconds` | `number` | `300` | TTL safety net for snapshot keys |
| `credentials.user` | `string` | — | NATS username |
| `credentials.pass` | `string` | — | NATS password |
| `credentials.token` | `string` | — | NATS token |
| `credentials.nkey` | `string` | — | NATS NKey |

## API Reference

### `init(): Promise<void>`
Connect to NATS and create/open the KV bucket.

### `persistWorkflowSnapshot(params): Promise<void>`
Store a workflow run snapshot.

### `loadWorkflowSnapshot(params): Promise<WorkflowRunState | null>`
Load a snapshot by workflow name and run ID. Returns `null` if not found or expired.

### `updateWorkflowState(params): Promise<WorkflowRunState | undefined>`
Update the state (status, result, error, suspendedPaths) of an existing snapshot.

### `updateWorkflowResults(params): Promise<Record<string, StepResult>>`
Update step results in an existing snapshot.

### `listWorkflowRuns(args?): Promise<WorkflowRuns>`
List workflow runs with optional filtering by workflow name, status, resourceId, date range, and pagination.

### `getWorkflowRunById(params): Promise<WorkflowRun | null>`
Get a single workflow run by ID.

### `deleteWorkflowRunById(params): Promise<void>`
Delete a workflow run snapshot and its index entry.

### `dangerouslyClearAll(): Promise<void>`
Delete all data from the bucket. Use only in tests.

### `close(): Promise<void>`
Drain and close the NATS connection.

## Running Tests Locally

```bash
# Start NATS cluster
docker compose -f docker-compose.test.yml up -d

# Run all tests
NATS_URL=nats://localhost:4222 pnpm test

# Unit tests only (no NATS required)
pnpm test:unit

# Stop cluster
docker compose -f docker-compose.test.yml down
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
