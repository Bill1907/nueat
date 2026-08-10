import cors from '@fastify/cors';
import type { Database } from '@nueat/database';
import Fastify, { LogController } from 'fastify';

import type { Auth } from './auth/auth';
import type { ApiEnvironment } from './config/env';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { sessionRoutes } from './routes/session';

export interface ServerDependencies {
  environment: ApiEnvironment;
  database: Database;
  auth: Auth;
}

export async function buildServer(dependencies: ServerDependencies) {
  const { environment } = dependencies;
  const app = Fastify({
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: environment.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          'email',
          '*.email',
          'otp',
          '*.otp',
        ],
        censor: '[REDACTED]',
      },
      ...(environment.nodeEnv === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' },
            },
          }
        : {}),
    },
    logController: new LogController({
      disableRequestLogging: environment.nodeEnv === 'test',
    }),
  });

  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86_400,
    origin(origin, callback) {
      if (!origin || environment.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('ORIGIN_NOT_ALLOWED'), false);
    },
  });

  await app.register(healthRoutes, {
    database: dependencies.database,
    databaseTimeoutMs: environment.healthDbTimeoutMs,
  });
  await app.register(authRoutes, {
    auth: dependencies.auth,
    environment,
  });
  await app.register(sessionRoutes, { auth: dependencies.auth });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: '요청한 경로를 찾을 수 없습니다.',
        requestId: request.id,
      },
    }),
  );

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    const { statusCode, isValidationError } = getErrorDetails(error);
    return reply.status(statusCode).send({
      error: {
        code: isValidationError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
        message:
          statusCode >= 500
            ? '요청을 처리하지 못했습니다.'
            : '요청 형식이 올바르지 않습니다.',
        requestId: request.id,
      },
    });
  });

  return app;
}

function getErrorDetails(error: unknown) {
  if (typeof error !== 'object' || error === null) {
    return { statusCode: 500, isValidationError: false };
  }

  const candidate = error as { statusCode?: unknown; validation?: unknown };
  const isValidationError = candidate.validation !== undefined;
  const statusCode =
    typeof candidate.statusCode === 'number' ? candidate.statusCode : isValidationError ? 400 : 500;

  return { statusCode, isValidationError };
}
