import {
  MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
  mealItemReviewFingerprint,
  type MealItemAuthorityFingerprintInput,
} from '@nueat/domain';
import { createHash } from 'node:crypto';

import {
  selectTrustedNutrition,
  type CatalogEligibilityQueryAdapter,
  type CatalogEligibilityReason,
  type CatalogServingUnit,
  type TrustedNutritionSelection,
} from './catalog-eligibility-selector';

export const MEAL_ITEM_AUTHORITY_PROJECTION_VERSION = 'meal-item-authority-projection-v1';
export const MANUAL_REVIEW_FINGERPRINT_VERSION =
  'meal-manual-review-authority-v1';

export type MealItemAuthorityInput = {
  item: {
    id: string;
    revision: number;
    foodId: string | null;
    amountMilliunits: number;
    unit: CatalogServingUnit;
    gramsMg: number;
  };
  activation: { id: string; catalogReleaseId: string };
  mapping: {
    method: 'exact' | 'lexical' | 'user_selected' | 'manual';
    decisionId: string | null;
    contentSha256: string | null;
  };
  calculation: {
    version: string;
    previewId: string | null;
    previewSha256: string | null;
    mealDecompositionRevisionId: string | null;
    mealDecompositionSha256: string | null;
  };
};

export type MealItemAuthorityProjection = {
  version: typeof MEAL_ITEM_AUTHORITY_PROJECTION_VERSION;
  itemId: string;
  selected: {
    food: TrustedNutritionSelection['food'];
    profile: TrustedNutritionSelection['profile'];
    serving: TrustedNutritionSelection['serving'];
    provenance: TrustedNutritionSelection['provenance'];
  } | null;
  officialSource: {
    sourceRegistryId: string;
    sourceReleaseId: string;
    sourceReleaseVersion: string;
    catalogSourcePriority: number;
  } | null;
  invalidReason: CatalogEligibilityReason | 'MISSING_FOOD_MAPPING' | null;
  calculationIdentity: MealItemAuthorityFingerprintInput | null;
  canonicalFingerprintInput: MealItemAuthorityFingerprintInput | null;
  fingerprintVersion: typeof MEAL_ITEM_REVIEW_FINGERPRINT_VERSION;
  fingerprint: string | null;
  canonicalFingerprintHash: string | null;
};

/**
 * The sole release-and-activation-bound authority for a meal item's selected
 * nutrition. Consumers must use this projection rather than independently
 * re-evaluating profile or serving eligibility.
 */
export async function projectMealItemAuthority(
  eligibility: CatalogEligibilityQueryAdapter,
  input: MealItemAuthorityInput,
): Promise<MealItemAuthorityProjection> {
  if (input.item.foodId === null) {
    return invalidProjection(input, 'MISSING_FOOD_MAPPING');
  }

  const result = await selectTrustedNutrition(eligibility, {
    catalogReleaseId: input.activation.catalogReleaseId,
    foodId: input.item.foodId,
    unit: input.item.unit,
  });
  if (result.kind === 'unavailable') return invalidProjection(input, result.reason);

  const calculationIdentity = fingerprintInput(input, result);
  const fingerprint = mealItemReviewFingerprint(calculationIdentity);
  return {
    version: MEAL_ITEM_AUTHORITY_PROJECTION_VERSION,
    itemId: input.item.id,
    selected: {
      food: result.food,
      profile: result.profile,
      serving: result.serving,
      provenance: result.provenance,
    },
    officialSource: {
      sourceRegistryId: result.profile.sourceRegistryId,
      sourceReleaseId: result.provenance.sourceReleaseId,
      sourceReleaseVersion: result.provenance.sourceReleaseVersion,
      catalogSourcePriority: result.provenance.catalogSourcePriority,
    },
    invalidReason: null,
    calculationIdentity,
    canonicalFingerprintInput: calculationIdentity,
    fingerprintVersion: MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
    fingerprint,
    canonicalFingerprintHash: fingerprint,
  };
}

export function projectManualMealItemAuthority(input: {
  id: string;
  itemRevision: number;
  recognizedLabel: string;
  amountMilliunits: number;
  unit: CatalogServingUnit;
  origin: string;
}) {
  const canonicalFingerprintInput = {
    version: MANUAL_REVIEW_FINGERPRINT_VERSION,
    itemId: input.id,
    itemRevision: input.itemRevision,
    recognizedLabel: input.recognizedLabel.normalize('NFC'),
    amountMilliunits: input.amountMilliunits,
    unit: input.unit,
    origin: input.origin,
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(canonicalFingerprintInput))
    .digest('hex');
  return {
    version: MEAL_ITEM_AUTHORITY_PROJECTION_VERSION,
    itemId: input.id,
    selected: null,
    officialSource: null,
    invalidReason: null,
    calculationIdentity: null,
    canonicalFingerprintInput,
    fingerprintVersion: MANUAL_REVIEW_FINGERPRINT_VERSION,
    fingerprint,
    canonicalFingerprintHash: fingerprint,
  } as const;
}

function invalidProjection(
  input: MealItemAuthorityInput,
  invalidReason: MealItemAuthorityProjection['invalidReason'],
): MealItemAuthorityProjection {
  return {
    version: MEAL_ITEM_AUTHORITY_PROJECTION_VERSION,
    itemId: input.item.id,
    selected: null,
    officialSource: null,
    invalidReason,
    calculationIdentity: null,
    canonicalFingerprintInput: null,
    fingerprintVersion: MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
    fingerprint: null,
    canonicalFingerprintHash: null,
  };
}

function fingerprintInput(
  input: MealItemAuthorityInput,
  selection: TrustedNutritionSelection | null,
): MealItemAuthorityFingerprintInput {
  return {
    itemId: input.item.id,
    itemRevision: input.item.revision,
    foodId: input.item.foodId!,
    nutrientProfileId: selection?.profile.id ?? null,
    amountMilliunits: input.item.amountMilliunits,
    unit: input.item.unit,
    gramsMg: input.item.gramsMg,
    catalogReleaseId: input.activation.catalogReleaseId,
    catalogActivationId: input.activation.id,
    mappingMethod: input.mapping.method,
    mappingDecisionId: input.mapping.decisionId,
    mappingContentSha256: input.mapping.contentSha256,
    sourceRegistryId: selection?.profile.sourceRegistryId ?? null,
    sourceReleaseId: selection?.provenance.sourceReleaseId ?? null,
    servingId: selection?.serving?.id ?? null,
    calculationPreviewId: input.calculation.previewId,
    calculationPreviewSha256: input.calculation.previewSha256,
    mealDecompositionRevisionId: input.calculation.mealDecompositionRevisionId,
    mealDecompositionSha256: input.calculation.mealDecompositionSha256,
    calculationVersion: input.calculation.version,
  };
}
