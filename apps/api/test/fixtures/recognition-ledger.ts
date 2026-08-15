export const recognitionLedgerFixture = {
  workflow: {
    id: '00000000-0000-4000-8000-000000000701',
    status: 'pending',
    protocolVersion: 'v2_option_b',
    automaticExecutionCount: 1,
    automaticInvocationReservationCount: 0,
  },
  execution: {
    id: '00000000-0000-4000-8000-000000000702',
    workflowId: '00000000-0000-4000-8000-000000000701',
    executionOrdinal: 1,
    trigger: 'initial',
    status: 'queued',
    leaseToken: null,
  },
  invocation: {
    id: '00000000-0000-4000-8000-000000000703',
    workflowId: '00000000-0000-4000-8000-000000000701',
    executionId: '00000000-0000-4000-8000-000000000702',
    invocationOrdinal: 1,
    workflowInvocationOrdinal: 1,
    status: 'reserved',
  },
} as const;
