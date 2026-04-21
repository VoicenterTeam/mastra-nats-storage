import type { WorkflowRunState } from '@mastra/core/workflows';
import type { WorkflowRun } from '@mastra/core/storage';

export function serializeSnapshot(snapshot: WorkflowRunState): string {
  return JSON.stringify(snapshot);
}

export function deserializeSnapshot(data: string): WorkflowRunState {
  return JSON.parse(data) as WorkflowRunState;
}

export interface IndexEntry {
  workflowName: string;
  runId: string;
  resourceId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function serializeIndexEntry(entry: IndexEntry): string {
  return JSON.stringify(entry);
}

export function deserializeIndexEntry(data: string): IndexEntry {
  return JSON.parse(data) as IndexEntry;
}

export function indexEntryToWorkflowRun(entry: IndexEntry, snapshot?: WorkflowRunState | string): WorkflowRun {
  return {
    workflowName: entry.workflowName,
    runId: entry.runId,
    resourceId: entry.resourceId,
    snapshot: snapshot ?? entry.status,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
  };
}
