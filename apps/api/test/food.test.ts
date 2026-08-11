import { afterEach, describe, expect, test } from 'bun:test';
import {
  foodAliases,
  foods,
  foodServings,
  mealItems,
  mealLogs,
  nutrientProfiles,
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
    expect(body.foods.map((food: { id: string }) => food.id)).toEqual([
      foodId,
      '00000000-0000-4000-8000-000000000005',
    ]);
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

  test('maps an item to the preferred profile and returns the full envelope', async () => {
    const server = await createServer(true);
    const response = await mapFood(server);
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.mealLog.id).toBe(mealLogId);
    expect(body.items[0]).toMatchObject({
      id: itemId,
      recognizedLabel: '김치',
      foodId,
      nutrientProfileId: profileId,
      mappingConfidenceBps: 10000,
      userCorrected: true,
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
      servings: [],
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

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).nutrientProfile).toMatchObject({
      id: persistedProfileId,
      qualityGrade: 'estimated',
    });
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
    payload: { foodId },
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
  const state = {
    aliases: overrides.aliases ?? [foodAlias('김치', foodId)],
    mealLogQueries: 0,
    meal: {
      id: mealLogId,
      userId: overrides.mealUserId ?? 'user-id',
      status: overrides.mealStatus ?? 'draft',
      eatenAt: new Date(),
      timezone: 'Asia/Seoul',
      localDate: '2026-08-10',
      mealType: 'lunch',
      imageAssetId: null,
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
    },
    food:
      overrides.food === undefined
        ? { id: foodId, canonicalNameKo: '김치', isDeprecated: false }
        : overrides.food,
    profiles: overrides.profiles ?? [
      {
        id: profileId,
        foodId,
        sourceRegistryId: '00000000-0000-4000-8000-000000000007',
        sourceCode: 'dataset',
        sourceDisplayName: 'Dataset',
        sourceItemId: 'kimchi',
        datasetVersion: '2026-01',
        basisAmountMg: 100000,
        energyMillicalories: 150000,
        carbohydrateMg: 30000,
        proteinMg: 2000,
        fatMg: 1000,
        fiberMg: 1000,
        qualityGrade: 'verified',
      },
    ],
    searchCandidateLimits: overrides.searchCandidateLimits,
    servings: [],
  };
  const auth = {
    api: { getSession: async () => (authenticated ? { user: { id: 'user-id' } } : null) },
  } as unknown as Auth;
  const server = await buildServer({ environment, auth, database: databaseMock(state) });
  servers.push(server);
  return server;
}

function databaseMock(state: Record<string, any>) {
  const resultFor = (table: unknown) => {
    if (table === foodAliases) return state.aliases;
    if (table === nutrientProfiles) return state.profiles;
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
        table === foodAliases
          ? [...new Map(rows.map((row) => [row.foodId, row])).values()]
          : rows,
        table,
      ),
    limit: async (limit: number) => {
      if (table === foodAliases) state.searchCandidateLimits?.push(limit);
      return rows.slice(0, limit);
    },
    orderBy: () => query(rows, table),
    then: (resolve: (value: any[]) => unknown) => Promise.resolve(rows).then(resolve),
  });
  const database = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(database),
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: () => ({ where: () => query(resultFor(table), table) }),
        where: () => query(resultFor(table), table),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table !== mealItems) return [];
            Object.assign(state.item, values);
            return [state.item];
          },
        }),
      }),
    }),
  };
  return database as unknown as Database;
}
