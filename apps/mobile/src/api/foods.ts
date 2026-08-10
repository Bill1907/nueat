import { apiRequest } from '@/api/client';
export {
  isFoodMappingCurrent,
  normalizeKoreanFoodLabel,
} from '@/meals/food-selection-policy';

export interface FoodServing {
  id: string;
  unit: string;
  labelKo: string;
  amountMilliunits: number;
  gramsMg: number;
  qualityGrade: string;
}

export interface FoodNutrientProfile {
  id: string;
  sourceRegistryId: string;
  sourceCode: string;
  sourceDisplayName: string;
  sourceItemId: string;
  datasetVersion: string;
  basisAmountMg: number;
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
  qualityGrade: string;
}

export interface CanonicalFood {
  id: string;
  canonicalNameKo: string;
  category: string;
  preparation: string | null;
  nutrientProfile: FoodNutrientProfile;
  servings: FoodServing[];
}

export interface FoodSearchResponse {
  foods: CanonicalFood[];
}

export function searchFoods(query: string) {
  return apiRequest<FoodSearchResponse>(
    `/api/foods/search?q=${encodeURIComponent(query)}&limit=10`,
  );
}
