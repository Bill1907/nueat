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
  draftRevision: number;
  confirmedAt: string | null;
  recognitionOutcome: 'recognized' | 'no_food' | 'insufficient_evidence' | null;
  recognitionEvidenceReason: string | null;
  recognitionManualOverride: {
    decision: 'direct_entry';
    decisionVersion: string;
    fromStatus: RecognitionStatus;
    fromOutcome: 'recognized' | 'no_food' | 'insufficient_evidence' | null;
    fromErrorCode: string | null;
    expectedDraftRevision: number;
    actorUserId: string;
    decidedAt: string;
    changedFields: string[];
  } | null;
}

export interface MealDraftItem {
  id: string;
  recognizedLabel: string;
  amountMilliunits: number;
  unit: MealUnit;
  estimatedAmountMilliunits: number | null;
  estimatedUnit: MealUnit | null;
  recognitionRegionIndex: number | null;
  recognitionConfidenceBps: number | null;
  portionConfidenceBps: number | null;
  userCorrected: boolean;
  foodId: string | null;
  nutrientProfileId: string | null;
  mappingConfidenceBps: number | null;
  gramsMg: number | null;
  currentResolutionSource:
    | 'model_primary'
    | 'model_alternative'
    | 'user_selected'
    | 'legacy_existing'
    | null;
  itemRevision: number;
  foodRevision: number;
  portionRevision: number;
  foodAcknowledgedRevision: number | null;
  portionAcknowledgedRevision: number | null;
  origin: 'model_estimate' | 'manual_entry' | 'user_added' | 'legacy_unknown';
  initialAssessment: unknown | null;
  currentResolution: {
    status: 'resolved' | 'unresolved';
    reason: string | null;
  } | null;
}

export interface MealDraftResponse {
  mealLog: MealDraft;
  items: MealDraftItem[];
  review: MealDraftReview;
}
export type MealReviewReason =
  | 'NO_FOOD_DETECTED'
  | 'INSUFFICIENT_IMAGE_EVIDENCE'
  | 'IMAGE_QUALITY_LOW'
  | 'QUICK_CONFIRM_POLICY_DISABLED'
  | 'FOOD_CONFIDENCE_LOW'
  | 'FOOD_CANDIDATE_MARGIN_LOW'
  | 'MODEL_FOOD_QUESTION'
  | 'INITIAL_ALTERNATIVE_MAPPING'
  | 'PORTION_CONFIDENCE_LOW'
  | 'MODEL_PORTION_QUESTION'
  | 'LEGACY_REVIEW_REQUIRED'
  | 'FOOD_MAPPING_MISSING'
  | 'FOOD_NOT_FOUND'
  | 'FOOD_DEPRECATED'
  | 'NUTRIENT_PROFILE_MISSING'
  | 'NUTRIENT_PROFILE_MISMATCHED'
  | 'NUTRIENT_PROFILE_UNTRUSTED'
  | 'CORE_NUTRIENTS_MISSING'
  | 'SERVING_CONVERSION_MISSING'
  | 'SERVING_CONVERSION_AMBIGUOUS'
  | 'SERVING_CONVERSION_UNTRUSTED'
  | 'CATALOG_SEARCH_EMPTY'
  | 'EMPTY_MEAL';

export interface MealDraftReview {
  confirmable: boolean;
  reasons: { code: MealReviewReason | string; itemId: string | null }[];
  requiredReviewFields: {
    itemId: string;
    fields: ('food' | 'portion')[];
  }[];
  nutrition: ConfirmedMealNutrition | null;
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

export function startManualMealDraftEntry(
  mealLogId: string,
  expectedDraftRevision: number,
) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/recognition/manual`,
    {
      method: 'POST',
      body: JSON.stringify({ expectedDraftRevision }),
    },
  );
}

export function addMealDraftItem(
  mealLogId: string,
  input: MealDraftItemInput & { expectedDraftRevision: number },
) {
  return apiRequest<MealDraftResponse>(`/api/meal-logs/${mealLogId}/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateMealDraftItem(
  mealLogId: string,
  itemId: string,
  input: Partial<MealDraftItemInput> & { expectedItemRevision: number },
) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/items/${itemId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}

export function deleteMealDraftItem(
  mealLogId: string,
  itemId: string,
  input: { expectedDraftRevision: number; expectedItemRevision: number },
) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/items/${itemId}`,
    { method: 'DELETE', body: JSON.stringify(input) },
  );
}
export function mapMealDraftItemFood(
  mealLogId: string,
  itemId: string,
  foodId: string,
  expectedItemRevision: number,
) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/items/${itemId}/food`,
    {
      method: 'PUT',
      body: JSON.stringify({ foodId, expectedItemRevision }),
    },
  );
}
export function reviewMealDraft(
  mealLogId: string,
  input: {
    expectedDraftRevision: number;
    items: {
      itemId: string;
      expectedItemRevision: number;
      foodAcknowledgedRevision?: number;
      portionAcknowledgedRevision?: number;
    }[];
  },
) {
  return apiRequest<MealDraftResponse>(`/api/meal-logs/${mealLogId}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function confirmMealDraft(
  mealLogId: string,
  input: {
    expectedDraftRevision: number;
    items: { itemId: string; expectedItemRevision: number }[];
  },
) {
  return apiRequest<ConfirmMealDraftResponse>(
    `/api/meal-logs/${mealLogId}/confirm`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}
export function deleteMealDraft(mealLogId: string, expectedDraftRevision: number) {
  return apiRequest<MealDraftResponse>(`/api/meal-logs/${mealLogId}`, {
    method: 'DELETE',
    body: JSON.stringify({ expectedDraftRevision }),
  });
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
