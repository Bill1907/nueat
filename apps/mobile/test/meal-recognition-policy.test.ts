import { describe, expect, test } from 'bun:test';

import {
  RECOGNITION_MAX_ELAPSED_MS,
  canAddMealDraftItem,
  isRetakeReason,
  recognitionPollDelay,
  reviewReasonCopy,
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

  test('uses Korean recovery copy only for retake-eligible outcomes', () => {
    expect(reviewReasonCopy('NO_FOOD_DETECTED')).toBe(
      '사진에서 음식을 확인하지 못했어요. 새 사진을 찍거나 직접 입력해 주세요.',
    );
    expect(reviewReasonCopy('INSUFFICIENT_IMAGE_EVIDENCE')).toBe(
      '사진 정보가 부족해요. 새 사진을 찍거나 직접 입력해 주세요.',
    );
    expect(reviewReasonCopy('FOOD_MAPPING_MISSING')).toBe(
      '공식 음식 DB에서 음식을 선택해 주세요.',
    );
    expect(isRetakeReason('NO_FOOD_DETECTED')).toBe(true);
    expect(isRetakeReason('INSUFFICIENT_IMAGE_EVIDENCE')).toBe(true);
    expect(isRetakeReason('no_food')).toBe(true);
    expect(isRetakeReason('insufficient_evidence')).toBe(true);
    expect(isRetakeReason('IMAGE_QUALITY_LOW')).toBe(false);
    expect(isRetakeReason('FOOD_MAPPING_MISSING')).toBe(false);
    expect(canAddMealDraftItem('ready', 'no_food')).toBe(false);
    expect(canAddMealDraftItem('ready', 'insufficient_evidence')).toBe(false);
    expect(canAddMealDraftItem('ready', 'recognized')).toBe(true);
    expect(canAddMealDraftItem('manual', 'no_food')).toBe(true);
  });
});
