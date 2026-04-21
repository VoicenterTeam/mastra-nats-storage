# Changelog

## 0.1.0

Initial release.

- NATS JetStream KV storage adapter implementing Mastra's `WorkflowsStorage` domain interface
- Full CRUD: `persistWorkflowSnapshot`, `loadWorkflowSnapshot`, `deleteWorkflowRunById`
- Listing with filtering by `workflowName`, `status`, `resourceId`, date range, and pagination
- Workflow state updates: `updateWorkflowState`, `updateWorkflowResults`
- Configurable TTL, replicas, and bucket name
- Works with `MastraCompositeStore` for domain-level routing
- Unit tests for serialization, key formatting, and error handling
- Integration tests against real NATS cluster (CRUD, TTL, concurrency)
