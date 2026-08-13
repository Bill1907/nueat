import { describe, expect, test } from 'bun:test';
import {
  assertExactCatalogTaxonomyLiterals,
  buildCatalogDocuments,
  buildCatalogManifest,
  buildCatalogSourceManifests,
  CATALOG_CATEGORY_TO_V3_V1,
  CATALOG_RELEASE_VERSION,
} from './catalog-release';

describe('catalog release planning', () => {
  test('freezes K-FIND and Data.go source manifests deterministically', () => {
    const first = buildCatalogManifest();
    const second = buildCatalogManifest();
    expect(first).toEqual(second);
    expect(first.version).toBe(CATALOG_RELEASE_VERSION);
    expect(buildCatalogSourceManifests().map((source) => source.code)).toEqual(['kfind_food_2025_12_29', 'data_go_15100070_food_2026_04_29']);
    expect(first.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('normalizes, sorts, and hashes search documents deterministically', () => {
    const inputs = [
      { foodId: 'b', sourceAliasId: 'a2', displayTextKo: '비빔-밥' },
      { foodId: 'a', sourceAliasId: null, displayTextKo: '김밥' },
    ];
    const documents = buildCatalogDocuments(inputs);
    expect(documents.map((document) => document.foodId)).toEqual(['a', 'b']);
    expect(buildCatalogManifest(inputs).documentCount).toBe(2);
    expect(buildCatalogDocuments([...inputs].reverse())).toEqual(documents);
  });

  test('rejects duplicate catalog document identities', () => {
    expect(() => buildCatalogDocuments([
      { foodId: 'food', sourceAliasId: null, displayTextKo: '김밥' },
      { foodId: 'food', sourceAliasId: null, displayTextKo: '김밥' },
    ])).toThrow('Catalog document collision');
  });

  test('requires exact imported taxonomy literal membership', () => {
    const categories = Object.keys(CATALOG_CATEGORY_TO_V3_V1);
    expect(() =>
      assertExactCatalogTaxonomyLiterals(categories, []),
    ).not.toThrow();
    expect(() =>
      assertExactCatalogTaxonomyLiterals(categories.slice(1), []),
    ).toThrow('Catalog category taxonomy literals do not match');
    expect(() =>
      assertExactCatalogTaxonomyLiterals([...categories, '새 분류'], []),
    ).toThrow('Catalog category taxonomy literals do not match');
  });

  test('binds exact eligibility-driving membership into the release digest', () => {
    const documents = [{
      foodId: 'food',
      sourceAliasId: null,
      displayTextKo: '김밥',
    }];
    const authority = {
      nutrientProfileIds: ['profile-a'],
      foodServingIds: ['serving-a'],
      sources: [{
        sourceReleaseId: 'source-a',
        priority: 100,
        allowedArtifactKinds: ['nutrition'],
        eligibilityManifestSha256: 'a'.repeat(64),
      }],
    };
    const baseline = buildCatalogManifest(documents, authority).manifestSha256;
    expect(buildCatalogManifest(documents, {
      ...authority,
      nutrientProfileIds: ['profile-b'],
    }).manifestSha256).not.toBe(baseline);
    expect(buildCatalogManifest(documents, {
      ...authority,
      sources: [{ ...authority.sources[0]!, priority: 110 }],
    }).manifestSha256).not.toBe(baseline);
  });
});
