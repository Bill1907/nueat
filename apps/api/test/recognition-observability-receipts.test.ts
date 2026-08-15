import { describe, expect, test } from 'bun:test';

import {
  recognitionEventLogFields,
  recognitionVerificationReceipt,
} from '../src/services/recognition-observability';
import {
  privacySentinels,
  receiptEventFixtures,
} from './fixtures/receipt-sink';

describe('recognition observability receipts', () => {
  test('projects only bounded event labels and correlation IDs', () => {
    for (const event of receiptEventFixtures) {
      const fields = recognitionEventLogFields(event);
      expect(Object.keys(fields)).toEqual([
        'recognitionEvent',
        'executionId',
        'workflowId',
        'code',
        'phase',
      ]);
      const serialized = JSON.stringify(fields);
      for (const sentinel of privacySentinels)
        expect(serialized).not.toContain(sentinel);
    }
  });

  test('builds a deterministic canary receipt with privacy and replay counters', () => {
    expect(recognitionVerificationReceipt({
      commit: '4845ef9',
      deploymentId: 'deployment-fixture',
      mode: 'v2_one_call',
      cohortPercent: 5,
      requestCount: 100,
      p95LatencyMs: 25_000,
      terminalWithinSloCount: 100,
      privacySentinelMatches: 0,
      replayViolationCount: 0,
      observedAt: '2026-08-15T00:00:00.000Z',
    })).toEqual({
      schemaVersion: 1,
      kind: 'recognition-canary-receipt',
      retentionClass: 'railway-bounded',
      commit: '4845ef9',
      deploymentId: 'deployment-fixture',
      mode: 'v2_one_call',
      cohortPercent: 5,
      requestCount: 100,
      p95LatencyMs: 25_000,
      terminalWithinSloCount: 100,
      privacySentinelMatches: 0,
      replayViolationCount: 0,
      observedAt: '2026-08-15T00:00:00.000Z',
    });
  });
});
