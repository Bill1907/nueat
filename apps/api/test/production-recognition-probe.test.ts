import { describe, expect, test } from 'bun:test';

import { productionRecognitionProbe } from '../scripts/production-recognition-probe';
import { productionProbeFixture } from './fixtures/production-probe';

function response(body: unknown, ok = true) {
  return async () => ({
    ok,
    status: ok ? 200 : 503,
    async json() {
      return body;
    },
  });
}

describe('production recognition probe', () => {
  test('emits a deterministic privacy-safe readiness and cohort receipt', async () => {
    await expect(productionRecognitionProbe({
      baseUrl: 'https://api-nueat.boseong.dev/private/path?secret=no',
      expectedMode: 'v2_one_call',
      expectedCohortPercent: 5,
      observedAt: '2026-08-15T00:00:00.000Z',
      fetchImpl: response(productionProbeFixture),
    })).resolves.toEqual({
      schemaVersion: 1,
      kind: 'production-recognition-probe',
      origin: 'https://api-nueat.boseong.dev',
      ready: true,
      mode: 'v2_one_call',
      cohortPercent: 5,
      recoveryEnabled: false,
      sdkMaxRetries: 0,
      observedAt: '2026-08-15T00:00:00.000Z',
    });
  });

  test('fails closed for mode, cohort, SDK retry, readiness, or privacy mismatch', async () => {
    const cases = [
      { ...productionProbeFixture, status: 'not_ready' },
      {
        ...productionProbeFixture,
        mealConfirmation: {
          ...productionProbeFixture.mealConfirmation,
          recognitionReliability: {
            ...productionProbeFixture.mealConfirmation.recognitionReliability,
            cohortPercent: 10,
          },
        },
      },
      { ...productionProbeFixture, objectKey: 'private/key' },
    ];
    for (const body of cases) {
      await expect(productionRecognitionProbe({
        baseUrl: 'https://api-nueat.boseong.dev',
        expectedMode: 'v2_one_call',
        expectedCohortPercent: 5,
        observedAt: '2026-08-15T00:00:00.000Z',
        fetchImpl: response(body),
      })).rejects.toBeInstanceOf(Error);
    }
  });
});
