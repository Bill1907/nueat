import {
  type MealCompositionInput,
  selectMealComposition,
} from '@nueat/domain';

import {
  selectTrustedNutritionRows,
  type TrustedNutritionSelection,
  type TrustedNutritionSelectorRows,
} from './catalog-eligibility-selector';

export const MEAL_COMPOSITION_SELECTOR_VERSION = 'meal-composition-selector-v1';

export type MealCompositionSelectorInput = {
  catalogReleaseId: string;
  releaseActivationId: string;
  rootMappingDecisionId: string;
  rootRevision: number;
  composition: MealCompositionInput;
};

export type CalculationPreviewIdentity = {
  selectorVersion: typeof MEAL_COMPOSITION_SELECTOR_VERSION;
  catalogReleaseId: string;
  releaseActivationId: string;
  rootMappingDecisionId: string;
  rootRevision: number;
  basis: 'finished_profile' | 'source_recipe' | 'meal_decomposition';
  recipeVersionId?: string;
  decompositionRevisionId?: string;
  leaves: ReadonlyArray<{
    ordinal: number;
    componentIdentity: string;
    foodId: string;
    edibleAmountMg: number;
    unit: 'g';
    nutrientProfileId: string;
    sourceItemId: string;
    profileQualityGrade: 'verified' | 'estimated' | 'unverified';
    servingId: null;
    servingAmountMilliunits: null;
    servingGramsMg: null;
    servingSourceRegistryId: null;
    servingQualityGrade: null;
    sourceRegistryId: string;
    sourceReleaseId: string;
    sourceReleaseVersion: string;
    catalogReleaseId: string;
    catalogManifestSha256: string;
    nutrientProfile: {
      basisAmountMg: number;
      energyMillicalories: number | null;
      carbohydrateMg: number | null;
      proteinMg: number | null;
      fatMg: number | null;
      fiberMg: number | null;
    };
  }>;
};

export type MealCompositionSelectorResult =
  | { kind: 'selected'; preview: { discriminant: 'meal-composition'; identity: CalculationPreviewIdentity }; leaves: readonly TrustedNutritionSelection[] }
  | { kind: 'unavailable'; reason: string };

/** Resolves every arithmetic leaf through the shared release-scoped trusted selector. */
export function selectMealCompositionRows(
  input: MealCompositionSelectorInput,
  rowsByFoodId: Readonly<Record<string, TrustedNutritionSelectorRows>>,
): MealCompositionSelectorResult {
  if (
    !input.catalogReleaseId.trim() ||
    !input.releaseActivationId.trim() ||
    !input.rootMappingDecisionId.trim() ||
    !Number.isSafeInteger(input.rootRevision) ||
    input.rootRevision <= 0
  ) {
    return { kind: 'unavailable', reason: 'INVALID_ROOT_REVISION' };
  }
  const composition = selectMealComposition(input.composition);
  if (composition.kind !== 'selected') return { kind: 'unavailable', reason: composition.reason };

  const leaves = composition.basis.kind === 'finished_profile'
    ? [{ id: input.rootMappingDecisionId, foodId: composition.basis.foodId, edibleAmountMg: composition.basis.edibleAmountMg, ordinal: 0 }]
    : composition.basis.components;
  const selected: TrustedNutritionSelection[] = [];
  for (const leaf of leaves) {
    const rows = rowsByFoodId[leaf.foodId];
    if (!rows) return { kind: 'unavailable', reason: 'LEAF_NOT_AVAILABLE_IN_CATALOG_RELEASE' };
    const resolved = selectTrustedNutritionRows({
      catalogReleaseId: input.catalogReleaseId,
      foodId: leaf.foodId,
      unit: 'g',
    }, rows);
    if (resolved.kind !== 'selected') return { kind: 'unavailable', reason: `LEAF_${resolved.reason}` };
    if (composition.basis.kind === 'finished_profile' && resolved.profile.id !== composition.basis.profileId) {
      return { kind: 'unavailable', reason: 'FINISHED_PROFILE_NOT_TRUSTED' };
    }
    selected.push(resolved);
  }

  return {
    kind: 'selected',
    leaves: selected,
    preview: {
      discriminant: 'meal-composition',
      identity: {
        selectorVersion: MEAL_COMPOSITION_SELECTOR_VERSION,
        catalogReleaseId: input.catalogReleaseId,
        releaseActivationId: input.releaseActivationId,
        rootMappingDecisionId: input.rootMappingDecisionId,
        rootRevision: input.rootRevision,
        basis: composition.basis.kind,
        ...(composition.basis.kind === 'source_recipe'
          ? { recipeVersionId: composition.basis.recipeVersionId }
          : composition.basis.kind === 'meal_decomposition'
            ? { decompositionRevisionId: composition.basis.revisionId }
            : {}),
        leaves: leaves.map((leaf, index) => ({
          ordinal: leaf.ordinal,
          componentIdentity: leaf.id,
          foodId: leaf.foodId,
          edibleAmountMg: leaf.edibleAmountMg,
          unit: 'g' as const,
          nutrientProfileId: selected[index]!.profile.id,
          sourceItemId: selected[index]!.profile.sourceItemId,
          profileQualityGrade: selected[index]!.profile.qualityGrade,
          servingId: null,
          servingAmountMilliunits: null,
          servingGramsMg: null,
          servingSourceRegistryId: null,
          servingQualityGrade: null,
          sourceRegistryId: selected[index]!.profile.sourceRegistryId,
          sourceReleaseId: selected[index]!.provenance.sourceReleaseId,
          sourceReleaseVersion: selected[index]!.provenance.sourceReleaseVersion,
          catalogReleaseId: selected[index]!.provenance.catalogReleaseId,
          catalogManifestSha256: selected[index]!.provenance.catalogManifestSha256,
          nutrientProfile: {
            basisAmountMg: selected[index]!.profile.basisAmountMg,
            energyMillicalories: selected[index]!.profile.energyMillicalories,
            carbohydrateMg: selected[index]!.profile.carbohydrateMg,
            proteinMg: selected[index]!.profile.proteinMg,
            fatMg: selected[index]!.profile.fatMg,
            fiberMg: selected[index]!.profile.fiberMg,
          },
        })),
      },
    },
  };
}
