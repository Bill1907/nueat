import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from '@nueat/database';
import type { FastifyInstance } from 'fastify';

import type { Auth } from '../src/auth/auth';
import { parseEnvironment } from '../src/config/env';
import { buildServer } from '../src/server';

const environment = parseEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api-nueat.boseong.dev',
  RESEND_API_KEY: 're_test',
  TRUSTED_ORIGINS: 'nueat://,https://nueat.boseong.dev',
});

const openServers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe('active nutrition target route', () => {
  test('rejects unauthenticated requests', async () => {
    const server = await createTestServer({ authenticated: false });
    const response = await server.inject({
      method: 'GET',
      url: '/api/nutrition-targets/active',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });

  test('returns pending and limited onboarding states without numeric targets', async () => {
    const pending = await createTestServer({ authenticated: true, onboardingStatus: 'pending' });
    const limited = await createTestServer({
      authenticated: true,
      onboardingStatus: 'limited',
      reasons: ['medical_nutrition_required'],
    });

    const pendingResponse = await pending.inject({
      method: 'GET',
      url: '/api/nutrition-targets/active',
    });
    const limitedResponse = await limited.inject({
      method: 'GET',
      url: '/api/nutrition-targets/active',
    });

    expect(JSON.parse(pendingResponse.body)).toEqual({ status: 'pending' });
    expect(JSON.parse(limitedResponse.body)).toEqual({
      status: 'limited',
      reasons: ['medical_nutrition_required'],
    });
  });

  test('returns the active versioned target for a completed profile', async () => {
    const target = {
      id: 'profile-id',
      goalType: 'balanced_diet',
      birthYear: 1990,
      calculationSex: 'female',
      heightMm: 1654,
      weightG: 60000,
      activityLevel: 'moderate',
      calorieTargetMillicalories: 2340000,
      carbohydrateTargetMg: 321750,
      proteinTargetMg: 117000,
      fatTargetMg: 65000,
      fiberTargetMg: 20000,
      engineVersion: 'nutrition-targets-v1',
      effectiveFrom: new Date('2026-08-10T12:40:41.528Z'),
    };
    const server = await createTestServer({
      authenticated: true,
      onboardingStatus: 'completed',
      target,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/nutrition-targets/active',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'active',
      profile: {
        goalType: 'balanced_diet',
        calorieTargetMillicalories: 2340000,
        proteinTargetMg: 117000,
        engineVersion: 'nutrition-targets-v1',
      },
      standard: {
        nameKo: '2025 한국인 영양소 섭취기준',
        corrigendaVersion: '2026-03-16',
      },
    });
  });

  test('reports inconsistent completed state without an active target', async () => {
    const server = await createTestServer({
      authenticated: true,
      onboardingStatus: 'completed',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/nutrition-targets/active',
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('ACTIVE_NUTRITION_TARGET_NOT_FOUND');
  });
});

async function createTestServer({
  authenticated,
  onboardingStatus = 'pending',
  reasons = [],
  target,
}: {
  authenticated: boolean;
  onboardingStatus?: 'pending' | 'completed' | 'limited';
  reasons?: string[];
  target?: Record<string, unknown>;
}) {
  const auth = {
    api: {
      getSession: async () =>
        authenticated
          ? { user: { id: 'user-id', email: 'user@example.com' }, session: {} }
          : null,
    },
  } as unknown as Auth;
  const database = createDatabaseMock({ onboardingStatus, reasons, target });
  const server = await buildServer({ environment, database, auth });
  openServers.push(server);
  return server;
}

function createDatabaseMock({
  onboardingStatus,
  reasons,
  target,
}: {
  onboardingStatus: 'pending' | 'completed' | 'limited';
  reasons: string[];
  target: Record<string, unknown> | undefined;
}) {
  return {
    select: () => ({
      from: (table: Record<string, unknown>) => ({
        where: () => {
          if ('onboardingStatus' in table) {
            return {
              limit: async () => [{ status: onboardingStatus, reasons }],
            };
          }
          return {
            orderBy: () => ({
              limit: async () => (target ? [target] : []),
            }),
          };
        },
      }),
    }),
  } as unknown as Database;
}
