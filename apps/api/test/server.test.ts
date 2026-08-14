import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from '@nueat/database';
import type { FastifyInstance } from 'fastify';

import type { Auth } from '../src/auth/auth';
import { parseEnvironment } from '../src/config/env';
import {
  buildServer,
  cohortGatedRecognitionRunner,
  materializeAutoSelectionPolicy,
} from '../src/server';

const environment = parseEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api-nueat.boseong.dev',
  RESEND_API_KEY: 're_test',
  TRUSTED_ORIGINS: 'nueat://,https://nueat.boseong.dev',
  S3_ENDPOINT: 'https://storage.railway.app',
  S3_BUCKET: 'nueat-test',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
});

const openServers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe('NUEAT API server', () => {
  test('routes protocol cohorts to distinct v2 and legacy runners without v2 fallback ledgers', async () => {
    const calls: string[] = [];
    const v2 = {
      async reconcile() {
        return { status: 'ready' as const };
      },
      async recognize(_mealLogId: string, _userId: string, trigger = 'initial') {
        calls.push(`v2:${trigger}`);
        return { status: 'ready' as const };
      },
    };
    const legacy = {
      async reconcile() {
        return { status: 'ready' as const };
      },
      async recognize(_mealLogId: string, _userId: string, trigger = 'initial') {
        calls.push(`legacy:${trigger}`);
        return { status: 'ready' as const };
      },
    };
    const base = {
      ...environment.mealRecognition.reliability,
      protocolMode: 'v2_one_call' as const,
      cohortPercent: 0,
      recoveryEnabled: false,
    };
    await cohortGatedRecognitionRunner(v2, legacy, base).recognize('meal', 'user');
    await cohortGatedRecognitionRunner(v2, legacy, {
      ...base, cohortPercent: 100, recoveryEnabled: true,
    }).recognize('meal', 'user', 'user_recovery');
    await cohortGatedRecognitionRunner(v2, legacy, {
      ...base, protocolMode: 'legacy_observe',
    }).recognize('meal', 'user');
    await cohortGatedRecognitionRunner(v2, legacy, {
      ...base, protocolMode: 'legacy_observe',
    }).recognize('meal', 'user', 'user_recovery');

    expect(calls).toEqual([
      'legacy:initial',
      'v2:user_recovery',
      'legacy:initial',
    ]);
  });

  test('materializes only a complete signed auto-selection policy carrier', () => {
    const policy = {
      version: 'catalog-auto-selection-policy-v1' as const,
      comparatorVersion: 'catalog-auto-selection-comparator-v1' as const,
      minimumWinnerScoreBps: 9_000,
      minimumMarginBps: 1_000,
      identitySha256: 'a'.repeat(64),
    };
    const autoEnvironment = {
      ...environment,
      mealRecognition: {
        ...environment.mealRecognition,
        reviewPolicy: {
          ...environment.mealRecognition.reviewPolicy,
          mode: 'auto_selection' as const,
          mappingMode: 'hybrid_auto' as const,
          approvedReportReceipt: { autoSelectionPolicy: policy },
        },
      },
    };

    expect(materializeAutoSelectionPolicy(autoEnvironment)).toEqual({
      policy,
      verifiedPolicyIdentitySha256: policy.identitySha256,
    });
    expect(() => materializeAutoSelectionPolicy({
      ...autoEnvironment,
      mealRecognition: {
        ...autoEnvironment.mealRecognition,
        reviewPolicy: {
          ...autoEnvironment.mealRecognition.reviewPolicy,
          approvedReportReceipt: { autoSelectionPolicy: { ...policy, minimumMarginBps: 10_001 } },
        },
      },
    })).toThrow('MEAL_RECOGNITION_AUTO_SELECTION_VERIFICATION_FAILED');
  });

  test('reports liveness without touching the database', async () => {
    let databaseCalls = 0;
    const server = await createTestServer({
      execute: async () => {
        databaseCalls += 1;
        return [];
      },
    });

    const response = await server.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', service: 'nueat-api' });
    expect(databaseCalls).toBe(0);
  });

  test('reports readiness only when Neon is reachable', async () => {
    const readyServer = await createTestServer({
      execute: async () => [{ ready: true }],
    });
    const unavailableServer = await createTestServer({
      execute: async () => {
        throw new Error('database unavailable');
      },
    });

    const ready = await readyServer.inject({ method: 'GET', url: '/health/ready' });
    const unavailable = await unavailableServer.inject({ method: 'GET', url: '/health/ready' });

    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({
      dependencies: { database: 'up' },
      mealConfirmation: {
        identity: 'meal-confirmation-cutover-v1',
        mode: 'normal',
        protocol: 'meal-confirmation-safe-review-v1',
        barrier: 'required',
      },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.parse(unavailable.body)).toMatchObject({
      dependencies: { database: 'down' },
      mealConfirmation: {
        identity: 'meal-confirmation-cutover-v1',
        mode: 'normal',
        protocol: 'meal-confirmation-safe-review-v1',
        barrier: 'required',
      },
    });
  });

  test('safe-review readiness requires the 0022 checkpoint column and guard', async () => {
    const oldSchemaServer = await createTestServer(
      { execute: async () => [{ ready: false }] },
      createAuthMock(async () => Response.json({ ok: true })),
      'safe_review_maintenance',
    );
    const readyServer = await createTestServer(
      { execute: async () => [{ ready: true }] },
      createAuthMock(async () => Response.json({ ok: true })),
      'safe_review_maintenance',
    );

    const oldSchema = await oldSchemaServer.inject({ method: 'GET', url: '/health/ready' });
    const ready = await readyServer.inject({ method: 'GET', url: '/health/ready' });

    expect(oldSchema.statusCode).toBe(503);
    expect(JSON.parse(oldSchema.body)).toMatchObject({
      dependencies: { database: 'up', mealConfirmationSafeReview: 'down' },
    });
    expect(ready.statusCode).toBe(200);
  });

  test('normal readiness requires the 0022 checkpoint column and guard', async () => {
    const server = await createTestServer(
      { execute: async () => [{ ready: false }] },
      createAuthMock(async () => Response.json({ ok: true })),
      'normal',
    );

    const response = await server.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      dependencies: { database: 'up', mealConfirmationSafeReview: 'down' },
    });
  });

  test('bridge startup skips invalid auto-selection policy materialization', async () => {
    const server = await buildServer({
      environment: {
        ...environment,
        mealConfirmationCutover: {
          ...environment.mealConfirmationCutover,
          mode: 'maintenance_bridge',
        },
        mealRecognition: {
          ...environment.mealRecognition,
          reviewPolicy: {
            ...environment.mealRecognition.reviewPolicy,
            mode: 'auto_selection',
            approvedReportReceipt: null,
          },
        },
      },
      database: { execute: async () => [] } as unknown as Database,
      auth: createAuthMock(async () => Response.json({ ok: true })),
    });
    openServers.push(server);

    expect(server).toBeDefined();
  });

  test('forwards Better Auth responses and multiple session cookies', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'session=one; Path=/; HttpOnly');
    headers.append('set-cookie', 'state=two; Path=/; HttpOnly');
    const auth = createAuthMock(async () =>
      Response.json({ ok: true }, { status: 201, headers }),
    );
    const server = await createTestServer({ execute: async () => [] }, auth);

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/test',
      payload: { email: 'hidden@example.com' },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(response.cookies.map((cookie) => cookie.name)).toEqual(['session', 'state']);
  });

  test('returns a stable unauthorized and not-found contract', async () => {
    const server = await createTestServer({ execute: async () => [] });

    const unauthorized = await server.inject({ method: 'GET', url: '/api/me' });
    const missing = await server.inject({ method: 'GET', url: '/missing' });

    expect(unauthorized.statusCode).toBe(401);
    expect(JSON.parse(unauthorized.body).error.code).toBe('UNAUTHORIZED');
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).error.code).toBe('NOT_FOUND');
  });
});

async function createTestServer(
  database: { execute: () => Promise<unknown> },
  auth = createAuthMock(async () => Response.json({ ok: true })),
  cutoverMode: 'normal' | 'maintenance_bridge' | 'safe_review_maintenance' = 'normal',
) {
  const server = await buildServer({
    environment: {
      ...environment,
      mealConfirmationCutover: {
        ...environment.mealConfirmationCutover,
        mode: cutoverMode,
      },
    },
    database: database as unknown as Database,
    auth,
  });
  openServers.push(server);
  return server;
}

function createAuthMock(handler: (request: Request) => Promise<Response>) {
  return {
    handler,
    api: {
      getSession: async () => null,
    },
  } as unknown as Auth;
}
