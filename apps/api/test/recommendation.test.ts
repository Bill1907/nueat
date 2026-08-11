import { afterEach, describe, expect, test } from 'bun:test';
import {
  calculationSnapshots,
  dietaryConstraints,
  foodAliases,
  mealItems,
  mealLogs,
  nutrientProfiles,
  nutritionProfiles,
  recommendations,
  userProfiles,
  type Database,
} from '@nueat/database';
import { CURATED_MEAL_RECOMMENDATION_TEMPLATES } from '@nueat/domain';
import type { FastifyInstance } from 'fastify';

import type { Auth } from '../src/auth/auth';
import { parseEnvironment } from '../src/config/env';
import { buildServer } from '../src/server';

const environment = parseEnvironment({
  NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32), BETTER_AUTH_URL: 'https://api.example.test',
  RESEND_API_KEY: 're_test', TRUSTED_ORIGINS: 'nueat://',
});
const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

describe('next recommendation route', () => {
  test('requires authentication before processing the request', async () => {
    const { server } = await createServer(false);
    const response = await server.inject({ method: 'POST', url: '/api/recommendations/next' });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });

  test('rejects a non-strict body before querying nutrition state', async () => {
    const { server } = await createServer(true);
    const response = await server.inject({ method: 'POST', url: '/api/recommendations/next', payload: { excludeFoodIds: [], extra: true } });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('INVALID_REQUEST');
  });

  test.each([
    ['missing user', { userProfile: undefined }],
    ['pending onboarding', { userProfile: { timezone: 'Asia/Seoul', onboardingStatus: 'pending' } }],
    ['missing target', { target: undefined }],
  ])('fails closed when the nutrition target is unavailable: %s', async (_name, fixture) => {
    const { server, database } = await createServer(true, fixture);
    const response = await server.inject({ method: 'POST', url: '/api/recommendations/next' });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('NUTRITION_TARGET_UNAVAILABLE');
    expect(database.inserts).toHaveLength(0);
  });

  test('aggregates latest confirmed snapshots and preserves a partial fiber gap', async () => {
    const { server, database } = await createServer(true, {
      meals: [{ id: 'meal-a' }, { id: 'meal-b' }],
      snapshots: [
        snapshot('meal-a', 2, 400_000, 40_000, 30_000, 20_000, [1_000]),
        snapshot('meal-a', 1, 900_000, 90_000, 90_000, 90_000, [9_000]),
        snapshot('meal-b', 1, 300_000, 30_000, 20_000, 10_000, [null]),
      ],
    });
    const response = await server.inject({ method: 'POST', url: '/api/recommendations/next' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.gaps).toEqual({ energyMillicalories: 1_300_000, proteinMg: 50_000, fiberMg: null });
    expect(body.safetyFlags).toEqual([]);
    expect(database.inserts[0]?.candidateItems).toHaveLength(3);
  });

  test('persists an empty fail-closed response for a missing or malformed snapshot', async () => {
    for (const snapshots of [[], [{ mealLogId: 'meal-a', sequence: 1, inputSnapshot: { mealItems: [] }, energyMillicalories: 1, carbohydrateMg: 1, proteinMg: 1, fatMg: 1 }]]) {
      const { server, database } = await createServer(true, { meals: [{ id: 'meal-a' }], snapshots });
      const response = await server.inject({ method: 'POST', url: '/api/recommendations/next' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body.candidates).toEqual([]);
      expect(body.gaps).toEqual({ energyMillicalories: null, proteinMg: null, fiberMg: null });
      expect(body.safetyFlags).toEqual(['CALCULATION_SNAPSHOT_UNAVAILABLE']);
      expect(database.inserts[0]).toMatchObject({
        candidateItems: [], modelVersion: null, promptVersion: null,
        safetyFlags: ['CALCULATION_SNAPSHOT_UNAVAILABLE'],
      });
    }
  });

  test('fails closed when an active allergy cannot be evaluated through ingredient metadata', async () => {
    const { server, database } = await createServer(true, {
      constraints: [{ id: 'allergy', type: 'allergy', foodId: 'food-0', labelKo: null }],
    });
    const response = await server.inject({
      method: 'POST', url: '/api/recommendations/next',
      payload: { excludeFoodIds: ['00000000-0000-4000-8000-000000000001'] },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.safetyFlags).toEqual(['UNRESOLVED_DIETARY_CONSTRAINT']);
    expect(body.candidates).toEqual([]);
    expect(database.inserts[0]).toMatchObject({
      contextSnapshot: { dietaryConstraintIds: ['allergy'] },
      safetyFlags: ['UNRESOLVED_DIETARY_CONSTRAINT'],
    });
  });

  test('fails closed for request exclusions until composite ingredient metadata is available', async () => {
    const excludedFoodId = '00000000-0000-4000-8000-000000000001';
    const { server, database } = await createServer(true);
    const response = await server.inject({
      method: 'POST',
      url: '/api/recommendations/next',
      payload: { excludeFoodIds: [excludedFoodId] },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.safetyFlags).toEqual(['UNRESOLVED_DIETARY_CONSTRAINT']);
    expect(body.candidates).toEqual([]);
    expect(database.inserts[0]).toMatchObject({
      candidateItems: [],
      safetyFlags: ['UNRESOLVED_DIETARY_CONSTRAINT'],
    });
  });

  test.each([
    ['one alias', [[{ foodId: 'food-0' }]]],
    ['no aliases', [[]]],
    ['multiple aliases', [[{ foodId: 'food-0' }, { foodId: 'food-1' }]]],
  ])('persists a fail-closed response while ingredient metadata is unavailable: %s', async (_name, aliases) => {
    const { server, database } = await createServer(true, {
      constraints: [{ id: 'label', type: 'exclusion', foodId: null, labelKo: '쌀' }],
      aliases,
    });
    const response = await server.inject({ method: 'POST', url: '/api/recommendations/next' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.safetyFlags).toEqual(['UNRESOLVED_DIETARY_CONSTRAINT']);
    expect(body.candidates).toEqual([]);
    expect(database.inserts[0]?.safetyFlags).toEqual(['UNRESOLVED_DIETARY_CONSTRAINT']);
  });

  test('uses complete trusted-profile query results, recent foods, and persists three deterministic candidates', async () => {
    const profiles = completeProfiles();
    const fixture = {
      profiles: [...profiles, { ...profiles[0]!, id: 'estimated-profile', foodId: 'unpreferred-food', nameKo: '낮은 우선순위 음식', qualityGrade: 'estimated', datasetVersion: '2099-01' }],
      recentMeals: [{ id: 'recent-meal' }],
      recentItems: [{ foodId: 'food-0' }],
    };
    const { server, database } = await createServer(true, fixture);
    const { server: repeatedServer } = await createServer(true, fixture);
    const first = JSON.parse((await server.inject({ method: 'POST', url: '/api/recommendations/next' })).body);
    const second = JSON.parse((await repeatedServer.inject({ method: 'POST', url: '/api/recommendations/next' })).body);

    expect(first.candidates).toHaveLength(3);
    expect(first.candidates.map((candidate: { rank: number }) => candidate.rank)).toEqual([1, 2, 3]);
    expect(first.candidates).toEqual(second.candidates);
    expect(first.candidates.every((candidate: { components: Array<{ foodId: string }> }) =>
      candidate.components.every((component) => component.foodId !== 'unpreferred-food'))).toBe(true);
    expect(first.candidates.some((candidate: { rationaleFacts: Array<{ code: string; hasRecentFood?: boolean }> }) =>
      candidate.rationaleFacts.some((fact) => fact.code === 'RECENT_FOOD_DIVERSITY' && fact.hasRecentFood === true))).toBe(true);
    expect(database.inserts[0]).toMatchObject({
      userId: 'user-id',
      engineVersion: 'meal-recommendations-v1',
      modelVersion: null,
      promptVersion: null,
      contextSnapshot: {
        targetId: 'target',
        recentMealIds: ['recent-meal'],
        selectedNutrientProfiles: expect.arrayContaining([
          expect.objectContaining({
            id: 'profile-0',
            sourceRegistryId: 'registry',
            sourceItemId: profiles[0]!.sourceItemId,
            datasetVersion: '2026-01',
            foodId: 'food-0',
          }),
        ]),
      },
      candidateItems: first.candidates.map((candidate: Record<string, unknown>) => ({
        rank: candidate.rank,
        templateId: candidate.templateId,
        titleKo: candidate.titleKo,
        scoreBps: candidate.scoreBps,
        components: candidate.components,
        nutrition: candidate.nutrients,
        projectedTotals: candidate.projectedTotals,
        rationaleFacts: candidate.rationaleFacts,
        warnings: candidate.warnings,
      })),
    });
  });

  test('flags and persists an empty response when trusted template profiles are unavailable', async () => {
    const { server, database } = await createServer(true, { profiles: [] });
    const response = await server.inject({ method: 'POST', url: '/api/recommendations/next' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.candidates).toEqual([]);
    expect(body.safetyFlags).toEqual(['NUTRIENT_PROFILE_UNAVAILABLE']);
    expect(database.inserts[0]).toMatchObject({
      candidateItems: [],
      safetyFlags: ['NUTRIENT_PROFILE_UNAVAILABLE'],
      contextSnapshot: { selectedNutrientProfiles: [] },
    });
  });
});

type Fixture = {
  userProfile?: { timezone: string; onboardingStatus: string } | undefined;
  target?: Record<string, number | string | null> | undefined;
  meals?: unknown[];
  snapshots?: unknown[];
  constraints?: unknown[];
  aliases?: Array<unknown[]>;
  recentMeals?: unknown[];
  recentItems?: unknown[];
  profiles?: unknown[];
};

class RecommendationDatabaseFake {
  readonly inserts: Array<Record<string, unknown>> = [];
  private mealLogQueries = 0;
  private readonly fixture: Required<Fixture>;

  constructor(fixture: Fixture) {
    this.fixture = {
      userProfile: { timezone: 'Asia/Seoul', onboardingStatus: 'completed' },
      target: { id: 'target', energyMillicalories: 2_000_000, carbohydrateMg: 250_000, proteinMg: 100_000, fatMg: 70_000, fiberMg: 25_000 },
      meals: [], snapshots: [], constraints: [], aliases: [], recentMeals: [], recentItems: [], profiles: completeProfiles(),
      ...fixture,
    };
  }

  select() {
    return {
      from: (table: unknown) => new QueryFake(() => this.rows(table)),
    };
  }

  insert(table: unknown) {
    expect(table).toBe(recommendations);
    return {
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          this.inserts.push(value);
          return [{ id: `recommendation-${this.inserts.length}`, createdAt: new Date('2026-08-11T00:00:00.000Z') }];
        },
      }),
    };
  }

  private rows(table: unknown): unknown[] {
    if (table === userProfiles) return this.fixture.userProfile ? [this.fixture.userProfile] : [];
    if (table === nutritionProfiles) return this.fixture.target ? [this.fixture.target] : [];
    if (table === mealLogs) return this.mealLogQueries++ === 0 ? this.fixture.meals : this.fixture.recentMeals;
    if (table === calculationSnapshots) return this.fixture.snapshots;
    if (table === dietaryConstraints) return this.fixture.constraints;
    if (table === foodAliases) return this.fixture.aliases.shift() ?? [];
    if (table === mealItems) return this.fixture.recentItems;
    if (table === nutrientProfiles) return this.fixture.profiles;
    throw new Error('Unexpected table queried by recommendation route');
  }
}

class QueryFake {
  constructor(private readonly result: () => unknown[]) {}
  where() { return this; }
  orderBy() { return this; }
  limit() { return this; }
  innerJoin() { return this; }
  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.result()).then(onfulfilled, onrejected);
  }
}

function completeProfiles() {
  const sourceItemIds = [...new Set(CURATED_MEAL_RECOMMENDATION_TEMPLATES.flatMap((template) => template.components.map((component) => component.sourceItemId)))];
  return sourceItemIds.map((sourceItemId, index) => ({
    id: `profile-${index}`, sourceRegistryId: 'registry', sourceItemId, datasetVersion: '2026-01', qualityGrade: 'verified',
    foodId: `food-${index}`, nameKo: `음식 ${index}`, basisAmountMg: 100_000,
    energyMillicalories: 100_000, carbohydrateMg: 10_000, proteinMg: 10_000, fatMg: 5_000, fiberMg: 1_000,
  }));
}

function snapshot(mealLogId: string, sequence: number, energyMillicalories: number, carbohydrateMg: number, proteinMg: number, fatMg: number, fiber: Array<number | null>) {
  return {
    id: `${mealLogId}-snapshot-${sequence}`,
    mealLogId, sequence, energyMillicalories, carbohydrateMg, proteinMg, fatMg,
    inputSnapshot: { mealItems: fiber.map((fiberMg) => ({ nutrients: { fiberMg } })) },
  };
}

async function createServer(authenticated: boolean, fixture: Fixture = {}) {
  const auth = { api: { getSession: async () => authenticated ? { user: { id: 'user-id', email: 'user@example.com' }, session: {} } : null } } as unknown as Auth;
  const database = new RecommendationDatabaseFake(fixture);
  const server = await buildServer({ environment, database: database as unknown as Database, auth });
  servers.push(server);
  return { server, database };
}
