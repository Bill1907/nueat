import type {
  MealDraftItem,
  RecognitionRecovery,
} from '../../src/api/meal-drafts';

type RecognitionStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'manual';

export function mealDraftObservation(
  overrides: Partial<MealDraftItem> = {},
): MealDraftItem {
  return {
    id: 'observation-item',
    recognizedLabel: '비빔밥',
    amountMilliunits: 1_000,
    unit: 'bowl',
    estimatedAmountMilliunits: 1_000,
    estimatedUnit: 'bowl',
    recognitionRegionIndex: 0,
    recognitionConfidenceBps: 8_600,
    portionConfidenceBps: 7_200,
    userCorrected: false,
    foodId: null,
    nutrientProfileId: null,
    mappingConfidenceBps: null,
    gramsMg: null,
    currentResolutionSource: null,
    itemRevision: 1,
    foodRevision: 1,
    portionRevision: 1,
    origin: 'model_estimate',
    initialAssessment: null,
    review: {
      status: 'required',
      checkpoint: null,
      authority: {
        fingerprintVersion: 'meal-manual-review-authority-v1',
        fingerprint: 'a'.repeat(64),
        officialSource: null,
        invalidReason: null,
      },
      nextAction: 'review_item',
    },
    confirmationProof: null,
    ...overrides,
  };
}

export const mobileApiCompatibilityMatrix: Array<{
  name: string;
  recognitionStatus: RecognitionStatus;
  recovery?: RecognitionRecovery | Record<string, unknown>;
  observations: MealDraftItem[];
}> = [
  {
    name: 'current_known_recovery',
    recognitionStatus: 'ready',
    recovery: { mode: 'none', reason: 'recognition_complete', retryAt: null },
    observations: [mealDraftObservation()],
  },
  {
    name: 'previous_api_recovery_absent',
    recognitionStatus: 'ready',
    observations: [mealDraftObservation()],
  },
  {
    name: 'unsupported_recovery_union',
    recognitionStatus: 'ready',
    recovery: { mode: 'future_mode', reason: 'future_reason', retryAt: null },
    observations: [mealDraftObservation()],
  },
  {
    name: 'legacy_recovery_flags',
    recognitionStatus: 'ready',
    recovery: { canRetryRecognition: true },
    observations: [mealDraftObservation()],
  },
  {
    name: 'pending_without_observation',
    recognitionStatus: 'pending',
    observations: [],
  },
];
