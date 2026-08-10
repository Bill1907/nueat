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

const validProfile = {
  goalType: 'maintenance',
  birthYear: 1990,
  calculationSex: 'female',
  heightMm: 1650,
  weightG: 60000,
  activityLevel: 'moderate',
  isPregnantOrLactating: false,
  hasEatingDisorderRisk: false,
  requiresMedicalNutrition: false,
};

const requiredConsents = ['terms', 'privacy', 'health_data'];

describe('onboarding routes', () => {
  test('rejects unauthenticated requests', async () => {
    const server = await createTestServer();

    const response = await server.inject({
      method: 'GET',
      url: '/api/onboarding/status',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });

  test('previews calculated and limited targets', async () => {
    const server = await createTestServer({ authenticated: true });

    const calculated = await server.inject({
      method: 'POST',
      url: '/api/onboarding/preview',
      payload: validProfile,
    });
    const limited = await server.inject({
      method: 'POST',
      url: '/api/onboarding/preview',
      payload: { ...validProfile, isPregnantOrLactating: true },
    });

    expect(JSON.parse(calculated.body).status).toBe('calculated');
    expect(JSON.parse(limited.body)).toMatchObject({
      status: 'limited',
      reasons: ['pregnant_or_lactating'],
    });
  });

  test('rejects completion without every required consent', async () => {
    const server = await createTestServer({ authenticated: true });

    const response = await server.inject({
      method: 'PUT',
      url: '/api/onboarding/complete',
      payload: {
        profile: validProfile,
        acceptedConsentTypes: ['terms', 'privacy'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(
      'REQUIRED_CONSENTS_MISSING',
    );
  });

  test('returns a conflict when onboarding is already terminal', async () => {
    const server = await createTestServer({
      authenticated: true,
      existingStatus: 'completed',
    });

    const response = await server.inject({
      method: 'PUT',
      url: '/api/onboarding/complete',
      payload: {
        profile: validProfile,
        acceptedConsentTypes: requiredConsents,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe(
      'ONBOARDING_ALREADY_COMPLETED',
    );
  });

  test('completes calculated onboarding in one transaction with consent and target writes', async () => {
    const calls: string[] = [];
    const server = await createTestServer({ authenticated: true, calls });

    const response = await server.inject({
      method: 'PUT',
      url: '/api/onboarding/complete',
      payload: {
        profile: validProfile,
        acceptedConsentTypes: requiredConsents,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'completed',
      targetResult: { status: 'calculated' },
      profileId: 'nutrition-profile-id',
    });
    expect(calls).toEqual([
      'transaction',
      'profile-upsert',
      'consent-insert:4',
      'nutrition-close',
      'nutrition-insert',
    ]);
  });

  test('completes limited onboarding without creating a nutrition profile', async () => {
    const calls: string[] = [];
    const server = await createTestServer({ authenticated: true, calls });

    const response = await server.inject({
      method: 'PUT',
      url: '/api/onboarding/complete',
      payload: {
        profile: { ...validProfile, calculationSex: null },
        acceptedConsentTypes: requiredConsents,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'limited',
      targetResult: {
        status: 'limited',
        reasons: ['calculation_sex_required'],
      },
    });
    expect(calls).toEqual([
      'transaction',
      'profile-upsert',
      'consent-insert:4',
    ]);
  });
});

async function createTestServer({
  authenticated = false,
  existingStatus,
  calls = [],
}: {
  authenticated?: boolean;
  existingStatus?: 'completed' | 'limited';
  calls?: string[];
} = {}) {
  const database = createDatabaseMock(existingStatus, calls);
  const auth = {
    api: {
      getSession: async () =>
        authenticated
          ? { user: { id: 'user-id', email: 'user@example.com' }, session: {} }
          : null,
    },
  } as unknown as Auth;
  const server = await buildServer({ environment, database, auth });
  openServers.push(server);
  return server;
}

function createDatabaseMock(
  existingStatus: 'completed' | 'limited' | undefined,
  calls: string[],
) {
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (existingStatus ? [{ status: existingStatus }] : []),
      }),
    }),
  });
  const transaction = async <T>(
    callback: (tx: Record<string, unknown>) => Promise<T>,
  ) => {
    calls.push('transaction');
    return callback(transactionClient);
  };
  const transactionClient = {
    select,
    insert: (table: { [key: string]: unknown }) => {
      if ('onboardingStatus' in table) {
        return {
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => {
                calls.push('profile-upsert');
                return [{ userId: 'user-id' }];
              },
            }),
          }),
        };
      }
      if ('documentVersion' in table) {
        return {
          values: (values: unknown[]) => {
            calls.push(`consent-insert:${values.length}`);
            return Promise.resolve();
          },
        };
      }
      return {
        values: () => ({
          returning: async () => {
            calls.push('nutrition-insert');
            return [{ id: 'nutrition-profile-id' }];
          },
        }),
      };
    },
    update: () => ({
      set: () => ({
        where: async () => {
          calls.push('nutrition-close');
        },
      }),
    }),
  };

  return { select, transaction } as unknown as Database;
}
