import { apiRequest } from '@/api/client';
import {
  inferMealType,
  type MealType,
  type MealUnit,
} from '@/meals/meal-draft-policy';

export { inferMealType };
export type { MealType, MealUnit };

export interface MealDraft {
  id: string;
  eatenAt: string;
  timezone: string;
  localDate: string;
  mealType: MealType;
  status: 'draft';
  imageAssetId: string;
  recognitionStatus: 'ready';
  recognitionEngineVersion: 'mock-recognition-v1';
}

export interface MealDraftItem {
  id: string;
  recognizedLabel: string;
  amountMilliunits: number;
  unit: MealUnit;
  recognitionConfidenceBps: number | null;
  portionConfidenceBps: number | null;
  userCorrected: boolean;
}

export interface MealDraftResponse {
  mealLog: MealDraft;
  items: MealDraftItem[];
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

export function getMealDraft(mealLogId: string) {
  return apiRequest<MealDraftResponse>(`/api/meal-logs/${mealLogId}`);
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

export interface MealImageDownloadIntent {
  downloadUrl: string;
  expiresAt: string;
}

export function getMealImageDownloadIntent(imageAssetId: string) {
  return apiRequest<MealImageDownloadIntent>(
    `/api/image-assets/${imageAssetId}/download-intent`,
    { method: 'POST' },
  );
}
