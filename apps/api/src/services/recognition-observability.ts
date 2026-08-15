import type {
  RecognitionExecutionEvent,
} from './meal-recognition-coordinator';

export function recognitionEventLogFields(
  event: RecognitionExecutionEvent,
) {
  return {
    recognitionEvent: event.type,
    executionId: 'executionId' in event ? event.executionId : undefined,
    workflowId: 'workflowId' in event ? event.workflowId : undefined,
    code: event.type === 'terminal' ? event.code : undefined,
    phase: event.type === 'phase' ? event.phase : undefined,
  };
}

export interface RecognitionVerificationReceiptInput {
  commit: string;
  deploymentId: string;
  mode: 'legacy_observe' | 'v2_one_call' | 'disabled';
  cohortPercent: number;
  requestCount: number;
  p95LatencyMs: number | null;
  terminalWithinSloCount: number;
  privacySentinelMatches: number;
  replayViolationCount: number;
  observedAt: string;
}

export function recognitionVerificationReceipt(
  input: RecognitionVerificationReceiptInput,
) {
  if (!/^[0-9a-f]{7,64}$/.test(input.commit))
    throw new Error('Invalid receipt commit');
  if (!Number.isInteger(input.cohortPercent) || input.cohortPercent < 0 || input.cohortPercent > 100)
    throw new Error('Invalid receipt cohort');
  for (const value of [
    input.requestCount,
    input.terminalWithinSloCount,
    input.privacySentinelMatches,
    input.replayViolationCount,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid receipt counter');
  }
  return {
    schemaVersion: 1,
    kind: 'recognition-canary-receipt',
    retentionClass: 'railway-bounded',
    ...input,
  } as const;
}
