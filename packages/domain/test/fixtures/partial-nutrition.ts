import type { MealNutritionInput } from '../../src/meal-nutrition';

export const partialNutritionFixture: MealNutritionInput[] = [
  {
    mealItemId: 'known-item',
    amountMilliunits: 100_000,
    unit: 'g',
    nutrientProfile: {
      basisAmountMg: 100_000,
      energyMillicalories: 120_000,
      carbohydrateMg: 20_000,
      proteinMg: 4_000,
      fatMg: 2_000,
      fiberMg: 1_000,
    },
  },
  {
    mealItemId: 'unknown-item',
    amountMilliunits: 100_000,
    unit: 'g',
    nutrientProfile: {
      basisAmountMg: 100_000,
      energyMillicalories: null,
      carbohydrateMg: null,
      proteinMg: null,
      fatMg: null,
      fiberMg: null,
    },
  },
];
