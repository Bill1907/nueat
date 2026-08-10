import type { Database } from '@nueat/database';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

interface HealthRouteOptions {
  database: Database;
  databaseTimeoutMs: number;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, options) => {
  app.get('/health/live', async () => ({
    status: 'ok',
    service: 'nueat-api',
  }));

  const readinessHandler = async (_request: unknown, reply: { status: (code: number) => unknown }) => {
    try {
      await withTimeout(
        options.database.execute(sql`select 1 as ok`),
        options.databaseTimeoutMs,
      );
      return {
        status: 'ready',
        service: 'nueat-api',
        dependencies: { database: 'up' },
      };
    } catch {
      reply.status(503);
      return {
        status: 'not_ready',
        service: 'nueat-api',
        dependencies: { database: 'down' },
      };
    }
  };

  app.get('/health', readinessHandler);
  app.get('/health/ready', readinessHandler);
};

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DATABASE_HEALTH_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
