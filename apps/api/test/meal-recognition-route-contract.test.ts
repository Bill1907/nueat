import { describe, expect, test } from 'bun:test';

import {
  forbiddenMealDraftResponseKeys,
  mealDraftResponseMatrix,
} from './fixtures/meal-draft-matrix';

describe('meal recognition route response contract', () => {
  test('keeps observations independent from recovery metadata generation', () => {
    for (const fixture of mealDraftResponseMatrix) {
      expect(fixture.response.items).toHaveLength(fixture.observationCount);
      if (fixture.name === 'old_api_recovery_absent_with_observation') {
        expect('recognitionRecovery' in fixture.response.mealLog).toBe(false);
        expect(fixture.response.items[0]?.recognizedLabel).toBe('비빔밥');
      }
    }
  });

  test('contains no provider, lease, storage, token, or identity diagnostics', () => {
    for (const fixture of mealDraftResponseMatrix) {
      const serialized = JSON.stringify(fixture.response);
      for (const key of forbiddenMealDraftResponseKeys)
        expect(serialized).not.toContain(key);
    }
  });

  test('binds current recovery to a closed public reason', () => {
    const current = mealDraftResponseMatrix[0].response.mealLog;
    expect(current.recognitionRecovery).toEqual({
      mode: 'none',
      reason: 'recognition_complete',
      retryAt: null,
    });
  });
});
