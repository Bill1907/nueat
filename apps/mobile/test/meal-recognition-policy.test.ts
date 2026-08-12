import { describe, expect, test } from 'bun:test';

import {
  RECOGNITION_MAX_ELAPSED_MS,
  areReviewReasonsAcknowledgeable,
  canAddMealDraftItem,
  deriveMealConfirmationActions,
  isAcknowledgeableReviewReason,
  isCorrectionReviewReason,
  isExactFoodMappingTransition,
  isExactItemDeleteTransition,
  isExactItemUpdateTransition,
  isExactReviewTransition,
  isRetakeReason,
  recognitionPollDelay,
  reviewReasonCopy,
} from '../src/meals/meal-recognition-policy';

function transitionMeal(draftRevision: number, status = 'draft') {
  return {
    id: 'meal-1',
    eatenAt: '2026-08-11T12:00:00Z',
    timezone: 'Asia/Seoul',
    localDate: '2026-08-11',
    mealType: 'lunch',
    status,
    imageAssetId: 'image-1',
    recognitionStatus: 'ready' as const,
    recognitionProvider: 'openai',
    recognitionModel: 'model-1',
    recognitionPromptVersion: 'prompt-1',
    recognitionSchemaVersion: '2',
    recognitionCompletedAt: '2026-08-11T12:00:01Z',
    recognitionLastErrorCode: null,
    recognitionAttemptCount: 1,
    recognitionNextAttemptAt: null,
    draftRevision,
    confirmedAt: null,
    recognitionOutcome: 'recognized',
    recognitionEvidenceReason: null,
    recognitionManualOverride: null,
  };
}
describe('meal recognition polling policy', () => {
  test('backs off with a bounded delay', () => {
    expect(
      recognitionPollDelay({
        status: 'pending',
        attempt: 0,
        elapsedMs: 0,
        isAppActive: true,
      }),
    ).toBe(1_000);
    expect(
      recognitionPollDelay({
        status: 'processing',
        attempt: 1,
        elapsedMs: 0,
        isAppActive: true,
      }),
    ).toBe(2_000);
    expect(
      recognitionPollDelay({
        status: 'processing',
        attempt: 10,
        elapsedMs: 0,
        isAppActive: true,
      }),
    ).toBe(8_000);
  });

  test('does not poll terminal, expired, or background work', () => {
    for (const status of ['ready', 'failed', 'manual'] as const) {
      expect(
        recognitionPollDelay({
          status,
          attempt: 0,
          elapsedMs: 0,
          isAppActive: true,
        }),
      ).toBeNull();
    }
    expect(
      recognitionPollDelay({
        status: 'pending',
        attempt: 0,
        elapsedMs: RECOGNITION_MAX_ELAPSED_MS,
        isAppActive: true,
      }),
    ).toBeNull();
    expect(
      recognitionPollDelay({
        status: 'pending',
        attempt: 0,
        elapsedMs: 0,
        isAppActive: false,
      }),
    ).toBeNull();
  });

  test('uses Korean recovery copy only for retake-eligible outcomes', () => {
    expect(reviewReasonCopy('NO_FOOD_DETECTED')).toBe(
      '사진에서 음식을 확인하지 못했어요. 새 사진을 찍거나 직접 입력해 주세요.',
    );
    expect(reviewReasonCopy('INSUFFICIENT_IMAGE_EVIDENCE')).toBe(
      '사진 정보가 부족해요. 새 사진을 찍거나 직접 입력해 주세요.',
    );
    expect(reviewReasonCopy('FOOD_MAPPING_MISSING')).toBe(
      '공식 음식 DB에서 음식을 선택해 주세요.',
    );
    expect(isRetakeReason('NO_FOOD_DETECTED')).toBe(true);
    expect(isRetakeReason('INSUFFICIENT_IMAGE_EVIDENCE')).toBe(true);
    expect(isRetakeReason('no_food')).toBe(true);
    expect(isRetakeReason('insufficient_evidence')).toBe(true);
    expect(isRetakeReason('IMAGE_QUALITY_LOW')).toBe(false);
    expect(isRetakeReason('FOOD_MAPPING_MISSING')).toBe(false);
    expect(canAddMealDraftItem('ready', 'no_food')).toBe(false);
    expect(canAddMealDraftItem('ready', 'insufficient_evidence')).toBe(false);
    expect(canAddMealDraftItem('ready', 'recognized')).toBe(true);
    expect(canAddMealDraftItem('manual', 'no_food')).toBe(true);
  });

  test('separates policy acknowledgement from correction-required review', () => {
    expect(isCorrectionReviewReason('QUICK_CONFIRM_POLICY_DISABLED')).toBe(false);
    expect(isCorrectionReviewReason('FOOD_CONFIDENCE_LOW')).toBe(true);
    expect(isAcknowledgeableReviewReason('FOOD_CONFIDENCE_LOW')).toBe(true);
    expect(isAcknowledgeableReviewReason('PORTION_CONFIDENCE_LOW')).toBe(true);
    expect(isAcknowledgeableReviewReason('FOOD_MAPPING_MISSING')).toBe(false);
    expect(isAcknowledgeableReviewReason('SERVING_CONVERSION_MISSING')).toBe(false);
    expect(areReviewReasonsAcknowledgeable(['FOOD_CONFIDENCE_LOW'])).toBe(true);
    expect(areReviewReasonsAcknowledgeable([
      'QUICK_CONFIRM_POLICY_DISABLED',
      'PORTION_CONFIDENCE_LOW',
    ])).toBe(true);
    expect(areReviewReasonsAcknowledgeable(['FOOD_MAPPING_MISSING'])).toBe(false);
    expect(areReviewReasonsAcknowledgeable([
      'FOOD_CONFIDENCE_LOW',
      'FOOD_MAPPING_MISSING',
    ])).toBe(false);
  });

  test('derives one final CTA only for confirmable or policy-only review state', () => {
    expect(deriveMealConfirmationActions({
      reasonCodes: ['QUICK_CONFIRM_POLICY_DISABLED'],
      reviewConfirmable: false,
      itemCount: 2,
      allItemsResolved: true,
      hasUnsavedItemForms: false,
      hasManualForm: false,
    })).toEqual({
      hasCorrectionReasons: false,
      hasPolicyAcknowledgementOnly: true,
      canConfirmMeal: true,
    });
    expect(deriveMealConfirmationActions({
      reasonCodes: ['FOOD_CONFIDENCE_LOW'],
      reviewConfirmable: false,
      itemCount: 2,
      allItemsResolved: true,
      hasUnsavedItemForms: false,
      hasManualForm: false,
    })).toEqual({
      hasCorrectionReasons: true,
      hasPolicyAcknowledgementOnly: false,
      canConfirmMeal: false,
    });
  });

  test('accepts only the exact acknowledgement transition after a lost response', () => {
    const item = {
      id: 'item-1',
      itemRevision: 2,
      foodRevision: 1,
      portionRevision: 1,
      recognizedLabel: '김치',
      amountMilliunits: 100,
      unit: 'g',
      recognitionRegionIndex: 0,
      foodId: 'food-1',
      nutrientProfileId: 'profile-1',
      foodAcknowledgedRevision: null,
      portionAcknowledgedRevision: null,
      mappingConfidenceBps: 10_000,
      gramsMg: null,
      currentResolutionSource: 'model_primary',
      recognitionConfidenceBps: 8_000,
      portionConfidenceBps: 8_000,
      userCorrected: false,
      origin: 'model_estimate',
      initialAssessment: { rawLabel: '김치' },
      currentResolution: { status: 'resolved' as const, reason: null },
    };
    const baseline = { mealLog: transitionMeal(4), items: [item] };
    const input = {
      expectedDraftRevision: 4,
      items: [{
        itemId: 'item-1',
        expectedItemRevision: 2,
        foodAcknowledgedRevision: 1,
      }],
    };
    const acknowledged = {
      mealLog: transitionMeal(5),
      items: [{ ...item, itemRevision: 3, foodAcknowledgedRevision: 1 }],
    };

    expect(isExactReviewTransition(acknowledged, baseline, input)).toBe(true);
    expect(isExactReviewTransition({
      ...acknowledged,
      items: [{ ...acknowledged.items[0]!, amountMilliunits: 200 }],
    }, baseline, input)).toBe(false);
    expect(isExactReviewTransition({
      mealLog: transitionMeal(6),
      items: acknowledged.items,
    }, baseline, input)).toBe(false);
    expect(isExactReviewTransition({
      ...acknowledged,
      mealLog: transitionMeal(5, 'confirmed'),
    }, baseline, input)).toBe(false);
    expect(isExactReviewTransition({
      ...acknowledged,
      items: [{
        ...acknowledged.items[0]!,
        initialAssessment: { rawLabel: '다른 값' },
      }],
    }, baseline, input)).toBe(false);
    expect(isExactReviewTransition({
      ...acknowledged,
      items: [{ ...acknowledged.items[0]!, gramsMg: 100 }],
    }, baseline, input)).toBe(false);
  });

  test('accepts only exact edit, mapping, and delete transitions after lost responses', () => {
    const item = {
      id: 'item-1',
      itemRevision: 2,
      foodRevision: 1,
      portionRevision: 1,
      recognizedLabel: '김치',
      amountMilliunits: 100,
      unit: 'g',
      recognitionRegionIndex: 0,
      foodId: 'food-1',
      nutrientProfileId: 'profile-1',
      mappingConfidenceBps: 9_000,
      gramsMg: null,
      currentResolutionSource: 'model_primary',
      recognitionConfidenceBps: 8_000,
      portionConfidenceBps: 8_000,
      userCorrected: false,
      origin: 'model_estimate',
      initialAssessment: { rawLabel: '김치' },
      currentResolution: { status: 'resolved' as const, reason: null },
      foodAcknowledgedRevision: null,
      portionAcknowledgedRevision: null,
    };
    const other = { ...item, id: 'item-2', recognizedLabel: '밥' };
    const baseline = {
      mealLog: transitionMeal(4),
      items: [item, other],
    };
    const edited = {
      mealLog: transitionMeal(5),
      items: [{
        ...item,
        itemRevision: 3,
        recognizedLabel: '배추김치',
        foodRevision: 2,
        foodId: null,
        nutrientProfileId: null,
        mappingConfidenceBps: null,
        userCorrected: true,
        currentResolutionSource: null,
        currentResolution: {
          status: 'unresolved' as const,
          reason: 'FOOD_MAPPING_MISSING',
        },
      }, other],
    };
    const editInput = {
      itemId: item.id,
      expectedItemRevision: 2,
      recognizedLabel: '배추김치',
    };
    expect(isExactItemUpdateTransition(edited, baseline, editInput)).toBe(true);
    expect(isExactItemUpdateTransition({
      ...edited,
      items: [edited.items[0]!, { ...other, amountMilliunits: 200 }],
    }, baseline, editInput)).toBe(false);
    expect(isExactItemUpdateTransition({
      ...edited,
      items: [edited.items[0]!, { ...other, mappingConfidenceBps: 8_500 }],
    }, baseline, editInput)).toBe(false);
    expect(isExactItemUpdateTransition({
      ...edited,
      items: [
        edited.items[0]!,
        { ...other, initialAssessment: { rawLabel: '다른 값' } },
      ],
    }, baseline, editInput)).toBe(false);
    expect(isExactItemUpdateTransition({
      ...edited,
      items: [
        edited.items[0]!,
        { ...other, currentResolution: { status: 'unresolved', reason: 'changed' } },
      ],
    }, baseline, editInput)).toBe(false);
    expect(isExactItemUpdateTransition({
      ...edited,
      items: [
        edited.items[0]!,
        { ...other, initialAssessment: [] },
      ],
    }, {
      ...baseline,
      items: [item, { ...other, initialAssessment: {} }],
    }, editInput)).toBe(false);
    expect(isExactItemUpdateTransition({
      ...edited,
      mealLog: transitionMeal(5, 'confirmed'),
    }, baseline, editInput)).toBe(false);
    expect(isExactItemUpdateTransition({
      ...edited,
      items: [{
        ...edited.items[0]!,
        recognitionRegionIndex: 1,
      }, other],
    }, baseline, editInput)).toBe(false);
    expect(isExactItemUpdateTransition({
      ...edited,
      items: [{
        ...edited.items[0]!,
        currentResolutionSource: 'user_selected',
      }, other],
    }, baseline, editInput)).toBe(false);

    const mapped = {
      mealLog: transitionMeal(5),
      items: [{
        ...item,
        itemRevision: 3,
        foodRevision: 2,
        recognizedLabel: '배추김치',
        foodId: 'food-2',
        nutrientProfileId: 'profile-2',
        mappingConfidenceBps: 10_000,
        userCorrected: true,
        currentResolutionSource: 'user_selected',
        currentResolution: { status: 'resolved' as const, reason: null },
        foodAcknowledgedRevision: 2,
      }, other],
    };
    const mappingInput = {
      itemId: item.id,
      expectedItemRevision: 2,
      foodId: 'food-2',
      recognizedLabel: '배추김치',
      nutrientProfileId: 'profile-2',
    };
    expect(isExactFoodMappingTransition(mapped, baseline, mappingInput)).toBe(true);
    expect(isExactFoodMappingTransition({
      ...mapped,
      items: [{ ...mapped.items[0]!, portionRevision: 2 }, other],
    }, baseline, mappingInput)).toBe(false);
    expect(isExactFoodMappingTransition({
      ...mapped,
      items: [{
        ...mapped.items[0]!,
        nutrientProfileId: 'profile-other',
      }, other],
    }, baseline, mappingInput)).toBe(false);
    expect(isExactFoodMappingTransition({
      ...mapped,
      items: [{
        ...mapped.items[0]!,
        currentResolutionSource: 'model_primary',
      }, other],
    }, baseline, mappingInput)).toBe(false);

    const deleted = {
      mealLog: transitionMeal(5),
      items: [other],
    };
    const deleteInput = {
      itemId: item.id,
      expectedDraftRevision: 4,
      expectedItemRevision: 2,
    };
    expect(isExactItemDeleteTransition(deleted, baseline, deleteInput)).toBe(true);
    expect(isExactItemDeleteTransition({
      ...deleted,
      items: [{ ...other, amountMilliunits: 200 }],
    }, baseline, deleteInput)).toBe(false);
  });
});
