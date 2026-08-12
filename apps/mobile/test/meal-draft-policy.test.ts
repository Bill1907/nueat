import { describe, expect, test } from 'bun:test';

import {
  hasUnsavedMealDraftItemForms,
  createNutritionPreview,
  decimalToMilliunits,
  formatNutritionValue,
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
  test('detects unsaved forms before confirmation', () => {
    const items = [
      {
        id: 'item-1',
        recognizedLabel: '밥',
        amountMilliunits: 1_500,
        unit: 'bowl' as const,
      },
    ];

    expect(
      hasUnsavedMealDraftItemForms(items, {
        'item-1': { recognizedLabel: '밥', amount: '1.5', unit: 'bowl' },
      }),
    ).toBe(false);
    expect(
      hasUnsavedMealDraftItemForms(items, {
        'item-1': { recognizedLabel: '밥', amount: '1.50', unit: 'bowl' },
      }),
    ).toBe(true);
    expect(
      hasUnsavedMealDraftItemForms(items, {
        'item-1': { recognizedLabel: '현미밥', amount: '1.5', unit: 'bowl' },
      }),
    ).toBe(true);
    expect(hasUnsavedMealDraftItemForms(items, {})).toBe(true);
  });
  test('allows core nutrition confirmation while retaining partial fiber totals', () => {
    const food = {
      id: 'rice',
      nutrientProfile: {
        id: 'profile-rice',
        basisAmountMg: 100_000,
        energyMillicalories: 130_000,
        carbohydrateMg: 28_000,
        proteinMg: 2_000,
        fatMg: 300,
        fiberMg: 400,
      },
      servings: [{ unit: 'bowl', amountMilliunits: 1_000, gramsMg: 210_000 }],
    };
    const preview = createNutritionPreview([
      {
        id: 'item-1',
        amountMilliunits: 1_500,
        unit: 'bowl',
        foodId: 'rice',
        nutrientProfileId: 'profile-rice',
        food,
      },
    ]);

    expect(preview.confirmable).toBe(true);
    expect(preview.items[0]).toMatchObject({
      gramsMg: 315_000,
      nutrients: { energyMillicalories: 409_500, fiberMg: 1_260 },
    });
    expect(preview.totals.fiberMg).toMatchObject({
      knownValue: 1_260,
      missingItemCount: 0,
      completeness: 'complete',
    });
    const partial = createNutritionPreview([
      previewItem('item-1', food),
      {
        id: 'item-2',
        amountMilliunits: 100_000,
        unit: 'g',
        foodId: 'tofu',
        nutrientProfileId: 'profile-tofu',
        food: {
          id: 'tofu',
          nutrientProfile: {
            id: 'profile-tofu',
            basisAmountMg: 100_000,
            energyMillicalories: 80_000,
            carbohydrateMg: 2_000,
            proteinMg: 10_000,
            fatMg: 5_000,
            fiberMg: null,
          },
          servings: [],
        },
      },
    ]);
    expect(partial.confirmable).toBe(true);
    expect(partial.totals.fiberMg).toMatchObject({
      value: null,
      knownValue: 840,
      missingItemCount: 1,
      completeness: 'partial',
    });

    expect(
      createNutritionPreview([
        { ...previewItem('item-2', food), foodId: null },
      ]).confirmable,
    ).toBe(false);
    expect(
      createNutritionPreview([
        { ...previewItem('item-3', food), unit: 'serving' },
      ]).confirmable,
    ).toBe(false);
    expect(
      createNutritionPreview([
        {
          ...previewItem('item-4', food),
          food: {
            ...food,
            nutrientProfile: { ...food.nutrientProfile, proteinMg: null },
          },
        },
      ]).confirmable,
    ).toBe(false);
  });

  test('uses BigInt half-up conversion and rejects unsafe inputs', () => {
    const food = {
      id: 'food',
      nutrientProfile: {
        id: 'profile',
        basisAmountMg: 2,
        energyMillicalories: 1,
        carbohydrateMg: 1,
        proteinMg: 1,
        fatMg: 1,
        fiberMg: null,
      },
      servings: [{ unit: 'bowl', amountMilliunits: 2, gramsMg: 1 }],
    };
    const rounded = createNutritionPreview([
      { ...previewItem('rounded', food), amountMilliunits: 1 },
    ]);
    expect(rounded.items[0]).toMatchObject({
      gramsMg: 1,
      nutrients: { energyMillicalories: 1 },
    });

    const overflow = createNutritionPreview([
      {
        ...previewItem('overflow', food),
        amountMilliunits: Number.MAX_SAFE_INTEGER,
        unit: 'g',
        food: {
          ...food,
          nutrientProfile: {
            ...food.nutrientProfile,
            basisAmountMg: 1,
            energyMillicalories: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    ]);
    expect(overflow.items[0].status).toBe('needs-review');
    expect(overflow.confirmable).toBe(false);
  });

  test('formats stored nutrition integers without changing precision', () => {
    expect(formatNutritionValue(123_456, 'energyMillicalories')).toBe(
      '123.456 kcal',
    );
    expect(formatNutritionValue(2_500, 'proteinMg')).toBe('2.5 g');
  });
});

function previewItem(
  id: string,
  food: {
    id: string;
    nutrientProfile: {
      id: string;
      basisAmountMg: number;
      energyMillicalories: number | null;
      carbohydrateMg: number | null;
      proteinMg: number | null;
      fatMg: number | null;
      fiberMg: number | null;
    };
    servings: { unit: string; amountMilliunits: number; gramsMg: number }[];
  },
) {
  return {
    id,
    amountMilliunits: 1_000,
    unit: 'bowl' as const,
    foodId: food.id,
    nutrientProfileId: food.nutrientProfile.id,
    food,
  };
}
