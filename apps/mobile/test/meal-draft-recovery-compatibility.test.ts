import { describe, expect, test } from 'bun:test';

import { deriveRecognitionRecoveryPolicy } from '../src/meals/meal-recognition-policy';
import { mobileApiCompatibilityMatrix } from './fixtures/meal-draft-current-previous';

describe('current and previous meal draft recovery compatibility', () => {
  test('never hides a stored observation when recovery is absent or unknown', () => {
    for (const fixture of mobileApiCompatibilityMatrix) {
      const policy = deriveRecognitionRecoveryPolicy({
        recovery: fixture.recovery,
        recognitionStatus: fixture.recognitionStatus,
        hasStoredObservation: fixture.observations.length > 0,
        localPollingTimedOut: false,
      });
      if (fixture.observations.length > 0) {
        expect(fixture.observations[0]?.recognizedLabel).toBe('비빔밥');
        expect(policy.showProgress).toBe(false);
        expect(policy.canStartDirectEntry).toBe(false);
      }
      if (
        fixture.name === 'previous_api_recovery_absent' ||
        fixture.name === 'unsupported_recovery_union' ||
        fixture.name === 'legacy_recovery_flags'
      ) {
        expect(policy.canRetryRecognition).toBe(false);
        expect(policy.message).toContain('음식 인식 결과를 확인해 주세요');
      }
    }
  });

  test('derives progress for an older pending response without recovery', () => {
    const fixture = mobileApiCompatibilityMatrix.find(
      (candidate) => candidate.name === 'pending_without_observation',
    )!;
    expect(deriveRecognitionRecoveryPolicy({
      recovery: fixture.recovery,
      recognitionStatus: fixture.recognitionStatus,
      hasStoredObservation: false,
      localPollingTimedOut: false,
    })).toMatchObject({
      showProgress: true,
      canRetryRecognition: false,
      canStartDirectEntry: false,
    });
  });
});
