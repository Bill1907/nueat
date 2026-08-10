import { describe, expect, test } from 'bun:test';

import {
  calculateItemNutrition,
  calculateMealNutrition,
  convertAmountToGramsMg,
  NutritionCalculationError,
  type NutrientProfileValues,
  type ServingConversion,
} from './meal-nutrition';

const riceBowl: ServingConversion = {
  id: 'serving-rice-bowl',
  unit: 'bowl',
  amountMilliunits: 1_000,
  gramsMg: 210_000,
  sourceRegistryId: 'source-fixture',
  qualityGrade: 'verified',
};

const cookedRice: NutrientProfileValues = {
  basisAmountMg: 100_000,
  energyMillicalories: 130_000,
  carbohydrateMg: 28_600,
  proteinMg: 2_700,
  fatMg: 300,
  fiberMg: 400,
};

const kimchi: NutrientProfileValues = {
  basisAmountMg: 100_000,
  energyMillicalories: 15_000,
  carbohydrateMg: 2_400,
  proteinMg: 1_100,
  fatMg: 500,
  fiberMg: null,
};

describe('serving conversion', () => {
  test('uses milligrams directly for gram input', () => {
    expect(convertAmountToGramsMg({ amountMilliunits: 125_500, unit: 'g' })).toBe(125_500);
  });

  test('converts fractional Korean serving units with integer half-up rounding', () => {
    expect(
      convertAmountToGramsMg({ amountMilliunits: 500, unit: 'bowl', serving: riceBowl }),
    ).toBe(105_000);
  });

  test('requires an exact conversion for volume and household units', () => {
    expectCalculationError(
      () => convertAmountToGramsMg({ amountMilliunits: 200_000, unit: 'ml' }),
      'SERVING_REQUIRED',
    );
    expectCalculationError(
      () =>
        convertAmountToGramsMg({ amountMilliunits: 1_000, unit: 'piece', serving: riceBowl }),
      'SERVING_UNIT_MISMATCH',
    );
  });

  test('rejects invalid amounts and serving records', () => {
    expectCalculationError(
      () => convertAmountToGramsMg({ amountMilliunits: 0, unit: 'g' }),
      'INVALID_AMOUNT',
    );
    expectCalculationError(
      () =>
        convertAmountToGramsMg({
          amountMilliunits: 1_000,
          unit: 'bowl',
          serving: { ...riceBowl, gramsMg: 0 },
        }),
      'INVALID_SERVING',
    );
  });
});

describe('nutrient calculation', () => {
  test('calculates a 210 g rice bowl from a 100 g nutrient basis', () => {
    expect(calculateItemNutrition(210_000, cookedRice)).toEqual({
      energyMillicalories: 273_000,
      carbohydrateMg: 60_060,
      proteinMg: 5_670,
      fatMg: 630,
      fiberMg: 840,
    });
  });

  test('rounds positive half values up and preserves missing nutrients', () => {
    expect(
      calculateItemNutrition(50, {
        basisAmountMg: 100,
        energyMillicalories: 1,
        carbohydrateMg: 1,
        proteinMg: 1,
        fatMg: 1,
        fiberMg: null,
      }),
    ).toEqual({
      energyMillicalories: 1,
      carbohydrateMg: 1,
      proteinMg: 1,
      fatMg: 1,
      fiberMg: null,
    });
  });

  test('rejects invalid profiles and unsafe integer overflow', () => {
    expectCalculationError(
      () => calculateItemNutrition(100, { ...cookedRice, basisAmountMg: 0 }),
      'INVALID_BASIS',
    );
    expectCalculationError(
      () => calculateItemNutrition(100, { ...cookedRice, proteinMg: -1 }),
      'INVALID_NUTRIENT_VALUE',
    );
    expectCalculationError(
      () =>
        calculateItemNutrition(Number.MAX_SAFE_INTEGER, {
          ...cookedRice,
          basisAmountMg: 1,
          energyMillicalories: Number.MAX_SAFE_INTEGER,
        }),
      'INTEGER_OVERFLOW',
    );
  });
});

describe('meal totals', () => {
  test('calculates known totals and marks a nutrient partial when any item is missing', () => {
    const result = calculateMealNutrition([
      {
        mealItemId: 'rice',
        amountMilliunits: 1_000,
        unit: 'bowl',
        serving: riceBowl,
        nutrientProfile: cookedRice,
      },
      {
        mealItemId: 'kimchi',
        amountMilliunits: 50_000,
        unit: 'g',
        nutrientProfile: kimchi,
      },
    ]);

    expect(result.items.map(({ mealItemId, gramsMg }) => ({ mealItemId, gramsMg }))).toEqual([
      { mealItemId: 'rice', gramsMg: 210_000 },
      { mealItemId: 'kimchi', gramsMg: 50_000 },
    ]);
    expect(result.totals.energyMillicalories).toEqual({
      value: 280_500,
      knownValue: 280_500,
      missingItemCount: 0,
      completeness: 'complete',
    });
    expect(result.totals.fiberMg).toEqual({
      value: null,
      knownValue: 840,
      missingItemCount: 1,
      completeness: 'partial',
    });
  });

  test('returns complete zero totals for an empty draft', () => {
    const result = calculateMealNutrition([]);
    expect(result.totals.proteinMg).toEqual({
      value: 0,
      knownValue: 0,
      missingItemCount: 0,
      completeness: 'complete',
    });
  });
});

function expectCalculationError(
  callback: () => unknown,
  code: NutritionCalculationError['code'],
) {
  try {
    callback();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(NutritionCalculationError);
    expect((error as NutritionCalculationError).code).toBe(code);
  }
}
