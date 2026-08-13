import { describe, expect, test } from 'bun:test';

import {
  deriveMealConfirmationReviewPolicy,
  deriveMealItemAuthorityRecovery,
  deriveReviewNutritionCopy,
  isConfirmedMealResponseProjection,
} from '../src/meals/meal-confirmation-review-policy';
import {
  type ConfirmedMealDraftResponse,
  type MealDraftItemReview,
} from '../src/api/meal-drafts';

function item(
  itemId: string,
  status: 'current' | 'required',
): { itemId: string; review: MealDraftItemReview } {
  return {
    itemId,
    review: {
      status,
      checkpoint: null,
      authority: {
        fingerprintVersion: 'meal-review-authority-v1',
        fingerprint: status === 'current' ? 'a'.repeat(64) : null,
        officialSource: null,
        invalidReason: null,
      },
      nextAction: status === 'required' ? 'review_item' : null,
    },
  };
}

describe('meal confirmation review policy', () => {
  test('handles an empty review with one add-item action and no confirmation', () => {
    expect(
      deriveMealConfirmationReviewPolicy({
        items: [],
        serverConfirmable: true,
        hasUnsavedChanges: false,
        hasPendingMutation: false,
      }),
    ).toEqual({
      recommendedNextItemId: null,
      freelyNavigableItemIds: [],
      reviewProgress: { completedItemCount: 0, itemCount: 0 },
      primaryAction: { kind: 'add_item' },
      canConfirmMeal: false,
    });
  });

  test('recommends the server checkpoint priority without restricting navigation', () => {
    const policy = deriveMealConfirmationReviewPolicy({
      items: [
        item('review-first', 'required'),
        item('review-later', 'required'),
        item('complete', 'current'),
      ],
      serverConfirmable: false,
      hasUnsavedChanges: false,
      hasPendingMutation: false,
    });

    expect(policy.recommendedNextItemId).toBe('review-first');
    expect(policy.freelyNavigableItemIds).toEqual([
      'review-first',
      'review-later',
      'complete',
    ]);
    expect(policy.reviewProgress).toEqual({ completedItemCount: 1, itemCount: 3 });
    expect(policy.primaryAction).toEqual({
      kind: 'review_item',
      itemId: 'review-first',
    });
  });

  test('keeps confirmation eligibility server-owned when a later required item is reviewed first', () => {
    const policy = deriveMealConfirmationReviewPolicy({
      items: [item('recommended-first', 'required'), item('review-now', 'required')],
      serverConfirmable: true,
      hasUnsavedChanges: false,
      hasPendingMutation: false,
    });

    expect(policy.recommendedNextItemId).toBe('recommended-first');
    expect(policy.freelyNavigableItemIds).toEqual([
      'recommended-first',
      'review-now',
    ]);
    expect(policy.canConfirmMeal).toBe(true);
  });

  test('recognizes the immutable confirmed response projection without draft fields', () => {
    const response = {
      mealLog: {
        id: 'meal-1',
        eatenAt: '2026-08-13T00:00:00.000Z',
        timezone: 'Asia/Seoul',
        localDate: '2026-08-13',
        mealType: 'breakfast',
        status: 'confirmed',
        confirmedAt: '2026-08-13T00:01:00.000Z',
      },
      items: [],
      review: {
        confirmable: false,
        evidence: 'explicit_v2',
        reasons: [],
      },
      nutrition: {
        id: 'snapshot-1',
        calculationVersion: 'meal-nutrition-v1',
        calculatedAt: '2026-08-13T00:01:00.000Z',
        items: [],
        totals: {
          energyMillicalories: { value: 0, knownValue: 0, missingItemCount: 0, completeness: 'complete' },
          carbohydrateMg: { value: 0, knownValue: 0, missingItemCount: 0, completeness: 'complete' },
          proteinMg: { value: 0, knownValue: 0, missingItemCount: 0, completeness: 'complete' },
          fatMg: { value: 0, knownValue: 0, missingItemCount: 0, completeness: 'complete' },
          fiberMg: { value: 0, knownValue: 0, missingItemCount: 0, completeness: 'complete' },
        },
      },
    } satisfies ConfirmedMealDraftResponse;

    expect(isConfirmedMealResponseProjection(response)).toBe(true);
  });

  test('offers exactly one final confirmation action once every item is current', () => {
    const policy = deriveMealConfirmationReviewPolicy({
      items: [item('one', 'current'), item('two', 'current')],
      serverConfirmable: true,
      hasUnsavedChanges: false,
      hasPendingMutation: false,
    });

    expect(policy.primaryAction).toEqual({ kind: 'confirm_meal' });
    expect(policy.canConfirmMeal).toBe(true);
    expect(policy.reviewProgress).toEqual({ completedItemCount: 2, itemCount: 2 });
  });

  test('uses waiting copy until an item is reviewed, then preserves a known zero', () => {
    expect(deriveReviewNutritionCopy(null, 0)).toEqual({
      state: 'pending',
      label: '계산 대기',
      value: '—',
    });
    expect(
      deriveReviewNutritionCopy({
        knownValue: null,
        missingItemCount: 0,
        status: 'complete',
      }, 1),
    ).toEqual({ state: 'pending', label: '계산 대기', value: '—' });
    expect(
      deriveReviewNutritionCopy({
        knownValue: 0,
        missingItemCount: 1,
        status: 'subtotal',
      }, 0),
    ).toEqual({ state: 'pending', label: '계산 대기', value: '—' });
    expect(
      deriveReviewNutritionCopy({
        knownValue: 420,
        missingItemCount: 1,
        status: 'subtotal',
      }, 1),
    ).toEqual({
      state: 'subtotal',
      label: '확인된 항목 소계 · 전체 아님',
      value: '420',
    });
    expect(
      deriveReviewNutritionCopy({
        knownValue: 0,
        missingItemCount: 0,
        status: 'complete',
      }, 1),
    ).toEqual({ state: 'complete', label: '완료', value: '0' });
  });

  test('never enables the final CTA around server or local blockers', () => {
    const base = {
      items: [item('one', 'current')],
      serverConfirmable: true,
      hasUnsavedChanges: false,
      hasPendingMutation: false,
    };
    expect(deriveMealConfirmationReviewPolicy(base).canConfirmMeal).toBe(true);
    expect(
      deriveMealConfirmationReviewPolicy({ ...base, serverConfirmable: false }).canConfirmMeal,
    ).toBe(false);
    expect(
      deriveMealConfirmationReviewPolicy({ ...base, hasUnsavedChanges: true }).canConfirmMeal,
    ).toBe(false);
    expect(
      deriveMealConfirmationReviewPolicy({ ...base, hasPendingMutation: true }).canConfirmMeal,
    ).toBe(false);
  });

  test.each([
    ['MISSING_FOOD_MAPPING', 'search_food'],
    ['CATALOG_RELEASE_NOT_PUBLISHED', 'refresh_source'],
    ['STALE_AUTHORITY', 'refresh_draft'],
  ] as const)('maps %s authority failure to %s recovery', (invalidReason, kind) => {
    expect(deriveMealItemAuthorityRecovery({
      ...item('recovery', 'required').review,
      authority: {
        fingerprintVersion: 'meal-review-authority-v1',
        fingerprint: null,
        officialSource: null,
        invalidReason,
      },
    })?.kind).toBe(kind);
  });
});
