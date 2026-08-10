import { describe, expect, test } from 'bun:test';

import {
  formatGrams,
  formatKilocalories,
  goalLabel,
  limitedReasonLabel,
} from '../src/components/nutrition-target-display';

describe('nutrition target display', () => {
  test('formats stored integer target units without losing decimals', () => {
    expect(formatKilocalories(2_340_000)).toBe('2,340kcal');
    expect(formatGrams(321_750)).toBe('321.75g');
    expect(formatGrams(20_000)).toBe('20g');
  });

  test('uses shared Korean goal and safety labels', () => {
    expect(goalLabel('balanced_diet')).toBe('균형 식사');
    expect(limitedReasonLabel('medical_nutrition_required')).toContain('의료진');
  });
});
