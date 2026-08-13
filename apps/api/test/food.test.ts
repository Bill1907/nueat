import { afterEach, describe, expect, test } from 'bun:test';
import {
  activeCatalogReleasePointers,
  catalogReleaseFoodServings,
  catalogReleaseFoods,
  catalogReleaseNutrientProfiles,
  catalogReleaseSearchDocuments,
  catalogReleaseSources,
  calculationPreviews,
  catalogReleases,
  foodAliases,
  foods,
  foodServings,
  mealItems,
  mealLogs,
  mappingDecisions,
  nutrientProfiles,
  releaseActivations,
  recognitionAttempts,
  storedObservations,
  sourceRegistries,
  sourceReleases,
  type Database,
} from '@nueat/database';
import type { FastifyInstance } from 'fastify';

import type { Auth } from '../src/auth/auth';
import { parseEnvironment } from '../src/config/env';
import { buildServer } from '../src/server';

const environment = parseEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api.example.test',
  RESEND_API_KEY: 're_test',
  TRUSTED_ORIGINS: 'nueat://',
});
const mealLogId = '00000000-0000-4000-8000-000000000001';
const itemId = '00000000-0000-4000-8000-000000000002';
const foodId = '00000000-0000-4000-8000-000000000003';
const profileId = '00000000-0000-4000-8000-000000000004';
const catalogReleaseId = '00000000-0000-4000-8000-000000000020';
const sourceReleaseId = '00000000-0000-4000-8000-000000000021';
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('canonical food routes', () => {
  test('requires authentication', async () => {
    const server = await createServer(false);
    const response = await server.inject({ method: 'GET', url: '/api/foods/search?q=김치' });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });

  test('normalizes exact aliases, orders deterministically, deduplicates foods, and limits results', async () => {
    const server = await createServer(true, {
      aliases: [
        foodAlias('김치', foodId),
        foodAlias('김치가', foodId),
        foodAlias('김치나', '00000000-0000-4000-8000-000000000005'),
        foodAlias('백김치', '00000000-0000-4000-8000-000000000006'),
      ],
      profiles: [
        { id: profileId, foodId, qualityGrade: 'verified', datasetVersion: '2026-01' },
        {
          id: '00000000-0000-4000-8000-000000000008',
          foodId: '00000000-0000-4000-8000-000000000005',
          qualityGrade: 'verified',
          datasetVersion: '2026-01',
        },
        {
          id: '00000000-0000-4000-8000-000000000009',
          foodId: '00000000-0000-4000-8000-000000000006',
          qualityGrade: 'verified',
          datasetVersion: '2026-01',
        },
      ],
    });
    const response = await server.inject({
      method: 'GET',
      url: '/api/foods/search?q=%EA%B9%80%20%EC%B9%98!&limit=2',
    });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.foods.map((food: { id: string }) => food.id)).toEqual([foodId]);
  });

  test('bounds the distinct eligible food query to the requested result limit', async () => {
    const searchCandidateLimits: number[] = [];
    const server = await createServer(true, {
      aliases: Array.from({ length: 150 }, (_, index) =>
        foodAlias(
          `김치${index}`,
          `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
        ),
      ),
      searchCandidateLimits,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/foods/search?q=김치&limit=20',
    });

    expect(response.statusCode).toBe(200);
    expect(searchCandidateLimits).toEqual([20]);
  });

  test('returns no results and rejects malformed queries', async () => {
    const server = await createServer(true, { aliases: [] });
    const empty = await server.inject({ method: 'GET', url: '/api/foods/search?q=---' });
    const tooLong = await server.inject({
      method: 'GET',
      url: `/api/foods/search?q=${'가'.repeat(101)}`,
    });
    const none = await server.inject({ method: 'GET', url: '/api/foods/search?q=없는음식' });
    expect(empty.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
    expect(JSON.parse(none.body)).toEqual({ foods: [] });
  });

  test('hides other users, rejects non-drafts and unavailable profiles', async () => {
    const otherUser = await createServer(true, { mealUserId: 'other-user' });
    const confirmed = await createServer(true, { mealStatus: 'confirmed' });
    const unavailable = await createServer(true, { profiles: [] });
    for (const [server, expected] of [
      [otherUser, 'MEAL_LOG_NOT_FOUND'],
      [confirmed, 'INVALID_MEAL_LOG_STATE'],
      [unavailable, 'FOOD_NUTRIENT_PROFILE_UNAVAILABLE'],
    ] as const) {
      const response = await mapFood(server);
      expect(JSON.parse(response.body).error.code).toBe(expected);
    }
  });
  test('rejects untrusted profiles and allows trusted partial profiles', async () => {
    const untrusted = await createServer(true, {
      profiles: [{
        id: profileId,
        foodId,
        sourceKind: 'user',
        qualityGrade: 'verified',
        datasetVersion: '2026-01',
        energyMillicalories: 150000,
        carbohydrateMg: 30000,
        proteinMg: 2000,
        fatMg: 1000,
      }],
    });
    const incomplete = await createServer(true, {
      profiles: [{
        id: profileId,
        foodId,
        sourceKind: 'public_dataset',
        qualityGrade: 'verified',
        datasetVersion: '2026-01',
        energyMillicalories: 150000,
        carbohydrateMg: null,
        proteinMg: 2000,
        fatMg: 1000,
      }],
    });

    const untrustedResponse = await mapFood(untrusted);
    expect(untrustedResponse.statusCode).toBe(409);
    expect(JSON.parse(untrustedResponse.body).error.code).toBe(
      'FOOD_NUTRIENT_PROFILE_UNAVAILABLE',
    );

    const partialResponse = await mapFood(incomplete);
    expect(partialResponse.statusCode).toBe(200);
  });

  test('maps an item to the preferred profile and returns the full envelope', async () => {
    const server = await createServer(true);
    const response = await mapFood(server);
    const body = JSON.parse(response.body);
    expect(response.statusCode, response.body).toBe(200);
    expect(body.mealLog.id).toBe(mealLogId);
    expect(body.items[0]).toMatchObject({
      id: itemId,
      recognizedLabel: '김치',
      foodId,
      nutrientProfileId: profileId,
      mappingConfidenceBps: 10000,
      currentResolutionSource: 'user_selected',
      userCorrected: true,
      review: {
        status: 'required',
        nextAction: 'review_item',
        authority: {
          invalidReason: null,
        },
      },
    });
  });
  test('hydrates a stable food ID with its preferred trusted profile', async () => {
    const server = await createServer(true, {
      profiles: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          foodId,
          qualityGrade: 'estimated',
          datasetVersion: '2027-01',
        },
        {
          id: profileId,
          foodId,
          qualityGrade: 'verified',
          datasetVersion: '2026-01',
        },
      ],
    });
    const response = await server.inject({
      method: 'GET',
      url: `/api/foods/${foodId}`,
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      id: foodId,
      canonicalNameKo: '김치',
      nutrientProfile: { id: profileId, qualityGrade: 'verified' },
      servings: [{
        id: '00000000-0000-4000-8000-000000000023',
        unit: 'serving',
      }],
    });
  });
  test('pins stable hydration to the requested trusted persisted profile', async () => {
    const persistedProfileId = '00000000-0000-4000-8000-000000000010';
    const server = await createServer(true, {
      profiles: [
        { id: profileId, foodId, qualityGrade: 'verified', datasetVersion: '2026-01' },
        {
          id: persistedProfileId,
          foodId,
          qualityGrade: 'estimated',
          datasetVersion: '2027-01',
        },
      ],
    });
    const response = await server.inject({
      method: 'GET',
      url: `/api/foods/${foodId}?nutrientProfileId=${persistedProfileId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('FOOD_NOT_FOUND');
  });

  test('returns 404 for a mismatched or untrusted requested profile', async () => {
    const mismatchedProfileId = '00000000-0000-4000-8000-000000000011';
    const untrustedProfileId = '00000000-0000-4000-8000-000000000012';
    const server = await createServer(true, {
      profiles: [
        {
          id: mismatchedProfileId,
          foodId: '00000000-0000-4000-8000-000000000013',
          qualityGrade: 'verified',
          datasetVersion: '2026-01',
        },
        {
          id: untrustedProfileId,
          foodId,
          qualityGrade: 'unverified',
          datasetVersion: '2026-01',
        },
      ],
    });

    for (const nutrientProfileId of [mismatchedProfileId, untrustedProfileId]) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/foods/${foodId}?nutrientProfileId=${nutrientProfileId}`,
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error.code).toBe('FOOD_NOT_FOUND');
    }
  });

  test('returns 404 when stable food hydration has no eligible profile', async () => {
    const server = await createServer(true, { profiles: [] });
    const response = await server.inject({
      method: 'GET',
      url: `/api/foods/${foodId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('FOOD_NOT_FOUND');
  });
  test('returns 404 when the stable food is missing or deprecated', async () => {
    const missing = await createServer(true, { food: null });
    const deprecated = await createServer(true, {
      food: { id: foodId, canonicalNameKo: '김치', isDeprecated: true },
    });

    for (const server of [missing, deprecated]) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/foods/${foodId}`,
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error.code).toBe('FOOD_NOT_FOUND');
    }
  });

});

async function mapFood(server: FastifyInstance) {
  return server.inject({
    method: 'PUT',
    url: `/api/meal-logs/${mealLogId}/items/${itemId}/food`,
    headers: {
      'X-NUEAT-Meal-Confirmation-Protocol':
        'meal-confirmation-safe-review-v1',
    },
    payload: { foodId, expectedItemRevision: 1 },
  });
}

function foodAlias(alias: string, id: string) {
  return { foodId: id, canonicalNameKo: alias, category: '반찬', preparation: null, alias };
}

async function createServer(
  authenticated: boolean,
  overrides: {
    aliases?: Record<string, unknown>[];
    mealUserId?: string;
    mealStatus?: string;
    profiles?: Record<string, unknown>[];
    food?: Record<string, unknown> | null;
    searchCandidateLimits?: number[];
  } = {},
) {
  const profileOverrides = overrides.profiles ?? [
    {
      id: profileId,
      foodId,
      qualityGrade: 'verified',
      datasetVersion: '2026-01',
    },
  ];
  const state = {
    aliases: overrides.aliases ?? [foodAlias('김치', foodId)],
    searchDocuments: (overrides.aliases ?? [foodAlias('김치', foodId)]).map(
      (alias, index) => ({
        id: `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
        catalogReleaseId,
        displayTextKo: alias.alias,
        normalizedCompact: normalizeFoodTestQuery(String(alias.alias)),
        ...alias,
      }),
    ),
    mealLogQueries: 0,
    meal: {
      id: mealLogId,
      userId: overrides.mealUserId ?? 'user-id',
      status: overrides.mealStatus ?? 'draft',
      eatenAt: new Date(),
      timezone: 'Asia/Seoul',
      localDate: '2026-08-10',
      mealType: 'lunch',
      imageAssetId: '00000000-0000-4000-8000-000000000030',
      recognitionStatus: 'ready',
      recognitionEngineVersion: 'mock-recognition-v1',
    },
    item: {
      id: itemId,
      mealLogId,
      recognizedLabel: 'unknown',
      amountMilliunits: 1000,
      unit: 'serving',
      recognitionConfidenceBps: 9000,
      portionConfidenceBps: 9000,
      userCorrected: false,
      foodId: null,
      nutrientProfileId: null,
      mappingConfidenceBps: null,
      itemRevision: 1,
      foodRevision: 1,
      portionRevision: 1,
      foodAcknowledgedRevision: 1,
      portionAcknowledgedRevision: 1,
    },
    food:
      overrides.food === undefined
        ? { id: foodId, canonicalNameKo: '김치', isDeprecated: false }
        : overrides.food,
    profiles: profileOverrides.map((profile) => ({
      sourceRegistryId: '00000000-0000-4000-8000-000000000007',
      sourceReleaseId,
      sourceCode: 'dataset',
      sourceDisplayName: 'Dataset',
      sourceItemId: String(profile.id),
      basisAmountMg: 100000,
      energyMillicalories: 150000,
      carbohydrateMg: 30000,
      proteinMg: 2000,
      fatMg: 1000,
      fiberMg: 1000,
      ...profile,
    })),
    searchCandidateLimits: overrides.searchCandidateLimits,
    servings: [{
      id: '00000000-0000-4000-8000-000000000023',
      foodId,
      sourceRegistryId: '00000000-0000-4000-8000-000000000007',
      sourceReleaseId,
      unit: 'serving',
      labelKo: '1인분',
      amountMilliunits: 1_000,
      gramsMg: 100_000,
      qualityGrade: 'verified',
    }],
    activeCatalogRelease: {
      id: '00000000-0000-4000-8000-000000000022',
      activationId: '00000000-0000-4000-8000-000000000022',
      catalogReleaseId,
      policyVersion: 'catalog-release-v1',
      policySha256: 'f'.repeat(64),
    },
    catalogRelease: { id: catalogReleaseId, status: 'published', manifestSha256: 'a'.repeat(64) },
    foodMembers: [{ catalogReleaseId, foodId }],
    profileMembers: profileOverrides.map((profile) => ({ catalogReleaseId, nutrientProfileId: profile.id })),
    servingMembers: [{
      catalogReleaseId,
      foodServingId: '00000000-0000-4000-8000-000000000023',
    }],
    sourceReleases: [{
      id: sourceReleaseId,
      sourceRegistryId: '00000000-0000-4000-8000-000000000007',
      version: '2026-01',
      status: 'published',
      kind: profileOverrides[0]?.sourceKind === 'user'
        ? 'user_entered'
        : 'public_dataset',
      artifactKind: 'nutrition',
      licenseSha256: 'b'.repeat(64),
      artifactSha256: 'c'.repeat(64),
      manifestSha256: 'd'.repeat(64),
    }],
    catalogSources: [{
      catalogReleaseId, sourceReleaseId, priority: 100,
      allowedArtifactKinds: ['nutrition'], eligibilityManifestSha256: 'e'.repeat(64),
    }],
    recognitionAttempt: null as Record<string, unknown> | null,
    storedObservation: null as Record<string, unknown> | null,
    mappingDecisions: [] as Record<string, unknown>[],
    calculationPreviews: [] as Record<string, unknown>[],
  };
  const auth = {
    api: { getSession: async () => (authenticated ? { user: { id: 'user-id' } } : null) },
  } as unknown as Auth;
  const server = await buildServer({ environment, auth, database: databaseMock(state) });
  servers.push(server);
  return server;
}

function applyValuesWithRevisionIncrements(
  target: Record<string, unknown>,
  values: Record<string, unknown>,
  revisionKeys: string[],
) {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'foodAcknowledgedRevision' && typeof value !== 'number') {
      target[key] = target.foodRevision;
    } else if (key === 'portionAcknowledgedRevision' && typeof value !== 'number') {
      target[key] = target.portionRevision;
    } else if (revisionKeys.includes(key) && typeof value !== 'number') {
      target[key] = Number(target[key] ?? 1) + 1;
    } else {
      target[key] = value;
    }
  }
}

function databaseMock(state: Record<string, any>) {
  const resultFor = (table: unknown) => {
    if (table === foodAliases) return state.aliases;
    if (table === catalogReleaseSearchDocuments) return state.searchDocuments;
    if (table === activeCatalogReleasePointers) return [state.activeCatalogRelease];
    if (table === catalogReleases) return [state.catalogRelease];
    if (table === releaseActivations) return [state.activeCatalogRelease];
    if (table === catalogReleaseFoods) return state.foodMembers;
    if (table === catalogReleaseNutrientProfiles) return state.profileMembers;
    if (table === catalogReleaseFoodServings) return state.servingMembers;
    if (table === sourceReleases) return state.sourceReleases;
    if (table === sourceRegistries) return [];
    if (table === recognitionAttempts)
      return state.recognitionAttempt ? [state.recognitionAttempt] : [];
    if (table === storedObservations)
      return state.storedObservation ? [state.storedObservation] : [];
    if (table === mappingDecisions) return state.mappingDecisions;
    if (table === calculationPreviews) return state.calculationPreviews;
    if (table === catalogReleaseSources) return state.catalogSources;
    if (table === nutrientProfiles)
      return state.profiles.filter((profile: Record<string, unknown>) => profile.foodId === foodId).map((profile: Record<string, unknown>) => ({
        sourceKind: 'public_dataset',
        sourceRegistryId: '00000000-0000-4000-8000-000000000007',
        sourceReleaseId,
        ...profile,
      }));
    if (table === foodServings) return state.servings;
    if (table === foods)
      return state.food && !state.food.isDeprecated ? [state.food] : [];
    if (table === mealLogs) {
      state.mealLogQueries += 1;
      return state.meal.userId === 'user-id' ? [state.meal] : [];
    }
    if (table === mealItems) return [state.item];
    return [];
  };
  const query = (rows: any[], table?: unknown) => ({
    for: () => query(rows, table),
    groupBy: () =>
      query(
        table === catalogReleaseSearchDocuments
          ? [...new Map(rows.map((row) => [row.foodId, row])).values()]
          : rows,
        table,
      ),
    limit: async (limit: number) => {
      if (table === catalogReleaseSearchDocuments) state.searchCandidateLimits?.push(limit);
      return rows.slice(0, limit);
    },
    orderBy: () => query(rows, table),
    then: (resolve: (value: any[]) => unknown) => Promise.resolve(rows).then(resolve),
  });
  const database = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(database),
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: () => Object.assign(query(resultFor(table), table), {
          where: () => query(resultFor(table), table),
        }),
        where: () => query(resultFor(table), table),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table === mealItems) {
              applyValuesWithRevisionIncrements(state.item, values, [
                'itemRevision',
                'foodRevision',
                'portionRevision',
              ]);
              return [state.item];
            }
            if (table === mealLogs) {
              applyValuesWithRevisionIncrements(state.meal, values, ['draftRevision']);
              return [state.meal];
            }
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (input: Record<string, unknown> | Record<string, unknown>[]) => {
        const values = Array.isArray(input) ? input : [input];
        const inserted = values.map((value, index) => {
          if (table === recognitionAttempts) {
            const row = {
              ...value,
              id: '00000000-0000-4000-8000-000000000031',
            };
            state.recognitionAttempt = row;
            return row;
          }
          if (table === storedObservations) {
            const row = {
              ...value,
              id: '00000000-0000-4000-8000-000000000032',
            };
            state.storedObservation = row;
            return row;
          }
          if (table === mappingDecisions) {
            const row = {
              ...value,
              id: `00000000-0000-4000-8000-${String(40 + state.mappingDecisions.length + index).padStart(12, '0')}`,
              createdAt: new Date(),
            };
            state.mappingDecisions.push(row);
            return row;
          }
          if (table === calculationPreviews) {
            const row = {
              ...value,
              id: `00000000-0000-4000-8000-${String(50 + state.calculationPreviews.length + index).padStart(12, '0')}`,
              createdAt: new Date(),
            };
            state.calculationPreviews.push(row);
            return row;
          }
          return value;
        });
        return {
          returning: async () => inserted,
          then<TResult1 = unknown>(
            resolve?: (value: unknown[]) => TResult1 | PromiseLike<TResult1>,
          ) {
            return Promise.resolve(inserted).then(resolve);
          },
        };
      },
    }),
  };
  return database as unknown as Database;
}

function normalizeFoodTestQuery(value: string) {
  return value.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
