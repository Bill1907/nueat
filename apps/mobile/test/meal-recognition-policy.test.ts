import { describe, expect, test } from 'bun:test';

import {
  RECOGNITION_MAX_ELAPSED_MS,
  canAddMealDraftItem,
  createConfirmMealDraftInput,
  deriveRecognitionRecoveryPolicy,
  formatRecognitionRetryAt,
  isRetakeReason,
  recognitionPollDelay,
  reviewReasonCopy,
} from '../src/meals/meal-recognition-policy';
import type {
  DraftMealDraftResponse,
  MealDraftItem,
  RecognitionRecovery,
} from '../src/api/meal-drafts';

function resolvedDraft(
  item: Pick<
    MealDraftItem,
    'id' | 'origin' | 'confirmationProof'
  >,
): DraftMealDraftResponse {
  const nutrient = {
    value: 0,
    knownValue: 0,
    missingItemCount: 0,
    status: 'complete' as const,
  };
  return {
    mealLog: {
      id: 'meal-1',
      eatenAt: '2026-08-13T01:00:00.000Z',
      timezone: 'Asia/Seoul',
      localDate: '2026-08-13',
      mealType: 'breakfast',
      imageAssetId: 'asset-opaque',
      recognitionStatus: 'ready',
      recognitionRecovery: {
        mode: 'none',
        reason: 'recognition_complete',
        retryAt: null,
      },
      draftRevision: 7,
      recognitionOutcome: 'recognized',
      recognitionEvidenceReason: null,
      status: 'draft',
      confirmedAt: null,
    },
    items: [
      {
        id: item.id,
        recognizedLabel: '음식',
        amountMilliunits: 100,
        unit: 'g',
        estimatedAmountMilliunits: 100,
        estimatedUnit: 'g',
        recognitionRegionIndex: 0,
        recognitionConfidenceBps: 10_000,
        portionConfidenceBps: 10_000,
        userCorrected: false,
        foodId: 'food-1',
        nutrientProfileId: 'profile-1',
        mappingConfidenceBps: 10_000,
        gramsMg: 100_000,
        currentResolutionSource: 'model_primary',
        itemRevision: 3,
        foodRevision: 1,
        portionRevision: 1,
        origin: item.origin,
        initialAssessment: null,
        review: {
          status: 'current',
          checkpoint: {
            reviewedItemRevision: 3,
            authorityFingerprintVersion: 'v1',
            authorityFingerprint: 'fingerprint-opaque',
            reviewedAt: '2026-08-13T01:01:00.000Z',
          },
          authority: {
            fingerprintVersion: 'v1',
            fingerprint: 'fingerprint-opaque',
            officialSource: null,
            invalidReason: null,
          },
          nextAction: null,
        },
        confirmationProof: item.confirmationProof,
      },
    ],
    review: {
      confirmable: true,
      reasons: [],
      nutrition: {
        status: 'complete',
        reviewedItemCount: 1,
        unreviewedItemCount: 0,
        totals: {
          energyMillicalories: nutrient,
          carbohydrateMg: nutrient,
          proteinMg: nutrient,
          fatMg: nutrient,
          fiberMg: nutrient,
        },
      },
    },
  };
}

describe('meal recognition polling policy', () => {
  test('maps every closed recovery mode and reason to safe actions and copy', () => {
    const cases: Array<{
      recovery: RecognitionRecovery;
      canRetryRecognition: boolean;
      canStartDirectEntry: boolean;
      showProgress: boolean;
    }> = [
      {
        recovery: { mode: 'none', reason: 'in_progress', retryAt: null },
        canRetryRecognition: false,
        canStartDirectEntry: false,
        showProgress: true,
      },
      {
        recovery: { mode: 'none', reason: 'recognition_complete', retryAt: null },
        canRetryRecognition: false,
        canStartDirectEntry: false,
        showProgress: false,
      },
      {
        recovery: { mode: 'none', reason: 'not_applicable', retryAt: null },
        canRetryRecognition: false,
        canStartDirectEntry: false,
        showProgress: false,
      },
      {
        recovery: {
          mode: 'retry_now',
          reason: 'recoverable_failure',
          retryAt: null,
        },
        canRetryRecognition: true,
        canStartDirectEntry: true,
        showProgress: false,
      },
      {
        recovery: {
          mode: 'retry_after',
          reason: 'cooldown',
          retryAt: '2026-08-13T01:02:03.000Z',
        },
        canRetryRecognition: false,
        canStartDirectEntry: true,
        showProgress: false,
      },
      {
        recovery: {
          mode: 'retry_after',
          reason: 'daily_quota',
          retryAt: '2026-08-14T00:00:00.000Z',
        },
        canRetryRecognition: false,
        canStartDirectEntry: true,
        showProgress: false,
      },
      ...(['asset_unavailable', 'recovery_exhausted', 'terminal_failure'] as const).map(
        (reason) => ({
          recovery: { mode: 'manual_only' as const, reason, retryAt: null },
          canRetryRecognition: false,
          canStartDirectEntry: true,
          showProgress: false,
        }),
      ),
    ];

    for (const expected of cases) {
      const policy = deriveRecognitionRecoveryPolicy({
        recovery: expected.recovery,
        localPollingTimedOut: false,
      });
      expect(policy).toMatchObject({
        canRetryRecognition: expected.canRetryRecognition,
        canStartDirectEntry: expected.canStartDirectEntry,
        showProgress: expected.showProgress,
      });
      expect(policy.message).not.toContain('제공자');
      expect(policy.message).not.toContain('모델');
    }
  });

  test('formats cooldown time in the device locale and timezone without enabling recognition retry', () => {
    const retryAt = '2026-08-13T01:02:03.000Z';
    const policy = deriveRecognitionRecoveryPolicy({
      recovery: { mode: 'retry_after', reason: 'cooldown', retryAt },
      localPollingTimedOut: false,
    });

    expect(policy.canRetryRecognition).toBe(false);
    expect(policy.canStartDirectEntry).toBe(true);
    expect(policy.retryLabel).toBe('다시 시도');
    expect(policy.message).not.toContain(retryAt);
    expect(
      formatRecognitionRetryAt(retryAt, {
        locale: 'ko-KR',
        timeZone: 'Asia/Seoul',
      }),
    ).toBe('2026. 8. 13. 오전 10:02');
  });

  test('fails closed for missing or unknown recovery metadata without trapping direct entry', () => {
    for (const recovery of [
      undefined,
      null,
      {},
      { mode: 'retry_now', reason: 'unknown', retryAt: null },
      { mode: 'retry_after', reason: 'cooldown', retryAt: null },
    ]) {
      const policy = deriveRecognitionRecoveryPolicy({
        recovery,
        localPollingTimedOut: false,
      });
      expect(policy.canRetryRecognition).toBe(false);
      expect(policy.canStartDirectEntry).toBe(true);
      expect(policy.showRefresh).toBe(true);
      expect(policy.showProgress).toBe(false);
      expect(policy.message).toContain('인식 상태를 확인할 수 없어요');
    }
  });

  test('treats a local polling timeout as presentation-only refresh and direct entry', () => {
    const policy = deriveRecognitionRecoveryPolicy({
      recovery: { mode: 'none', reason: 'in_progress', retryAt: null },
      localPollingTimedOut: true,
    });

    expect(policy).toMatchObject({
      canRetryRecognition: false,
      canStartDirectEntry: true,
      showRefresh: true,
      showProgress: false,
    });
    expect(policy.message).toContain('시간이 더 걸리고 있어요');
  });

  test('uses finished-profile confirmation proof IDs from GET unchanged in confirmation JSON', () => {
    const draft = resolvedDraft({
      id: 'item-1',
      origin: 'model_estimate',
      confirmationProof: {
        mappingDecisionId: 'decision-opaque',
        calculationPreviewId: 'preview-opaque',
      },
    });
    const request = createConfirmMealDraftInput(
      draft,
      'idempotency-opaque',
    );

    expect('currentResolution' in draft.items[0]).toBe(false);
    expect(JSON.stringify(request)).toBe(JSON.stringify({
      expectedDraftRevision: 7,
      idempotencyKey: 'idempotency-opaque',
      items: [
        {
          itemId: 'item-1',
          expectedItemRevision: 3,
          mappingDecisionId: 'decision-opaque',
          calculationPreviewId: 'preview-opaque',
        },
      ],
    }));
  });

  test('uses decomposition proof IDs and omits absent proof or optional keys', () => {
    const decomposed = createConfirmMealDraftInput(
      resolvedDraft({
        id: 'item-2',
        origin: 'model_estimate',
        confirmationProof: {
          mappingDecisionId: 'decision-opaque',
          calculationPreviewId: 'preview-opaque',
          decompositionRevisionId: 'decomposition-opaque',
        },
      }),
      'idempotency-opaque',
    );
    const missingProof = createConfirmMealDraftInput(
      resolvedDraft({
        id: 'item-3',
        origin: 'model_estimate',
        confirmationProof: null,
      }),
      'idempotency-opaque',
    );

    expect(JSON.stringify(decomposed)).toBe(JSON.stringify({
      expectedDraftRevision: 7,
      idempotencyKey: 'idempotency-opaque',
      items: [{
        itemId: 'item-2',
        expectedItemRevision: 3,
        mappingDecisionId: 'decision-opaque',
        calculationPreviewId: 'preview-opaque',
        decompositionRevisionId: 'decomposition-opaque',
      }],
    }));
    expect(missingProof).toBeNull();
  });

  test('allows reviewed canonical legacy persisted item without V3 proof', () => {
    const request = createConfirmMealDraftInput(
      resolvedDraft({
        id: 'legacy-item',
        origin: 'legacy_unknown',
        confirmationProof: null,
      }),
      'idempotency-opaque',
    );

    expect(JSON.stringify(request)).toBe(JSON.stringify({
      expectedDraftRevision: 7,
      idempotencyKey: 'idempotency-opaque',
      items: [{
        itemId: 'legacy-item',
        expectedItemRevision: 3,
      }],
    }));
  });

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
});
