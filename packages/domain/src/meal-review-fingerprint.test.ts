import { describe, expect, test } from 'bun:test';

import {
  canonicalMealItemAuthorityBytes,
  canonicalReviewRequestBytes,
  mealItemReviewFingerprint,
  reviewRequestFingerprint,
  type MealItemAuthorityFingerprintInput,
  type ReviewRequestFingerprintInput,
} from './meal-review-fingerprint';

const authority: MealItemAuthorityFingerprintInput = {
  itemId: 'item-1', itemRevision: 2, foodId: 'food-1', nutrientProfileId: null,
  amountMilliunits: 125_000, unit: 'g', gramsMg: 125_000,
  catalogReleaseId: 'release-1', catalogActivationId: 'activation-1',
  mappingMethod: 'exact', mappingDecisionId: 'decision-1',
  mappingContentSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceRegistryId: 'mfds', sourceReleaseId: '2025-12-29', servingId: null,
  calculationPreviewId: 'preview-1',
  calculationPreviewSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  mealDecompositionRevisionId: null, mealDecompositionSha256: null,
  calculationVersion: 'meal-nutrition-v1',
};
const request: ReviewRequestFingerprintInput = {
  mealId: 'meal-1', itemId: 'item-1', idempotencyKey: 'review-1',
  expectedDraftRevision: 3, expectedItemRevision: 2,
  displayedAuthorityFingerprintVersion: 'meal-item-review-fingerprint-v1',
  displayedAuthorityFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
};

describe('meal review fingerprints', () => {
  test('matches fixed canonical byte and digest vectors', () => {
    expect(new TextDecoder().decode(canonicalMealItemAuthorityBytes(authority))).toBe(
      'meal-item-review-fingerprint-v1\n{"amountMilliunits":125000,"calculationPreviewId":"preview-1","calculationPreviewSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","calculationVersion":"meal-nutrition-v1","catalogActivationId":"activation-1","catalogReleaseId":"release-1","foodId":"food-1","gramsMg":125000,"itemId":"item-1","itemRevision":2,"mappingContentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mappingDecisionId":"decision-1","mappingMethod":"exact","mealDecompositionRevisionId":null,"mealDecompositionSha256":null,"nutrientProfileId":null,"servingId":null,"sourceRegistryId":"mfds","sourceReleaseId":"2025-12-29","unit":"g"}',
    );
    expect(mealItemReviewFingerprint(authority)).toBe('f886abccc738a87ab2c65051bd76d4ecdf3d004d85babe5efa5aa5e45a6e95d0');
    expect(new TextDecoder().decode(canonicalReviewRequestBytes(request))).toBe(
      'meal-item-review-fingerprint-v1:review-request\n{"displayedAuthorityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","displayedAuthorityFingerprintVersion":"meal-item-review-fingerprint-v1","expectedDraftRevision":3,"expectedItemRevision":2,"idempotencyKey":"review-1","itemId":"item-1","mealId":"meal-1"}',
    );
    expect(reviewRequestFingerprint(request)).toBe('7533c4a3755b546e27f23e7f011f095378b382c2178c95fc5b9a0415e01018e2');
  });

  test('normalizes NFC and ignores object insertion order', () => {
    const reordered = Object.fromEntries(Object.entries(authority).reverse()) as MealItemAuthorityFingerprintInput;
    expect(mealItemReviewFingerprint({ ...reordered, foodId: 'cafe\u0301' })).toBe(
      mealItemReviewFingerprint({ ...authority, foodId: 'café' }),
    );
  });

  test('changes when any authority or request field changes', () => {
    for (const key of Object.keys(authority) as Array<keyof MealItemAuthorityFingerprintInput>) {
      const value = authority[key];
      const changed =
        key === 'unit' ? 'ml'
        : key === 'mappingMethod' ? 'lexical'
        : key.endsWith('Sha256') ? 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
        : typeof value === 'number' ? value + 1
        : value === null ? 'set'
        : `${value}-changed`;
      expect(mealItemReviewFingerprint({ ...authority, [key]: changed } as MealItemAuthorityFingerprintInput)).not.toBe(
        mealItemReviewFingerprint(authority),
      );
    }
    for (const key of Object.keys(request) as Array<keyof ReviewRequestFingerprintInput>) {
      const value = request[key];
      const changed =
        key === 'displayedAuthorityFingerprint'
          ? 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
          : typeof value === 'number' ? value + 1
          : `${value}-changed`;
      expect(reviewRequestFingerprint({ ...request, [key]: changed } as ReviewRequestFingerprintInput)).not.toBe(
        reviewRequestFingerprint(request),
      );
    }
  });

  test('distinguishes null, zero, and empty strings and rejects malformed values', () => {
    expect(mealItemReviewFingerprint(authority)).not.toBe(mealItemReviewFingerprint({ ...authority, nutrientProfileId: '' }));
    expect(mealItemReviewFingerprint(authority)).not.toBe(mealItemReviewFingerprint({ ...authority, amountMilliunits: 0 }));
    expect(() => mealItemReviewFingerprint({ ...authority, amountMilliunits: 1.5 })).toThrow();
    expect(() => mealItemReviewFingerprint({ ...authority, amountMilliunits: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => mealItemReviewFingerprint({ ...authority, amountMilliunits: Number.NaN })).toThrow();
    expect(() => mealItemReviewFingerprint({ ...authority, extra: true } as MealItemAuthorityFingerprintInput)).toThrow();
    expect(() => mealItemReviewFingerprint({ ...authority, foodId: undefined } as unknown as MealItemAuthorityFingerprintInput)).toThrow();
    expect(() => reviewRequestFingerprint({ ...request, displayedAuthorityFingerprint: 'ABC' })).toThrow();
  });
});
