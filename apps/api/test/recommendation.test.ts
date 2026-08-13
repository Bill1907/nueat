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
  recommendationMealDrafts,
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

  test('suppresses ranking when a partial confirmed intake affects a target nutrient', async () => {
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
    expect(body.gaps).toEqual({ energyMillicalories: null, proteinMg: null, fiberMg: null });
    expect(body.safetyFlags).toEqual(['PARTIAL_CONFIRMED_INTAKE']);
    expect(database.inserts[0]?.candidateItems).toEqual([]);
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
    expect(first.candidates[0]?.nutrition).toBeDefined();
    expect(first.candidates[0]).not.toHaveProperty('nutrients');
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
      candidateItems: first.candidates,
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
describe('recommendation meal draft route', () => {
  const recommendationId = '00000000-0000-4000-8000-000000000100';

  test('requires authentication and validates the exact rank body', async () => {
    const { server } = await createDraftServer(false);
    expect((await server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload: { candidateRank: 1 } })).statusCode).toBe(401);

    const authenticated = await createDraftServer(true);
    for (const payload of [{}, { candidateRank: 0 }, { candidateRank: 4 }, { candidateRank: 1.5 }, { candidateRank: 1, extra: true }]) {
      const response = await authenticated.server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('INVALID_REQUEST');
    }
  });

  test('fails closed for an unowned recommendation and persisted safety flags', async () => {
    const unowned = await createDraftServer(true, { recommendation: { ...draftRecommendation(), userId: 'another-user' } });
    const notFound = await unowned.server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload: { candidateRank: 1 } });
    expect(notFound.statusCode).toBe(404);
    expect(JSON.parse(notFound.body).error.code).toBe('RECOMMENDATION_NOT_FOUND');

    const unsafe = await createDraftServer(true, { recommendation: { ...draftRecommendation(), safetyFlags: ['UNRESOLVED_DIETARY_CONSTRAINT'] } });
    const response = await unsafe.server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload: { candidateRank: 1 } });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('RECOMMENDATION_SAFETY_UNAVAILABLE');
    expect(unsafe.database.mealLogInserts).toHaveLength(0);
  });

  test.each([
    ['mismatched', { foodId: '00000000-0000-4000-8000-000000000999' }],
    ['untrusted', { sourceKind: 'untrusted' }],
    ['deprecated', { foodDeprecated: true }],
    ['unverified', { qualityGrade: 'unverified' }],
  ])('fails closed for %s persisted provenance', async (_name, profilePatch) => {
    const { server, database } = await createDraftServer(true, { profilePatch });
    const response = await server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload: { candidateRank: 1 } });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('RECOMMENDATION_PROVENANCE_UNAVAILABLE');
    expect(database.mealLogInserts).toHaveLength(0);
  });

  test('allows an estimated profile from a trusted source', async () => {
    const { server } = await createDraftServer(true, {
      profilePatch: { qualityGrade: 'estimated' },
    });
    const response = await server.inject({
      method: 'POST',
      url: `/api/recommendations/${recommendationId}/meal-draft`,
      payload: { candidateRank: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).items[0]).toMatchObject({
      nutrientProfileId: '00000000-0000-4000-8000-000000000301',
    });
  });

  test('creates exactly the persisted candidate as a manual image-less draft and replays its rank', async () => {
    const { server, database } = await createDraftServer(true);
    const first = await server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload: { candidateRank: 1 } });
    const body = JSON.parse(first.body);
    expect(first.statusCode).toBe(201);
    expect(body.mealLog).toMatchObject({ status: 'draft', recognitionStatus: 'manual', recognitionNextAttemptAt: null, imageAssetId: null });
    expect(body.items).toEqual([expect.objectContaining({
      recognizedLabel: '저장된 음식',
      foodId: '00000000-0000-4000-8000-000000000201',
      nutrientProfileId: '00000000-0000-4000-8000-000000000301',
      unit: 'g',
      amountMilliunits: 125_000,
      gramsMg: 125_000,
    })]);
    expect(database.draftLinks).toEqual([expect.objectContaining({ recommendationId, candidateRank: 1, mealLogId: body.mealLog.id })]);

    const replay = await server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload: { candidateRank: 1 } });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toEqual(body);
    const conflict = await server.inject({ method: 'POST', url: `/api/recommendations/${recommendationId}/meal-draft`, payload: { candidateRank: 2 } });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body).error.code).toBe('RECOMMENDATION_ALREADY_ACTIONED');
    expect(database.transactions).toBe(3);
  });

  test.each(['confirmed', 'deleted'] as const)('does not replay a linked %s meal as a draft', async (status) => {
    const { server, database } = await createDraftServer(true);
    const created = await server.inject({
      method: 'POST',
      url: `/api/recommendations/${recommendationId}/meal-draft`,
      payload: { candidateRank: 1 },
    });
    expect(created.statusCode).toBe(201);
    database.mealLogInserts[0]!.status = status;

    const replay = await server.inject({
      method: 'POST',
      url: `/api/recommendations/${recommendationId}/meal-draft`,
      payload: { candidateRank: 1 },
    });
    expect(replay.statusCode).toBe(409);
    expect(JSON.parse(replay.body).error.code).toBe('RECOMMENDATION_ALREADY_ACTIONED');
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
    fiberMg: fiber.every((value) => value !== null)
      ? fiber.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null,
    inputSnapshot: {
      mealItems: fiber.map((fiberMg, index) => ({
        nutrients: {
          energyMillicalories: index === 0 ? energyMillicalories : 0,
          carbohydrateMg: index === 0 ? carbohydrateMg : 0,
          proteinMg: index === 0 ? proteinMg : 0,
          fatMg: index === 0 ? fatMg : 0,
          fiberMg,
        },
      })),
    },
  };
}

async function createServer(authenticated: boolean, fixture: Fixture = {}) {
  const auth = { api: { getSession: async () => authenticated ? { user: { id: 'user-id', email: 'user@example.com' }, session: {} } : null } } as unknown as Auth;
  const database = new RecommendationDatabaseFake(fixture);
  const server = await buildServer({ environment, database: database as unknown as Database, auth });
  servers.push(server);
  return { server, database };
}
type DraftFixture = {
  recommendation?: Record<string, unknown>;
  profilePatch?: Record<string, unknown>;
};

class DraftDatabaseFake {
  readonly mealLogInserts: Array<Record<string, unknown>> = [];
  readonly draftLinks: Array<Record<string, unknown>> = [];
  readonly itemInserts: Array<Record<string, unknown>> = [];
  transactions = 0;
  private readonly fixture: DraftFixture;

  constructor(fixture: DraftFixture) { this.fixture = fixture; }
  async transaction<T>(callback: (tx: this) => Promise<T>) { this.transactions++; return callback(this); }
  async execute() {}
  select() { return { from: (table: unknown) => new DraftQueryFake(() => this.rows(table)) }; }
  insert(table: unknown) {
    return {
      values: (value: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const returning = async () => {
          const values = Array.isArray(value) ? value : [value];
          if (table === mealLogs) {
            const rows = values.map((row, index) => ({ id: `draft-${this.mealLogInserts.length + index + 1}`, ...row }));
            this.mealLogInserts.push(...rows);
            return rows;
          }
          if (table === mealItems) {
            const rows = values.map((row, index) => ({ id: `item-${this.itemInserts.length + index + 1}`, ...row }));
            this.itemInserts.push(...rows);
            return rows;
          }
          return [];
        };
        return {
          returning,
          then: (resolve: (value: unknown) => void) => {
            if (table === recommendationMealDrafts) this.draftLinks.push(value as Record<string, unknown>);
            resolve(undefined);
          },
        };
      },
    };
  }
  private rows(table: unknown): unknown[] {
    if (table === recommendationMealDrafts) {
      return this.draftLinks.map((link) => ({
        candidateRank: link.candidateRank,
        mealLog: this.mealLogInserts.find((meal) => meal.id === link.mealLogId),
      }));
    }
    if (table === recommendations) {
      const recommendation = this.fixture.recommendation ?? draftRecommendation();
      return recommendation.userId === 'user-id' ? [recommendation] : [];
    }
    if (table === userProfiles) return [{ timezone: 'Asia/Seoul', onboardingStatus: 'completed' }];
    if (table === nutrientProfiles) return [{ ...draftProfile(), ...this.fixture.profilePatch }];
    if (table === mealItems) return this.itemInserts;
    return [];
  }
}

class DraftQueryFake {
  constructor(private readonly result: () => unknown[]) {}
  innerJoin() { return this; }
  where() { return this; }
  limit() { return this; }
  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) { return Promise.resolve(this.result()).then(onfulfilled, onrejected); }
}

function draftRecommendation() {
  return {
    id: '00000000-0000-4000-8000-000000000100',
    userId: 'user-id',
    safetyFlags: [],
    contextSnapshot: {
      selectedNutrientProfiles: [{
        id: '00000000-0000-4000-8000-000000000301',
        foodId: '00000000-0000-4000-8000-000000000201',
        sourceRegistryId: '00000000-0000-4000-8000-000000000401',
        sourceItemId: 'stored-food',
        datasetVersion: '2026-01',
      }],
    },
    candidateItems: [{
      rank: 1,
      components: [{
        foodId: '00000000-0000-4000-8000-000000000201',
        nutrientProfileId: '00000000-0000-4000-8000-000000000301',
        nameKo: '저장된 음식',
        gramsMg: 125_000,
      }],
    }],
  };
}

function draftProfile() {
  return {
    id: '00000000-0000-4000-8000-000000000301',
    foodId: '00000000-0000-4000-8000-000000000201',
    sourceRegistryId: '00000000-0000-4000-8000-000000000401',
    sourceItemId: 'stored-food',
    datasetVersion: '2026-01',
    qualityGrade: 'verified',
    foodDeprecated: false,
    sourceKind: 'public_dataset',
  };
}

async function createDraftServer(authenticated: boolean, fixture: DraftFixture = {}) {
  const auth = { api: { getSession: async () => authenticated ? { user: { id: 'user-id', email: 'user@example.com' }, session: {} } : null } } as unknown as Auth;
  const database = new DraftDatabaseFake(fixture);
  const server = await buildServer({ environment, database: database as unknown as Database, auth });
  servers.push(server);
  return { server, database };
}
