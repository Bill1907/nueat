import { describe, expect, test } from 'bun:test';

import {
  isFoodMappingCurrent,
  normalizeKoreanFoodLabel,
} from '../src/meals/food-selection-policy';

describe('food selection policy', () => {
  test('normalizes Korean food labels for display comparisons', () => {
    expect(normalizeKoreanFoodLabel('  비빔　밥  ')).toBe('비빔 밥');
    expect(normalizeKoreanFoodLabel('된장\n\t찌개')).toBe('된장 찌개');
  });

  test('derives current mapping from review, confirmation proof, and canonical food fields', () => {
    expect(
      isFoodMappingCurrent({
        review: { status: 'current', authority: { fingerprint: 'canonical' } },
        origin: 'model_estimate',
        confirmationProof: {},
        foodId: 'food-1',
        nutrientProfileId: 'profile-1',
      }),
    ).toBe(true);
    expect(
      isFoodMappingCurrent({
        review: { status: 'required', authority: { fingerprint: 'canonical' } },
        origin: 'model_estimate',
        confirmationProof: {},
        foodId: 'food-1',
        nutrientProfileId: 'profile-1',
      }),
    ).toBe(false);
    expect(
      isFoodMappingCurrent({
        review: { status: 'current', authority: { fingerprint: 'canonical' } },
        origin: 'model_estimate',
        confirmationProof: null,
        foodId: 'food-1',
        nutrientProfileId: 'profile-1',
      }),
    ).toBe(false);
    expect(
      isFoodMappingCurrent({
        review: { status: 'current', authority: { fingerprint: 'canonical' } },
        origin: 'legacy_unknown',
        confirmationProof: null,
        foodId: 'food-1',
        nutrientProfileId: 'profile-1',
      }),
    ).toBe(true);
  });
});
