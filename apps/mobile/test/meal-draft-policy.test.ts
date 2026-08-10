import { describe, expect, test } from 'bun:test';

import {
  decimalToMilliunits,
  inferMealType,
  mealUnitLabel,
} from '../src/meals/meal-draft-policy';

describe('meal draft policy', () => {
  test.each([
    [4, 'snack'],
    [5, 'breakfast'],
    [10, 'breakfast'],
    [11, 'lunch'],
    [15, 'lunch'],
    [16, 'dinner'],
    [21, 'dinner'],
    [22, 'snack'],
  ] as const)('maps hour %i to %s', (hour, expected) => {
    const date = new Date(2026, 7, 10, hour);
    expect(inferMealType(date)).toBe(expected);
  });

  test('converts decimal portions to integer milliunits', () => {
    expect(decimalToMilliunits('1.25')).toBe(1250);
    expect(decimalToMilliunits('0,5')).toBe(500);
    expect(decimalToMilliunits('0')).toBeNull();
    expect(decimalToMilliunits('-1')).toBeNull();
    expect(decimalToMilliunits('food')).toBeNull();
  });

  test('uses Korean labels for serving units', () => {
    expect(mealUnitLabel('g')).toBe('g');
    expect(mealUnitLabel('ml')).toBe('ml');
    expect(mealUnitLabel('serving')).toBe('인분');
    expect(mealUnitLabel('bowl')).toBe('공기');
    expect(mealUnitLabel('piece')).toBe('조각');
  });
});
