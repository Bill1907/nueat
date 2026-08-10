import { afterEach, describe, expect, test } from 'bun:test';
import {
  imageAssets,
  mealItems,
  mealLogs,
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

  test('creates a processed draft with the exact deterministic mock items', async () => {
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
      recognitionEngineVersion: 'mock-recognition-v1',
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
    recognitionEngineVersion: 'mock-recognition-v1',
  };
}

async function createServer(
  authenticated: boolean,
  overrides: { assetStatus?: string; mealUserId?: string } = {},
) {
  const state: {
    asset: Record<string, unknown>;
    meal?: Record<string, unknown>;
    items: Record<string, unknown>[];
    deletionJob?: Record<string, unknown>;
  } = {
    asset: {
      id: imageId,
      userId: 'user-id',
      status: overrides.assetStatus ?? 'validated',
    },
    items: [],
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
  });
  servers.push(server);
  return { server, state };
}

function databaseMock(state: {
  asset: Record<string, unknown>;
  meal?: Record<string, unknown>;
  items: Record<string, unknown>[];
  deletionJob?: Record<string, unknown>;
}) {
  const canClaimImage = state.asset.status === 'validated';
  const query = (value: unknown) => ({
    limit: async () => (value === undefined ? [] : [value]),
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
            table === mealLogs && state.meal?.userId === 'user-id'
              ? state.meal
              : table === mealItems
                ? state.items
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
