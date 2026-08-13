import { describe, expect, test } from 'bun:test';

import {
  projectMealItemAuthority,
  type MealItemAuthorityInput,
} from '../src/services/meal-item-authority';
import type { TrustedNutritionSelectorRows } from '../src/services/catalog-eligibility-selector';

const hash = 'a'.repeat(64);
const input: MealItemAuthorityInput = {
  item: { id: 'item-1', revision: 2, foodId: 'food-1', amountMilliunits: 1_000, unit: 'bowl', gramsMg: 200_000 },
  activation: { id: 'activation-1', catalogReleaseId: 'catalog-1' },
  mapping: { method: 'exact', decisionId: 'decision-1', contentSha256: hash },
  calculation: {
    version: 'meal-nutrition-v1', previewId: 'preview-1', previewSha256: 'b'.repeat(64),
    mealDecompositionRevisionId: null, mealDecompositionSha256: null,
  },
};

function rows(overrides: Partial<TrustedNutritionSelectorRows> = {}): TrustedNutritionSelectorRows {
  return {
    catalogRelease: { id: 'catalog-1', status: 'published', manifestSha256: hash },
    food: { id: 'food-1', canonicalNameKo: '김치', isDeprecated: false },
    foodMembers: [{ catalogReleaseId: 'catalog-1', foodId: 'food-1' }],
    profiles: [{
      id: 'profile-1', foodId: 'food-1', sourceRegistryId: 'registry-1', sourceReleaseId: 'source-1',
      sourceItemId: 'kimchi', datasetVersion: '2026-01', basisAmountMg: 100_000,
      energyMillicalories: 100_000, carbohydrateMg: null, proteinMg: 2_000, fatMg: null, fiberMg: null,
      qualityGrade: 'verified',
    }],
    profileMembers: [{ catalogReleaseId: 'catalog-1', nutrientProfileId: 'profile-1' }],
    servings: [{
      id: 'serving-1', foodId: 'food-1', sourceRegistryId: 'registry-1', sourceReleaseId: 'source-1',
      unit: 'bowl', amountMilliunits: 1_000, gramsMg: 200_000, qualityGrade: 'verified',
    }],
    servingMembers: [{ catalogReleaseId: 'catalog-1', foodServingId: 'serving-1' }],
    sourceReleases: [{
      id: 'source-1', sourceRegistryId: 'registry-1', version: '2026-01', status: 'published',
      kind: 'public_dataset', artifactKind: 'nutrition-json', licenseSha256: hash,
      artifactSha256: hash, manifestSha256: hash,
    }],
    catalogSources: [{
      catalogReleaseId: 'catalog-1', sourceReleaseId: 'source-1', priority: 100,
      allowedArtifactKinds: ['nutrition-json'], eligibilityManifestSha256: hash,
    }],
    ...overrides,
  };
}

describe('meal item authority projection', () => {
  test('selects only release-member nutrition and exposes official source display', async () => {
    const authority = await projectMealItemAuthority({ load: async () => rows() }, input);

    expect(authority).toMatchObject({
      invalidReason: null,
      selected: { food: { id: 'food-1', canonicalNameKo: '김치' }, profile: { id: 'profile-1' }, serving: { id: 'serving-1' } },
      officialSource: { sourceRegistryId: 'registry-1', sourceReleaseId: 'source-1', sourceReleaseVersion: '2026-01', catalogSourcePriority: 100 },
    });
    expect(authority.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await projectMealItemAuthority({ load: async () => rows() }, input)).fingerprint)
      .toBe(authority.fingerprint);
  });

  test('fails closed for source, serving, and release membership changes', async () => {
    expect((await projectMealItemAuthority({ load: async () => rows({ foodMembers: [] }) }, input)).invalidReason)
      .toBe('FOOD_NOT_RELEASE_MEMBER');
    expect((await projectMealItemAuthority({ load: async () => rows({ sourceReleases: [{ ...rows().sourceReleases[0]!, status: 'revoked' }] }) }, input)).invalidReason)
      .toBe('SOURCE_RELEASE_REVOKED');
    expect((await projectMealItemAuthority({ load: async () => rows({ servingMembers: [] }) }, input)).invalidReason)
      .toBe('SERVING_NOT_RELEASE_MEMBER');
  });

  test('uses priority-selected nutrition and changes its fingerprint for affected authority inputs', async () => {
    const preferred = { ...rows().profiles[0]!, id: 'profile-preferred', sourceReleaseId: 'source-2', sourceRegistryId: 'registry-2' };
    const data = rows({
      profiles: [rows().profiles[0]!, preferred],
      profileMembers: [
        { catalogReleaseId: 'catalog-1', nutrientProfileId: 'profile-1' },
        { catalogReleaseId: 'catalog-1', nutrientProfileId: 'profile-preferred' },
      ],
      sourceReleases: [
        rows().sourceReleases[0]!,
        { ...rows().sourceReleases[0]!, id: 'source-2', sourceRegistryId: 'registry-2' },
      ],
      catalogSources: [
        rows().catalogSources[0]!,
        { ...rows().catalogSources[0]!, sourceReleaseId: 'source-2', priority: 10 },
      ],
    });
    const selected = await projectMealItemAuthority({ load: async () => data }, input);
    const revised = await projectMealItemAuthority({ load: async () => data }, {
      ...input,
      item: { ...input.item, revision: 3 },
    });
    expect(selected.selected?.profile.id).toBe('profile-preferred');
    expect(revised.fingerprint).not.toBe(selected.fingerprint);
  });
});
