import { describe, expect, test } from 'bun:test';

import {
  assessInitialEstimate,
  deriveItemReviewState,
  deriveMealReviewState,
  isReviewReason,
  type CurrentMealItemResolution,
  type MealEstimateItemReviewInput,
  type MealEstimateReviewPolicy,
  type RecognitionFoodV2,
} from './meal-estimate-review';

const policy: MealEstimateReviewPolicy = {
  version: 'meal-estimate-review-v1',
  activation: 'quick_confirm',
  minImageQualityConfidenceBps: 8_000,
  minFoodConfidenceBps: 8_000,
  minFoodCandidateMarginBps: 500,
  minPortionConfidenceBps: 7_000,
};

const food: RecognitionFoodV2 = {
  regionIndex: 0,
  rawLabel: '쌀밥',
  normalizedLabel: '쌀밥',
  foodConfidenceBps: 9_000,
  amountMilliunits: 200_000,
  unit: 'g',
  portionConfidenceBps: 8_000,
  questions: [],
  alternatives: [],
};

const resolution: CurrentMealItemResolution = {
  mappingSource: 'model_primary',
  foodId: 'food-rice',
  nutrientProfileId: 'profile-rice',
  hardReasons: [],
  requiresServingConversion: false,
  hasTrustedServingConversion: false,
  hasCoreNutrients: true,
};

function itemInput(overrides: Partial<MealEstimateItemReviewInput> = {}): MealEstimateItemReviewInput {
  return {
    origin: 'model_estimate',
    itemRevision: 1,
    foodRevision: 1,
    portionRevision: 1,
    foodAcknowledgedRevision: 1,
    portionAcknowledgedRevision: 1,
    initialEstimateAssessment: assessInitialEstimate(food, 'model_primary', '쌀밥', policy),
    currentResolution: resolution,
    imageQualityConfidenceBps: 9_000,
    policy,
    ...overrides,
  };
}

describe('meal estimate review policy', () => {
  test('preserves ordered alternatives and derives only the primary-runner-up margin', () => {
    const assessment = assessInitialEstimate(
      {
        ...food,
        alternatives: [
          { normalizedLabel: '현미밥', confidenceBps: 8_400 },
          { normalizedLabel: '보리밥', confidenceBps: 8_100 },
        ],
      },
      'model_primary',
      '쌀밥',
      policy,
    );

    expect(assessment.alternatives.map((alternative) => alternative.normalizedLabel)).toEqual([
      '현미밥',
      '보리밥',
    ]);
    expect(assessment.foodCandidateMarginBps).toBe(600);
    expect(assessInitialEstimate(food, 'model_primary', '쌀밥', policy).foodCandidateMarginBps).toBeNull();
    expect(deriveItemReviewState(itemInput({ initialEstimateAssessment: assessment })).reasons).toEqual([]);
  });

  test('requires acknowledgement at the current revision for low confidence and model questions', () => {
    const assessment = assessInitialEstimate(
      {
        ...food,
        foodConfidenceBps: 7_999,
        portionConfidenceBps: 6_999,
        questions: [
          { target: 'food', question: '밥 종류를 확인해 주세요.' },
          { target: 'portion', question: '양을 확인해 주세요.' },
        ],
        alternatives: [{ normalizedLabel: '현미밥', confidenceBps: 7_500 }],
      },
      'model_alternative',
      '현미밥',
      policy,
    );
    const review = deriveItemReviewState(itemInput({
      foodAcknowledgedRevision: 0,
      portionAcknowledgedRevision: 0,
      initialEstimateAssessment: assessment,
    }));

    expect(review.foodReasons).toEqual([
      'FOOD_CANDIDATE_MARGIN_LOW',
      'FOOD_CONFIDENCE_LOW',
      'INITIAL_ALTERNATIVE_MAPPING',
      'MODEL_FOOD_QUESTION',
    ]);
    expect(review.portionReasons).toEqual(['MODEL_PORTION_QUESTION', 'PORTION_CONFIDENCE_LOW']);
    expect(review.quickEligible).toBeFalse();
  });

  test('allows a fiber-partial official profile but fail-closes missing mapping, core nutrients, serving, and unknown reasons', () => {
    expect(deriveItemReviewState(itemInput()).quickEligible).toBeTrue();

    const hard = deriveItemReviewState(itemInput({
      currentResolution: {
        ...resolution,
        foodId: null,
        nutrientProfileId: null,
        hasCoreNutrients: false,
        requiresServingConversion: true,
        hasTrustedServingConversion: false,
        hardReasons: ['FOOD_NOT_FOUND', 'unexpected_catalog_state'],
      },
    }));
    expect(hard.foodReasons).toEqual([
      'CORE_NUTRIENTS_MISSING',
      'FOOD_MAPPING_MISSING',
      'FOOD_NOT_FOUND',
    ]);
    expect(hard.portionReasons).toEqual(['SERVING_CONVERSION_MISSING']);
    expect(hard.quickEligible).toBeFalse();
  });

  test('keeps legacy and missing model provenance reviewable rather than auto-eligible', () => {
    expect(deriveItemReviewState(itemInput({
      origin: 'legacy_unknown',
      foodAcknowledgedRevision: null,
      portionAcknowledgedRevision: null,
    })).reasons).toEqual([
      'LEGACY_REVIEW_REQUIRED',
    ]);
    expect(deriveItemReviewState(itemInput({ initialEstimateAssessment: null })).reasons).toEqual([
      'FOOD_MAPPING_MISSING',
      'SERVING_CONVERSION_MISSING',
    ]);
  });
  test('applies model uncertainty only to model estimates, keeping direct-entry origins eligible when resolved', () => {
    for (const origin of ['manual_entry', 'user_added'] as const) {
      expect(deriveItemReviewState(itemInput({
        origin,
        initialEstimateAssessment: null,
        foodAcknowledgedRevision: null,
        portionAcknowledgedRevision: null,
      }))).toMatchObject({ reasons: [], quickEligible: true });
    }
  });

  test('requires a retake for immutable zero-item outcomes until an exact manual override, while retaining EMPTY_MEAL', () => {
    const noFood = { outcome: 'no_food' as const, imageQualityConfidenceBps: 9_000, foods: [] as [] };
    const insufficient = {
      outcome: 'insufficient_evidence' as const,
      imageQualityConfidenceBps: 9_000,
      evidenceReason: 'blurred' as const,
      foods: [] as [],
    };
    const override = {
      fromStatus: 'ready' as const,
      fromOutcome: 'no_food' as const,
      decision: 'direct_entry' as const,
      decidedAt: '2026-08-11T00:00:00.000Z',
      decisionVersion: 'recognition-manual-override-v1' as const,
    };

    expect(deriveMealReviewState({ recognition: noFood, recognitionStatus: 'ready', manualOverride: null, items: [], policy })).toMatchObject({
      reasons: ['EMPTY_MEAL', 'NO_FOOD_DETECTED'], requiresRetake: true,
    });
    expect(deriveMealReviewState({ recognition: noFood, recognitionStatus: 'manual', manualOverride: override, items: [], policy })).toMatchObject({
      reasons: ['EMPTY_MEAL'], requiresRetake: false,
    });
    expect(deriveMealReviewState({ recognition: insufficient, recognitionStatus: 'manual', manualOverride: override, items: [], policy })).toMatchObject({
      reasons: ['EMPTY_MEAL', 'INSUFFICIENT_IMAGE_EVIDENCE'], requiresRetake: true,
    });
    expect(deriveMealReviewState({
      recognition: noFood,
      recognitionStatus: 'manual',
      manualOverride: override,
      items: [{ origin: 'manual_entry', review: deriveItemReviewState(itemInput({
        origin: 'manual_entry',
        initialEstimateAssessment: null,
        foodAcknowledgedRevision: null,
        portionAcknowledgedRevision: null,
      })) }],
      policy,
    })).toMatchObject({ reasons: [], requiresRetake: false });
  });

  test('keeps review-only policy out of the quick-confirm path and rejects unknown review reasons', () => {
    const reviewOnly = deriveItemReviewState(itemInput({
      policy: { ...policy, activation: 'review_only' },
      foodAcknowledgedRevision: null,
      portionAcknowledgedRevision: null,
    }));
    expect(reviewOnly.reasons).toEqual([]);
    expect(deriveMealReviewState({
      recognition: null,
      recognitionStatus: 'ready',
      manualOverride: null,
      items: [{ origin: 'model_estimate', review: reviewOnly }],
      policy: { ...policy, activation: 'review_only' },
    }).reasons).toEqual(['QUICK_CONFIRM_POLICY_DISABLED']);
    const acknowledged = deriveItemReviewState(itemInput({
      policy: { ...policy, activation: 'review_only' },
      foodAcknowledgedRevision: 1,
      portionAcknowledgedRevision: 1,
    }));
    expect(deriveMealReviewState({
      recognition: null,
      recognitionStatus: 'ready',
      manualOverride: null,
      items: [{ origin: 'model_estimate', review: acknowledged }],
      policy: { ...policy, activation: 'review_only' },
    }).reasons).toEqual([]);
    expect(isReviewReason('FOOD_NOT_FOUND')).toBeTrue();
    expect(isReviewReason('future_reason')).toBeFalse();
  });
});
