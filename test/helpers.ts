import type { WorkflowRunState } from '@mastra/core/workflows';

export function createTestSnapshot(
  overrides: Partial<WorkflowRunState> & { workflowName?: string } = {},
): WorkflowRunState {
  const { workflowName: _wn, ...rest } = overrides;
  return {
    runId: rest.runId ?? `run-${Math.random().toString(36).slice(2, 10)}`,
    status: 'suspended',
    value: {},
    context: { input: {} },
    serializedStepGraph: [],
    activePaths: [],
    activeStepsPath: {},
    suspendedPaths: {},
    resumeLabels: {},
    waitingPaths: {},
    timestamp: Date.now(),
    ...rest,
  };
}
