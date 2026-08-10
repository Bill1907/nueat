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

  test('requires the editable label to match the mapped canonical food', () => {
    const food = { canonicalNameKo: '김치찌개' };

    expect(isFoodMappingCurrent(' 김치찌개 ', food)).toBe(true);
    expect(isFoodMappingCurrent('참치김치찌개', food)).toBe(false);
    expect(isFoodMappingCurrent('김치찌개', null)).toBe(false);
  });
});
