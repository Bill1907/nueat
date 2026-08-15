import { describe, expect, test } from 'bun:test';

import {
  CALCULATION_INPUT_SNAPSHOT_V2,
  parseCalculationInputSnapshot,
  projectCalculationInputSnapshot,
} from './calculation-snapshot';
import type {
  CalculationInputSnapshotV2,
  LegacyCalculationInputSnapshot,
} from './calculation-snapshot';

const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const legacyItem = {
  mealItemId: 'item-1', origin: 'legacy_unknown', initialEstimateAssessment: null,
  currentResolutionSource: 'legacy_existing', itemRevision: 1, foodRevision: 1, portionRevision: 1,
  foodAcknowledgedRevision: null, portionAcknowledgedRevision: null, foodId: 'food-1', nutrientProfileId: 'profile-1',
  amountMilliunits: 100_000, unit: 'g', gramsMg: 100_000, sourceRegistryId: 'mfds', sourceItemId: 'source-1',
  datasetVersion: '2025-12-29', nutrientProfileQualityGrade: 'verified',
  nutrientProfile: { basisAmountMg: 100_000 }, serving: null,
  nutrients: { energyMillicalories: 100_000, carbohydrateMg: 20_000, proteinMg: 3_000, fatMg: 1_000, fiberMg: null },
} satisfies LegacyCalculationInputSnapshot['mealItems'][number];
const confirmationDecision = {
  originalRecognition: null, manualOverride: null,
  policy: { version: 'meal-estimate-review-v1', activation: 'review_only', approvedReportSha256: null, activeReportSha256: null, approvedReportVersion: null },
} satisfies LegacyCalculationInputSnapshot['confirmationDecision'];
const v2ConfirmationDecision = {
  reviewProtocol: 'meal-confirmation-safe-review-v1',
  originalRecognition: null,
  manualOverride: null,
} satisfies CalculationInputSnapshotV2['confirmationDecision'];
const legacy: LegacyCalculationInputSnapshot = { confirmationDecision, mealItems: [legacyItem] };
const v2Item = {
  ...legacyItem,
  checkpoint: { reviewedItemRevision: 1, reviewedAuthorityFingerprintVersion: 'meal-item-review-fingerprint-v1', reviewedAuthorityFingerprint: hash, reviewIdempotencyKey: 'review-1', reviewRequestFingerprint: hash, reviewedAt: '2026-08-13T00:00:00.000Z' },
  authority: { fingerprintVersion: 'meal-item-review-fingerprint-v1', fingerprint: hash },
  provenance: { calculationVersion: 'meal-nutrition-v1', sourceRegistryId: 'mfds', sourceItemId: 'source-1', datasetVersion: '2025-12-29', nutrientProfileId: 'profile-1' },
} satisfies CalculationInputSnapshotV2['mealItems'][number];
const v2: CalculationInputSnapshotV2 = {
  version: CALCULATION_INPUT_SNAPSHOT_V2,
  confirmationDecision: v2ConfirmationDecision,
  mealItems: [v2Item],
};

describe('calculation input snapshots', () => {
  test('parses exact legacy payloads without rewriting their evidence', () => {
    const parsed = parseCalculationInputSnapshot(legacy);
    expect(parsed).toEqual({ kind: 'legacy', snapshot: legacy });
    expect(parsed?.snapshot).toBe(legacy);
    expect(parsed && projectCalculationInputSnapshot(parsed)).toMatchObject({
      version: 'legacy', reviewEvidence: 'legacy_unknown',
      mealItems: [{ mealItemId: 'item-1', nutrients: legacyItem.nutrients, checkpoint: null, authority: null }],
    });
  });

  test('parses explicit V2 snapshots and projects explicit checkpoint evidence', () => {
    const parsed = parseCalculationInputSnapshot(v2);
    expect(parsed).toEqual({ kind: 'v2', snapshot: v2 });
    expect(parsed && projectCalculationInputSnapshot(parsed)).toMatchObject({
      version: CALCULATION_INPUT_SNAPSHOT_V2, reviewEvidence: 'explicit_v2',
      mealItems: [{ checkpoint: v2Item.checkpoint, authority: v2Item.authority, provenance: v2Item.provenance }],
    });
  });

  test('preserves reviewed unmapped intake with null nutrition authority', () => {
    const manualItem: CalculationInputSnapshotV2['mealItems'][number] = {
      ...v2Item,
      origin: 'manual_entry',
      currentResolutionSource: null,
      foodId: null,
      nutrientProfileId: null,
      gramsMg: null,
      sourceRegistryId: null,
      sourceItemId: null,
      datasetVersion: null,
      nutrientProfileQualityGrade: null,
      nutrientProfile: null,
      nutrients: {
        energyMillicalories: null,
        carbohydrateMg: null,
        proteinMg: null,
        fatMg: null,
        fiberMg: null,
      },
      authority: {
        fingerprintVersion: 'meal-manual-review-authority-v1',
        fingerprint: hash,
      },
      provenance: {
        calculationVersion: 'meal-nutrition-v1',
        sourceRegistryId: null,
        sourceItemId: null,
        datasetVersion: null,
        nutrientProfileId: null,
      },
    };
    const snapshot = { ...v2, mealItems: [manualItem] };
    const parsed = parseCalculationInputSnapshot(snapshot);

    expect(parsed).toEqual({ kind: 'v2', snapshot });
    expect(parsed && projectCalculationInputSnapshot(parsed)).toMatchObject({
      mealItems: [{
        foodId: null,
        nutrients: { energyMillicalories: null },
        authority: manualItem.authority,
      }],
    });
  });

  test('parses the V2 writer confirmation fixture for every supported manual origin', () => {
    for (const [fromStatus, fromOutcome] of [
      ['ready', 'no_food'],
      ['pending', null],
      ['processing', 'recognized'],
      ['failed', 'insufficient_evidence'],
    ] as const) {
      const snapshot = {
        ...v2,
        confirmationDecision: {
          ...v2ConfirmationDecision,
          manualOverride: {
            fromStatus,
            fromOutcome,
            decision: 'direct_entry' as const,
            decisionVersion: 'recognition-manual-override-v1' as const,
            decidedAt: '2026-08-13T00:00:00.000Z',
          },
        },
      };
      expect(parseCalculationInputSnapshot(snapshot)).toEqual({
        kind: 'v2',
        snapshot,
      });
    }
  });

  test('fails closed for extra legacy fields, malformed V2, and unknown versions', () => {
    expect(parseCalculationInputSnapshot({ ...legacy, version: 'meal-calculation-snapshot-v3' })).toBeNull();
    expect(parseCalculationInputSnapshot({ ...legacy, extra: true })).toBeNull();
    expect(parseCalculationInputSnapshot({ ...v2, mealItems: [{ ...v2Item, checkpoint: { ...v2Item.checkpoint, reviewedAuthorityFingerprint: 'uppercase' } }] })).toBeNull();
    expect(parseCalculationInputSnapshot({ ...v2, version: null })).toBeNull();
    expect(parseCalculationInputSnapshot({
      ...v2,
      confirmationDecision: { ...v2ConfirmationDecision, policy: {} },
    })).toBeNull();
  });
});
