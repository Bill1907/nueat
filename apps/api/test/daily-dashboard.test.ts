import { afterEach, describe, expect, test } from 'bun:test';
import {
  calculationSnapshots,
  mealItems,
  mealLogs,
  nutritionProfiles,
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
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('daily dashboard route', () => {
  test('rejects unauthenticated requests and invalid dates', async () => {
    const unauthenticated = await createServer({ authenticated: false });
    const invalid = await createServer({ authenticated: true });

    const unauthenticatedResponse = await unauthenticated.inject({
      method: 'GET',
      url: '/api/dashboard/daily',
    });
    const invalidResponse = await invalid.inject({
      method: 'GET',
      url: '/api/dashboard/daily?date=2026-02-30',
    });
    const malformedResponse = await invalid.inject({
      method: 'GET',
      url: '/api/dashboard/daily?date=11-08-2026',
    });
    const yearZeroResponse = await invalid.inject({
      method: 'GET',
      url: '/api/dashboard/daily?date=0000-01-01',
    });

    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(JSON.parse(unauthenticatedResponse.body).error.code).toBe('UNAUTHORIZED');
    expect(invalidResponse.statusCode).toBe(400);
    expect(JSON.parse(invalidResponse.body).error.code).toBe('INVALID_REQUEST');
    expect(malformedResponse.statusCode).toBe(400);
    expect(JSON.parse(malformedResponse.body).error.code).toBe('INVALID_REQUEST');
    expect(yearZeroResponse.statusCode).toBe(400);
    expect(JSON.parse(yearZeroResponse.body).error.code).toBe('INVALID_REQUEST');
  });

  test('uses the profile timezone for the default date and returns empty deterministic totals', async () => {
    const server = await createServer({ timezone: 'Pacific/Honolulu' });

    const response = await server.inject({ method: 'GET', url: '/api/dashboard/daily' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      date: localDate(new Date(), 'Pacific/Honolulu'),
      timezone: 'Pacific/Honolulu',
      target: null,
      totals: {
        energyMillicalories: 0,
        carbohydrateMg: 0,
        proteinMg: 0,
        fatMg: 0,
        fiberMg: 0,
        fiberKnownMg: 0,
        fiberComplete: true,
      },
      meals: [],
    });
  });
  test('returns explicit limited target state without inventing a target', async () => {
    const server = await createServer({
      onboardingStatus: 'limited',
      safetyModeReasonCodes: ['high_risk_profile'],
    });

    const response = await server.inject({ method: 'GET', url: '/api/dashboard/daily' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      targetStatus: 'limited',
      targetReasons: ['high_risk_profile'],
      target: null,
    });
  });


  test('returns only confirmed owned meals with latest snapshot totals, partial fiber, ordering, labels, quality, and effective target', async () => {
    const server = await createServer({
      profiles: [
        profile('future', '2026-08-12T00:00:00.000Z', null, 9000000),
        profile('expired', '2026-08-01T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 1000000),
        profile('active', '2026-08-10T00:00:00.000Z', null, 2000000),
      ],
      meals: [
        { id: 'late', eatenAt: new Date('2026-08-11T12:00:00.000Z'), mealType: 'dinner' },
        { id: 'early', eatenAt: new Date('2026-08-11T07:00:00.000Z'), mealType: 'breakfast' },
      ],
      snapshots: [
        snapshot('late', 2, 700, 70, 30, 20, [itemNutrients(4, 'estimated')]),
        snapshot('late', 1, 9999, 9999, 9999, 9999, [itemNutrients(999)]),
        snapshot('early', 2, 500, 50, 20, 10, [itemNutrients(3), itemNutrients(null)]),
        snapshot('early', 1, 9999, 9999, 9999, 9999, [itemNutrients(999)]),
      ],
      items: [
        { mealLogId: 'early', recognizedLabel: '현재 아침', recognitionRegionIndex: 0, id: 'item-early' },
        { mealLogId: 'late', recognizedLabel: '현재 저녁', recognitionRegionIndex: 0, id: 'item-late' },
      ],
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/dashboard/daily?date=2026-08-11',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      date: '2026-08-11',
      timezone: 'Asia/Seoul',
      targetStatus: 'active',
      targetReasons: [],
      target: {
        profileId: 'active',
        goalType: 'balanced_diet',
        energyMillicalories: 2000000,
        carbohydrateMg: 250000,
        proteinMg: 100000,
        fatMg: 60000,
        fiberMg: 25000,
      },
      totals: {
        energyMillicalories: 1200,
        carbohydrateMg: 120,
        proteinMg: 50,
        fatMg: 30,
        fiberMg: null,
        fiberKnownMg: 7,
        fiberComplete: false,
      },
      meals: [
        {
          id: 'early',
          eatenAt: '2026-08-11T07:00:00.000Z',
          mealType: 'breakfast',
          itemLabels: ['현재 아침'],
          totals: {
            energyMillicalories: 500,
            carbohydrateMg: 50,
            proteinMg: 20,
            fatMg: 10,
            fiberMg: null,
            fiberKnownMg: 3,
            fiberComplete: false,
          },
          qualityGrade: 'verified',
          calculationVersion: 'meal-nutrition-v1',
          calculatedAt: '2026-08-11T07:01:00.000Z',
        },
        {
          id: 'late',
          eatenAt: '2026-08-11T12:00:00.000Z',
          mealType: 'dinner',
          itemLabels: ['현재 저녁'],
          totals: {
            energyMillicalories: 700,
            carbohydrateMg: 70,
            proteinMg: 30,
            fatMg: 20,
            fiberMg: 4,
            fiberKnownMg: 4,
            fiberComplete: true,
          },
          qualityGrade: 'estimated',
          calculationVersion: 'meal-nutrition-v1',
          calculatedAt: '2026-08-11T07:01:00.000Z',
        },
      ],
    });
  });
  test('fails closed when a confirmed meal snapshot is missing or malformed', async () => {
    const meal = {
      id: 'meal',
      eatenAt: new Date('2026-08-11T07:00:00.000Z'),
      mealType: 'breakfast',
    };
    const missing = await createServer({ meals: [meal] });
    const malformed = await createServer({
      meals: [meal],
      snapshots: [snapshot('meal', 1, 100, 10, 5, 2, [])],
    });

    const missingResponse = await missing.inject({
      method: 'GET',
      url: '/api/dashboard/daily?date=2026-08-11',
    });
    const malformedResponse = await malformed.inject({
      method: 'GET',
      url: '/api/dashboard/daily?date=2026-08-11',
    });

    expect(missingResponse.statusCode).toBe(500);
    expect(malformedResponse.statusCode).toBe(500);
  });
});

async function createServer({
  authenticated = true,
  timezone = 'Asia/Seoul',
  onboardingStatus = 'completed',
  safetyModeReasonCodes = [],
  profiles = [],
  meals = [],
  snapshots = [],
  items = [],
}: {
  authenticated?: boolean;
  timezone?: string;
  onboardingStatus?: 'pending' | 'completed' | 'limited';
  safetyModeReasonCodes?: string[];
  profiles?: Record<string, unknown>[];
  meals?: Record<string, unknown>[];
  snapshots?: Record<string, unknown>[];
  items?: Record<string, unknown>[];
}) {
  const auth = {
    api: {
      getSession: async () =>
        authenticated ? { user: { id: 'user-id', email: 'user@example.com' }, session: {} } : null,
    },
  } as unknown as Auth;
  const database = createDatabaseMock({
    timezone,
    onboardingStatus,
    safetyModeReasonCodes,
    profiles,
    meals,
    snapshots,
    items,
  });
  const server = await buildServer({ environment, database, auth });
  servers.push(server);
  return server;
}

function createDatabaseMock(state: {
  timezone: string;
  onboardingStatus: 'pending' | 'completed' | 'limited';
  safetyModeReasonCodes: string[];
  profiles: Record<string, unknown>[];
  meals: Record<string, unknown>[];
  snapshots: Record<string, unknown>[];
  items: Record<string, unknown>[];
}) {
  const rowsFor = (table: unknown) => {
    if (table === userProfiles)
      return [{
        timezone: state.timezone,
        onboardingStatus: state.onboardingStatus,
        safetyModeReasonCodes: state.safetyModeReasonCodes,
      }];
    if (table === nutritionProfiles) return state.profiles;
    if (table === mealLogs) return state.meals;
    if (table === calculationSnapshots) return state.snapshots;
    if (table === mealItems) return state.items;
    return [];
  };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (count: number) => rowsFor(table).slice(0, count),
          orderBy: async () => orderedRows(table, rowsFor(table)),
        }),
      }),
    }),
  } as unknown as Database;
}

function orderedRows(table: unknown, rows: Record<string, unknown>[]) {
  if (table === mealLogs)
    return [...rows].sort(
      (left, right) =>
        (left.eatenAt as Date).getTime() - (right.eatenAt as Date).getTime(),
    );
  if (table === calculationSnapshots)
    return [...rows].sort(
      (left, right) => (right.sequence as number) - (left.sequence as number),
    );
  return rows;
}
function localDate(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function profile(id: string, effectiveFrom: string, effectiveTo: string | null, energyMillicalories: number) {
  return {
    id,
    goalType: 'balanced_diet',
    energyMillicalories,
    carbohydrateMg: 250000,
    proteinMg: 100000,
    fatMg: 60000,
    fiberMg: 25000,
    effectiveFrom: new Date(effectiveFrom),
    effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
  };
}

function itemNutrients(fiberMg: number | null, nutrientProfileQualityGrade = 'verified') {
  return {
    nutrientProfileQualityGrade,
    nutrients: { fiberMg },
  };
}

function snapshot(
  mealLogId: string,
  sequence: number,
  energyMillicalories: number,
  carbohydrateMg: number,
  proteinMg: number,
  fatMg: number,
  mealItems: ReturnType<typeof itemNutrients>[],
) {
  return {
    mealLogId,
    sequence,
    inputSnapshot: { mealItems },
    energyMillicalories,
    carbohydrateMg,
    proteinMg,
    fatMg,
    calculationVersion: 'meal-nutrition-v1',
    calculatedAt: new Date('2026-08-11T07:01:00.000Z'),
  };
}
