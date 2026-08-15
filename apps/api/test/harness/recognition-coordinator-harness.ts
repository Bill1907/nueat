export interface RecognitionLedgerHarnessInput {
  workflowId: string;
  executions: Array<{
    id: string;
    workflowId: string;
    executionOrdinal: number;
  }>;
  invocations: Array<{
    executionId: string;
    invocationOrdinal: number;
    workflowInvocationOrdinal: number;
  }>;
}

export function recognitionLedgerInvariantErrors(
  input: RecognitionLedgerHarnessInput,
): string[] {
  const errors: string[] = [];
  const executionOrdinals = new Set<number>();
  const workflowInvocationOrdinals = new Set<number>();
  const executionIds = new Set(input.executions.map((value) => value.id));
  for (const execution of input.executions) {
    if (execution.workflowId !== input.workflowId)
      errors.push('execution_workflow_mismatch');
    if (executionOrdinals.has(execution.executionOrdinal))
      errors.push('duplicate_execution_ordinal');
    executionOrdinals.add(execution.executionOrdinal);
  }
  for (const invocation of input.invocations) {
    if (!executionIds.has(invocation.executionId))
      errors.push('invocation_execution_mismatch');
    if (invocation.invocationOrdinal !== 1)
      errors.push('multiple_invocations_per_execution');
    if (workflowInvocationOrdinals.has(invocation.workflowInvocationOrdinal))
      errors.push('duplicate_workflow_invocation_ordinal');
    workflowInvocationOrdinals.add(invocation.workflowInvocationOrdinal);
  }
  return errors;
}
