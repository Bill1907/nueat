import { describe, expect, test } from 'bun:test';

import {
  selectTrustedNutrition,
  selectTrustedNutritionRows,
  type TrustedNutritionSelectorRows,
} from '../src/services/catalog-eligibility-selector';

const hash = 'a'.repeat(64);

function rows(overrides: Partial<TrustedNutritionSelectorRows> = {}): TrustedNutritionSelectorRows {
  return {
    catalogRelease: { id: 'catalog-1', status: 'published', manifestSha256: hash },
    food: { id: 'food-1', canonicalNameKo: '김치', isDeprecated: false },
    foodMembers: [{ catalogReleaseId: 'catalog-1', foodId: 'food-1' }],
    profiles: [{
      id: 'profile-1', foodId: 'food-1', sourceRegistryId: 'registry-1', sourceReleaseId: 'source-1',
      sourceItemId: 'kimchi', datasetVersion: '2026-01', basisAmountMg: 100_000,
      energyMillicalories: 100_000, carbohydrateMg: 20_000, proteinMg: 2_000, fatMg: 1_000,
      fiberMg: null, qualityGrade: 'verified',
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

function select(input: Partial<{ unit: 'g' | 'bowl' }> = {}, data = rows()) {
  return selectTrustedNutritionRows({ catalogReleaseId: 'catalog-1', foodId: 'food-1', unit: 'g', ...input }, data);
}

describe('trusted nutrition selector', () => {
  test('uses the adapter and returns profile provenance without replacing nullable nutrients', async () => {
    const data = rows();
    const result = await selectTrustedNutrition({ load: async () => data }, {
      catalogReleaseId: 'catalog-1', foodId: 'food-1', unit: 'g',
    });
    expect(result).toMatchObject({
      kind: 'selected',
      profile: { id: 'profile-1', fiberMg: null },
      serving: null,
      provenance: { catalogReleaseId: 'catalog-1', sourceReleaseId: 'source-1', catalogSourcePriority: 100 },
    });
  });

  test('fails closed for a deprecated food or nonmember food', () => {
    expect(select({}, rows({ food: { id: 'food-1', canonicalNameKo: '김치', isDeprecated: true } }))).toEqual({
      kind: 'unavailable', reason: 'DEPRECATED_FOOD',
    });
    expect(select({}, rows({ foodMembers: [] }))).toEqual({ kind: 'unavailable', reason: 'FOOD_NOT_RELEASE_MEMBER' });
  });

  test('rejects revoked sources, untrusted kinds, and mismatched profile versions', () => {
    expect(select({}, rows({ sourceReleases: [{ ...rows().sourceReleases[0]!, status: 'revoked' }] }))).toEqual({
      kind: 'unavailable', reason: 'SOURCE_RELEASE_REVOKED',
    });
    expect(select({}, rows({ sourceReleases: [{ ...rows().sourceReleases[0]!, kind: 'user_entered' }] }))).toEqual({
      kind: 'unavailable', reason: 'UNTRUSTED_SOURCE_KIND',
    });
    expect(select({}, rows({ profiles: [{ ...rows().profiles[0]!, datasetVersion: 'other-version' }] }))).toEqual({
      kind: 'unavailable', reason: 'PROFILE_SOURCE_VERSION_MISMATCH',
    });
  });

  test('rejects profiles that do not belong to the selected food', () => {
    expect(select({}, rows({ profiles: [{ ...rows().profiles[0]!, foodId: 'other-food' }] }))).toEqual({
      kind: 'unavailable', reason: 'MISMATCHED_PROFILE',
    });
  });

  test('accepts a partial profile when it has at least one supported nutrient', () => {
    const profile = { ...rows().profiles[0]!, energyMillicalories: null, carbohydrateMg: null, proteinMg: 2_000, fatMg: null };
    expect(select({}, rows({ profiles: [profile] }))).toMatchObject({ kind: 'selected', profile });
  });

  test('requires exactly one trusted serving at the best source priority', () => {
    expect(select({ unit: 'bowl' }, rows({ servings: [] }))).toEqual({
      kind: 'unavailable', reason: 'SERVING_NOT_RELEASE_MEMBER',
    });
    expect(select({ unit: 'bowl' }, rows({ servings: [{ ...rows().servings[0]!, qualityGrade: 'unverified' }] }))).toEqual({
      kind: 'unavailable', reason: 'UNTRUSTED_SERVING_SOURCE',
    });
    const secondServing = { ...rows().servings[0]!, id: 'serving-2' };
    expect(select({ unit: 'bowl' }, rows({
      servings: [rows().servings[0]!, secondServing],
      servingMembers: [
        { catalogReleaseId: 'catalog-1', foodServingId: 'serving-1' },
        { catalogReleaseId: 'catalog-1', foodServingId: 'serving-2' },
      ],
    }))).toEqual({ kind: 'unavailable', reason: 'AMBIGUOUS_SERVING_CONVERSION' });
  });

  test('uses source priority, quality, supported count, and UTF-8 ID tie breaks deterministically', () => {
    const estimated = { ...rows().profiles[0]!, id: 'z-profile', sourceReleaseId: 'source-2', sourceRegistryId: 'registry-2', sourceItemId: 'z', qualityGrade: 'estimated' as const };
    const verified = { ...rows().profiles[0]!, id: 'b-profile', sourceReleaseId: 'source-3', sourceRegistryId: 'registry-3', sourceItemId: 'z', qualityGrade: 'verified' as const };
    const lexicalFirst = { ...verified, id: 'a-profile', sourceItemId: 'a' };
    const data = rows({
      profiles: [estimated, verified, lexicalFirst],
      profileMembers: [
        { catalogReleaseId: 'catalog-1', nutrientProfileId: 'z-profile' },
        { catalogReleaseId: 'catalog-1', nutrientProfileId: 'b-profile' },
        { catalogReleaseId: 'catalog-1', nutrientProfileId: 'a-profile' },
      ],
      sourceReleases: [
        { ...rows().sourceReleases[0]!, id: 'source-2', sourceRegistryId: 'registry-2' },
        { ...rows().sourceReleases[0]!, id: 'source-3', sourceRegistryId: 'registry-3' },
      ],
      catalogSources: [
        { ...rows().catalogSources[0]!, sourceReleaseId: 'source-2', priority: 200 },
        { ...rows().catalogSources[0]!, sourceReleaseId: 'source-3', priority: 100 },
      ],
    });
    expect(select({}, data)).toMatchObject({ kind: 'selected', profile: { id: 'a-profile' } });
  });
});
