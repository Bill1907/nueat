import {
  assetDeletionJobs,
  foods,
  imageAssets,
  mealItems,
  mealLogs,
  nutrientProfiles,
  type Database,
} from '@nueat/database';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';
import type { MealRecognitionRunner } from '../services/meal-recognition-coordinator';

const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const servingUnitSchema = z.enum(['g', 'ml', 'serving', 'bowl', 'piece']);
const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(new Date(value).getTime()));
const timezoneSchema = z.string().refine(isIanaTimezone);
const mealLogIdParamsSchema = z.object({ mealLogId: z.uuid() }).strict();
const mealItemIdParamsSchema = mealLogIdParamsSchema
  .extend({ itemId: z.uuid() })
  .strict();
const createMealLogSchema = z
  .object({
    imageAssetId: z.uuid(),
    eatenAt: dateTimeSchema,
    timezone: timezoneSchema,
    mealType: mealTypeSchema,
  })
  .strict();
const updateMealLogSchema = z
  .object({
    eatenAt: dateTimeSchema.optional(),
    timezone: timezoneSchema.optional(),
    mealType: mealTypeSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const createMealItemSchema = z
  .object({
    recognizedLabel: z.string().trim().min(1),
    amountMilliunits: z.int().positive(),
    unit: servingUnitSchema,
  })
  .strict();
const updateMealItemSchema = z
  .object({
    recognizedLabel: z.string().trim().min(1).optional(),
    amountMilliunits: z.int().positive().optional(),
    unit: servingUnitSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const mapFoodSchema = z.object({ foodId: z.uuid() }).strict();

interface MealLogRouteOptions {
  auth: Auth;
  database: Database;
  recognitionCoordinator: MealRecognitionRunner;
}

export const mealLogRoutes: FastifyPluginAsync<MealLogRouteOptions> = async (
  app,
  options,
) => {
  app.post('/api/meal-logs', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const parsed = createMealLogSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, request);

    const input = parsed.data;
    const now = new Date();
    const eatenAt = new Date(input.eatenAt);
    const eatenLocalDate = localDate(eatenAt, input.timezone);
    const existing = await findOwnedDraftMealLogByImage(
      options.database,
      input.imageAssetId,
      userId,
    );
    if (existing) {
      const outcome = await options.recognitionCoordinator.recognize(
        existing.id,
        userId,
      );
      const current = await findOwnedMealLog(options.database, existing.id, userId);
      if (!current) return mealLogNotFound(reply, request);
      return recognitionResponse(
        reply,
        current,
        await findMealItems(options.database, current.id),
        outcome,
      );
    }
    const mealLog = await options.database.transaction(async (tx) => {
      const [claimedAsset] = await tx
        .update(imageAssets)
        .set({ status: 'processing' })
        .where(
          and(
            eq(imageAssets.id, input.imageAssetId),
            eq(imageAssets.userId, userId),
            eq(imageAssets.status, 'validated'),
          ),
        )
        .returning({ id: imageAssets.id });
      if (!claimedAsset) return null;
      const [created] = await tx
        .insert(mealLogs)
        .values({
          userId,
          imageAssetId: input.imageAssetId,
          eatenAt,
          eatenTimezone: input.timezone,
          eatenLocalDate,
          mealType: input.mealType,
          status: 'draft',
          recognitionStatus: 'pending',
          recognitionNextAttemptAt: now,
        })
        .returning(mealLogSelection);
      if (!created) throw new Error('MealLog insert did not return a row');
      return created;
    });
    if (!mealLog) {
      const concurrent = await findOwnedDraftMealLogByImage(
        options.database,
        input.imageAssetId,
        userId,
      );
      if (!concurrent) return imageUnavailable(reply, request);
      const outcome = await options.recognitionCoordinator.recognize(
        concurrent.id,
        userId,
      );
      const current = await findOwnedMealLog(options.database, concurrent.id, userId);
      if (!current) return mealLogNotFound(reply, request);
      return recognitionResponse(
        reply,
        current,
        await findMealItems(options.database, current.id),
        outcome,
      );
    }
    const outcome = await options.recognitionCoordinator.recognize(mealLog.id, userId);
    const current = await findOwnedMealLog(options.database, mealLog.id, userId);
    if (!current) return mealLogNotFound(reply, request);
    return recognitionResponse(reply, current, await findMealItems(options.database, current.id), outcome, 201);
  });

  app.get('/api/meal-logs/:mealLogId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request);
    const mealLog = await findOwnedMealLog(
      options.database,
      params.data.mealLogId,
      userId,
    );
    if (!mealLog) return mealLogNotFound(reply, request);
    const items = await findMealItems(options.database, mealLog.id);
    return mealLogResponse(mealLog, items);
  });

  app.patch('/api/meal-logs/:mealLogId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    const body = updateMealLogSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);
    const existing = await findOwnedMealLog(
      options.database,
      params.data.mealLogId,
      userId,
    );
    if (!existing) return mealLogNotFound(reply, request);
    if (existing.status !== 'draft') return invalidMealLogState(reply, request);

    const eatenAt = body.data.eatenAt
      ? new Date(body.data.eatenAt)
      : existing.eatenAt;
    const timezone = body.data.timezone ?? existing.timezone;
    const [mealLog] = await options.database
      .update(mealLogs)
      .set({
        eatenAt,
        eatenTimezone: timezone,
        eatenLocalDate: localDate(eatenAt, timezone),
        mealType: body.data.mealType ?? existing.mealType,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mealLogs.id, existing.id),
          eq(mealLogs.userId, userId),
          eq(mealLogs.status, 'draft'),
        ),
      )
      .returning(mealLogSelection);
    if (!mealLog) return invalidMealLogState(reply, request);
    const items = await findMealItems(options.database, mealLog.id);
    return mealLogResponse(mealLog, items);
  });

  app.post('/api/meal-logs/:mealLogId/items', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    const body = createMealItemSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);
    const mealLog = await findOwnedDraftMealLog(
      options.database,
      params.data.mealLogId,
      userId,
    );
    if (!mealLog)
      return mealLogStateOrNotFound(
        options.database,
        params.data.mealLogId,
        userId,
        reply,
        request,
      );
    await options.database
      .insert(mealItems)
      .values({ mealLogId: mealLog.id, ...body.data, userCorrected: true });
    const items = await findMealItems(options.database, mealLog.id);
    return reply.status(201).send(mealLogResponse(mealLog, items));
  });

  app.patch(
    '/api/meal-logs/:mealLogId/items/:itemId',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      const params = mealItemIdParamsSchema.safeParse(request.params);
      const body = updateMealItemSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return invalidRequest(reply, request);
      const mealLog = await findOwnedDraftMealLog(
        options.database,
        params.data.mealLogId,
        userId,
      );
      if (!mealLog)
        return mealLogStateOrNotFound(
          options.database,
          params.data.mealLogId,
          userId,
          reply,
          request,
        );
      const [item] = await options.database
        .update(mealItems)
        .set({
          ...body.data,
          ...(body.data.recognizedLabel === undefined
            ? {}
            : {
                foodId: null,
                nutrientProfileId: null,
                mappingConfidenceBps: null,
              }),
          userCorrected: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mealItems.id, params.data.itemId),
            eq(mealItems.mealLogId, mealLog.id),
          ),
        )
        .returning(mealItemSelection);
      if (!item) return mealLogNotFound(reply, request);
      const items = await findMealItems(options.database, mealLog.id);
      return mealLogResponse(mealLog, items);
    },
  );
  app.put(
    '/api/meal-logs/:mealLogId/items/:itemId/food',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      const params = mealItemIdParamsSchema.safeParse(request.params);
      const body = mapFoodSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return invalidRequest(reply, request);
      const mealLog = await findOwnedDraftMealLog(
        options.database,
        params.data.mealLogId,
        userId,
      );
      if (!mealLog)
        return mealLogStateOrNotFound(
          options.database,
          params.data.mealLogId,
          userId,
          reply,
          request,
        );

      const mapped = await options.database.transaction(async (tx) => {
        const [food] = await tx
          .select({ id: foods.id, canonicalNameKo: foods.canonicalNameKo })
          .from(foods)
          .where(
            and(
              eq(foods.id, body.data.foodId),
              eq(foods.isDeprecated, false),
            ),
          )
          .limit(1);
        if (!food) return { kind: 'food_not_found' as const };

        const [profile] = await tx
          .select({ id: nutrientProfiles.id })
          .from(nutrientProfiles)
          .where(
            and(
              eq(nutrientProfiles.foodId, food.id),
              or(
                eq(nutrientProfiles.qualityGrade, 'verified'),
                eq(nutrientProfiles.qualityGrade, 'estimated'),
              ),
            ),
          )
          .orderBy(
            desc(nutrientProfiles.qualityGrade),
            desc(nutrientProfiles.datasetVersion),
            asc(nutrientProfiles.id),
          )
          .limit(1);
        if (!profile) return { kind: 'profile_unavailable' as const };

        const [item] = await tx
          .update(mealItems)
          .set({
            recognizedLabel: food.canonicalNameKo,
            foodId: food.id,
            nutrientProfileId: profile.id,
            mappingConfidenceBps: 10_000,
            userCorrected: true,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mealItems.id, params.data.itemId),
              eq(mealItems.mealLogId, mealLog.id),
            ),
          )
          .returning(mealItemSelection);
        return item ? { kind: 'mapped' as const } : { kind: 'item_not_found' as const };
      });

      if (mapped.kind === 'food_not_found') return foodNotFound(reply, request);
      if (mapped.kind === 'profile_unavailable')
        return foodNutrientProfileUnavailable(reply, request);
      if (mapped.kind === 'item_not_found') return mealLogNotFound(reply, request);
      const items = await findMealItems(options.database, mealLog.id);
      return mealLogResponse(mealLog, items);
    },
  );

  app.delete(
    '/api/meal-logs/:mealLogId/items/:itemId',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      const params = mealItemIdParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply, request);
      const mealLog = await findOwnedDraftMealLog(
        options.database,
        params.data.mealLogId,
        userId,
      );
      if (!mealLog)
        return mealLogStateOrNotFound(
          options.database,
          params.data.mealLogId,
          userId,
          reply,
          request,
        );
      const [item] = await options.database
        .delete(mealItems)
        .where(
          and(
            eq(mealItems.id, params.data.itemId),
            eq(mealItems.mealLogId, mealLog.id),
          ),
        )
        .returning({ id: mealItems.id });
      if (!item) return mealLogNotFound(reply, request);
      const items = await findMealItems(options.database, mealLog.id);
      return mealLogResponse(mealLog, items);
    },
  );

  app.delete('/api/meal-logs/:mealLogId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request);
    const existing = await findOwnedMealLog(
      options.database,
      params.data.mealLogId,
      userId,
    );
    if (!existing) return mealLogNotFound(reply, request);
    if (existing.status !== 'draft') return invalidMealLogState(reply, request);
    const now = new Date();
    const deleted = await options.database.transaction(async (tx) => {
      const [mealLog] = await tx
        .update(mealLogs)
        .set({
          status: 'deleted',
          deletedAt: now,
          purgeAfter: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(mealLogs.id, existing.id),
            eq(mealLogs.userId, userId),
            eq(mealLogs.status, 'draft'),
          ),
        )
        .returning({ imageAssetId: mealLogs.imageAssetId });
      if (!mealLog) return false;
      if (mealLog.imageAssetId) {
        await tx
          .update(imageAssets)
          .set({ status: 'deletion_pending', deletionRequestedAt: now })
          .where(
            and(
              eq(imageAssets.id, mealLog.imageAssetId),
              eq(imageAssets.userId, userId),
            ),
          );
        await tx
          .insert(assetDeletionJobs)
          .values({
            imageAssetId: mealLog.imageAssetId,
            status: 'pending',
            nextAttemptAt: now,
          })
          .onConflictDoNothing();
      }
      return true;
    });
    if (!deleted) return invalidMealLogState(reply, request);
    return reply.status(204).send();
  });
  app.post('/api/meal-logs/:mealLogId/recognition/retry', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request);
    const existing = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
    if (!existing) return mealLogNotFound(reply, request);
    if (
      existing.status !== 'draft' ||
      existing.recognitionStatus === 'ready' ||
      existing.recognitionStatus === 'manual' ||
      existing.recognitionStatus === 'processing' ||
      (existing.recognitionStatus === 'failed' && !existing.recognitionNextAttemptAt)
    )
      return invalidMealLogState(reply, request);
    if (existing.recognitionStatus === 'failed') {
      const [advanced] = await options.database
        .update(mealLogs)
        .set({ recognitionNextAttemptAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(mealLogs.id, existing.id),
            eq(mealLogs.userId, userId),
            eq(mealLogs.status, 'draft'),
            eq(mealLogs.recognitionStatus, 'failed'),
          ),
        )
        .returning({ id: mealLogs.id });
      if (!advanced) return invalidMealLogState(reply, request);
    }
    const outcome = await options.recognitionCoordinator.recognize(existing.id, userId);
    const mealLog = await findOwnedMealLog(options.database, existing.id, userId);
    if (!mealLog) return mealLogNotFound(reply, request);
    return recognitionResponse(reply, mealLog, await findMealItems(options.database, mealLog.id), outcome);
  });

  app.post('/api/meal-logs/:mealLogId/recognition/manual', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request);
    const now = new Date();
    const changed = await options.database.transaction(async (tx) => {
      const [existing] = await tx
        .select(mealLogSelection)
        .from(mealLogs)
        .where(
          and(
            eq(mealLogs.id, params.data.mealLogId),
            eq(mealLogs.userId, userId),
            eq(mealLogs.status, 'draft'),
          ),
        )
        .limit(1);
      if (!existing) return null;
      if (existing.recognitionStatus === 'manual') return existing;
      if (existing.recognitionStatus === 'ready') return null;
      const [mealLog] = await tx
        .update(mealLogs)
        .set({
          recognitionStatus: 'manual',
          recognitionProvider: null,
          recognitionModel: null,
          recognitionPromptVersion: null,
          recognitionSchemaVersion: null,
          recognitionResult: null,
          recognitionCompletedAt: null,
          recognitionProviderRequestId: null,
          recognitionInputTokens: 0,
          recognitionOutputTokens: 0,
          recognitionLeaseToken: null,
          recognitionLeaseExpiresAt: null,
          recognitionNextAttemptAt: null,
          recognitionLastErrorCode: null,
          updatedAt: now,
        })
        .where(and(
          eq(mealLogs.id, params.data.mealLogId),
          eq(mealLogs.userId, userId),
          eq(mealLogs.status, 'draft'),
          or(
            eq(mealLogs.recognitionStatus, 'pending'),
            eq(mealLogs.recognitionStatus, 'processing'),
            eq(mealLogs.recognitionStatus, 'failed'),
          ),
        ))
        .returning(mealLogSelection);
      if (!mealLog) return null;
      if (mealLog.imageAssetId) {
        await tx.update(imageAssets).set({
          status: 'processed',
          processingCompletedAt: now,
        }).where(and(
          eq(imageAssets.id, mealLog.imageAssetId),
          eq(imageAssets.status, 'processing'),
        ));
      }
      return mealLog;
    });
    if (!changed)
      return mealLogStateOrNotFound(
        options.database,
        params.data.mealLogId,
        userId,
        reply,
        request,
      );
    return mealLogResponse(changed, await findMealItems(options.database, changed.id));
  });
};
function recognitionResponse(
  reply: FastifyReply,
  mealLog: NonNullable<Awaited<ReturnType<typeof findOwnedMealLog>>>,
  items: Awaited<ReturnType<typeof findMealItems>>,
  outcome: { status: 'ready' | 'active' | 'unavailable'; retryAfterSeconds?: number; code?: string; retryable?: boolean },
  createdStatus?: number,
) {
  const recognitionOutcome = {
    status: outcome.status,
    ...(outcome.status === 'active'
      ? { retryAfterSeconds: outcome.retryAfterSeconds ?? 1 }
      : outcome.status === 'unavailable'
        ? { code: outcome.code ?? 'RECOGNITION_UNAVAILABLE', retryable: outcome.retryable ?? false }
        : {}),
  };
  if (outcome.status === 'active') {
    reply.header('Retry-After', String(outcome.retryAfterSeconds ?? 1));
    return reply.status(202).send({ ...mealLogResponse(mealLog, items), recognitionOutcome });
  }
  return reply.status(createdStatus ?? 200).send({ ...mealLogResponse(mealLog, items), recognitionOutcome });
}

const mealLogSelection = {
  id: mealLogs.id,
  eatenAt: mealLogs.eatenAt,
  timezone: mealLogs.eatenTimezone,
  localDate: mealLogs.eatenLocalDate,
  mealType: mealLogs.mealType,
  status: mealLogs.status,
  imageAssetId: mealLogs.imageAssetId,
  recognitionStatus: mealLogs.recognitionStatus,
  recognitionProvider: mealLogs.recognitionProvider,
  recognitionModel: mealLogs.recognitionModel,
  recognitionPromptVersion: mealLogs.recognitionPromptVersion,
  recognitionSchemaVersion: mealLogs.recognitionSchemaVersion,
  recognitionCompletedAt: mealLogs.recognitionCompletedAt,
  recognitionLastErrorCode: mealLogs.recognitionLastErrorCode,
  recognitionAttemptCount: mealLogs.recognitionAttemptCount,
  recognitionNextAttemptAt: mealLogs.recognitionNextAttemptAt,
};
const mealItemSelection = {
  id: mealItems.id,
  recognizedLabel: mealItems.recognizedLabel,
  amountMilliunits: mealItems.amountMilliunits,
  unit: mealItems.unit,
  recognitionRegionIndex: mealItems.recognitionRegionIndex,
  recognitionConfidenceBps: mealItems.recognitionConfidenceBps,
  portionConfidenceBps: mealItems.portionConfidenceBps,
  userCorrected: mealItems.userCorrected,
  foodId: mealItems.foodId,
  nutrientProfileId: mealItems.nutrientProfileId,
  mappingConfidenceBps: mealItems.mappingConfidenceBps,
};


async function findOwnedMealLog(
  database: Database,
  mealLogId: string,
  userId: string,
) {
  const [mealLog] = await database
    .select(mealLogSelection)
    .from(mealLogs)
    .where(and(eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId)))
    .limit(1);
  return mealLog;
}

async function findOwnedDraftMealLog(
  database: Database,
  mealLogId: string,
  userId: string,
) {
  const [mealLog] = await database
    .select(mealLogSelection)
    .from(mealLogs)
    .where(
      and(
        eq(mealLogs.id, mealLogId),
        eq(mealLogs.userId, userId),
        eq(mealLogs.status, 'draft'),
        or(
          eq(mealLogs.recognitionStatus, 'ready'),
          eq(mealLogs.recognitionStatus, 'manual'),
        ),
      ),
    )
    .limit(1);
  return mealLog;
}

async function findMealItems(database: Database, mealLogId: string) {
  return database
    .select(mealItemSelection)
    .from(mealItems)
    .where(eq(mealItems.mealLogId, mealLogId));
}
async function findOwnedDraftMealLogByImage(
  database: Database,
  imageAssetId: string,
  userId: string,
) {
  const [mealLog] = await database
    .select(mealLogSelection)
    .from(mealLogs)
    .where(
      and(
        eq(mealLogs.imageAssetId, imageAssetId),
        eq(mealLogs.userId, userId),
        eq(mealLogs.status, 'draft'),
      ),
    )
    .limit(1);
  return mealLog;
}

async function mealLogStateOrNotFound(
  database: Database,
  mealLogId: string,
  userId: string,
  reply: FastifyReply,
  request: FastifyRequest,
) {
  const mealLog = await findOwnedMealLog(database, mealLogId, userId);
  return mealLog
    ? invalidMealLogState(reply, request)
    : mealLogNotFound(reply, request);
}

function mealLogResponse<TMeal, TItem>(mealLog: TMeal, items: TItem[]) {
  return { mealLog, items };
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

function isIanaTimezone(value: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

async function requireUserId(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: Auth,
) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (session) return session.user.id;
  reply.status(401).send({
    error: {
      code: 'UNAUTHORIZED',
      message: '로그인이 필요합니다.',
      requestId: request.id,
    },
  });
  return null;
}

function invalidRequest(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(400).send({
    error: {
      code: 'INVALID_REQUEST',
      message: '요청 형식이 올바르지 않습니다.',
      requestId: request.id,
    },
  });
}

function mealLogNotFound(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(404).send({
    error: {
      code: 'MEAL_LOG_NOT_FOUND',
      message: '식사 기록을 찾을 수 없습니다.',
      requestId: request.id,
    },
  });
}

function invalidMealLogState(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(409).send({
    error: {
      code: 'INVALID_MEAL_LOG_STATE',
      message: '현재 식사 기록 상태에서는 요청을 처리할 수 없습니다.',
      requestId: request.id,
    },
  });
}
function foodNotFound(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(404).send({
    error: {
      code: 'FOOD_NOT_FOUND',
      message: '음식을 찾을 수 없습니다.',
      requestId: request.id,
    },
  });
}

function foodNutrientProfileUnavailable(
  reply: FastifyReply,
  request: FastifyRequest,
) {
  return reply.status(409).send({
    error: {
      code: 'FOOD_NUTRIENT_PROFILE_UNAVAILABLE',
      message: '사용 가능한 영양 정보를 찾을 수 없습니다.',
      requestId: request.id,
    },
  });
}

function imageUnavailable(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(409).send({
    error: {
      code: 'IMAGE_ASSET_UNAVAILABLE',
      message: '사용할 수 있는 이미지를 찾을 수 없습니다.',
      requestId: request.id,
    },
  });
}
