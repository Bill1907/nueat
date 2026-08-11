import OpenAI from 'openai';
import cors from '@fastify/cors';
import type { Database } from '@nueat/database';
import Fastify, { LogController } from 'fastify';

import type { Auth } from './auth/auth';
import type { ApiEnvironment } from './config/env';
import { createS3ImageObjectStore, type ImageObjectStore } from './services/image-object-store';
import {
  MealRecognitionCoordinator,
  type MealRecognitionRunner,
} from './services/meal-recognition-coordinator';
import { MockMealRecognizer } from './services/mock-meal-recognizer';
import {
  OpenAIMealRecognizer,
  type OpenAIResponsesClient,
} from './services/openai-meal-recognizer';
import { authRoutes } from './routes/auth';
import { dailyDashboardRoutes } from './routes/daily-dashboard';
import { foodRoutes } from './routes/food';
import { healthRoutes } from './routes/health';
import { imageAssetRoutes } from './routes/image-asset';
import { mealLogRoutes } from './routes/meal-log';
import { onboardingRoutes } from './routes/onboarding';
import { nutritionTargetRoutes } from './routes/nutrition-target';
import { sessionRoutes } from './routes/session';

export interface ServerDependencies {
  environment: ApiEnvironment;
  database: Database;
  auth: Auth;
  imageObjectStore?: ImageObjectStore;
  recognitionCoordinator?: MealRecognitionRunner;
}

export async function buildServer(dependencies: ServerDependencies) {
  const { environment } = dependencies;
  const imageObjectStore =
    dependencies.imageObjectStore ??
    (environment.imageBucket ? createS3ImageObjectStore(environment.imageBucket) : null);
  const recognitionCoordinator =
    dependencies.recognitionCoordinator ??
    (imageObjectStore
      ? new MealRecognitionCoordinator({
          database: dependencies.database,
          objectStore: imageObjectStore,
          recognizer:
            environment.mealRecognition.mode === 'openai'
              ? new OpenAIMealRecognizer(
                  new OpenAI({
                    apiKey: environment.mealRecognition.apiKey,
                  }) as unknown as OpenAIResponsesClient,
                  {
                    deadlineMs: environment.mealRecognition.deadlineMs,
                    maxOutputTokens: environment.mealRecognition.maxOutputTokens,
                  },
                )
              : new MockMealRecognizer(),
          maxBytes: environment.imageBucket?.maxBytes ?? 10_000_000,
          timeoutMs: environment.mealRecognition.deadlineMs,
          leaseMs: environment.mealRecognition.deadlineMs + 5_000,
          maxAttempts: environment.mealRecognition.maxAttempts,
          dailyQuota: environment.mealRecognition.dailyAttemptQuota,
        })
      : unavailableRecognitionRunner);
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
  await app.register(imageAssetRoutes, {
    auth: dependencies.auth,
    database: dependencies.database,
    environment,
    objectStore: imageObjectStore,
  });
  await app.register(authRoutes, {
    auth: dependencies.auth,
    environment,
  });
  await app.register(sessionRoutes, { auth: dependencies.auth });
  await app.register(onboardingRoutes, {
    auth: dependencies.auth,
    database: dependencies.database,
  });
  await app.register(nutritionTargetRoutes, {
    auth: dependencies.auth,
    database: dependencies.database,
  });
  await app.register(mealLogRoutes, {
    auth: dependencies.auth,
    database: dependencies.database,
    recognitionCoordinator,
  });
  await app.register(dailyDashboardRoutes, {
    auth: dependencies.auth,
    database: dependencies.database,
  });
  await app.register(foodRoutes, {
    auth: dependencies.auth,
    database: dependencies.database,
  });

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

const unavailableRecognitionRunner: MealRecognitionRunner = {
  async recognize() {
    return {
      status: 'unavailable',
      code: 'RECOGNITION_UNAVAILABLE',
      retryable: false,
    };
  },
};
