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

describe('NUEAT API server', () => {
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
    const readyServer = await createTestServer({ execute: async () => [] });
    const unavailableServer = await createTestServer({
      execute: async () => {
        throw new Error('database unavailable');
      },
    });

    const ready = await readyServer.inject({ method: 'GET', url: '/health/ready' });
    const unavailable = await unavailableServer.inject({ method: 'GET', url: '/health/ready' });

    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body).dependencies.database).toBe('up');
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.parse(unavailable.body).dependencies.database).toBe('down');
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
) {
  const server = await buildServer({
    environment,
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
