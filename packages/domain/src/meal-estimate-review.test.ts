import { describe, expect, test } from 'bun:test';

import {
  deriveCurrentItemReviewCheckpoint,
  deriveMealConfirmability,
  type CurrentItemReviewCheckpointInput,
} from './meal-estimate-review';

function checkpoint(
  overrides: Partial<CurrentItemReviewCheckpointInput> = {},
): CurrentItemReviewCheckpointInput {
  return {
    itemId: 'rice',
    itemRevision: 3,
    selectedFoodId: 'food-rice',
    officialSourceRevision: 8,
    currentOfficialSourceRevision: 8,
    reviewedItemRevision: 3,
    ...overrides,
  };
}

describe('current item review checkpoint', () => {
  test('requires an explicit review when an otherwise current item is unreviewed', () => {
    expect(deriveCurrentItemReviewCheckpoint(checkpoint({ reviewedItemRevision: null }))).toEqual({
      itemId: 'rice',
      itemRevision: 3,
      selection: 'selected',
      officialSource: 'current',
      userReview: 'unreviewed',
      nextAction: 'review_item',
      confirmable: false,
    });
  });

  test('marks an earlier review stale without changing selection or official source state', () => {
    expect(deriveCurrentItemReviewCheckpoint(checkpoint({ reviewedItemRevision: 2 }))).toMatchObject({
      selection: 'selected',
      officialSource: 'current',
      userReview: 'stale',
      nextAction: 'review_item',
      confirmable: false,
    });
  });

  test('makes an item confirmable only when selection, official source, and review are all current', () => {
    expect(deriveCurrentItemReviewCheckpoint(checkpoint())).toMatchObject({
      selection: 'selected',
      officialSource: 'current',
      userReview: 'current',
      nextAction: 'none',
      confirmable: true,
    });
  });

  test('keeps selection and official-source failures independent from review state', () => {
    expect(deriveCurrentItemReviewCheckpoint(checkpoint({ selectedFoodId: null }))).toMatchObject({
      selection: 'missing',
      officialSource: 'current',
      userReview: 'current',
      nextAction: 'select_item',
    });
    expect(deriveCurrentItemReviewCheckpoint(checkpoint({ officialSourceRevision: 7 }))).toMatchObject({
      selection: 'selected',
      officialSource: 'stale',
      userReview: 'current',
      nextAction: 'refresh_official_source',
    });
    expect(deriveCurrentItemReviewCheckpoint(checkpoint({ officialSourceRevision: null }))).toMatchObject({
      officialSource: 'missing',
      nextAction: 'refresh_official_source',
    });
  });

  test('allows explicit manual authority without inventing catalog authority', () => {
    expect(deriveCurrentItemReviewCheckpoint(checkpoint({
      selectedFoodId: null,
      officialSourceRevision: null,
      currentOfficialSourceRevision: null,
      manualAuthority: true,
    }))).toMatchObject({
      selection: 'selected',
      officialSource: 'current',
      userReview: 'current',
      nextAction: 'none',
      confirmable: true,
    });
  });
});

describe('meal confirmability', () => {
  test('prioritizes selection, then official source, then user review', () => {
    const source = deriveCurrentItemReviewCheckpoint(checkpoint({
      itemId: 'source',
      officialSourceRevision: 7,
      reviewedItemRevision: null,
    }));
    const selection = deriveCurrentItemReviewCheckpoint(checkpoint({
      itemId: 'selection',
      selectedFoodId: null,
      reviewedItemRevision: null,
    }));
    const review = deriveCurrentItemReviewCheckpoint(checkpoint({
      itemId: 'review',
      reviewedItemRevision: null,
    }));

    expect(deriveMealConfirmability({ items: [source, review, selection] })).toEqual({
      confirmable: false,
      itemCount: 3,
      nextAction: 'select_item',
      nextItemId: 'selection',
    });
    expect(deriveMealConfirmability({ items: [source, review] })).toMatchObject({
      nextAction: 'refresh_official_source',
      nextItemId: 'source',
    });
    expect(deriveMealConfirmability({ items: [review] })).toMatchObject({
      nextAction: 'review_item',
      nextItemId: 'review',
    });
  });

  test('does not confirm an empty meal and confirms a non-empty current meal', () => {
    expect(deriveMealConfirmability({ items: [] })).toEqual({
      confirmable: false,
      itemCount: 0,
      nextAction: 'select_item',
      nextItemId: null,
    });
    expect(deriveMealConfirmability({ items: [deriveCurrentItemReviewCheckpoint(checkpoint())] })).toEqual({
      confirmable: true,
      itemCount: 1,
      nextAction: 'confirm_meal',
      nextItemId: null,
    });
  });
});
