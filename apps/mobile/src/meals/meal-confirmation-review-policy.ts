import type {
  ConfirmedMealDraftResponse,
  MealDraftItemReview,
  MealDraftResponse,
} from '@/api/meal-drafts';

/** Lets the modal keep immutable confirmation responses out of draft-only flows. */
export function isConfirmedMealResponseProjection(
  response: MealDraftResponse,
): response is ConfirmedMealDraftResponse {
  return response.mealLog.status === 'confirmed';
}

export interface MealConfirmationReviewPolicyInput {
  items: readonly { itemId: string; review: MealDraftItemReview }[];
  serverConfirmable: boolean;
  hasUnsavedChanges: boolean;
  hasPendingMutation: boolean;
}

export type MealConfirmationPrimaryAction =
  | { kind: 'add_item' }
  | { kind: 'review_item'; itemId: string }
  | { kind: 'confirm_meal' };

export interface MealConfirmationReviewPolicy {
  recommendedNextItemId: string | null;
  freelyNavigableItemIds: readonly string[];
  reviewProgress: { completedItemCount: number; itemCount: number };
  primaryAction: MealConfirmationPrimaryAction;
  canConfirmMeal: boolean;
}

export type MealItemAuthorityRecovery =
  | {
      kind: 'search_food';
      instruction: '공식 음식 DB에서 음식을 다시 연결해 주세요.';
      label: '공식 음식 DB 검색';
    }
  | {
      kind: 'refresh_source';
      instruction: '공식 영양 정보를 다시 불러온 뒤 확인해 주세요.';
      label: '공식 음식 정보 다시 불러오기';
    }
  | {
      kind: 'refresh_draft';
      instruction: '최신 식사 정보를 다시 불러온 뒤 확인해 주세요.';
      label: '식사 정보 다시 불러오기';
    };

/** Maps bounded server authority failures to the only safe local recovery. */
export function deriveMealItemAuthorityRecovery(
  review: MealDraftItemReview,
): MealItemAuthorityRecovery | null {
  if (review.authority.fingerprint !== null) return null;
  if (review.authority.invalidReason === 'MISSING_FOOD_MAPPING') {
    return {
      kind: 'search_food',
      instruction: '공식 음식 DB에서 음식을 다시 연결해 주세요.',
      label: '공식 음식 DB 검색',
    };
  }
  if (review.authority.invalidReason === 'STALE_AUTHORITY') {
    return {
      kind: 'refresh_draft',
      instruction: '최신 식사 정보를 다시 불러온 뒤 확인해 주세요.',
      label: '식사 정보 다시 불러오기',
    };
  }
  return {
    kind: 'refresh_source',
    instruction: '공식 영양 정보를 다시 불러온 뒤 확인해 주세요.',
    label: '공식 음식 정보 다시 불러오기',
  };
}

/**
 * The server owns item-review state and confirmation eligibility. The client
 * only selects the next server-required item and blocks local unsaved changes.
 */
export function deriveMealConfirmationReviewPolicy(
  input: MealConfirmationReviewPolicyInput,
): MealConfirmationReviewPolicy {
  const nextItem = input.items.find(
    (item) => item.review.status === 'required',
  );
  const primaryAction =
    input.items.length === 0
      ? { kind: 'add_item' as const }
      : nextItem
        ? { kind: 'review_item' as const, itemId: nextItem.itemId }
        : { kind: 'confirm_meal' as const };

  return {
    recommendedNextItemId: nextItem?.itemId ?? null,
    freelyNavigableItemIds: input.items.map((item) => item.itemId),
    reviewProgress: {
      completedItemCount: input.items.filter(
        (item) => item.review.status === 'current',
      ).length,
      itemCount: input.items.length,
    },
    primaryAction,
    canConfirmMeal:
      input.items.length > 0 &&
      input.serverConfirmable &&
      !input.hasUnsavedChanges &&
      !input.hasPendingMutation,
  };
}

export interface ReviewNutritionTotal {
  knownValue: number | null;
  missingItemCount: number;
  status: 'pending' | 'subtotal' | 'complete';
}

export type ReviewNutritionCopy =
  | { state: 'pending'; label: '계산 대기'; value: '—' }
  | {
      state: 'subtotal';
      label: '확인된 항목 소계 · 전체 아님';
      value: string;
    }
  | { state: 'complete'; label: '완료'; value: string };

/** Distinguishes unavailable nutrition from a calculated zero. */
export function deriveReviewNutritionCopy(
  total: ReviewNutritionTotal | null,
  reviewedItemCount: number,
): ReviewNutritionCopy {
  if (
    total === null ||
    reviewedItemCount === 0 ||
    total.status === 'pending' ||
    total.knownValue === null
  ) {
    return { state: 'pending', label: '계산 대기', value: '—' };
  }
  if (total.status === 'subtotal') {
    return {
      state: 'subtotal',
      label: '확인된 항목 소계 · 전체 아님',
      value: String(total.knownValue),
    };
  }
  return { state: 'complete', label: '완료', value: String(total.knownValue) };
}
