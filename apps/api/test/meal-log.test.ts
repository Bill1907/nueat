import { afterEach, describe, expect, test } from 'bun:test';
import {
  calculationSnapshots,
  foods,
  foodServings,
  imageAssets,
  mealItems,
  mealLogs,
  nutrientProfiles,
  sourceRegistries,
  userProfiles,
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
const mealId = '00000000-0000-4000-8000-000000000001';
const imageId = '00000000-0000-4000-8000-000000000002';
const itemId = '00000000-0000-4000-8000-000000000003';
const foodId = '00000000-0000-4000-8000-000000000010';
const nutrientProfileId = '00000000-0000-4000-8000-000000000011';
const sourceRegistryId = '00000000-0000-4000-8000-000000000013';
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('meal log routes', () => {
  test('rejects unauthenticated access', async () => {
    const { server } = await createServer(false);
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });

  test('creates a processed draft with the deterministic mock recognizer', async () => {
    const { server, state } = await createServer(true);
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(201);
    expect(body.mealLog).toMatchObject({
      id: mealId,
      imageAssetId: imageId,
      status: 'draft',
      recognitionStatus: 'ready',
      recognitionProvider: 'mock',
      recognitionModel: 'mock-recognition-v2',
      localDate: '2026-08-10',
    });
    expect(
      body.items.map(
        (item: {
          recognizedLabel: string;
          amountMilliunits: number;
          unit: string;
        }) => [item.recognizedLabel, item.amountMilliunits, item.unit],
      ),
    ).toEqual([
      ['흰쌀밥', 1000, 'bowl'],
      ['김치찌개', 1000, 'serving'],
      ['배추김치', 500, 'serving'],
    ]);
    expect(state.asset.status).toBe('processed');
  });
  test('derives meal date and type from the persisted profile timezone', async () => {
    const { server } = await createServer(true, {
      profileTimezone: 'Pacific/Honolulu',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).mealLog).toMatchObject({
      timezone: 'Pacific/Honolulu',
      localDate: '2026-08-09',
      mealType: 'dinner',
    });
  });

  test('includes an additive recognition outcome without changing mealLog/items', async () => {
    const { server } = await createServer(true);
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      mealLog: { recognitionStatus: 'ready' },
      recognitionOutcome: { status: 'ready' },
    });
    expect(Array.isArray(body.items)).toBe(true);
  });


  test('returns the existing draft when the validated image is retried', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();
    state.asset.status = 'processed';
    state.items = [
      {
        id: itemId,
        mealLogId: mealId,
        recognizedLabel: '흰쌀밥',
        amountMilliunits: 1000,
        unit: 'bowl',
        recognitionConfidenceBps: 9500,
        portionConfidenceBps: 9200,
        userCorrected: false,
      },
    ];

    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).mealLog.id).toBe(mealId);
    expect(state.items).toHaveLength(1);
  });

  test('does not claim an unavailable image or disclose image storage details', async () => {
    const { server } = await createServer(true, { assetStatus: 'uploaded' });
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('IMAGE_ASSET_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain('objectKey');
    expect(JSON.stringify(body)).not.toContain('bucketName');
  });

  test('hides other users meals as not found', async () => {
    const { server } = await createServer(true, { mealUserId: 'other-user' });
    const response = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('MEAL_LOG_NOT_FOUND');
  });

  test('adds, corrects, and deletes a draft item', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();
    const add = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items`,
      payload: {
        recognizedLabel: '수정 음식',
        amountMilliunits: 250,
        unit: 'g',
      },
    });
    expect(add.statusCode).toBe(201);
    Object.assign(state.items[0]!, {
      foodId: '00000000-0000-4000-8000-000000000010',
      nutrientProfileId: '00000000-0000-4000-8000-000000000011',
      mappingConfidenceBps: 10_000,
    });
    const edit = await server.inject({
      method: 'PATCH',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
      payload: { amountMilliunits: 500 },
    });
    expect(edit.statusCode).toBe(200);
    expect(JSON.parse(edit.body).items[0].userCorrected).toBe(true);
    expect(JSON.parse(edit.body).items[0].foodId).not.toBeNull();

    const rename = await server.inject({
      method: 'PATCH',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
      payload: { recognizedLabel: '새 음식 이름' },
    });
    expect(rename.statusCode).toBe(200);
    expect(JSON.parse(rename.body).items[0]).toMatchObject({
      foodId: null,
      nutrientProfileId: null,
      mappingConfidenceBps: null,
    });
    const remove = await server.inject({
      method: 'DELETE',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
    });
    expect(remove.statusCode).toBe(200);
  });

  test('soft deletes a draft and queues its image deletion', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/meal-logs/${mealId}`,
    });
    expect(response.statusCode).toBe(204);
    expect(state.meal?.status).toBe('deleted');
    expect(state.asset.status).toBe('deletion_pending');
    expect(state.deletionJob?.imageAssetId).toBe(imageId);
  });
  test('rejects retry and manual conversion after recognition is ready', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();

    const retry = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/retry`,
    });
    const manual = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/manual`,
    });

    expect(retry.statusCode).toBe(409);
    expect(manual.statusCode).toBe(409);
    expect(state.meal.recognitionStatus).toBe('ready');
    expect(state.meal.recognitionProvider).toBe('mock');
  });
  test('confirms mapped gram items with persisted profile values', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
    });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      mealLog: { status: 'confirmed' },
      items: [{ gramsMg: 1_500 }],
      nutrition: {
        calculationVersion: 'meal-nutrition-v1',
        items: [{
          source: {
            nutrientProfileId,
            qualityGrade: 'verified',
            servingId: null,
            servingSourceRegistryId: null,
            servingQualityGrade: null,
          },
        }],
        totals: { energyMillicalories: { value: 300, completeness: 'complete' } },
      },
    });
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]!.inputSnapshot).toEqual({
      mealItems: [{
        mealItemId: itemId,
        foodId,
        nutrientProfileId,
        amountMilliunits: 1_500,
        unit: 'g',
        gramsMg: 1_500,
        sourceRegistryId,
        sourceItemId: 'test-source-item',
        datasetVersion: '2026-08',
        nutrientProfileQualityGrade: 'verified',
        nutrientProfile: {
          basisAmountMg: 100_000,
          energyMillicalories: 20_000,
          carbohydrateMg: 3_000,
          proteinMg: 1_000,
          fatMg: 500,
          fiberMg: null,
        },
        serving: null,
        nutrients: {
          energyMillicalories: 300,
          carbohydrateMg: 45,
          proteinMg: 15,
          fatMg: 8,
          fiberMg: null,
        },
      }],
    });
  });

  test('converts non-gram items through their sole matching serving', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'serving');
    state.servings.push({
      id: '00000000-0000-4000-8000-000000000012',
      foodId: foodId,
      unit: 'serving',
      amountMilliunits: 1_000,
      gramsMg: 200_000,
      sourceRegistryId: sourceRegistryId,
      qualityGrade: 'verified',
    });
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items[0].gramsMg).toBe(300_000);
    expect(body.nutrition.items[0].source).toMatchObject({
      servingId: '00000000-0000-4000-8000-000000000012',
      servingSourceRegistryId: sourceRegistryId,
      servingQualityGrade: 'verified',
    });
  });

  test('rejects missing mappings, profiles, and serving conversions without mutation', async () => {
    for (const invalid of ['mapping', 'profile', 'serving'] as const) {
      const { server, state } = await createServer(true);
      configureConfirmableDraft(state, invalid === 'serving' ? 'serving' : 'g');
      if (invalid === 'mapping') {
        delete state.items[0]!.foodId;
        delete state.items[0]!.nutrientProfileId;
      }
      if (invalid === 'profile') state.profiles = [];
      const response = await server.inject({
        method: 'POST',
        url: `/api/meal-logs/${mealId}/confirm`,
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.details.items[0].code).toBe(
        invalid === 'mapping'
          ? 'MISSING_MAPPING'
          : invalid === 'profile'
            ? 'MISSING_PROFILE'
            : 'MISSING_SERVING_CONVERSION',
      );
      expect(state.meal?.status).toBe('draft');
      expect(state.items[0]!.gramsMg).toBeUndefined();
      expect(state.snapshots).toHaveLength(0);
    }
  });

  test('rejects mismatched food/profile ownership without mutation', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.profiles[0]!.foodId = '00000000-0000-4000-8000-000000000099';
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.details.items[0].code).toBe('MISMATCHED_PROFILE');
    expect(state.meal?.status).toBe('draft');
    expect(state.snapshots).toHaveLength(0);
  });

  test('rejects deprecated foods and untrusted profile or serving sources', async () => {
    for (const invalid of ['food', 'profile', 'serving'] as const) {
      const { server, state } = await createServer(true);
      configureConfirmableDraft(state, invalid === 'serving' ? 'serving' : 'g');
      if (invalid === 'food') state.foods[0]!.isDeprecated = true;
      if (invalid === 'profile')
        state.registries[0]!.kind = 'recipe_estimate';
      if (invalid === 'serving') {
        state.servings.push({
          id: '00000000-0000-4000-8000-000000000012',
          foodId,
          unit: 'serving',
          amountMilliunits: 1_000,
          gramsMg: 200_000,
          sourceRegistryId: '00000000-0000-4000-8000-000000000015',
          qualityGrade: 'verified',
        });
        state.registries.push({
          id: '00000000-0000-4000-8000-000000000015',
          kind: 'user_entered',
        });
      }
      const response = await server.inject({
        method: 'POST',
        url: `/api/meal-logs/${mealId}/confirm`,
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.details.items[0].code).toBe(
        invalid === 'food'
          ? 'DEPRECATED_FOOD'
          : invalid === 'profile'
            ? 'UNTRUSTED_PROFILE_SOURCE'
            : 'UNTRUSTED_SERVING_SOURCE',
      );
      expect(state.meal?.status).toBe('draft');
      expect(state.snapshots).toHaveLength(0);
    }
  });
  test('replays the latest confirmation snapshot without creating another', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    const first = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
    });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body).nutrition.id).toBe(JSON.parse(first.body).nutrition.id);
    expect(state.snapshots).toHaveLength(1);
  });
});

function createPayload() {
  return {
    imageAssetId: imageId,
    eatenAt: '2026-08-10T03:00:00.000Z',
    timezone: 'Asia/Seoul',
    mealType: 'lunch',
  };
}
function draftMeal() {
  return {
    id: mealId,
    userId: 'user-id',
    eatenAt: new Date('2026-08-10T03:00:00.000Z'),
    timezone: 'Asia/Seoul',
    localDate: '2026-08-10',
    mealType: 'lunch',
    status: 'draft',
    imageAssetId: imageId,
    recognitionStatus: 'ready',
    recognitionProvider: 'mock',
    recognitionModel: 'mock-recognition-v2',
    recognitionPromptVersion: 'meal-recognition-prompt-v1',
    recognitionSchemaVersion: 'meal-recognition-schema-v1',
    recognitionCompletedAt: new Date('2026-08-10T03:00:01.000Z'),
    recognitionLastErrorCode: null,
    recognitionAttemptCount: 1,
    recognitionNextAttemptAt: null,
  };
}

async function createServer(
  authenticated: boolean,
  overrides: { assetStatus?: string; mealUserId?: string; profileTimezone?: string } = {},
) {
  const state: {
    asset: Record<string, unknown>;
    meal?: Record<string, unknown>;
    items: Record<string, unknown>[];
    foods: Record<string, unknown>[];
    profiles: Record<string, unknown>[];
    servings: Record<string, unknown>[];
    registries: Record<string, unknown>[];
    snapshots: Record<string, unknown>[];
    deletionJob?: Record<string, unknown>;
    profileTimezone: string | null;
  } = {
    asset: {
      id: imageId,
      userId: 'user-id',
      status: overrides.assetStatus ?? 'validated',
    },
    items: [],
    foods: [],
    profiles: [],
    servings: [],
    registries: [],
    snapshots: [],
    profileTimezone: overrides.profileTimezone ?? null,
  };
  if (overrides.mealUserId)
    state.meal = { ...draftMeal(), userId: overrides.mealUserId };
  const auth = {
    api: {
      getSession: async () =>
        authenticated ? { user: { id: 'user-id' }, session: {} } : null,
    },
  } as unknown as Auth;
  const server = await buildServer({
    environment,
    auth,
    database: databaseMock(state),
    recognitionCoordinator: {
      async recognize() {
        if (state.meal?.recognitionStatus !== 'ready') {
          Object.assign(state.meal ?? {}, {
            recognitionStatus: 'ready',
            recognitionProvider: 'mock',
            recognitionModel: 'mock-recognition-v2',
            recognitionPromptVersion: 'meal-recognition-prompt-v1',
            recognitionSchemaVersion: 'meal-recognition-schema-v1',
            recognitionCompletedAt: new Date('2026-08-10T03:00:01.000Z'),
            recognitionLastErrorCode: null,
            recognitionAttemptCount: 1,
            recognitionNextAttemptAt: null,
          });
          if (state.items.length === 0) {
            state.items.push(
              {
                id: itemId,
                mealLogId: mealId,
                recognizedLabel: '흰쌀밥',
                amountMilliunits: 1_000,
                unit: 'bowl',
                recognitionRegionIndex: 0,
                recognitionConfidenceBps: 9_500,
                portionConfidenceBps: 9_200,
                userCorrected: false,
              },
              {
                id: `${itemId.slice(0, -1)}4`,
                mealLogId: mealId,
                recognizedLabel: '김치찌개',
                amountMilliunits: 1_000,
                unit: 'serving',
                recognitionRegionIndex: 1,
                recognitionConfidenceBps: 9_300,
                portionConfidenceBps: 9_000,
                userCorrected: false,
              },
              {
                id: `${itemId.slice(0, -1)}5`,
                mealLogId: mealId,
                recognizedLabel: '배추김치',
                amountMilliunits: 500,
                unit: 'serving',
                recognitionRegionIndex: 2,
                recognitionConfidenceBps: 9_100,
                portionConfidenceBps: 8_800,
                userCorrected: false,
              },
            );
          }
          state.asset.status = 'processed';
        }
        return { status: 'ready' };
      },
    },
  });
  servers.push(server);
  return { server, state };
}
function configureConfirmableDraft(
  state: {
    meal?: Record<string, unknown>;
    items: Record<string, unknown>[];
    foods: Record<string, unknown>[];
    profiles: Record<string, unknown>[];
    registries: Record<string, unknown>[];
  },
  unit: 'g' | 'serving',
) {
  state.meal = draftMeal();
  state.items = [{
    id: itemId,
    mealLogId: mealId,
    recognizedLabel: '테스트 음식',
    foodId,
    nutrientProfileId,
    amountMilliunits: 1_500,
    unit,
    userCorrected: true,
  }];
  state.foods = [{ id: foodId, isDeprecated: false }];
  state.profiles = [{
    id: nutrientProfileId,
    foodId,
    sourceRegistryId,
    sourceItemId: 'test-source-item',
    datasetVersion: '2026-08',
    basisAmountMg: 100_000,
    energyMillicalories: 20_000,
    carbohydrateMg: 3_000,
    proteinMg: 1_000,
    fatMg: 500,
    qualityGrade: 'verified',
    fiberMg: null,
  }];
  state.registries = [{ id: sourceRegistryId, kind: 'public_dataset' }];
}

function databaseMock(state: {
  asset: Record<string, unknown>;
  meal?: Record<string, unknown>;
  items: Record<string, unknown>[];
  foods: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  servings: Record<string, unknown>[];
  registries: Record<string, unknown>[];
  snapshots: Record<string, unknown>[];
  deletionJob?: Record<string, unknown>;
  profileTimezone: string | null;
}) {
  const canClaimImage = state.asset.status === 'validated';
  const query = (value: unknown) => ({
    for: () => query(value),
    orderBy: () => query(value),
    limit: async () =>
      value === undefined ? [] : Array.isArray(value) ? value.slice(0, 1) : [value],
    then<TResult1 = unknown, TResult2 = never>(
      ok?: ((result: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      fail?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(value === undefined ? [] : value).then(ok, fail);
    },
  });
  const database = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(database),
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          query(
            table === userProfiles
              ? state.profileTimezone
                ? { timezone: state.profileTimezone }
                : undefined
              : table === mealLogs && state.meal?.userId === 'user-id'
                ? state.meal
                : table === mealItems
                  ? state.items
                  : table === foods
                    ? state.foods
                    : table === nutrientProfiles
                      ? state.profiles
                      : table === foodServings
                        ? state.servings
                        : table === sourceRegistries
                          ? state.registries
                          : table === calculationSnapshots
                            ? state.snapshots
                            : undefined,
          ),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const apply = () => {
            if (
              table === imageAssets &&
              (values.status !== 'processing' || canClaimImage)
            )
              Object.assign(state.asset, values);
            if (table === mealLogs && state.meal)
              Object.assign(state.meal, values);
            if (table === mealItems && state.items[0])
              Object.assign(state.items[0], values);
          };
          return {
            returning: async () => {
              apply();
              return table === imageAssets
                ? state.asset.status === 'processing'
                  ? [{ id: imageId }]
                  : []
                : table === mealLogs && state.meal
                  ? [state.meal]
                  : table === mealItems && state.items[0]
                    ? [state.items[0]]
                    : [];
            },
            then<TResult1 = unknown, TResult2 = never>(
              ok?:
                | ((result: unknown) => TResult1 | PromiseLike<TResult1>)
                | null,
              fail?:
                | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                | null,
            ) {
              apply();
              return Promise.resolve(undefined).then(ok, fail);
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(values) ? values : [values];
        const firstRow = rows[0];
        if (!firstRow) throw new Error('Expected at least one inserted row');
        const apply = () => {
          if (table === mealLogs) {
            state.meal = {
              ...firstRow,
              id: mealId,
              timezone: firstRow.eatenTimezone,
              localDate: firstRow.eatenLocalDate,
            };
            return [state.meal];
          }
          if (table === mealItems) {
            const inserted = rows.map((row, index) => ({
              ...row,
              id: index === 0 ? itemId : `${itemId.slice(0, -1)}${index + 1}`,
              userCorrected: row.userCorrected ?? false,
            }));
            state.items.push(...inserted);
            return inserted;
          }
          if (table === calculationSnapshots) {
            const snapshot = {
              ...firstRow,
              id: '00000000-0000-4000-8000-000000000014',
            };
            state.snapshots.push(snapshot);
            return [snapshot];
          }
          return [];
        };
        return {
          returning: async () => apply(),
          onConflictDoNothing: async () => {
            state.deletionJob = firstRow;
          },
          then<TResult1 = unknown, TResult2 = never>(
            ok?: ((result: unknown) => TResult1 | PromiseLike<TResult1>) | null,
            fail?:
              | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
              | null,
          ) {
            return Promise.resolve(apply()).then(ok, fail);
          },
        };
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          const item = state.items.shift();
          return item ? [{ id: item.id }] : [];
        },
      }),
    }),
  };
  return database as unknown as Database;
}
