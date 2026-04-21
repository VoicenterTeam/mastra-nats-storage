export function snapshotKey(workflowName: string, runId: string): string {
  if (!workflowName) throw new Error('workflowName must not be empty');
  if (!runId) throw new Error('runId must not be empty');
  return `wf.${workflowName}.${runId}`;
}

export function indexKey(workflowName: string, runId: string): string {
  if (!workflowName) throw new Error('workflowName must not be empty');
  if (!runId) throw new Error('runId must not be empty');
  return `wf-idx.${workflowName}.${runId}`;
}

export function indexFilter(workflowName?: string): string {
  return workflowName ? `wf-idx.${workflowName}.>` : 'wf-idx.>';
}
