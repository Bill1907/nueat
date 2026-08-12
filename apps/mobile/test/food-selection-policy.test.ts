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

  test('treats the server resolution as authoritative for aliases', () => {
    expect(
      isFoodMappingCurrent({
        status: 'resolved',
        reason: 'INITIAL_ALTERNATIVE_MAPPING',
      }),
    ).toBe(true);
    expect(
      isFoodMappingCurrent({
        status: 'unresolved',
        reason: 'FOOD_MAPPING_MISSING',
      }),
    ).toBe(false);
    expect(isFoodMappingCurrent(null)).toBe(false);
  });
});
