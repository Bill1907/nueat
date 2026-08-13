import { describe, expect, test } from 'bun:test';
import {
  foodAliases,
  foods,
  foodServings,
  nutrientProfiles,
  sourceRegistries,
} from '@nueat/database';

import {
  calculateCatalogReleaseIdentity,
  calculateCatalogRegistrySha256,
} from '../src/services/catalog-registry-verifier';

describe('catalog registry verifier', () => {
  test('hashes authoritative catalog rows deterministically and detects drift', async () => {
    const rows = new Map<unknown, Record<string, unknown>[]>([
      [sourceRegistries, [{ id: 'registry-1', code: 'official', kind: 'public_dataset', datasetVersion: '2026-01', licenseReference: 'official', publishedAt: new Date('2026-01-01T00:00:00Z') }]],
      [foods, [{ id: 'food-1', canonicalNameKo: '김치', category: '반찬', preparation: null, isComposite: false, isDeprecated: false, replacementFoodId: null }]],
      [foodAliases, [{ id: 'alias-1', normalizedAliasKo: '김치', foodId: 'food-1' }]],
      [nutrientProfiles, [{ id: 'profile-1', foodId: 'food-1', sourceRegistryId: 'registry-1', sourceItemId: 'kimchi', datasetVersion: '2026-01', basisAmountMg: 100000, energyMillicalories: 150000, carbohydrateMg: 30000, proteinMg: 2000, fatMg: 1000, fiberMg: 1000, qualityGrade: 'verified' }]],
      [foodServings, [{ id: 'serving-1', foodId: 'food-1', unit: 'g', amountMilliunits: 100000, gramsMg: 100000, sourceRegistryId: 'registry-1', qualityGrade: 'verified' }]],
    ]);
    const database = fakeDatabase(rows);
    const first = await calculateCatalogRegistrySha256(database as never);
    const second = await calculateCatalogRegistrySha256(database as never);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    rows.get(foodAliases)![0]!.normalizedAliasKo = '배추김치';
    expect(await calculateCatalogRegistrySha256(database as never)).not.toBe(first);
  });

  test('derives stable release IDs bound to the same authoritative registry digest', async () => {
    const rows = new Map<unknown, Record<string, unknown>[]>([
      [sourceRegistries, [{ id: 'registry-1', code: 'official', kind: 'public_dataset', datasetVersion: '2026-01', licenseReference: 'official', publishedAt: new Date('2026-01-01T00:00:00Z') }]],
      [foods, []], [foodAliases, []], [nutrientProfiles, []], [foodServings, []],
    ]);
    const database = fakeDatabase(rows);
    const identity = await calculateCatalogReleaseIdentity(database as never);
    expect(identity.releaseIds).toEqual(['official@2026-01']);
    expect(identity.registrySha256).toBe(await calculateCatalogRegistrySha256(database as never));
  });
});

function fakeDatabase(rows: Map<unknown, Record<string, unknown>[]>) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        orderBy: async () => rows.get(table) ?? [],
      }),
    }),
  };
}
