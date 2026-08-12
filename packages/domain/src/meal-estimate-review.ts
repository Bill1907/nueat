import type { ServingUnit } from './meal-nutrition';

export const MEAL_ESTIMATE_REVIEW_POLICY_VERSION = 'meal-estimate-review-v1';
export const MEAL_ESTIMATE_REVIEW_THRESHOLDS = {
  minImageQualityConfidenceBps: 7_000,
  minFoodConfidenceBps: 7_000,
  minFoodCandidateMarginBps: 1_000,
  minPortionConfidenceBps: 7_000,
} as const;

export type MealItemOrigin = 'model_estimate' | 'manual_entry' | 'user_added' | 'legacy_unknown';
export type MealItemMappingSource =
  | 'model_primary'
  | 'model_alternative'
  | 'user_selected'
  | 'legacy_existing'
  | null;
export type RecognitionEvidenceReason =
  | 'blurred'
  | 'too_dark'
  | 'occluded'
  | 'not_meal_photo'
  | 'other';
export type MealEstimateReviewReason =
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

export type AcknowledgeableMealEstimateReviewReason = Exclude<
  MealEstimateReviewReason,
  | 'NO_FOOD_DETECTED'
  | 'INSUFFICIENT_IMAGE_EVIDENCE'
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
  | 'EMPTY_MEAL'
>;

export interface RecognitionQuestionV2 {
  target: 'food' | 'portion';
  question: string;
}

export interface RecognitionAlternativeV2 {
  normalizedLabel: string;
  confidenceBps: number;
}

export interface RecognitionFoodV2 {
  regionIndex: number;
  rawLabel: string;
  normalizedLabel: string;
  foodConfidenceBps: number;
  amountMilliunits: number;
  unit: ServingUnit;
  portionConfidenceBps: number;
  questions: RecognitionQuestionV2[];
  alternatives: RecognitionAlternativeV2[];
}

export type RecognitionResultV2 =
  | {
      outcome: 'recognized';
      imageQualityConfidenceBps: number;
      foods: RecognitionFoodV2[];
    }
  | {
      outcome: 'no_food';
      imageQualityConfidenceBps: number;
      foods: [];
    }
  | {
      outcome: 'insufficient_evidence';
      imageQualityConfidenceBps: number;
      evidenceReason: RecognitionEvidenceReason;
      foods: [];
    };

export interface ManualRecognitionOverride {
  fromStatus: 'ready';
  fromOutcome: 'no_food' | 'insufficient_evidence';
  decision: 'direct_entry';
  decidedAt: string;
  decisionVersion: 'recognition-manual-override-v1';
}

export interface MealEstimateReviewPolicy {
  version: string;
  activation: 'review_only' | 'quick_confirm';
  minImageQualityConfidenceBps: number;
  minFoodConfidenceBps: number;
  minFoodCandidateMarginBps: number;
  minPortionConfidenceBps: number;
}

export interface InitialEstimateAssessment {
  rawLabel: string;
  normalizedLabel: string;
  foodConfidenceBps: number;
  portionConfidenceBps: number;
  foodCandidateMarginBps: number | null;
  questions: RecognitionQuestionV2[];
  alternatives: RecognitionAlternativeV2[];
  initialMappingSource: Exclude<MealItemMappingSource, null> | null;
  initialMatchedLabel: string | null;
  policyVersion: string;
}

export interface CurrentMealItemResolution {
  mappingSource: MealItemMappingSource;
  foodId: string | null;
  nutrientProfileId: string | null;
  hardReasons: readonly string[];
  requiresServingConversion: boolean;
  hasTrustedServingConversion: boolean;
  hasCoreNutrients: boolean;
}

export interface MealEstimateItemReviewInput {
  origin: MealItemOrigin;
  itemRevision: number;
  foodRevision: number;
  portionRevision: number;
  foodAcknowledgedRevision: number | null;
  portionAcknowledgedRevision: number | null;
  initialEstimateAssessment: InitialEstimateAssessment | null;
  currentResolution: CurrentMealItemResolution;
  imageQualityConfidenceBps: number | null;
  policy: MealEstimateReviewPolicy;
}

export interface MealEstimateItemReviewState {
  reasons: MealEstimateReviewReason[];
  foodReasons: MealEstimateReviewReason[];
  portionReasons: MealEstimateReviewReason[];
  foodAcknowledged: boolean;
  portionAcknowledged: boolean;
  quickEligible: boolean;
}

export interface MealEstimateReviewItem {
  review: MealEstimateItemReviewState;
  origin: MealItemOrigin;
}

export interface MealEstimateReviewInput {
  recognition: RecognitionResultV2 | null;
  recognitionStatus: 'pending' | 'processing' | 'ready' | 'failed' | 'manual';
  manualOverride: ManualRecognitionOverride | null;
  items: readonly MealEstimateReviewItem[];
  policy: MealEstimateReviewPolicy;
}

export interface MealEstimateReviewState {
  reasons: MealEstimateReviewReason[];
  quickEligible: boolean;
  requiresRetake: boolean;
}

const HARD_REASONS = new Set<MealEstimateReviewReason>([
  'FOOD_MAPPING_MISSING',
  'FOOD_NOT_FOUND',
  'FOOD_DEPRECATED',
  'NUTRIENT_PROFILE_MISSING',
  'NUTRIENT_PROFILE_MISMATCHED',
  'NUTRIENT_PROFILE_UNTRUSTED',
  'CORE_NUTRIENTS_MISSING',
  'SERVING_CONVERSION_MISSING',
  'SERVING_CONVERSION_AMBIGUOUS',
  'SERVING_CONVERSION_UNTRUSTED',
  'CATALOG_SEARCH_EMPTY',
]);

const KNOWN_REASONS = new Set<MealEstimateReviewReason>([
  'NO_FOOD_DETECTED',
  'INSUFFICIENT_IMAGE_EVIDENCE',
  'IMAGE_QUALITY_LOW',
  'QUICK_CONFIRM_POLICY_DISABLED',
  'FOOD_CONFIDENCE_LOW',
  'FOOD_CANDIDATE_MARGIN_LOW',
  'MODEL_FOOD_QUESTION',
  'INITIAL_ALTERNATIVE_MAPPING',
  'PORTION_CONFIDENCE_LOW',
  'MODEL_PORTION_QUESTION',
  'LEGACY_REVIEW_REQUIRED',
  ...HARD_REASONS,
  'EMPTY_MEAL',
]);

export function assessInitialEstimate(
  food: RecognitionFoodV2,
  initialMappingSource: Exclude<MealItemMappingSource, null> | null,
  initialMatchedLabel: string | null,
  policy: MealEstimateReviewPolicy,
): InitialEstimateAssessment {
  const runnerUp = food.alternatives[0];
  return {
    rawLabel: food.rawLabel,
    normalizedLabel: food.normalizedLabel,
    foodConfidenceBps: food.foodConfidenceBps,
    portionConfidenceBps: food.portionConfidenceBps,
    foodCandidateMarginBps: runnerUp ? food.foodConfidenceBps - runnerUp.confidenceBps : null,
    questions: food.questions,
    alternatives: food.alternatives,
    initialMappingSource,
    initialMatchedLabel,
    policyVersion: policy.version,
  };
}

export function deriveItemReviewState(input: MealEstimateItemReviewInput): MealEstimateItemReviewState {
  const foodReasons = new Set<MealEstimateReviewReason>();
  const portionReasons = new Set<MealEstimateReviewReason>();
  const assessment = input.initialEstimateAssessment;

  for (const reason of input.currentResolution.hardReasons) {
    if (isReviewReason(reason)) {
      if (reason.startsWith('SERVING_')) portionReasons.add(reason);
      else foodReasons.add(reason);
    } else {
      foodReasons.add('FOOD_MAPPING_MISSING');
    }
  }
  if (!input.currentResolution.foodId || !input.currentResolution.nutrientProfileId) {
    foodReasons.add('FOOD_MAPPING_MISSING');
  }
  if (!input.currentResolution.hasCoreNutrients) foodReasons.add('CORE_NUTRIENTS_MISSING');
  if (input.currentResolution.requiresServingConversion && !input.currentResolution.hasTrustedServingConversion) {
    portionReasons.add('SERVING_CONVERSION_MISSING');
  }

  if (input.origin === 'legacy_unknown') {
    foodReasons.add('LEGACY_REVIEW_REQUIRED');
    portionReasons.add('LEGACY_REVIEW_REQUIRED');
  }
  if (input.origin === 'model_estimate' && !assessment) {
    foodReasons.add('FOOD_MAPPING_MISSING');
    portionReasons.add('SERVING_CONVERSION_MISSING');
  }
  if (input.origin === 'model_estimate' && assessment) {
    if (input.imageQualityConfidenceBps === null || input.imageQualityConfidenceBps < input.policy.minImageQualityConfidenceBps) {
      foodReasons.add('IMAGE_QUALITY_LOW');
      portionReasons.add('IMAGE_QUALITY_LOW');
    }
    if (assessment.foodConfidenceBps < input.policy.minFoodConfidenceBps) foodReasons.add('FOOD_CONFIDENCE_LOW');
    if (
      assessment.foodCandidateMarginBps !== null &&
      assessment.foodCandidateMarginBps < input.policy.minFoodCandidateMarginBps
    ) {
      foodReasons.add('FOOD_CANDIDATE_MARGIN_LOW');
    }
    if (assessment.questions.some((question) => question.target === 'food')) foodReasons.add('MODEL_FOOD_QUESTION');
    if (assessment.questions.some((question) => question.target === 'portion')) portionReasons.add('MODEL_PORTION_QUESTION');
    if (assessment.portionConfidenceBps < input.policy.minPortionConfidenceBps) portionReasons.add('PORTION_CONFIDENCE_LOW');
    if (assessment.initialMappingSource === 'model_alternative') foodReasons.add('INITIAL_ALTERNATIVE_MAPPING');
  }

  const foodAcknowledged = input.foodAcknowledgedRevision === input.foodRevision;
  const portionAcknowledged = input.portionAcknowledgedRevision === input.portionRevision;
  const unresolvedFoodReasons = [...foodReasons].filter((reason) => HARD_REASONS.has(reason) || !foodAcknowledged);
  const unresolvedPortionReasons = [...portionReasons].filter((reason) => HARD_REASONS.has(reason) || !portionAcknowledged);
  const reasons = uniqueReasons([...unresolvedFoodReasons, ...unresolvedPortionReasons]);

  return {
    reasons,
    foodReasons: uniqueReasons(unresolvedFoodReasons),
    portionReasons: uniqueReasons(unresolvedPortionReasons),
    foodAcknowledged,
    portionAcknowledged,
    quickEligible: reasons.length === 0,
  };
}

export function deriveMealReviewState(input: MealEstimateReviewInput): MealEstimateReviewState {
  const reasons = new Set<MealEstimateReviewReason>();
  const validOverride = hasValidManualOverride(input.recognition, input.recognitionStatus, input.manualOverride);

  if (input.recognition?.outcome === 'no_food' && !validOverride) reasons.add('NO_FOOD_DETECTED');
  if (input.recognition?.outcome === 'insufficient_evidence' && !validOverride) reasons.add('INSUFFICIENT_IMAGE_EVIDENCE');
  if (
    input.policy.activation !== 'quick_confirm' &&
    input.items.some(
      (item) =>
        item.origin === 'model_estimate' &&
        (!item.review.foodAcknowledged || !item.review.portionAcknowledged),
    )
  ) {
    reasons.add('QUICK_CONFIRM_POLICY_DISABLED');
  }
  if (input.items.length === 0) reasons.add('EMPTY_MEAL');
  for (const item of input.items) {
    for (const reason of item.review.reasons) reasons.add(reason);
  }

  const allReasons = uniqueReasons([...reasons]);
  return {
    reasons: allReasons,
    quickEligible: allReasons.length === 0 && input.policy.activation === 'quick_confirm',
    requiresRetake: allReasons.includes('NO_FOOD_DETECTED') || allReasons.includes('INSUFFICIENT_IMAGE_EVIDENCE'),
  };
}

export function hasValidManualOverride(
  recognition: RecognitionResultV2 | null,
  recognitionStatus: MealEstimateReviewInput['recognitionStatus'],
  override: ManualRecognitionOverride | null,
) {
  return (
    recognitionStatus === 'manual' &&
    override?.fromStatus === 'ready' &&
    override.decision === 'direct_entry' &&
    override.decisionVersion === 'recognition-manual-override-v1' &&
    (override.fromOutcome === 'no_food' || override.fromOutcome === 'insufficient_evidence') &&
    recognition !== null &&
    recognition.outcome === override.fromOutcome
  );
}

export function isReviewReason(value: string): value is MealEstimateReviewReason {
  return KNOWN_REASONS.has(value as MealEstimateReviewReason);
}

function uniqueReasons(reasons: Iterable<MealEstimateReviewReason>) {
  return [...new Set(reasons)].sort();
}
