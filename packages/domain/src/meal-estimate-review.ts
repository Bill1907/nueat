export const MEAL_REVIEW_CHECKPOINT_VERSION = 'meal-review-checkpoint-v1';
export const MEAL_REVIEW_POLICY_VERSION = 'meal-review-policy-v1';
export const MEAL_REVIEW_POLICY_THRESHOLDS = {
  minImageQualityConfidenceBps: 7_000,
  minFoodConfidenceBps: 7_000,
  minFoodCandidateMarginBps: 1_000,
  minPortionConfidenceBps: 7_000,
} as const;

export type ItemSelectionStatus = 'selected' | 'missing';
export type OfficialSourceStatus = 'current' | 'missing' | 'stale';
export type UserReviewStatus = 'current' | 'unreviewed' | 'stale';
export type ItemReviewNextAction =
  | 'select_item'
  | 'refresh_official_source'
  | 'review_item'
  | 'none';
export type MealReviewNextAction = Exclude<ItemReviewNextAction, 'none'> | 'confirm_meal';

export interface CurrentItemReviewCheckpointInput {
  itemId: string;
  itemRevision: number;
  selectedFoodId: string | null;
  manualAuthority?: boolean;
  officialSourceRevision: number | null;
  currentOfficialSourceRevision: number | null;
  reviewedItemRevision: number | null;
}

export interface CurrentItemReviewCheckpointStatus {
  itemId: string;
  itemRevision: number;
  selection: ItemSelectionStatus;
  officialSource: OfficialSourceStatus;
  userReview: UserReviewStatus;
  nextAction: ItemReviewNextAction;
  confirmable: boolean;
}

export interface MealConfirmabilityInput {
  items: readonly CurrentItemReviewCheckpointStatus[];
}

export interface MealConfirmabilityStatus {
  confirmable: boolean;
  itemCount: number;
  nextAction: MealReviewNextAction;
  nextItemId: string | null;
}

/**
 * Derives the current checkpoint from persisted catalog authority or an
 * explicit manual-review authority, plus the current item revision. Manual
 * authority never supplies nutrition and any item edit still invalidates it.
 */
export function deriveCurrentItemReviewCheckpoint(
  input: CurrentItemReviewCheckpointInput,
): CurrentItemReviewCheckpointStatus {
  assertPositiveInteger(input.itemRevision, 'itemRevision');
  assertNullablePositiveInteger(input.officialSourceRevision, 'officialSourceRevision');
  assertNullablePositiveInteger(input.currentOfficialSourceRevision, 'currentOfficialSourceRevision');
  assertNullablePositiveInteger(input.reviewedItemRevision, 'reviewedItemRevision');

  const selection: ItemSelectionStatus =
    input.selectedFoodId === null && !input.manualAuthority ? 'missing' : 'selected';
  const officialSource = input.manualAuthority
    ? 'current'
    : deriveOfficialSourceStatus(input);
  const userReview = deriveUserReviewStatus(input);
  const nextAction = deriveItemNextAction(selection, officialSource, userReview);

  return {
    itemId: input.itemId,
    itemRevision: input.itemRevision,
    selection,
    officialSource,
    userReview,
    nextAction,
    confirmable: nextAction === 'none',
  };
}

/** A meal is confirmable only when it contains at least one current item. */
export function deriveMealConfirmability(input: MealConfirmabilityInput): MealConfirmabilityStatus {
  if (input.items.length === 0) {
    return {
      confirmable: false,
      itemCount: 0,
      nextAction: 'select_item',
      nextItemId: null,
    };
  }

  for (const action of ['select_item', 'refresh_official_source', 'review_item'] as const) {
    const item = input.items.find((candidate) => candidate.nextAction === action);
    if (item) {
      return {
        confirmable: false,
        itemCount: input.items.length,
        nextAction: action,
        nextItemId: item.itemId,
      };
    }
  }

  return {
    confirmable: true,
    itemCount: input.items.length,
    nextAction: 'confirm_meal',
    nextItemId: null,
  };
}

function deriveOfficialSourceStatus(input: CurrentItemReviewCheckpointInput): OfficialSourceStatus {
  if (input.officialSourceRevision === null || input.currentOfficialSourceRevision === null) {
    return 'missing';
  }
  return input.officialSourceRevision === input.currentOfficialSourceRevision ? 'current' : 'stale';
}

function deriveUserReviewStatus(input: CurrentItemReviewCheckpointInput): UserReviewStatus {
  if (input.reviewedItemRevision === null) return 'unreviewed';
  return input.reviewedItemRevision === input.itemRevision ? 'current' : 'stale';
}

function deriveItemNextAction(
  selection: ItemSelectionStatus,
  officialSource: OfficialSourceStatus,
  userReview: UserReviewStatus,
): ItemReviewNextAction {
  if (selection === 'missing') return 'select_item';
  if (officialSource !== 'current') return 'refresh_official_source';
  if (userReview !== 'current') return 'review_item';
  return 'none';
}

function assertPositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function assertNullablePositiveInteger(value: number | null, field: string) {
  if (value !== null) assertPositiveInteger(value, field);
}
