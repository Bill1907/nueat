export type ServingUnit = 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
export type NutritionValueKey =
  | 'energyMillicalories'
  | 'carbohydrateMg'
  | 'proteinMg'
  | 'fatMg'
  | 'fiberMg';

export interface ServingConversion {
  id: string;
  unit: Exclude<ServingUnit, 'g'>;
  amountMilliunits: number;
  gramsMg: number;
  sourceRegistryId: string;
  qualityGrade: 'verified' | 'estimated' | 'unverified';
}

export interface NutrientProfileValues {
  basisAmountMg: number;
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
}

export interface MealNutritionInput {
  mealItemId: string;
  amountMilliunits: number;
  unit: ServingUnit;
  serving?: ServingConversion;
  nutrientProfile: NutrientProfileValues;
}

export interface CalculatedNutritionValues {
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
}

export interface CalculatedMealItem {
  mealItemId: string;
  gramsMg: number;
  nutrients: CalculatedNutritionValues;
}

export interface NutrientAggregate {
  value: number | null;
  knownValue: number;
  missingItemCount: number;
  completeness: 'complete' | 'partial';
}

export interface MealNutritionResult {
  items: CalculatedMealItem[];
  totals: Record<NutritionValueKey, NutrientAggregate>;
}

export type NutritionCalculationErrorCode =
  | 'INVALID_AMOUNT'
  | 'SERVING_REQUIRED'
  | 'SERVING_UNIT_MISMATCH'
  | 'INVALID_SERVING'
  | 'INVALID_BASIS'
  | 'INVALID_NUTRIENT_VALUE'
  | 'INTEGER_OVERFLOW';

export class NutritionCalculationError extends Error {
  constructor(readonly code: NutritionCalculationErrorCode) {
    super(code);
    this.name = 'NutritionCalculationError';
  }
}

const NUTRIENT_KEYS: NutritionValueKey[] = [
  'energyMillicalories',
  'carbohydrateMg',
  'proteinMg',
  'fatMg',
  'fiberMg',
];

export function convertAmountToGramsMg(input: {
  amountMilliunits: number;
  unit: ServingUnit;
  serving?: ServingConversion;
}) {
  assertPositiveInteger(input.amountMilliunits, 'INVALID_AMOUNT');

  if (input.unit === 'g') {
    return input.amountMilliunits;
  }
  if (!input.serving) {
    throw new NutritionCalculationError('SERVING_REQUIRED');
  }
  if (input.serving.unit !== input.unit) {
    throw new NutritionCalculationError('SERVING_UNIT_MISMATCH');
  }
  assertPositiveInteger(input.serving.amountMilliunits, 'INVALID_SERVING');
  assertPositiveInteger(input.serving.gramsMg, 'INVALID_SERVING');

  return divideAndRoundHalfUp(
    BigInt(input.amountMilliunits) * BigInt(input.serving.gramsMg),
    BigInt(input.serving.amountMilliunits),
  );
}

export function calculateItemNutrition(
  gramsMg: number,
  nutrientProfile: NutrientProfileValues,
): CalculatedNutritionValues {
  assertPositiveInteger(gramsMg, 'INVALID_AMOUNT');
  assertPositiveInteger(nutrientProfile.basisAmountMg, 'INVALID_BASIS');

  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => {
      const value = nutrientProfile[key];
      if (value === null) return [key, null];
      assertNonnegativeInteger(value, 'INVALID_NUTRIENT_VALUE');
      return [
        key,
        divideAndRoundHalfUp(
          BigInt(gramsMg) * BigInt(value),
          BigInt(nutrientProfile.basisAmountMg),
        ),
      ];
    }),
  ) as unknown as CalculatedNutritionValues;
}

export function calculateMealNutrition(inputs: MealNutritionInput[]): MealNutritionResult {
  const items = inputs.map((input) => {
    const gramsMg = convertAmountToGramsMg(input);
    return {
      mealItemId: input.mealItemId,
      gramsMg,
      nutrients: calculateItemNutrition(gramsMg, input.nutrientProfile),
    };
  });

  const totals = Object.fromEntries(
    NUTRIENT_KEYS.map((key) => {
      let knownValue = 0n;
      let missingItemCount = 0;

      for (const item of items) {
        const value = item.nutrients[key];
        if (value === null) {
          missingItemCount += 1;
        } else {
          knownValue += BigInt(value);
        }
      }

      const knownValueNumber = safeBigIntToNumber(knownValue);
      const completeness = missingItemCount === 0 ? 'complete' : 'partial';
      return [
        key,
        {
          value: completeness === 'complete' ? knownValueNumber : null,
          knownValue: knownValueNumber,
          missingItemCount,
          completeness,
        },
      ];
    }),
  ) as unknown as Record<NutritionValueKey, NutrientAggregate>;

  return { items, totals };
}

function divideAndRoundHalfUp(numerator: bigint, denominator: bigint) {
  return safeBigIntToNumber((numerator + denominator / 2n) / denominator);
}

function safeBigIntToNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NutritionCalculationError('INTEGER_OVERFLOW');
  }
  return Number(value);
}

function assertPositiveInteger(value: number, code: NutritionCalculationErrorCode) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NutritionCalculationError(code);
  }
}

function assertNonnegativeInteger(value: number, code: NutritionCalculationErrorCode) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NutritionCalculationError(code);
  }
}
