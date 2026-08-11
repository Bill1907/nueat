import { apiRequest } from '@/api/client';
import {
  inferMealType,
  type MealType,
  type MealUnit,
} from '@/meals/meal-draft-policy';
import type { RecognitionStatus } from '@/meals/meal-recognition-policy';

export { inferMealType };
export type { MealType, MealUnit };

export interface MealDraft {
  id: string;
  eatenAt: string;
  timezone: string;
  localDate: string;
  mealType: MealType;
  status: 'draft' | 'confirmed';
  imageAssetId: string | null;
  recognitionStatus: RecognitionStatus;
  recognitionProvider: string | null;
  recognitionModel: string | null;
  recognitionPromptVersion: string | null;
  recognitionSchemaVersion: string | null;
  recognitionCompletedAt: string | null;
  recognitionLastErrorCode: string | null;
  recognitionAttemptCount: number;
  recognitionNextAttemptAt: string | null;
}

export interface MealDraftItem {
  id: string;
  recognizedLabel: string;
  amountMilliunits: number;
  unit: MealUnit;
  recognitionConfidenceBps: number | null;
  portionConfidenceBps: number | null;
  userCorrected: boolean;
  foodId: string | null;
  nutrientProfileId: string | null;
  mappingConfidenceBps: number | null;
}

export interface MealDraftResponse {
  mealLog: MealDraft;
  items: MealDraftItem[];
}
export interface ConfirmedNutrientValue {
  value: number | null;
  knownValue: number;
  missingItemCount: number;
  completeness: 'complete' | 'partial';
}

export interface ConfirmedMealNutritionItem {
  mealItemId: string;
  gramsMg: number;
  nutrients: {
    energyMillicalories: number | null;
    carbohydrateMg: number | null;
    proteinMg: number | null;
    fatMg: number | null;
    fiberMg: number | null;
  };
  source: {
    foodId: string;
    nutrientProfileId: string;
    sourceRegistryId: string;
    sourceItemId: string;
    datasetVersion: string;
    qualityGrade: string;
    servingId: string | null;
    servingSourceRegistryId: string | null;
    servingQualityGrade: string | null;
  };
}

export interface ConfirmedMealNutrition {
  id: string;
  calculationVersion: string;
  calculatedAt: string;
  items: ConfirmedMealNutritionItem[];
  totals: Record<
    'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
    ConfirmedNutrientValue
  >;
}

export interface ConfirmMealDraftResponse {
  mealLog: MealDraft;
  items: MealDraftItem[];
  nutrition: ConfirmedMealNutrition;
}

export interface CreateMealDraftInput {
  imageAssetId: string;
  eatenAt: string;
  timezone: string;
  mealType: MealType;
}

export interface MealDraftItemInput {
  recognizedLabel: string;
  amountMilliunits: number;
  unit: MealUnit;
}

export function createMealDraft(input: CreateMealDraftInput) {
  return apiRequest<MealDraftResponse>('/api/meal-logs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getMealDraft(mealLogId: string, signal?: AbortSignal) {
  return apiRequest<MealDraftResponse>(`/api/meal-logs/${mealLogId}`, {
    signal,
  });
}

export function retryMealDraftRecognition(mealLogId: string) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/recognition/retry`,
    { method: 'POST' },
  );
}

export function startManualMealDraftEntry(mealLogId: string) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/recognition/manual`,
    { method: 'POST' },
  );
}

export function addMealDraftItem(mealLogId: string, input: MealDraftItemInput) {
  return apiRequest<MealDraftResponse>(`/api/meal-logs/${mealLogId}/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateMealDraftItem(
  mealLogId: string,
  itemId: string,
  input: Partial<MealDraftItemInput>,
) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/items/${itemId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}

export function deleteMealDraftItem(mealLogId: string, itemId: string) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/items/${itemId}`,
    { method: 'DELETE' },
  );
}
export function mapMealDraftItemFood(
  mealLogId: string,
  itemId: string,
  foodId: string,
) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/items/${itemId}/food`,
    {
      method: 'PUT',
      body: JSON.stringify({ foodId }),
    },
  );
}
export function confirmMealDraft(mealLogId: string) {
  return apiRequest<ConfirmMealDraftResponse>(
    `/api/meal-logs/${mealLogId}/confirm`,
    { method: 'POST' },
  );
}

export interface MealImageDownloadIntent {
  downloadUrl: string;
  expiresAt: string;
}

export function getMealImageDownloadIntent(
  imageAssetId: string,
  signal?: AbortSignal,
) {
  return apiRequest<MealImageDownloadIntent>(
    `/api/image-assets/${imageAssetId}/download-intent`,
    { method: 'POST', signal },
  );
}
