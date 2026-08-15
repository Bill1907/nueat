import { apiRequest } from '@/api/client';
import {
  inferMealType,
  type MealType,
  type MealUnit,
} from '@/meals/meal-draft-policy';
import type { RecognitionStatus } from '@/meals/meal-recognition-policy';

export { inferMealType };
export type { MealType, MealUnit };

export type RecognitionRecovery =
  | {
      mode: 'none';
      reason: 'in_progress' | 'recognition_complete' | 'not_applicable';
      retryAt: null;
    }
  | { mode: 'retry_now'; reason: 'recoverable_failure'; retryAt: null }
  | {
      mode: 'retry_after';
      reason: 'cooldown' | 'daily_quota';
      retryAt: string;
    }
  | {
      mode: 'manual_only';
      reason: 'asset_unavailable' | 'recovery_exhausted' | 'terminal_failure';
      retryAt: null;
    };

interface MealLogBase {
  id: string;
  eatenAt: string;
  timezone: string;
  localDate: string;
  mealType: MealType;
  imageAssetId: string | null;
  recognitionStatus: RecognitionStatus;
  recognitionRecovery?: RecognitionRecovery;
  draftRevision: number;
  recognitionOutcome: 'recognized' | 'no_food' | 'insufficient_evidence' | null;
  recognitionEvidenceReason: string | null;
}

export interface DraftMealLog extends MealLogBase {
  status: 'draft';
  confirmedAt: null;
}

export interface ConfirmedMealLog {
  id: string;
  eatenAt: string;
  timezone: string;
  localDate: string;
  mealType: MealType;
  status: 'confirmed';
  confirmedAt: string | null;
}

export type MealDraft = DraftMealLog | ConfirmedMealLog;

export interface MealDraftItemReview {
  status: 'current' | 'required';
  checkpoint: {
    reviewedItemRevision: number;
    authorityFingerprintVersion: string;
    authorityFingerprint: string;
    reviewedAt: string;
  } | null;
  authority: {
    fingerprintVersion: string;
    fingerprint: string | null;
    officialSource: unknown | null;
    invalidReason: string | null;
  };
  nextAction: 'review_item' | null;
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
  origin: 'model_estimate' | 'manual_entry' | 'user_added' | 'legacy_unknown';
  initialAssessment: unknown | null;
  review: MealDraftItemReview;
  confirmationProof:
    | {
        mappingDecisionId: string;
        calculationPreviewId: string;
        decompositionRevisionId?: string;
      }
    | null;
}

export interface DraftMealDraftResponse {
  mealLog: DraftMealLog;
  items: MealDraftItem[];
  review: MealDraftReview;
}
export type MealReviewReason =
  | 'NO_FOOD_DETECTED'
  | 'INSUFFICIENT_IMAGE_EVIDENCE'
  | 'IMAGE_QUALITY_LOW'

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
  nutrition: ReviewedMealNutrition;
}
export interface ReviewedNutrientValue {
  value: number | null;
  knownValue: number;
  missingItemCount: number;
  status: 'pending' | 'subtotal' | 'complete';
}
export interface ReviewedMealNutrition {
  status: 'pending' | 'subtotal' | 'complete';
  reviewedItemCount: number;
  unreviewedItemCount: number;
  totals: Record<
    'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
    ReviewedNutrientValue
  >;
}
export interface ConfirmedNutrientValue {
  value: number | null;
  knownValue: number;
  missingItemCount: number;
  completeness: 'complete' | 'partial';
}

export interface ConfirmedMealNutritionItem {
  mealItemId: string;
  amountMilliunits: number;
  unit: MealUnit;
  gramsMg: number | null;
  nutrients: {
    energyMillicalories: number | null;
    carbohydrateMg: number | null;
    proteinMg: number | null;
    fatMg: number | null;
    fiberMg: number | null;
  };
  calculationPreview: unknown | null;
  source: {
    foodId: string | null;
    nutrientProfileId: string | null;
    sourceRegistryId: string | null;
    sourceItemId: string | null;
    datasetVersion: string | null;
    qualityGrade: string | null;
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

export interface ConfirmedMealDraftItem {
  mealItemId: string;
  foodId: string | null;
  nutrientProfileId: string | null;
  nutrients: ConfirmedMealNutritionItem['nutrients'];
  provenance: {
    calculationVersion: string;
    sourceRegistryId: string | null;
    sourceItemId: string | null;
    datasetVersion: string | null;
    nutrientProfileId: string | null;
  };
  checkpoint: {
    reviewedItemRevision: number;
    reviewedAuthorityFingerprintVersion: string;
    reviewedAuthorityFingerprint: string;
    reviewIdempotencyKey: string;
    reviewRequestFingerprint: string;
    reviewedAt: string;
  } | null;
  authority: {
    fingerprintVersion: string;
    fingerprint: string;
  } | null;
}

export interface ConfirmedMealDraftReview {
  confirmable: false;
  evidence: 'legacy_unknown' | 'explicit_v2';
  reasons: [];
}

export interface ConfirmedMealDraftResponse {
  mealLog: ConfirmedMealLog;
  items: ConfirmedMealDraftItem[];
  review: ConfirmedMealDraftReview;
  nutrition: ConfirmedMealNutrition;
}

/** GET returns either an editable draft review or an immutable nutrition snapshot. */
export type MealDraftResponse =
  | DraftMealDraftResponse
  | ConfirmedMealDraftResponse;

export type ConfirmMealDraftResponse = ConfirmedMealDraftResponse;

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
  return apiRequest<DraftMealDraftResponse>('/api/meal-logs', {
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
export function reviewMealDraftItem(
  mealLogId: string,
  itemId: string,
  input: {
    expectedDraftRevision: number;
    expectedItemRevision: number;
    idempotencyKey: string;
    displayedAuthorityFingerprintVersion: string;
    displayedAuthorityFingerprint: string;
  },
) {
  return apiRequest<MealDraftResponse>(
    `/api/meal-logs/${mealLogId}/items/${itemId}/review`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export type ConfirmMealDraftInput = {
  expectedDraftRevision: number;
  idempotencyKey: string;
  items: (
    | {
        itemId: string;
        expectedItemRevision: number;
        mappingDecisionId: string;
        calculationPreviewId: string;
        decompositionRevisionId?: string;
      }
    | {
        itemId: string;
        expectedItemRevision: number;
      }
  )[];
};

export function confirmMealDraft(mealLogId: string, input: ConfirmMealDraftInput) {
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
