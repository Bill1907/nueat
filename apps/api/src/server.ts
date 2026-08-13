import OpenAI from 'openai';
import cors from '@fastify/cors';
import type { Database } from '@nueat/database';
import { sql } from 'drizzle-orm';
import Fastify, { LogController } from 'fastify';

import type { Auth } from './auth/auth';
import type { ApiEnvironment } from './config/env';
import {
  calculateCatalogReleaseIdentity,
  calculateCatalogRegistrySha256,
} from './services/catalog-registry-verifier';
import { createS3ImageObjectStore, type ImageObjectStore } from './services/image-object-store';
import {
  MealRecognitionCoordinator,
  type MealRecognitionRunner,
} from './services/meal-recognition-coordinator';
import {
  type VerifiedCatalogAutoSelectionPolicy,
} from './services/meal-resolution-coordinator';
import {
  CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
  CATALOG_AUTO_SELECTION_POLICY_VERSION,
} from './services/catalog-auto-selection-policy';
import { MockMealRecognizer } from './services/mock-meal-recognizer';
import {
  OpenAIMealRecognizer,
  type OpenAIResponsesClient,
} from './services/openai-meal-recognizer';
import {
  MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
} from './services/meal-confirmation-cutover';
import { authRoutes } from './routes/auth';
import { dailyDashboardRoutes } from './routes/daily-dashboard';
import { foodRoutes } from './routes/food';
import { healthRoutes } from './routes/health';
import { imageAssetRoutes } from './routes/image-asset';
import { mealConfirmationBridgeRoutes } from './routes/meal-confirmation-bridge';
import { mealLogRoutes } from './routes/meal-log';
import { onboardingRoutes } from './routes/onboarding';
import { nutritionTargetRoutes } from './routes/nutrition-target';
import { sessionRoutes } from './routes/session';
import { recommendationRoutes } from './routes/recommendation';

export interface ServerDependencies {
  environment: ApiEnvironment;
  database: Database;
  auth: Auth;
  imageObjectStore?: ImageObjectStore;
  recognitionCoordinator?: MealRecognitionRunner;
}

export async function buildServer(dependencies: ServerDependencies) {
  const { environment } = dependencies;
  const bridgeMode =
    environment.mealConfirmationCutover.mode === 'maintenance_bridge';
  const configuredAutoSelectionPolicy = bridgeMode
    ? null
    : materializeAutoSelectionPolicy(environment);
  if (configuredAutoSelectionPolicy) {
    const expectedCatalogSha256 =
      environment.mealRecognition.reviewPolicy.catalogRegistrySha256;
    const actualCatalogSha256 = await calculateCatalogRegistrySha256(
      dependencies.database,
    );
    if (!expectedCatalogSha256 || actualCatalogSha256 !== expectedCatalogSha256) {
      throw new Error('MEAL_RECOGNITION_AUTO_SELECTION_VERIFICATION_FAILED');
    }
    if (environment.mealRecognition.reviewPolicy.mappingMode === 'hybrid_auto') {
      const receipt = environment.mealRecognition.reviewPolicy.approvedReportReceipt;
      const identity = receipt &&
        typeof receipt.provenance === 'object' &&
        receipt.provenance !== null &&
        !Array.isArray(receipt.provenance)
        ? (receipt.provenance as { activationIdentity?: { catalogReleaseSha256?: string; catalogReleaseIds?: string[] } }).activationIdentity
        : null;
      const release = await calculateCatalogReleaseIdentity(dependencies.database);
      if (
        !identity ||
        identity.catalogReleaseSha256 !== release.registrySha256 ||
        !Array.isArray(identity.catalogReleaseIds) ||
        canonicalReleaseIds(identity.catalogReleaseIds) !== canonicalReleaseIds(release.releaseIds)
      ) {
        throw new Error('MEAL_RECOGNITION_AUTO_SELECTION_VERIFICATION_FAILED');
      }
    }
  }
  const autoSelectionPolicy =
    bridgeMode ? null : configuredAutoSelectionPolicy;
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
                    model: environment.mealRecognition.model,
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
          autoSelectionPolicy,
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
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-NUEAT-Meal-Confirmation-Protocol',
    ],
    maxAge: 86_400,
    origin(origin, callback) {
      if (!origin || environment.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('ORIGIN_NOT_ALLOWED'), false);
    },
  });

  app.addHook('preSerialization', (request, _reply, payload, done) => {
    if (
      (request.url === '/health' || request.url === '/health/ready') &&
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
    ) {
      done(null, {
        ...payload,
        mealConfirmation: {
          identity: 'meal-confirmation-cutover-v1',
          mode: environment.mealConfirmationCutover.mode,
          protocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
          barrier: 'required',
        },
      });
      return;
    }
    done(null, payload);
  });
  if (!bridgeMode) {
    app.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?', 1)[0];
      if (pathname !== '/health' && pathname !== '/health/ready') return;
      try {
        const [capability] = await dependencies.database.execute(sql`
          select
            exists (
              select 1
              from information_schema.columns
              where table_schema = current_schema()
                and table_name = 'meal_item'
                and column_name = 'reviewed_item_revision'
            )
            and exists (
              select 1
              from pg_trigger
              where tgname = 'meal_log_confirmed_review_checkpoint_guard'
                and not tgisinternal
            ) as ready
        `);
        if (capability?.ready === true) return;
      } catch {
        reply.hijack();
        reply.raw.statusCode = 503;
        reply.raw.setHeader('content-type', 'application/json; charset=utf-8');
        reply.raw.end(JSON.stringify({
          status: 'not_ready',
          service: 'nueat-api',
          dependencies: { database: 'down', mealConfirmationSafeReview: 'down' },
          mealConfirmation: {
            identity: 'meal-confirmation-cutover-v1',
            mode: environment.mealConfirmationCutover.mode,
            protocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
            barrier: 'required',
          },
        }));
        return;
      }
      reply.hijack();
      reply.raw.statusCode = 503;
      reply.raw.setHeader('content-type', 'application/json; charset=utf-8');
      reply.raw.end(JSON.stringify({
        status: 'not_ready',
        service: 'nueat-api',
        dependencies: { database: 'up', mealConfirmationSafeReview: 'down' },
        mealConfirmation: {
          identity: 'meal-confirmation-cutover-v1',
          mode: environment.mealConfirmationCutover.mode,
          protocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
          barrier: 'required',
        },
      }));
    });
  }
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
  if (environment.mealConfirmationCutover.mode === 'maintenance_bridge') {
    await app.register(mealConfirmationBridgeRoutes, {
      auth: dependencies.auth,
      database: dependencies.database,
      cutover: environment.mealConfirmationCutover,
    });
  } else {
    await app.register(mealLogRoutes, {
      auth: dependencies.auth,
      database: dependencies.database,
      recognitionCoordinator,
      reviewPolicy: environment.mealRecognition.reviewPolicy,
      mealConfirmationCutover: environment.mealConfirmationCutover,
    });
    await app.register(dailyDashboardRoutes, {
      auth: dependencies.auth,
      database: dependencies.database,
    });
  }
  await app.register(foodRoutes, {
    auth: dependencies.auth,
    database: dependencies.database,
  });
  if (environment.mealConfirmationCutover.mode !== 'maintenance_bridge') {
    await app.register(recommendationRoutes, {
      auth: dependencies.auth,
      database: dependencies.database,
    });
  }

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

function canonicalReleaseIds(ids: string[]) {
  return [...ids].sort().join('\n');
}

export function materializeAutoSelectionPolicy(
  environment: ApiEnvironment,
): VerifiedCatalogAutoSelectionPolicy | null {
  if (environment.mealRecognition.reviewPolicy.mode !== 'auto_selection') return null;
  const receipt = environment.mealRecognition.reviewPolicy.approvedReportReceipt;
  if (!isRecord(receipt) || !isRecord(receipt.autoSelectionPolicy)) {
    throw new Error('MEAL_RECOGNITION_AUTO_SELECTION_VERIFICATION_FAILED');
  }
  const policy = receipt.autoSelectionPolicy;
  if (
    policy.version !== CATALOG_AUTO_SELECTION_POLICY_VERSION ||
    policy.comparatorVersion !== CATALOG_AUTO_SELECTION_COMPARATOR_VERSION ||
    !isBps(policy.minimumWinnerScoreBps) ||
    !isBps(policy.minimumMarginBps) ||
    !isSha256(policy.identitySha256)
  ) throw new Error('MEAL_RECOGNITION_AUTO_SELECTION_VERIFICATION_FAILED');
  return {
    policy: {
      version: policy.version,
      comparatorVersion: policy.comparatorVersion,
      minimumWinnerScoreBps: policy.minimumWinnerScoreBps,
      minimumMarginBps: policy.minimumMarginBps,
      identitySha256: policy.identitySha256,
    },
    verifiedPolicyIdentitySha256: policy.identitySha256,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
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
