import { describe, expect, test } from 'bun:test';

import {
  RECOGNITION_MAX_ELAPSED_MS,
  recognitionPollDelay,
} from '../src/meals/meal-recognition-policy';

describe('meal recognition polling policy', () => {
  test('backs off with a bounded delay', () => {
    expect(
      recognitionPollDelay({
        status: 'pending',
        attempt: 0,
        elapsedMs: 0,
        isAppActive: true,
      }),
    ).toBe(1_000);
    expect(
      recognitionPollDelay({
        status: 'processing',
        attempt: 1,
        elapsedMs: 0,
        isAppActive: true,
      }),
    ).toBe(2_000);
    expect(
      recognitionPollDelay({
        status: 'processing',
        attempt: 10,
        elapsedMs: 0,
        isAppActive: true,
      }),
    ).toBe(8_000);
  });

  test('does not poll terminal, expired, or background work', () => {
    for (const status of ['ready', 'failed', 'manual'] as const) {
      expect(
        recognitionPollDelay({
          status,
          attempt: 0,
          elapsedMs: 0,
          isAppActive: true,
        }),
      ).toBeNull();
    }
    expect(
      recognitionPollDelay({
        status: 'pending',
        attempt: 0,
        elapsedMs: RECOGNITION_MAX_ELAPSED_MS,
        isAppActive: true,
      }),
    ).toBeNull();
    expect(
      recognitionPollDelay({
        status: 'pending',
        attempt: 0,
        elapsedMs: 0,
        isAppActive: false,
      }),
    ).toBeNull();
  });
});
