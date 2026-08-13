export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type MealUnit = 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
export const nutritionKeys = [
  'energyMillicalories',
  'carbohydrateMg',
  'proteinMg',
  'fatMg',
  'fiberMg',
] as const;

export type NutritionKey = (typeof nutritionKeys)[number];
export type MealCalculationBasis =
  | 'finished_profile'
  | 'source_recipe'
  | 'meal_decomposition';

/** A composite root has one basis; its finished-dish nutrients are never added
 * to the reviewed component leaves. */
export function mealCalculationBasisLabel(
  basis: MealCalculationBasis | null,
) {
  switch (basis) {
    case 'meal_decomposition':
      return '검토한 구성 재료 기준';
    case 'source_recipe':
      return '출처 레시피 기준';
    case 'finished_profile':
      return '완성 음식 기준';
    default:
      return null;
  }
}

export interface PreviewNutrientProfile {
  id: string;
  basisAmountMg: number;
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
}

export interface PreviewServing {
  unit: string;
  amountMilliunits: number;
  gramsMg: number;
}

export interface NutritionPreviewItem {
  id: string;
  amountMilliunits: number;
  unit: MealUnit;
  foodId: string | null;
  nutrientProfileId: string | null;
  food: {
    id: string;
    nutrientProfile: PreviewNutrientProfile;
    servings: PreviewServing[];
  } | null;
}
export interface PersistedMealDraftItemForForm {
  id: string;
  recognizedLabel: string;
  amountMilliunits: number;
  unit: MealUnit;
}

export interface MealDraftItemFormForComparison {
  recognizedLabel: string;
  amount: string;
  unit: MealUnit;
}

export function hasUnsavedMealDraftItemForms(
  items: PersistedMealDraftItemForForm[],
  forms: Record<string, MealDraftItemFormForComparison | undefined>,
) {
  return items.some((item) => {
    const form = forms[item.id];
    return (
      form === undefined ||
      form.recognizedLabel !== item.recognizedLabel ||
      form.amount !== (item.amountMilliunits / 1000).toString() ||
      form.unit !== item.unit
    );
  });
}

export interface NutritionPreview {
  confirmable: boolean;
  items: {
    itemId: string;
    gramsMg: number | null;
    status: 'ready' | 'needs-review';
    nutrients: Record<NutritionKey, number | null>;
  }[];
  totals: Record<
    NutritionKey,
    {
      value: number | null;
      knownValue: number | null;
      missingItemCount: number;
      completeness: 'complete' | 'partial';
    }
  >;
}

export function createNutritionPreview(items: NutritionPreviewItem[]): NutritionPreview {
  const previewItems = items.map((item) => {
    const gramsMg = previewGramsMg(item);
    const profile =
      item.food?.id === item.foodId &&
      item.food.nutrientProfile.id === item.nutrientProfileId
        ? item.food.nutrientProfile
        : null;
    const nutrients = calculatePreviewNutrients(gramsMg, profile);
    const coreNutrientsPresent = coreNutritionKeys.every(
      (key) => nutrients[key] !== null,
    );

    return {
      itemId: item.id,
      gramsMg,
      status:
        gramsMg !== null && coreNutrientsPresent
          ? ('ready' as const)
          : ('needs-review' as const),
      nutrients,
    };
  });
  let totalsOverflowed = false;
  const totals = Object.fromEntries(
    nutritionKeys.map((key) => {
      let knownValue = 0n;
      let missingItemCount = 0;
      for (const item of previewItems) {
        const value = item.nutrients[key];
        if (value === null) {
          missingItemCount += 1;
        } else {
          knownValue += BigInt(value);
        }
      }
      const knownValueNumber = safeBigIntToNumber(knownValue);
      if (knownValueNumber === null) totalsOverflowed = true;
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
  ) as NutritionPreview['totals'];

  return {
    confirmable:
      !totalsOverflowed &&
      items.length > 0 &&
      previewItems.every((item) => item.status === 'ready'),
    items: previewItems,
    totals,
  };
}

export function formatNutritionValue(value: number, key: NutritionKey) {
  const divisor = key === 'energyMillicalories' ? 1000 : 1000;
  const unit = key === 'energyMillicalories' ? 'kcal' : 'g';
  return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 3 }).format(value / divisor)} ${unit}`;
}

const coreNutritionKeys = [
  'energyMillicalories',
  'carbohydrateMg',
  'proteinMg',
  'fatMg',
] as const;

function calculatePreviewNutrients(
  gramsMg: number | null,
  profile: PreviewNutrientProfile | null,
) {
  return Object.fromEntries(
    nutritionKeys.map((key) => {
      const value = profile?.[key] ?? null;
      return [
        key,
        gramsMg !== null &&
        profile !== null &&
        isPositiveSafeInteger(profile.basisAmountMg) &&
        isNonnegativeSafeInteger(value)
          ? divideAndRoundHalfUp(
              BigInt(gramsMg) * BigInt(value),
              BigInt(profile.basisAmountMg),
            )
          : null,
      ];
    }),
  ) as Record<NutritionKey, number | null>;
}

function previewGramsMg(item: NutritionPreviewItem) {
  if (!isPositiveSafeInteger(item.amountMilliunits)) return null;
  if (item.unit === 'g') return item.amountMilliunits;
  const servings = item.food?.servings.filter(
    (serving) =>
      serving.unit === item.unit &&
      isPositiveSafeInteger(serving.amountMilliunits) &&
      isPositiveSafeInteger(serving.gramsMg),
  );
  if (!servings || servings.length !== 1) return null;
  return divideAndRoundHalfUp(
    BigInt(item.amountMilliunits) * BigInt(servings[0].gramsMg),
    BigInt(servings[0].amountMilliunits),
  );
}

function divideAndRoundHalfUp(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) return null;
  return safeBigIntToNumber((numerator + denominator / 2n) / denominator);
}

function safeBigIntToNumber(value: bigint) {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function isPositiveSafeInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export function inferMealType(date: Date): MealType {
  const hour = date.getHours();
  if (hour >= 5 && hour <= 10) return 'breakfast';
  if (hour >= 11 && hour <= 15) return 'lunch';
  if (hour >= 16 && hour <= 21) return 'dinner';
  return 'snack';
}

export function decimalToMilliunits(value: string) {
  const amount = Number(value.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const milliunits = Math.round(amount * 1000);
  return milliunits > 0 && Number.isSafeInteger(milliunits) ? milliunits : null;
}

export function mealUnitLabel(unit: MealUnit) {
  switch (unit) {
    case 'serving':
      return '인분';
    case 'bowl':
      return '공기';
    case 'piece':
      return '조각';
    default:
      return unit;
  }
}
