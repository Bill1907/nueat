import { describe, expect, test } from 'bun:test';

import type { TrustedNutritionSelectorRows } from '../src/services/catalog-eligibility-selector';
import { selectMealCompositionRows } from '../src/services/meal-composition-selector';

const hash = 'a'.repeat(64);
function rows(foodId: string): TrustedNutritionSelectorRows {
  return {
    catalogRelease: { id: 'catalog-1', status: 'published', manifestSha256: hash },
    food: { id: foodId, canonicalNameKo: foodId, isDeprecated: false },
    foodMembers: [{ catalogReleaseId: 'catalog-1', foodId }],
    profiles: [{ id: `profile-${foodId}`, foodId, sourceRegistryId: 'registry-1', sourceReleaseId: 'source-1', sourceItemId: foodId, datasetVersion: 'v1', basisAmountMg: 100_000, energyMillicalories: 1, carbohydrateMg: null, proteinMg: null, fatMg: null, fiberMg: null, qualityGrade: 'verified' }],
    profileMembers: [{ catalogReleaseId: 'catalog-1', nutrientProfileId: `profile-${foodId}` }],
    servings: [], servingMembers: [],
    sourceReleases: [{ id: 'source-1', sourceRegistryId: 'registry-1', version: 'v1', status: 'published', kind: 'public_dataset', artifactKind: 'nutrition-json', licenseSha256: hash, artifactSha256: hash, manifestSha256: hash }],
    catalogSources: [{ catalogReleaseId: 'catalog-1', sourceReleaseId: 'source-1', priority: 100, allowedArtifactKinds: ['nutrition-json'], eligibilityManifestSha256: hash }],
  };
}
const input = (composition: Parameters<typeof selectMealCompositionRows>[0]['composition']) => ({ catalogReleaseId: 'catalog-1', releaseActivationId: 'activation-1', rootMappingDecisionId: 'root-decision', rootRevision: 1, composition });

describe('meal composition selector', () => {
  test('resolves every source recipe leaf in ordinal order and returns one root preview identity', () => {
    const result = selectMealCompositionRows(input({ sourceRecipe: { kind: 'source_recipe', recipeVersionId: 'recipe', sourceReleaseId: 'source-1', yieldMg: 20_000, consumedRootAmountMg: 20_000, components: [
      { id: 'first', foodId: 'food-b', edibleAmountMg: 10_000, ordinal: 0 },
      { id: 'second', foodId: 'food-a', edibleAmountMg: 10_000, ordinal: 1 },
    ] } }), { 'food-a': rows('food-a'), 'food-b': rows('food-b') });
    expect(result).toMatchObject({ kind: 'selected', preview: { identity: { basis: 'source_recipe', leaves: [{ foodId: 'food-b', ordinal: 0 }, { foodId: 'food-a', ordinal: 1 }] } } });
    expect(result).toMatchObject({ preview: { identity: { releaseActivationId: 'activation-1' } } });
  });

  test('fails closed when any leaf is missing or belongs to another catalog release', () => {
    const composition = { sourceRecipe: { kind: 'source_recipe' as const, recipeVersionId: 'recipe', sourceReleaseId: 'source-1', yieldMg: 10_000, consumedRootAmountMg: 10_000, components: [{ id: 'leaf', foodId: 'food-a', edibleAmountMg: 10_000, ordinal: 0 }] } };
    expect(selectMealCompositionRows(input(composition), {})).toEqual({ kind: 'unavailable', reason: 'LEAF_NOT_AVAILABLE_IN_CATALOG_RELEASE' });
    expect(selectMealCompositionRows(input(composition), { 'food-a': { ...rows('food-a'), foodMembers: [] } })).toEqual({ kind: 'unavailable', reason: 'LEAF_FOOD_NOT_RELEASE_MEMBER' });
  });
});
