import {
  assetDeletionJobs,
  activeCatalogReleasePointers,
  calculationSnapshots,
  calculationPreviews,
  imageAssets,
  mappingDecisions,
  mealDecompositionComponents,
  mealDecompositionRevisions,
  mealItems,
  mealLogs,
  recognitionAttempts,
  recognitionDailyUsages,
  releaseActivations,
  resolutionAttempts,
  storedObservations,
  userProfiles,
  isRecognitionResultV2,
  isRecognitionResultV3,
  type CalculationPreviewIdentity,
  type Database,
} from '@nueat/database';
import {
  calculateMealNutrition,
  deriveCurrentItemReviewCheckpoint,
  deriveMealConfirmability,
  MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
  NutritionCalculationError,
  reviewRequestFingerprint,
  type MealNutritionInput,
} from '@nueat/domain';
import {
  CALCULATION_INPUT_SNAPSHOT_V2,
  parseCalculationInputSnapshot,
  projectCalculationInputSnapshot,
} from '@nueat/database';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';
import type { ApiEnvironment } from '../config/env';
import type { MealRecognitionRunner } from '../services/meal-recognition-coordinator';
import {
  classifyMealConfirmationCutover,
  MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
} from '../services/meal-confirmation-cutover';
import { isInRecognitionCohort } from '../services/recognition-cohort';
import {
  resolveCurrentMealItems,
} from '../services/meal-item-resolution';
import {
  selectTrustedNutrition,
  type TrustedNutritionSelection,
} from '../services/catalog-eligibility-selector';
import { projectMealItemAuthority } from '../services/meal-item-authority';
import { catalogEligibilityAdapter } from '../services/meal-resolution-coordinator';
const MANUAL_REVIEW_FINGERPRINT_VERSION = 'meal-manual-review-authority-v1';
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
const expectedDraftRevisionSchema = z.object({ expectedDraftRevision: z.int().positive() }).strict();
const updateMealLogSchema = z.object({
  expectedDraftRevision: z.int().positive(),
  eatenAt: dateTimeSchema.optional(),
  timezone: timezoneSchema.optional(),
  mealType: mealTypeSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 1);
const createMealItemSchema = z.object({
  expectedDraftRevision: z.int().positive(),
  recognizedLabel: z.string().trim().min(1),
  amountMilliunits: z.int().positive(),
  unit: servingUnitSchema,
}).strict();
const updateMealItemSchema = z.object({
  expectedItemRevision: z.int().positive(),
  recognizedLabel: z.string().trim().min(1).optional(),
  amountMilliunits: z.int().positive().optional(),
  unit: servingUnitSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 1);
const mapFoodSchema = z.object({ foodId: z.uuid(), expectedItemRevision: z.int().positive() }).strict();
const deleteMealItemSchema = z.object({
  expectedDraftRevision: z.int().positive(),
  expectedItemRevision: z.int().positive(),
}).strict();
const confirmMealSchema = z.object({
  expectedDraftRevision: z.int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  items: z.array(z.object({
    itemId: z.uuid(),
    expectedItemRevision: z.int().positive(),
    mappingDecisionId: z.uuid().optional(),
    calculationPreviewId: z.uuid().optional(),
    decompositionRevisionId: z.uuid().optional(),
  }).strict()),
}).strict();
const replaceMealDecompositionSchema = z.object({
  expectedDraftRevision: z.int().positive(),
  expectedItemRevision: z.int().positive(),
  components: z.array(z.object({
    foodId: z.uuid(),
    amountMilliunits: z.int().positive(),
    unit: servingUnitSchema,
  }).strict()).min(1).max(12),
}).strict();
const reviewMealItemSchema = z.object({
  expectedDraftRevision: z.int().positive(),
  expectedItemRevision: z.int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  displayedAuthorityFingerprintVersion: z.enum([
    MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
    MANUAL_REVIEW_FINGERPRINT_VERSION,
  ]),
  displayedAuthorityFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

interface MealLogRouteOptions {
  auth: Auth;
  database: Database;
  recognitionCoordinator: MealRecognitionRunner;
  reviewPolicy: ApiEnvironment['mealRecognition']['reviewPolicy'];
  recoveryEnabled: boolean;
  v2OneCallAdmitted: boolean;
  cohortPercent: number;
  dailyRecognitionQuota: number;
  responseReserveMs: number;

  mealConfirmationCutover: ApiEnvironment['mealConfirmationCutover'];
}
type RecognitionRecoveryPolicy = {
  enabled: boolean;
  dailyQuota: number;
  v2OneCallAdmitted: boolean;
  cohortPercent: number;
};

type ResponseDeadlineOutcome = {
  responseDeadlineAt?: Date;
};

class ResponseBudgetExhaustedError extends Error {
  statusCode = 503;

  constructor() {
    super('Recognition response budget exhausted');
  }
}

function assertResponseBudget(
  responseDeadlineAt: Date | undefined,
  responseReserveMs: number,
) {
  if (
    responseDeadlineAt &&
    responseDeadlineAt.getTime() - Date.now() <= responseReserveMs
  )
    throw new ResponseBudgetExhaustedError();
}

async function withinResponseBudget<T>(
  promise: Promise<T>,
  responseDeadlineAt: Date | undefined,
  responseReserveMs: number,
): Promise<T> {
  if (!responseDeadlineAt) return promise;
  const remainingMs = responseDeadlineAt.getTime() - Date.now() - responseReserveMs;
  if (remainingMs <= 0) throw new ResponseBudgetExhaustedError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ResponseBudgetExhaustedError()),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const mealLogRoutes: FastifyPluginAsync<MealLogRouteOptions> = async (
  app,
  options,
) => {
  const mealLogResponse = (
    database: Database,
    mealLog: any,
    items: any[],
    request?: FastifyRequest,
    reply?: FastifyReply,
  ) => {
    const response = (signal?: AbortSignal) => buildMealLogResponse(database, mealLog, items, options.reviewPolicy, {
      enabled: options.recoveryEnabled,
      dailyQuota: options.dailyRecognitionQuota,
      v2OneCallAdmitted: options.v2OneCallAdmitted,
      cohortPercent: options.cohortPercent,
    }, options.recognitionCoordinator, signal, options.responseReserveMs);
    return request && reply
      ? withRequestAbortSignal(
          request,
          reply,
          response,
          () => options.recognitionCoordinator.responseLost?.(mealLog.id, mealLog.userId),
        )
      : response();
  };
  const recognitionResponse = (
    database: Database,
    reply: FastifyReply,
    mealLog: NonNullable<Awaited<ReturnType<typeof findOwnedMealLog>>>,
    items: Awaited<ReturnType<typeof findMealItems>>,
    outcome: {
      status: 'ready' | 'active' | 'unavailable';
      retryAfterSeconds?: number;
      code?: string;
      retryable?: boolean;
      responseDeadlineAt?: Date;
    },
    createdStatus?: number,
  ) => sendRecognitionResponse(
    database,
    options.reviewPolicy,
    { enabled: options.recoveryEnabled, dailyQuota: options.dailyRecognitionQuota, v2OneCallAdmitted: options.v2OneCallAdmitted, cohortPercent: options.cohortPercent },
    options.recognitionCoordinator,
    options.responseReserveMs,
    reply,
    mealLog,
    items,
    outcome,
    createdStatus,
  );
  const queuedDraftResponse = (mealLog: any, items: any[] = []) =>
    buildMealLogResponse(
      options.database,
      mealLog,
      items,
      options.reviewPolicy,
      {
        enabled: options.recoveryEnabled,
        dailyQuota: options.dailyRecognitionQuota,
        v2OneCallAdmitted: options.v2OneCallAdmitted,
        cohortPercent: options.cohortPercent,
      },
    );
  const enqueueInitialRecognition = async (
    mealLog: { id: string; userId: string },
    request: FastifyRequest,
  ) => {
    try {
      await options.recognitionCoordinator.enqueueInitial?.(
        mealLog.id,
        mealLog.userId,
      );
    } catch {
      request.log.error(
        { code: 'RECOGNITION_QUEUE_ADMISSION_FAILED' },
        'Recognition queue admission failed',
      );
    }
  };
  const staleMealResponse = (
    database: Database,
    reply: FastifyReply,
    request: FastifyRequest,
    code: 'MEAL_DRAFT_STALE' | 'MEAL_ITEM_STALE',
    latest: { mealLog: unknown; items: unknown[] },
  ) => sendStaleMealResponse(
    database,
    options.reviewPolicy,
    { enabled: options.recoveryEnabled, dailyQuota: options.dailyRecognitionQuota, v2OneCallAdmitted: options.v2OneCallAdmitted, cohortPercent: options.cohortPercent },
    options.recognitionCoordinator,
    reply,
    request,
    code,
    latest,
  );
  app.post('/api/meal-logs', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const parsed = createMealLogSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, request);

    const input = parsed.data;
    const now = new Date();
    const eatenAt = new Date(input.eatenAt);
    const profileTimezone = await findUserTimezone(options.database, userId);
    const timezone = profileTimezone ?? input.timezone;
    const eatenLocalDate = localDate(eatenAt, timezone);
    const mealType = profileTimezone
      ? inferMealType(eatenAt, profileTimezone)
      : input.mealType;
    const existing = await findOwnedDraftMealLogByImage(
      options.database,
      input.imageAssetId,
      userId,
    );
    if (existing) {
      await enqueueInitialRecognition(existing, request);
      return reply.status(200).send(await queuedDraftResponse(existing));
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
          eatenTimezone: timezone,
          eatenLocalDate,
          mealType,
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
      await enqueueInitialRecognition(concurrent, request);
      return reply.status(200).send(await queuedDraftResponse(concurrent));
    }
    await enqueueInitialRecognition(mealLog, request);
    return reply.status(201).send(await queuedDraftResponse(mealLog));
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
    if (mealLog.status === 'confirmed') {
      const [snapshot] = await options.database
        .select(calculationSnapshotSelection)
        .from(calculationSnapshots)
        .where(eq(calculationSnapshots.mealLogId, mealLog.id))
        .orderBy(desc(calculationSnapshots.sequence))
        .limit(1);
      const response = snapshot
        ? confirmedMealSnapshotResponse(mealLog, snapshot)
        : null;
      if (!response) {
        return reply.status(500).send({
          error: {
            code: 'CONFIRMED_MEAL_INTEGRITY_ERROR',
            message: '확정된 식사 기록을 안전하게 읽을 수 없습니다.',
            requestId: request.id,
          },
        });
      }
      return response;
    }
    return await mealLogResponse(options.database, mealLog, [], request, reply);
  });

  app.patch('/api/meal-logs/:mealLogId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    if (!applyMealConfirmationCutover(request, reply, options)) return;
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
    const profileTimezone = await findUserTimezone(options.database, userId);
    const timezone =
      profileTimezone ??
      body.data.timezone ??
      existing.timezone;
    const mealType = profileTimezone
      ? inferMealType(eatenAt, profileTimezone)
      : body.data.mealType ?? existing.mealType;
    const [mealLog] = await options.database
      .update(mealLogs)
      .set({
        eatenAt,
        eatenTimezone: timezone,
        eatenLocalDate: localDate(eatenAt, timezone),
        mealType,
        draftRevision: sql`${mealLogs.draftRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mealLogs.id, existing.id),
          eq(mealLogs.userId, userId),
          eq(mealLogs.status, 'draft'),
          eq(mealLogs.draftRevision, body.data.expectedDraftRevision),
        ),
      )
      .returning(mealLogSelection);
    if (!mealLog) {
      return await staleMealResponse(options.database, reply, request, 'MEAL_DRAFT_STALE', {
        mealLog: await findOwnedMealLog(options.database, existing.id, userId),
        items: await findMealItems(options.database, existing.id),
      });
    }
    const items = await findMealItems(options.database, mealLog.id);
    return await mealLogResponse(options.database, mealLog, items, request, reply);
  });

  app.post('/api/meal-logs/:mealLogId/items', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    if (!applyMealConfirmationCutover(request, reply, options)) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    const body = createMealItemSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);
    const created = await options.database.transaction(async (tx) => {
      const [mealLog] = await tx
        .select(mealLogSelection)
        .from(mealLogs)
        .where(
          and(
            eq(mealLogs.id, params.data.mealLogId),
            eq(mealLogs.userId, userId),
          ),
        )
        .for('update')
        .limit(1);
      if (!mealLog) return { kind: 'not_found' as const };
      if (
        mealLog.status !== 'draft' ||
        (mealLog.recognitionStatus !== 'ready' &&
          mealLog.recognitionStatus !== 'manual')
      )
        return { kind: 'invalid_state' as const };
      if (mealLog.draftRevision !== body.data.expectedDraftRevision)
        return { kind: 'stale' as const, mealLog };
      if (
        mealLog.recognitionStatus === 'ready' &&
        (isRecognitionResultV2(mealLog.recognitionResult) ||
          isRecognitionResultV3(mealLog.recognitionResult)) &&
        mealLog.recognitionResult.outcome !== 'recognized'
      )
        return { kind: 'invalid_state' as const };
      const { expectedDraftRevision, ...itemInput } = body.data;
      await tx
        .insert(mealItems)
        .values({
          mealLogId: mealLog.id,
          ...itemInput,
          userCorrected: true,
          origin: mealLog.recognitionStatus === 'manual' ? 'manual_entry' : 'user_added',
          currentResolutionSource: null,
        });
      const [currentMealLog] = await tx
        .update(mealLogs)
        .set({ draftRevision: sql`${mealLogs.draftRevision} + 1`, updatedAt: new Date() })
        .where(eq(mealLogs.id, mealLog.id))
        .returning(mealLogSelection);
      if (!currentMealLog) throw new Error('Draft meal disappeared while adding item');
      const items = await tx
        .select(mealItemSelection)
        .from(mealItems)
        .where(eq(mealItems.mealLogId, mealLog.id))
        .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id))
        .for('update');
      // Root rows are part of the confirmation tuple.  Lock them before looking
      // at immutable resolution artifacts so a concurrent edit cannot pair a
      // new root revision with an old decision or preview.
      await tx
        .select({ id: mealItems.id })
        .from(mealItems)
        .where(eq(mealItems.mealLogId, mealLog.id))
        .for('update');
      return { kind: 'created' as const, mealLog: currentMealLog, items };
    });
    if (created.kind === 'not_found') return mealLogNotFound(reply, request);
    if (created.kind === 'stale') {
      const latest = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
      if (!latest) return mealLogNotFound(reply, request);
      return await staleMealResponse(options.database, reply, request, 'MEAL_DRAFT_STALE', {
        mealLog: latest,
        items: await findMealItems(options.database, latest.id),
      });
    }
    if (created.kind === 'invalid_state')
      return invalidMealLogState(reply, request);
    return reply.status(201).send(await mealLogResponse(options.database, created.mealLog, created.items));
  });

  app.patch(
    '/api/meal-logs/:mealLogId/items/:itemId',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      if (!applyMealConfirmationCutover(request, reply, options)) return;
      const params = mealItemIdParamsSchema.safeParse(request.params);
      const body = updateMealItemSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return invalidRequest(reply, request);
      const updated = await options.database.transaction(async (tx) => {
        const [mealLog] = await tx
          .select(mealLogSelection)
          .from(mealLogs)
          .where(
            and(
              eq(mealLogs.id, params.data.mealLogId),
              eq(mealLogs.userId, userId),
            ),
          )
          .for('update')
          .limit(1);
        if (!mealLog) return { kind: 'not_found' as const };
        if (
          mealLog.status !== 'draft' ||
          (mealLog.recognitionStatus !== 'ready' &&
            mealLog.recognitionStatus !== 'manual')
        )
          return { kind: 'invalid_state' as const };

        const { expectedItemRevision, ...changes } = body.data;
        const [currentItem] = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(and(eq(mealItems.id, params.data.itemId), eq(mealItems.mealLogId, mealLog.id)))
          .limit(1);
        if (!currentItem || currentItem.itemRevision !== body.data.expectedItemRevision)
          return { kind: 'item_not_found' as const };
        const foodChanged =
          body.data.recognizedLabel !== undefined &&
          body.data.recognizedLabel !== currentItem.recognizedLabel;
        const amountChanged =
          body.data.amountMilliunits !== undefined &&
          body.data.amountMilliunits !== currentItem.amountMilliunits;
        const unitChanged =
          body.data.unit !== undefined && body.data.unit !== currentItem.unit;
        const portionChanged = amountChanged || unitChanged;
        if (!foodChanged && !portionChanged) {
          const items = await tx.select(mealItemSelection).from(mealItems)
            .where(eq(mealItems.mealLogId, mealLog.id))
            .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
          return { kind: 'updated' as const, mealLog, items };
        }
        const [item] = await tx
          .update(mealItems)
          .set({
            ...(foodChanged
              ? {
                  recognizedLabel: changes.recognizedLabel,
                  foodId: null,
                  nutrientProfileId: null,
                  mappingConfidenceBps: null,
                  currentResolutionSource: null,
                }
              : {}),
            ...(amountChanged ? { amountMilliunits: changes.amountMilliunits } : {}),
            ...(unitChanged ? { unit: changes.unit } : {}),
            itemRevision: sql`${mealItems.itemRevision} + 1`,
            reviewedItemRevision: null,
            reviewedAuthorityFingerprintVersion: null,
            reviewedAuthorityFingerprint: null,
            reviewIdempotencyKey: null,
            reviewRequestFingerprint: null,
            reviewedAt: null,
            ...(foodChanged
              ? { foodRevision: sql`${mealItems.foodRevision} + 1` }
              : {}),
            ...(portionChanged
              ? {
                  portionRevision: sql`${mealItems.portionRevision} + 1`,
                }
              : {}),
            userCorrected: true,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mealItems.id, params.data.itemId),
              eq(mealItems.mealLogId, mealLog.id),
              eq(mealItems.itemRevision, expectedItemRevision),
            ),
          )
          .returning(mealItemSelection);
        if (!item) return { kind: 'item_not_found' as const };
        const [currentMealLog] = await tx
          .update(mealLogs)
          .set({ draftRevision: sql`${mealLogs.draftRevision} + 1`, updatedAt: new Date() })
          .where(eq(mealLogs.id, mealLog.id))
          .returning(mealLogSelection);
        if (!currentMealLog) throw new Error('Draft meal disappeared while updating item');
        const items = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(eq(mealItems.mealLogId, mealLog.id))
          .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
        return { kind: 'updated' as const, mealLog: currentMealLog, items };
      });
      if (updated.kind === 'not_found') return mealLogNotFound(reply, request);
      if (updated.kind === 'item_not_found') {
        const latest = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
        if (!latest) return mealLogNotFound(reply, request);
        return await staleMealResponse(options.database, reply, request, 'MEAL_ITEM_STALE', {
          mealLog: latest,
          items: await findMealItems(options.database, latest.id),
        });
      }
      if (updated.kind === 'invalid_state')
        return invalidMealLogState(reply, request);
      return await mealLogResponse(options.database, updated.mealLog, updated.items);
    },
  );
  app.put(
    '/api/meal-logs/:mealLogId/items/:itemId/food',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      if (!applyMealConfirmationCutover(request, reply, options)) return;
      const params = mealItemIdParamsSchema.safeParse(request.params);
      const body = mapFoodSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return invalidRequest(reply, request);
      const mapped = await options.database.transaction(async (tx) => {
        const [mealLog] = await tx
          .select(mealLogSelection)
          .from(mealLogs)
          .where(and(eq(mealLogs.id, params.data.mealLogId), eq(mealLogs.userId, userId)))
          .for('update')
          .limit(1);
        if (!mealLog) return { kind: 'not_found' as const };
        if (
          mealLog.status !== 'draft' ||
          (mealLog.recognitionStatus !== 'ready' &&
            mealLog.recognitionStatus !== 'manual')
        )
          return { kind: 'invalid_state' as const };
        const [currentItem] = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(and(eq(mealItems.id, params.data.itemId), eq(mealItems.mealLogId, mealLog.id)))
          .limit(1);
        if (!currentItem || currentItem.itemRevision !== body.data.expectedItemRevision)
          return { kind: 'item_not_found' as const };
        let [storedObservation] = await tx
          .select({
            id: storedObservations.id,
            canonicalContent: storedObservations.canonicalContent,
          })
          .from(storedObservations)
          .where(eq(storedObservations.mealLogId, mealLog.id))
          .for('update')
          .limit(1);
        if (!storedObservation) {
          if (!mealLog.imageAssetId)
            return {
              kind: 'profile_unavailable' as const,
              reason: 'IMAGE_ASSET_REQUIRED_FOR_MANUAL_AUTHORITY',
            };
          let [attempt] = await tx
            .select({
              id: recognitionAttempts.id,
              provider: recognitionAttempts.provider,
              model: recognitionAttempts.model,
              promptVersion: recognitionAttempts.promptVersion,
              schemaVersion: recognitionAttempts.schemaVersion,
            })
            .from(recognitionAttempts)
            .where(eq(recognitionAttempts.mealLogId, mealLog.id))
            .for('update')
            .limit(1);
          if (!attempt) {
            [attempt] = await tx
              .insert(recognitionAttempts)
              .values({
                mealLogId: mealLog.id,
                imageAssetId: mealLog.imageAssetId,
                status: 'ready',
                provider: 'manual',
                model: 'manual-entry-authority-v1',
                promptVersion: 'manual-entry-authority-v1',
                schemaVersion: 'manual-entry-authority-v1',
                inputTokens: 0,
                outputTokens: 0,
                attemptCount: 0,
                nextAttemptAt: new Date(),
                completedAt: new Date(),
              })
              .returning({
                id: recognitionAttempts.id,
                provider: recognitionAttempts.provider,
                model: recognitionAttempts.model,
                promptVersion: recognitionAttempts.promptVersion,
                schemaVersion: recognitionAttempts.schemaVersion,
              });
          }
          if (!attempt)
            throw new Error('Manual observation attempt was not created');
          const canonicalContent = {
            version: 3,
            authority: 'manual_entry',
            observations: [],
          } as const;
          [storedObservation] = await tx
            .insert(storedObservations)
            .values({
              mealLogId: mealLog.id,
              recognitionAttemptId: attempt.id,
              provider: attempt.provider ?? 'manual',
              model: attempt.model ?? 'manual-entry-authority-v1',
              promptVersion:
                attempt.promptVersion ?? 'manual-entry-authority-v1',
              schemaVersion:
                attempt.schemaVersion ?? 'manual-entry-authority-v1',
              inputTokens: 0,
              outputTokens: 0,
              canonicalContent,
              contentSha256: hash(JSON.stringify(canonicalContent)),
            })
            .returning({
              id: storedObservations.id,
              canonicalContent: storedObservations.canonicalContent,
            });
        }
        if (!storedObservation)
          throw new Error('Manual observation was not created');
        const localObservationId =
          currentItem.origin === 'model_estimate' &&
          currentItem.recognitionRegionIndex !== null
            ? observationLocalId(
                storedObservation.canonicalContent,
                currentItem.recognitionRegionIndex,
              )
            : `manual:${currentItem.id}`;
        if (!localObservationId)
          return {
            kind: 'profile_unavailable' as const,
            reason: 'OBSERVATION_ID_UNAVAILABLE',
          };
        const [predecessor] =
          await tx
                .select({
                  id: mappingDecisions.id,
                  candidates: mappingDecisions.candidates,
                  selectedFoodId: mappingDecisions.selectedFoodId,
                })
                .from(mappingDecisions)
                .where(
                  and(
                    eq(
                      mappingDecisions.storedObservationId,
                      storedObservation.id,
                    ),
                    eq(
                      mappingDecisions.localObservationId,
                      localObservationId,
                    ),
                  ),
                )
                .orderBy(desc(mappingDecisions.createdAt), desc(mappingDecisions.id))
                .for('update')
                .limit(1);
        const [active] =
          await tx
                .select({
                  activationId: activeCatalogReleasePointers.activationId,
                  catalogReleaseId: releaseActivations.catalogReleaseId,
                  policyVersion: releaseActivations.policyVersion,
                  policySha256: releaseActivations.policySha256,
                })
                .from(activeCatalogReleasePointers)
                .innerJoin(
                  releaseActivations,
                  eq(
                    activeCatalogReleasePointers.activationId,
                    releaseActivations.id,
                  ),
                )
                .for('update')
                .limit(1);
        if (!active)
          return {
            kind: 'profile_unavailable' as const,
            reason: 'ACTIVE_CATALOG_RELEASE_UNAVAILABLE',
          };
        const trustedSelection =
          await selectTrustedNutrition(
                catalogEligibilityAdapter(tx as unknown as Database),
                {
                  catalogReleaseId: active.catalogReleaseId,
                  foodId: body.data.foodId,
                  unit: currentItem.unit,
                },
              );
        if (trustedSelection.kind === 'unavailable')
          return {
            kind: 'profile_unavailable' as const,
            reason: trustedSelection.reason,
          };
        const selectedFood = trustedSelection.food;
        const selectedProfileId = trustedSelection.profile.id;
        if (
          currentItem.foodId === selectedFood.id &&
          currentItem.nutrientProfileId === selectedProfileId &&
          predecessor?.selectedFoodId === selectedFood.id
        ) {
          const items = await tx.select(mealItemSelection).from(mealItems)
            .where(eq(mealItems.mealLogId, mealLog.id))
            .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
          return { kind: 'mapped' as const, mealLog, items };
        }

        const nextItemRevision = currentItem.itemRevision + 1;
        {
          const resolverVersion = 'user-selected-mapping-v1';
          const edibleAmountMg =
            currentItem.unit === 'g'
              ? currentItem.amountMilliunits
              : servingAmountToGrams(
                  currentItem.amountMilliunits,
                  trustedSelection.serving?.amountMilliunits,
                  trustedSelection.serving?.gramsMg,
                );
          if (edibleAmountMg === null)
            return {
              kind: 'profile_unavailable' as const,
              reason: 'MISSING_SERVING_CONVERSION',
            };
          const [decision] = await tx
            .insert(mappingDecisions)
            .values({
              storedObservationId: storedObservation.id,
              localObservationId,
              catalogReleaseId: active.catalogReleaseId,
              releaseActivationId: active.activationId,
              resolverVersion,
              resolverSha256: hash(resolverVersion),
              policyVersion: active.policyVersion,
              policySha256: active.policySha256,
              candidates: predecessor?.candidates ?? [],
              selectedFoodId: trustedSelection.food.id,
              status: 'selected',
              method: 'user_selected',
              reasonCode: 'USER_SELECTED',
              evidence: {
                predecessorDecisionId: predecessor?.id ?? null,
                explicitUserSelection: true,
              },
              predecessorId: predecessor?.id ?? null,
            })
            .returning({ id: mappingDecisions.id });
          if (!decision)
            throw new Error('User selection decision insert did not return a row');
          const identity: CalculationPreviewIdentity = {
            basis: 'finished_profile',
            rootMappingDecisionId: decision.id,
            rootRevision: nextItemRevision,
            catalogReleaseId: active.catalogReleaseId,
            releaseActivationId: active.activationId,
            leaves: [
              previewLeaf(
                decision.id,
                0,
                edibleAmountMg,
                currentItem.unit,
                trustedSelection,
              ),
            ],
          };
          await tx.insert(calculationPreviews).values({
            mealLogId: mealLog.id,
            rootMappingDecisionId: decision.id,
            rootRevision: nextItemRevision,
            catalogReleaseId: active.catalogReleaseId,
            releaseActivationId: active.activationId,
            discriminant: 'finished_profile',
            identity,
            contentSha256: hash(JSON.stringify(identity)),
          });
        }

        const [item] = await tx
          .update(mealItems)
          .set({
            recognizedLabel: selectedFood.canonicalNameKo,
            foodId: selectedFood.id,
            nutrientProfileId: selectedProfileId,
            mappingConfidenceBps: 10_000,
            currentResolutionSource: 'user_selected',
            itemRevision: sql`${mealItems.itemRevision} + 1`,
            reviewedItemRevision: null,
            reviewedAuthorityFingerprintVersion: null,
            reviewedAuthorityFingerprint: null,
            reviewIdempotencyKey: null,
            reviewRequestFingerprint: null,
            reviewedAt: null,
            foodRevision: sql`${mealItems.foodRevision} + 1`,
            userCorrected: true,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mealItems.id, params.data.itemId),
              eq(mealItems.mealLogId, mealLog.id),
              eq(mealItems.itemRevision, body.data.expectedItemRevision),
            ),
          )
          .returning(mealItemSelection);
        if (!item) return { kind: 'item_not_found' as const };
        const [currentMealLog] = await tx
          .update(mealLogs)
          .set({ draftRevision: sql`${mealLogs.draftRevision} + 1`, updatedAt: new Date() })
          .where(eq(mealLogs.id, mealLog.id))
          .returning(mealLogSelection);
        if (!currentMealLog) throw new Error('Draft meal disappeared while mapping food');
        const items = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(eq(mealItems.mealLogId, mealLog.id))
          .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
        return { kind: 'mapped' as const, mealLog: currentMealLog, items };
      });
      if (mapped.kind === 'not_found') return mealLogNotFound(reply, request);
      if (mapped.kind === 'item_not_found') {
        const latest = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
        if (!latest) return mealLogNotFound(reply, request);
        return await staleMealResponse(options.database, reply, request, 'MEAL_ITEM_STALE', {
          mealLog: latest,
          items: await findMealItems(options.database, latest.id),
        });
      }
      if (mapped.kind === 'invalid_state')
        return invalidMealLogState(reply, request);
      if (mapped.kind === 'profile_unavailable')
        return foodNutrientProfileUnavailable(reply, request, mapped.reason);
      return await mealLogResponse(options.database, mapped.mealLog, mapped.items);
    },
  );
  app.post('/api/meal-logs/:mealLogId/items/:itemId/review', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    if (!applyMealConfirmationCutover(request, reply, options)) return;
    const params = mealItemIdParamsSchema.safeParse(request.params);
    const body = reviewMealItemSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);
    const result = await options.database.transaction(async (tx) => {
      const [mealLog] = await tx.select(mealLogSelection).from(mealLogs).where(and(
        eq(mealLogs.id, params.data.mealLogId), eq(mealLogs.userId, userId),
      )).for('update').limit(1);
      if (!mealLog) return { kind: 'not_found' as const };
      const [item] = await tx.select(mealItemSelection).from(mealItems).where(and(
        eq(mealItems.id, params.data.itemId), eq(mealItems.mealLogId, mealLog.id),
      )).for('update').limit(1);
      if (!item || mealLog.status !== 'draft') return { kind: 'stale' as const };
      const requestFingerprint = reviewRequestFingerprint({
        mealId: mealLog.id, itemId: item.id, idempotencyKey: body.data.idempotencyKey,
        expectedDraftRevision: body.data.expectedDraftRevision,
        expectedItemRevision: body.data.expectedItemRevision,
        displayedAuthorityFingerprintVersion: body.data.displayedAuthorityFingerprintVersion,
        displayedAuthorityFingerprint: body.data.displayedAuthorityFingerprint,
      });
      if (item.reviewIdempotencyKey === body.data.idempotencyKey) {
        if (item.reviewRequestFingerprint !== requestFingerprint)
          return { kind: 'key_reused' as const };
        return { kind: 'replayed' as const, mealLog, item };
      }
      if (
        mealLog.draftRevision !== body.data.expectedDraftRevision ||
        item.itemRevision !== body.data.expectedItemRevision
      ) return { kind: 'stale' as const };
      const authority = await projectCurrentItemAuthority(tx as unknown as Database, item);
      if (
        !authority.fingerprint ||
        authority.fingerprintVersion !== body.data.displayedAuthorityFingerprintVersion ||
        authority.fingerprint !== body.data.displayedAuthorityFingerprint
      ) return { kind: 'authority_stale' as const };
      const now = new Date();
      const [reviewed] = await tx.update(mealItems).set({
        reviewedItemRevision: item.itemRevision,
        reviewedAuthorityFingerprintVersion: authority.fingerprintVersion,
        reviewedAuthorityFingerprint: authority.fingerprint,
        reviewIdempotencyKey: body.data.idempotencyKey,
        reviewRequestFingerprint: requestFingerprint,
        reviewedAt: now,
        updatedAt: now,
      }).where(eq(mealItems.id, item.id)).returning(mealItemSelection);
      const [updatedMealLog] = await tx.update(mealLogs).set({
        draftRevision: sql`${mealLogs.draftRevision} + 1`, updatedAt: now,
      }).where(eq(mealLogs.id, mealLog.id)).returning(mealLogSelection);
      if (!reviewed || !updatedMealLog) throw new Error('Meal disappeared while reviewing');
      return { kind: 'reviewed' as const, mealLog: updatedMealLog, item: reviewed };
    }, { isolationLevel: 'serializable' });
    if (result.kind === 'not_found') return mealLogNotFound(reply, request);
    if (result.kind === 'key_reused') return reply.status(409).send({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: '동일한 검토 키에 다른 요청을 사용할 수 없습니다.', requestId: request.id } });
    if (result.kind === 'stale' || result.kind === 'authority_stale')
      return reply.status(409).send({ error: { code: result.kind === 'authority_stale' ? 'MEAL_ITEM_AUTHORITY_STALE' : 'MEAL_ITEM_STALE', message: '식사 항목이 변경되었습니다.', requestId: request.id } });
    const current = result.kind === 'replayed' ? result.mealLog : result.mealLog;
    return await mealLogResponse(options.database, current, await findMealItems(options.database, current.id));
  });
  app.put('/api/meal-logs/:mealLogId/items/:itemId/decomposition', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    if (!applyMealConfirmationCutover(request, reply, options)) return;
    const params = mealItemIdParamsSchema.safeParse(request.params);
    const body = replaceMealDecompositionSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);

    const result = await options.database.transaction(async (tx) => {
      const [mealLog] = await tx.select(mealLogSelection).from(mealLogs).where(and(
        eq(mealLogs.id, params.data.mealLogId),
        eq(mealLogs.userId, userId),
        eq(mealLogs.status, 'draft'),
      )).for('update').limit(1);
      if (!mealLog) return { kind: 'not_found' as const };
      const [root] = await tx.select(mealItemSelection).from(mealItems).where(and(
        eq(mealItems.id, params.data.itemId),
        eq(mealItems.mealLogId, mealLog.id),
      )).for('update').limit(1);
      if (!root || root.itemRevision !== body.data.expectedItemRevision ||
        mealLog.draftRevision !== body.data.expectedDraftRevision)
        return { kind: 'stale' as const };
      if (mealLog.recognitionStatus !== 'ready' && mealLog.recognitionStatus !== 'manual')
        return { kind: 'invalid_state' as const };

      const [observation] = await tx.select({ id: storedObservations.id, canonicalContent: storedObservations.canonicalContent })
        .from(storedObservations).where(eq(storedObservations.mealLogId, mealLog.id)).for('update').limit(1);
      const localObservationId = root.recognitionRegionIndex === null
        ? null
        : observationLocalId(observation?.canonicalContent, root.recognitionRegionIndex);
      if (!observation || !localObservationId) return { kind: 'stale' as const };
      const [active] = await tx.select({
        activationId: activeCatalogReleasePointers.activationId,
        catalogReleaseId: releaseActivations.catalogReleaseId,
        policyVersion: releaseActivations.policyVersion,
        policySha256: releaseActivations.policySha256,
      }).from(activeCatalogReleasePointers)
        .innerJoin(releaseActivations, eq(activeCatalogReleasePointers.activationId, releaseActivations.id))
        .for('update').limit(1);
      if (!active) return { kind: 'stale' as const };
      const [rootDecision] = await tx.select({
        id: mappingDecisions.id,
        selectedFoodId: mappingDecisions.selectedFoodId,
        status: mappingDecisions.status,
        catalogReleaseId: mappingDecisions.catalogReleaseId,
        releaseActivationId: mappingDecisions.releaseActivationId,
      }).from(mappingDecisions).where(and(
        eq(mappingDecisions.storedObservationId, observation.id),
        eq(mappingDecisions.localObservationId, localObservationId),
      )).orderBy(desc(mappingDecisions.createdAt), desc(mappingDecisions.id)).for('update').limit(1);
      if (!rootDecision || rootDecision.status !== 'selected' || !rootDecision.selectedFoodId ||
        rootDecision.catalogReleaseId !== active.catalogReleaseId ||
        rootDecision.releaseActivationId !== active.activationId)
        return { kind: 'stale' as const };

      const adapter = catalogEligibilityAdapter(tx as unknown as Database);
      const selections: TrustedNutritionSelection[] = [];
      const edibleAmountsMg: number[] = [];
      for (const component of body.data.components) {
        const selection = await selectTrustedNutrition(adapter, {
          catalogReleaseId: active.catalogReleaseId,
          foodId: component.foodId,
          unit: component.unit,
        });
        if (selection.kind !== 'selected') return { kind: 'stale' as const };
        selections.push(selection);
        const edibleAmountMg = component.unit === 'g'
          ? component.amountMilliunits
          : servingAmountToGrams(component.amountMilliunits, selection.serving?.amountMilliunits, selection.serving?.gramsMg);
        if (edibleAmountMg === null) return { kind: 'stale' as const };
        edibleAmountsMg.push(edibleAmountMg);
      }
      const nextRootRevision = root.itemRevision + 1;
      const componentDecisions = await tx.insert(mappingDecisions).values(
        body.data.components.map((component, ordinal) => ({
          storedObservationId: observation.id,
          localObservationId: `decomposition:${root.id}:${nextRootRevision}:${ordinal}:${randomUUID()}`,
          catalogReleaseId: active.catalogReleaseId,
          releaseActivationId: active.activationId,
          resolverVersion: 'user-selected-composition-v1',
          resolverSha256: hash('user-selected-composition-v1'),
          policyVersion: active.policyVersion,
          policySha256: active.policySha256,
          candidates: [],
          selectedFoodId: component.foodId,
          status: 'selected' as const,
          method: 'user_selected' as const,
          reasonCode: 'USER_SELECTED_COMPOSITION',
          evidence: { rootItemId: root.id, ordinal, unit: component.unit, amountMilliunits: component.amountMilliunits, edibleAmountMg: edibleAmountsMg[ordinal] },
        })),
      ).returning({ id: mappingDecisions.id });
      const componentPreviews = await Promise.all(componentDecisions.map(async (decision, ordinal) => {
        const component = body.data.components[ordinal]!;
        const selection = selections[ordinal]!;
        const identity: CalculationPreviewIdentity = {
          basis: 'finished_profile',
          rootMappingDecisionId: decision.id,
          rootRevision: 1,
          catalogReleaseId: active.catalogReleaseId,
          releaseActivationId: active.activationId,
          leaves: [previewLeaf(
            decision.id,
            0,
            edibleAmountsMg[ordinal]!,
            component.unit,
            selection,
          )],
        };
        const [preview] = await tx.insert(calculationPreviews).values({
          mealLogId: mealLog.id, rootMappingDecisionId: decision.id, rootRevision: 1,
          catalogReleaseId: active.catalogReleaseId, releaseActivationId: active.activationId,
          discriminant: 'finished_profile', identity, contentSha256: hash(JSON.stringify(identity)),
        }).returning({ id: calculationPreviews.id });
        if (!preview) throw new Error('Component preview insert did not return a row');
        return preview;
      }));
      const decompositionId = randomUUID();
      const rootIdentity: CalculationPreviewIdentity = {
        basis: 'meal_decomposition',
        rootMappingDecisionId: rootDecision.id,
        rootRevision: nextRootRevision,
        catalogReleaseId: active.catalogReleaseId,
        releaseActivationId: active.activationId,
        decompositionRevisionId: decompositionId,
        leaves: body.data.components.map((component, ordinal) =>
          previewLeaf(
            componentDecisions[ordinal]!.id,
            ordinal,
            edibleAmountsMg[ordinal]!,
            component.unit,
            selections[ordinal]!,
          )),
      };
      const [rootPreview] = await tx.insert(calculationPreviews).values({
        mealLogId: mealLog.id, rootMappingDecisionId: rootDecision.id, rootRevision: nextRootRevision,
        catalogReleaseId: active.catalogReleaseId, releaseActivationId: active.activationId,
        discriminant: 'meal-composition', identity: rootIdentity, contentSha256: hash(JSON.stringify(rootIdentity)),
      }).returning({ id: calculationPreviews.id });
      if (!rootPreview) throw new Error('Root decomposition preview insert did not return a row');
      const priorRevisions = await tx.select({ revision: mealDecompositionRevisions.revision })
        .from(mealDecompositionRevisions).where(eq(mealDecompositionRevisions.mealLogId, mealLog.id))
        .orderBy(desc(mealDecompositionRevisions.revision)).for('update').limit(1);
      const revision = priorRevisions[0]?.revision ?? 0;
      const [decomposition] = await tx.insert(mealDecompositionRevisions).values({
        id: decompositionId, mealLogId: mealLog.id, revision: revision + 1,
        rootMappingDecisionId: rootDecision.id, rootCalculationPreviewId: rootPreview.id,
      }).returning({ id: mealDecompositionRevisions.id });
      if (!decomposition) throw new Error('Decomposition insert did not return a row');
      await tx.insert(mealDecompositionComponents).values(body.data.components.map((component, ordinal) => ({
        mealDecompositionRevisionId: decomposition.id, ordinal, mappingDecisionId: componentDecisions[ordinal]!.id,
        calculationPreviewId: componentPreviews[ordinal]!.id, edibleAmountMg: edibleAmountsMg[ordinal]!,
      })));
      const [updatedRoot] = await tx.update(mealItems).set({
        itemRevision: nextRootRevision,
        reviewedItemRevision: null,
        reviewedAuthorityFingerprintVersion: null,
        reviewedAuthorityFingerprint: null,
        reviewIdempotencyKey: null,
        reviewRequestFingerprint: null,
        reviewedAt: null,
        portionRevision: sql`${mealItems.portionRevision} + 1`,
        userCorrected: true,
        updatedAt: new Date(),
      }).where(eq(mealItems.id, root.id)).returning(mealItemSelection);
      const [updatedMealLog] = await tx.update(mealLogs).set({
        draftRevision: sql`${mealLogs.draftRevision} + 1`, updatedAt: new Date(),
      }).where(eq(mealLogs.id, mealLog.id)).returning(mealLogSelection);
      if (!updatedRoot || !updatedMealLog) throw new Error('Meal disappeared while replacing decomposition');
      const items = await tx.select(mealItemSelection).from(mealItems).where(eq(mealItems.mealLogId, mealLog.id))
        .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
      return { kind: 'updated' as const, mealLog: updatedMealLog, items };
    }, { isolationLevel: 'serializable' });
    if (result.kind === 'not_found') return mealLogNotFound(reply, request);
    if (result.kind === 'stale') return staleMealConfirmation(reply, request);
    if (result.kind === 'invalid_state') return invalidMealLogState(reply, request);
    return await mealLogResponse(options.database, result.mealLog, result.items);
  });

  app.post('/api/meal-logs/:mealLogId/confirm', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    if (!applyMealConfirmationCutover(request, reply, options)) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    const body = confirmMealSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);

    const confirmed = await options.database.transaction(async (tx) => {
      const [mealLog] = await tx
        .select(mealLogSelection)
        .from(mealLogs)
        .where(
          and(
            eq(mealLogs.id, params.data.mealLogId),
            eq(mealLogs.userId, userId),
            or(eq(mealLogs.status, 'draft'), eq(mealLogs.status, 'confirmed')),
          ),
        )
        .for('update')
        .limit(1);
      if (!mealLog) return { kind: 'not_found' as const };

      const items = await tx
        .select(mealItemSelection)
        .from(mealItems)
        .where(eq(mealItems.mealLogId, mealLog.id))
        .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id))
        .for('update');
      const [snapshot] = await tx
        .select(calculationSnapshotSelection)
        .from(calculationSnapshots)
        .where(eq(calculationSnapshots.mealLogId, mealLog.id))
        .orderBy(desc(calculationSnapshots.sequence))
        .limit(1);
      const fingerprint = confirmationFingerprint(body.data);
      if (mealLog.status === 'confirmed') {
        const [idempotentSnapshot] = await tx
          .select(calculationSnapshotSelection)
          .from(calculationSnapshots)
          .where(and(
            eq(calculationSnapshots.mealLogId, mealLog.id),
            eq(calculationSnapshots.confirmationIdempotencyKey, body.data.idempotencyKey),
          ))
          .limit(1);
        if (idempotentSnapshot) {
          return idempotentSnapshot.confirmationFingerprint === fingerprint
            ? { kind: 'confirmed' as const, mealLog, items, snapshot: idempotentSnapshot }
            : { kind: 'idempotency_reused' as const };
        }
        return { kind: 'idempotency_reused' as const };
      }

      if (mealLog.status === 'draft' && mealLog.draftRevision !== body.data.expectedDraftRevision)
        return { kind: 'stale' as const, mealLog, items };
      const expectedItems = new Map(body.data.items.map((item) => [item.itemId, item.expectedItemRevision]));
      if (
        expectedItems.size !== items.length ||
        items.some((item) => expectedItems.get(item.id) !== item.itemRevision)
      ) return { kind: 'stale' as const, mealLog, items };
      if (
        mealLog.recognitionStatus !== 'ready' &&
        mealLog.recognitionStatus !== 'manual'
      )
        return { kind: 'invalid_state' as const };
      if (items.length === 0)
        return {
          kind: 'invalid' as const,
          details: [{ code: 'EMPTY_MEAL' }],
        };
      const authorities = await Promise.all(
        items.map((item) => projectCurrentItemAuthority(tx as unknown as Database, item)),
      );
      if (authorities.some((authority, index) => {
        const item = items[index]!;
        return !authority.fingerprint ||
          item.reviewedItemRevision !== item.itemRevision ||
          item.reviewedAuthorityFingerprintVersion !== authority.fingerprintVersion ||
          item.reviewedAuthorityFingerprint !== authority.fingerprint;
      })) {
        return {
          kind: 'invalid' as const,
          details: [{ code: 'MEAL_ITEM_REVIEW_REQUIRED' }],
        };
      }
      const resolutionTuple = await revalidateConfirmationResolutionTuples(
        tx as unknown as Database,
        mealLog.id,
        items,
        body.data.items,
      );
      if (resolutionTuple.stale)
        return { kind: 'stale' as const, mealLog, items };
      if (resolutionTuple.details.length > 0)
        return { kind: 'stale' as const, mealLog, items };
      const authoritativeReview = await mealLogResponse(tx as unknown as Database, mealLog, items);
      if (!authoritativeReview.review.confirmable)
        return {
          kind: 'invalid' as const,
          details: authoritativeReview.review.reasons,
        };

      const resolvedNutrition = await calculateResolvedMealNutrition(
        tx,
        items,
        undefined,
        resolutionTuple.previewsByItemId,
      );
      if ('details' in resolvedNutrition) return { kind: 'invalid' as const, details: resolvedNutrition.details };
      const { nutrition, resolutionsByItemId } = resolvedNutrition;

      const now = new Date();
      const calculatedByItemId = new Map(
        nutrition.items.map((item) => [item.mealItemId, item]),
      );
      for (const item of items) {
        await tx
          .update(mealItems)
          .set({
            gramsMg: calculatedByItemId.get(item.id)?.gramsMg ?? null,
            updatedAt: now,
          })
          .where(eq(mealItems.id, item.id));
      }

      const [createdSnapshot] = await tx
        .insert(calculationSnapshots)
        .values({
          mealLogId: mealLog.id,
          sequence: snapshot ? snapshot.sequence + 1 : 1,
          inputSnapshot: {
            version: CALCULATION_INPUT_SNAPSHOT_V2,
            confirmationDecision: {
              originalRecognition: (isRecognitionResultV2(mealLog.recognitionResult) || isRecognitionResultV3(mealLog.recognitionResult)) && mealLog.recognitionProvider && mealLog.recognitionModel && mealLog.recognitionPromptVersion && mealLog.recognitionSchemaVersion && mealLog.recognitionCompletedAt
                ? {
                    provider: mealLog.recognitionProvider,
                    model: mealLog.recognitionModel,
                    promptVersion: mealLog.recognitionPromptVersion,
                    schemaVersion: mealLog.recognitionSchemaVersion,
                    outcome: mealLog.recognitionResult.outcome,
                    ...(mealLog.recognitionResult.outcome === 'insufficient_evidence'
                      ? { evidenceReason: mealLog.recognitionResult.evidenceReason }
                      : {}),
                    completedAt: mealLog.recognitionCompletedAt.toISOString(),
                  }
                : null,
              manualOverride: mealLog.recognitionManualOverride
                ? {
                    fromStatus: mealLog.recognitionManualOverride.fromStatus,
                    fromOutcome: mealLog.recognitionManualOverride.fromOutcome,
                    decision: mealLog.recognitionManualOverride.decision,
                    decidedAt: mealLog.recognitionManualOverride.decidedAt,
                    decisionVersion:
                      mealLog.recognitionManualOverride.decisionVersion,
                  }
                : null,
              reviewProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
            },
            mealItems: items.map((item) => {
              const authority = authorities.find(
                (candidate) => candidate.itemId === item.id,
              );
              if (!authority?.fingerprint)
                throw new Error('Confirmed item is missing review authority');
              const calculated = calculatedByItemId.get(item.id)!;
              if (item.foodId === null) {
                return {
                  mealItemId: item.id,
                  origin: item.origin,
                  initialEstimateAssessment: item.initialEstimateAssessment,
                  currentResolutionSource: null,
                  itemRevision: item.itemRevision,
                  foodRevision: item.foodRevision,
                  portionRevision: item.portionRevision,
                  foodId: null,
                  nutrientProfileId: null,
                  amountMilliunits: item.amountMilliunits,
                  unit: item.unit,
                  gramsMg: calculated.gramsMg,
                  sourceRegistryId: null,
                  sourceItemId: null,
                  datasetVersion: null,
                  nutrientProfileQualityGrade: null,
                  nutrientProfile: null,
                  serving: null,
                  nutrients: calculated.nutrients,
                  checkpoint: {
                    reviewedItemRevision: item.reviewedItemRevision!,
                    reviewedAuthorityFingerprintVersion:
                      item.reviewedAuthorityFingerprintVersion!,
                    reviewedAuthorityFingerprint:
                      item.reviewedAuthorityFingerprint!,
                    reviewIdempotencyKey: item.reviewIdempotencyKey!,
                    reviewRequestFingerprint: item.reviewRequestFingerprint!,
                    reviewedAt: item.reviewedAt!.toISOString(),
                  },
                  authority: {
                    fingerprintVersion: authority.fingerprintVersion,
                    fingerprint: authority.fingerprint,
                  },
                  provenance: {
                    calculationVersion: 'meal-nutrition-v1',
                    sourceRegistryId: null,
                    sourceItemId: null,
                    datasetVersion: null,
                    nutrientProfileId: null,
                  },
                };
              }
              const resolution = resolutionsByItemId.get(item.id)!;
              const previewValue =
                resolutionTuple.previewsByItemId.get(item.id);
              const preview = isCalculationPreviewIdentity(previewValue)
                ? previewValue
                : null;
              const directLeaf =
                preview?.basis === 'finished_profile'
                  ? preview.leaves[0] ?? null
                  : null;
              const profile = directLeaf
                ? {
                    id: directLeaf.nutrientProfileId,
                    sourceRegistryId: directLeaf.sourceRegistryId,
                    sourceItemId: directLeaf.sourceItemId,
                    datasetVersion: directLeaf.sourceReleaseVersion,
                    qualityGrade: directLeaf.profileQualityGrade,
                    ...directLeaf.nutrientProfile,
                  }
                : resolution.profile;
              if (!profile && !preview)
                throw new Error('Confirmed item is missing immutable provenance');
              const serving = directLeaf?.servingId
                ? {
                    id: directLeaf.servingId,
                    unit: item.unit,
                    amountMilliunits: directLeaf.servingAmountMilliunits!,
                    gramsMg: directLeaf.servingGramsMg!,
                    sourceRegistryId: directLeaf.servingSourceRegistryId!,
                    qualityGrade: directLeaf.servingQualityGrade!,
                  }
                : resolution.serving;
              return {
                mealItemId: item.id,
                origin: item.origin,
                initialEstimateAssessment: item.initialEstimateAssessment,
                currentResolutionSource: item.currentResolutionSource,
                itemRevision: item.itemRevision,
                foodRevision: item.foodRevision,
                portionRevision: item.portionRevision,
                foodId: item.foodId!,
                nutrientProfileId: profile?.id ?? null,
                amountMilliunits: item.amountMilliunits,
                unit: item.unit,
                gramsMg: calculated.gramsMg,
                sourceRegistryId: profile?.sourceRegistryId ?? null,
                sourceItemId: profile?.sourceItemId ?? null,
                datasetVersion: profile?.datasetVersion ?? null,
                nutrientProfileQualityGrade: profile?.qualityGrade ?? null,
                nutrientProfile: profile
                  ? {
                      basisAmountMg: profile.basisAmountMg,
                      energyMillicalories: profile.energyMillicalories,
                      carbohydrateMg: profile.carbohydrateMg,
                      proteinMg: profile.proteinMg,
                      fatMg: profile.fatMg,
                      fiberMg: profile.fiberMg,
                    }
                  : null,
                serving: serving && item.unit !== 'g'
                  ? {
                      id: serving.id,
                      unit: serving.unit as 'ml' | 'serving' | 'bowl' | 'piece',
                      amountMilliunits: serving.amountMilliunits,
                      gramsMg: serving.gramsMg,
                      sourceRegistryId: serving.sourceRegistryId,
                      qualityGrade: serving.qualityGrade,
                    }
                  : null,
                nutrients: calculated.nutrients,
                ...(preview
                  ? {
                      calculationBasis: preview.basis,
                      calculationLeaves: preview.leaves,
                      calculationPreview: preview,
                    }
                  : {}),
                checkpoint: {
                  reviewedItemRevision: item.reviewedItemRevision!,
                  reviewedAuthorityFingerprintVersion:
                    item.reviewedAuthorityFingerprintVersion!,
                  reviewedAuthorityFingerprint:
                    item.reviewedAuthorityFingerprint!,
                  reviewIdempotencyKey: item.reviewIdempotencyKey!,
                  reviewRequestFingerprint: item.reviewRequestFingerprint!,
                  reviewedAt: item.reviewedAt!.toISOString(),
                },
                authority: {
                  fingerprintVersion: authority.fingerprintVersion,
                  fingerprint: authority.fingerprint,
                },
                provenance: {
                  calculationVersion: 'meal-nutrition-v1',
                  sourceRegistryId: profile?.sourceRegistryId ?? null,
                  sourceItemId: profile?.sourceItemId ?? null,
                  datasetVersion: profile?.datasetVersion ?? null,
                  nutrientProfileId: profile?.id ?? null,
                },
              };
            }),
          },
          energyMillicalories: nutrition.totals.energyMillicalories.value,
          carbohydrateMg: nutrition.totals.carbohydrateMg.value,
          proteinMg: nutrition.totals.proteinMg.value,
          fatMg: nutrition.totals.fatMg.value,
          fiberMg: nutrition.totals.fiberMg.value,
          nutrientEvidence: nutrition.totals,
          confirmationIdempotencyKey: body.data.idempotencyKey,
          confirmationFingerprint: fingerprint,
          calculationVersion: 'meal-nutrition-v1',
          calculatedAt: now,
        })
        .returning(calculationSnapshotSelection);
      if (!createdSnapshot) throw new Error('Calculation snapshot insert did not return a row');

      const [updatedMealLog] = await tx
        .update(mealLogs)
        .set({ status: 'confirmed', confirmedAt: now, updatedAt: now })
        .where(
          and(
            eq(mealLogs.id, mealLog.id),
            eq(mealLogs.userId, userId),
            eq(mealLogs.status, 'draft'),
          ),
        )
        .returning(mealLogSelection);
      if (!updatedMealLog) return { kind: 'invalid_state' as const };

      return {
        kind: 'confirmed' as const,
        mealLog: updatedMealLog,
        items: items.map((item) => ({
          ...item,
          gramsMg: calculatedByItemId.get(item.id)!.gramsMg,
        })),
        snapshot: createdSnapshot,
      };
    }, { isolationLevel: 'serializable' }).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '40001'
      )
        return { kind: 'retry' as const };
      throw error;
    });

    if (confirmed.kind === 'retry')
      return mealConfirmationRetryable(reply, request);
    if (confirmed.kind === 'stale') {
      const latest = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
      if (!latest) return mealLogNotFound(reply, request);
      return reply.status(409).send({
        error: {
          code: 'STALE_MEAL_CONFIRMATION',
          message: '식사 초안이 변경되어 확인할 수 없습니다.',
          requestId: request.id,
        },
        latest: await mealLogResponse(
          options.database,
          latest,
          await findMealItems(options.database, latest.id),
        ),
      });
    }
    if (confirmed.kind === 'not_found') return mealLogNotFound(reply, request);
    if (confirmed.kind === 'idempotency_reused') {
      return reply.status(409).send({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: '동일한 확인 키에 다른 요청을 사용할 수 없습니다.',
          requestId: request.id,
        },
      });
    }
    if (confirmed.kind === 'invalid_state') return invalidMealLogState(reply, request);
    if (confirmed.kind === 'invalid')
      return invalidMealConfirmation(reply, request, confirmed.details);
    const response = confirmedMealSnapshotResponse(
      confirmed.mealLog,
      confirmed.snapshot,
    );
    if (!response) {
      return reply.status(500).send({
        error: {
          code: 'CONFIRMED_MEAL_INTEGRITY_ERROR',
          message: '확정된 식사 기록을 안전하게 읽을 수 없습니다.',
          requestId: request.id,
        },
      });
    }
    return response;
  });

  app.delete(
    '/api/meal-logs/:mealLogId/items/:itemId',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      if (!applyMealConfirmationCutover(request, reply, options)) return;
      const params = mealItemIdParamsSchema.safeParse(request.params);
      const body = deleteMealItemSchema.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply, request);
      const deleted = await options.database.transaction(async (tx) => {
        const [mealLog] = await tx
          .select(mealLogSelection)
          .from(mealLogs)
          .where(
            and(
              eq(mealLogs.id, params.data.mealLogId),
              eq(mealLogs.userId, userId),
            ),
          )
          .for('update')
          .limit(1);
        if (!mealLog) return { kind: 'not_found' as const };
        if (
          mealLog.status !== 'draft' ||
          (mealLog.recognitionStatus !== 'ready' &&
            mealLog.recognitionStatus !== 'manual')
        )
          return { kind: 'invalid_state' as const };
        if (mealLog.draftRevision !== body.data.expectedDraftRevision)
          return { kind: 'stale' as const, mealLog };
        const [item] = await tx
          .delete(mealItems)
          .where(
            and(
              eq(mealItems.id, params.data.itemId),
              eq(mealItems.mealLogId, mealLog.id),
              eq(mealItems.itemRevision, body.data.expectedItemRevision),
            ),
          )
          .returning({ id: mealItems.id });
        if (!item) return { kind: 'stale' as const, mealLog };
        const [currentMealLog] = await tx
          .update(mealLogs)
          .set({ draftRevision: sql`${mealLogs.draftRevision} + 1`, updatedAt: new Date() })
          .where(eq(mealLogs.id, mealLog.id))
          .returning(mealLogSelection);
        if (!currentMealLog) throw new Error('Draft meal disappeared while deleting item');
        const items = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(eq(mealItems.mealLogId, mealLog.id))
          .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
        return { kind: 'deleted' as const, mealLog: currentMealLog, items };
      });
      if (deleted.kind === 'not_found') return mealLogNotFound(reply, request);
      if (deleted.kind === 'stale') {
        const latest = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
        if (!latest) return mealLogNotFound(reply, request);
        return await staleMealResponse(options.database, reply, request, 'MEAL_ITEM_STALE', {
          mealLog: latest,
          items: await findMealItems(options.database, latest.id),
        });
      }
      if (deleted.kind === 'invalid_state')
        return invalidMealLogState(reply, request);
      return await mealLogResponse(options.database, deleted.mealLog, deleted.items);
    },
  );

  app.delete('/api/meal-logs/:mealLogId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    if (!applyMealConfirmationCutover(request, reply, options)) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    const body = expectedDraftRevisionSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);
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
            eq(mealLogs.draftRevision, body.data.expectedDraftRevision),
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
    if (!deleted) {
      const latest = await findOwnedMealLog(options.database, existing.id, userId);
      if (!latest) return mealLogNotFound(reply, request);
      return await staleMealResponse(options.database, reply, request, 'MEAL_DRAFT_STALE', {
        mealLog: latest,
        items: await findMealItems(options.database, latest.id),
      });
    }
    return reply.status(204).send();
  });
  app.post('/api/meal-logs/:mealLogId/recognition/retry', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request);
    const existing = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
    if (!existing) return mealLogNotFound(reply, request);
    if (existing.recognitionStatus === 'failed') {
      const recovery = await recognitionRecoveryResponse(
        options.database,
        existing,
        options.dailyRecognitionQuota,
        options.recoveryEnabled,
        options.v2OneCallAdmitted,
        options.cohortPercent,
      );
      if (recovery.mode !== 'retry_now') {
        return reply.status(200).send(
          await buildMealLogResponse(
            options.database,
            existing,
            await findMealItems(options.database, existing.id),
            options.reviewPolicy,
            { enabled: options.recoveryEnabled, dailyQuota: options.dailyRecognitionQuota, v2OneCallAdmitted: options.v2OneCallAdmitted, cohortPercent: options.cohortPercent },
            options.recognitionCoordinator,
          ),
        );
      }
      const outcome = await withRequestAbortSignal(request, reply, (signal) => options.recognitionCoordinator.recognize(
        existing.id,
        userId,
        'user_recovery',
        signal,
      ), () => options.recognitionCoordinator.responseLost?.(existing.id, userId));
      return recognitionResponse(
        options.database,
        reply,
        existing,
        [],
        outcome,
      );
    }
    if (
      existing.status !== 'draft' ||
      existing.recognitionStatus === 'manual' ||
      existing.recognitionStatus === 'processing' ||
      existing.recognitionStatus === 'pending'
    ) return invalidMealLogState(reply, request);
    if (existing.recognitionStatus === 'ready' && existing.recognitionResult?.version === 3) {
      const [observation] = await options.database.select({ id: storedObservations.id })
        .from(storedObservations).where(eq(storedObservations.mealLogId, existing.id)).limit(1);
      if (!observation) return invalidMealLogState(reply, request);
      await options.database.update(resolutionAttempts)
        .set({ nextAttemptAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(resolutionAttempts.storedObservationId, observation.id),
          eq(resolutionAttempts.status, 'failed'),
        ));
    }
    // A stored observation is resolved only; this path never invokes a provider.
    const outcome = await withRequestAbortSignal(
      request, reply,
      (signal) => options.recognitionCoordinator.recognize(existing.id, userId, 'initial', signal),
      () => options.recognitionCoordinator.responseLost?.(existing.id, userId),
    );
    return recognitionResponse(options.database, reply, existing, [], outcome);
  });

  app.post('/api/meal-logs/:mealLogId/recognition/manual', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    if (!applyMealConfirmationCutover(request, reply, options)) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    const body = expectedDraftRevisionSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);
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
        .for('update')
        .limit(1);
      if (!existing) return null;
      if (existing.draftRevision !== body.data.expectedDraftRevision)
        return { kind: 'stale' as const };
      if (existing.recognitionStatus === 'manual')
        return { kind: 'invalid' as const };
      if (
        existing.recognitionStatus === 'ready' &&
        existing.recognitionManualOverride === null &&
        (isRecognitionResultV2(existing.recognitionResult) ||
          isRecognitionResultV3(existing.recognitionResult)) &&
        (existing.recognitionResult.outcome === 'no_food' ||
          existing.recognitionResult.outcome === 'insufficient_evidence')
      ) {
        const [{ count } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(mealItems)
          .where(eq(mealItems.mealLogId, existing.id));
        if (count === 0) {
          const override = {
            fromStatus: 'ready' as const,
            fromOutcome: existing.recognitionResult.outcome,
            decision: 'direct_entry' as const,
            decidedAt: now.toISOString(),
            decisionVersion: 'recognition-manual-override-v1' as const,
            actorUserId: userId,
            expectedDraftRevision: body.data.expectedDraftRevision,
            changedFields: ['recognitionStatus'] as const,
            fromErrorCode: null,
          };
          const [mealLog] = await tx.update(mealLogs).set({
            recognitionStatus: 'manual',
            recognitionManualOverride: override,
            draftRevision: sql`${mealLogs.draftRevision} + 1`,
            updatedAt: now,
          }).where(and(
            eq(mealLogs.id, existing.id),
            eq(mealLogs.draftRevision, body.data.expectedDraftRevision),
            eq(mealLogs.recognitionStatus, 'ready'),
          )).returning(mealLogSelection);
          return mealLog ? { kind: 'changed' as const, mealLog } : { kind: 'stale' as const };
        }
      }
      if (existing.recognitionStatus === 'ready') return { kind: 'invalid' as const };
      if (
        existing.recognitionStatus !== 'pending' &&
        existing.recognitionStatus !== 'processing' &&
        existing.recognitionStatus !== 'failed'
      ) {
        return { kind: 'invalid' as const };
      }
      const manualOverride = {
        fromStatus: existing.recognitionStatus,
        fromOutcome: (isRecognitionResultV2(existing.recognitionResult) ||
          isRecognitionResultV3(existing.recognitionResult))
          ? existing.recognitionResult.outcome
          : null,
        fromErrorCode: existing.recognitionLastErrorCode,
        decision: 'direct_entry' as const,
        actorUserId: userId,
        expectedDraftRevision: body.data.expectedDraftRevision,
        changedFields: ['recognitionStatus'] as const,
        decidedAt: now.toISOString(),
        decisionVersion: 'recognition-manual-override-v1' as const,
      };
      const [mealLog] = await tx
        .update(mealLogs)
        .set({
          recognitionStatus: 'manual',
          recognitionManualOverride: manualOverride,
          recognitionLeaseToken: null,
          recognitionLeaseExpiresAt: null,
          recognitionNextAttemptAt: null,
          draftRevision: sql`${mealLogs.draftRevision} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(mealLogs.id, params.data.mealLogId),
          eq(mealLogs.userId, userId),
          eq(mealLogs.status, 'draft'),
          eq(mealLogs.draftRevision, body.data.expectedDraftRevision),
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
      return { kind: 'changed' as const, mealLog };
    });
    if (!changed || changed.kind === 'invalid')
      return mealLogStateOrNotFound(
        options.database,
        params.data.mealLogId,
        userId,
        reply,
        request,
      );
    if (changed.kind === 'stale') {
      const latest = await findOwnedMealLog(options.database, params.data.mealLogId, userId);
      if (!latest) return mealLogNotFound(reply, request);
      return await staleMealResponse(options.database, reply, request, 'MEAL_DRAFT_STALE', {
        mealLog: latest,
        items: await findMealItems(options.database, latest.id),
      });
    }
    return await mealLogResponse(options.database, changed.mealLog, await findMealItems(options.database, changed.mealLog.id));
  });
};
async function sendRecognitionResponse(
  database: Database,
  reviewPolicy: ApiEnvironment['mealRecognition']['reviewPolicy'],
  recoveryPolicy: RecognitionRecoveryPolicy,
  recognitionCoordinator: MealRecognitionRunner,
  responseReserveMs: number,
  reply: FastifyReply,
  mealLog: NonNullable<Awaited<ReturnType<typeof findOwnedMealLog>>>,
  items: Awaited<ReturnType<typeof findMealItems>>,
  outcome: { status: 'ready' | 'active' | 'unavailable'; retryAfterSeconds?: number; code?: string; retryable?: boolean; responseDeadlineAt?: Date },
  createdStatus?: number,
) {
  if (outcome.status === 'active') {
    reply.header('Retry-After', String(outcome.retryAfterSeconds ?? 1));
    return reply.status(202).send(await buildMealLogResponse(database, mealLog, items, reviewPolicy, recoveryPolicy, recognitionCoordinator, undefined, responseReserveMs, outcome.responseDeadlineAt));
  }
  if (
    outcome.status === 'unavailable' &&
    outcome.retryable &&
    outcome.code === 'CATALOG_UNAVAILABLE'
  ) {
    reply.header('Retry-After', String(outcome.retryAfterSeconds ?? 60));
    return reply.status(503).send({
      error: {
        code: 'CATALOG_UNAVAILABLE',
        message: '식품 카탈로그를 일시적으로 사용할 수 없습니다.',
        requestId: reply.request.id,
      },
    });
  }
  if (outcome.status === 'unavailable') {
    reply.header('Retry-After', String(outcome.retryAfterSeconds ?? 60));
    return reply.status(503).send({
      error: {
        code: outcome.code === 'CLAIM_UNAVAILABLE' ? 'CLAIM_UNAVAILABLE' : 'RECOGNITION_UNAVAILABLE',
        message: '인식 서비스를 일시적으로 사용할 수 없습니다.',
        requestId: reply.request.id,
      },
      mealLog: await buildMealLogResponse(
        database, mealLog, items, reviewPolicy, recoveryPolicy, recognitionCoordinator, undefined, responseReserveMs, outcome.responseDeadlineAt,
      ),
    });
  }
  return reply.status(createdStatus ?? 200).send(
    await buildMealLogResponse(database, mealLog, items, reviewPolicy, recoveryPolicy, recognitionCoordinator, undefined, responseReserveMs, outcome.responseDeadlineAt),
  );
}

const mealLogSelection = {
  id: mealLogs.id,
  userId: mealLogs.userId,
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
  recognitionResult: mealLogs.recognitionResult,
  recognitionManualOverride: mealLogs.recognitionManualOverride,
  draftRevision: mealLogs.draftRevision,
  confirmedAt: mealLogs.confirmedAt,
};
const mealItemSelection = {
  id: mealItems.id,
  mealLogId: mealItems.mealLogId,
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
  gramsMg: mealItems.gramsMg,
  origin: mealItems.origin,
  initialEstimateAssessment: mealItems.initialEstimateAssessment,
  currentResolutionSource: mealItems.currentResolutionSource,
  itemRevision: mealItems.itemRevision,
  foodRevision: mealItems.foodRevision,
  portionRevision: mealItems.portionRevision,
  reviewedItemRevision: mealItems.reviewedItemRevision,
  reviewedAuthorityFingerprintVersion: mealItems.reviewedAuthorityFingerprintVersion,
  reviewedAuthorityFingerprint: mealItems.reviewedAuthorityFingerprint,
  reviewIdempotencyKey: mealItems.reviewIdempotencyKey,
  reviewRequestFingerprint: mealItems.reviewRequestFingerprint,
  reviewedAt: mealItems.reviewedAt,
};
const calculationSnapshotSelection = {
  id: calculationSnapshots.id,
  sequence: calculationSnapshots.sequence,
  inputSnapshot: calculationSnapshots.inputSnapshot,
  energyMillicalories: calculationSnapshots.energyMillicalories,
  carbohydrateMg: calculationSnapshots.carbohydrateMg,
  proteinMg: calculationSnapshots.proteinMg,
  fatMg: calculationSnapshots.fatMg,
  fiberMg: calculationSnapshots.fiberMg,
  confirmationFingerprint: calculationSnapshots.confirmationFingerprint,
  calculationVersion: calculationSnapshots.calculationVersion,
  calculatedAt: calculationSnapshots.calculatedAt,
};
function confirmedMealSnapshotResponse(mealLog: any, snapshot: any) {
  const parsed = parseCalculationInputSnapshot(snapshot.inputSnapshot);
  if (!parsed) return null;
  const projection = projectCalculationInputSnapshot(parsed);
  return {
    mealLog: {
      id: mealLog.id,
      eatenAt: mealLog.eatenAt,
      timezone: mealLog.timezone,
      localDate: mealLog.localDate,
      mealType: mealLog.mealType,
      status: mealLog.status,
      confirmedAt: mealLog.confirmedAt,
    },
    items: projection.mealItems,
    review: {
      confirmable: false,
      evidence: projection.reviewEvidence,
      reasons: [],
    },
    nutrition: nutritionSnapshotResponse(snapshot),
  };
}
function nutritionSnapshotResponse(
  snapshot: Pick<
    typeof calculationSnapshots.$inferSelect,
    | 'id'
    | 'inputSnapshot'
    | 'energyMillicalories'
    | 'carbohydrateMg'
    | 'proteinMg'
    | 'fatMg'
    | 'fiberMg'
    | 'calculationVersion'
    | 'calculatedAt'
  >,
) {
  const items = snapshot.inputSnapshot.mealItems.map((item) => {
    const serving = snapshotServingSource(item.serving);
    return {
      mealItemId: item.mealItemId,
      amountMilliunits: item.amountMilliunits,
      unit: item.unit,
      gramsMg: item.gramsMg,
      nutrients: item.nutrients,
      calculationPreview: item.calculationPreview ?? null,
      source: {
        foodId: item.foodId,
        nutrientProfileId: item.nutrientProfileId,
        sourceRegistryId: item.sourceRegistryId,
        sourceItemId: item.sourceItemId,
        datasetVersion: item.datasetVersion,
        qualityGrade: item.nutrientProfileQualityGrade,
        servingId: serving.id,
        servingSourceRegistryId: serving.sourceRegistryId,
        servingQualityGrade: serving.qualityGrade,
      },
    };
  });
  const aggregate = (
    key: 'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
    value: number | null,
  ) => {
    const missingItemCount = items.filter((item) => item.nutrients[key] === null).length;
    const knownValue = items.reduce(
      (total, item) => total + (item.nutrients[key] ?? 0),
      0,
    );
    return {
      value: missingItemCount === 0 ? value : null,
      knownValue,
      missingItemCount,
      completeness: missingItemCount === 0 ? 'complete' as const : 'partial' as const,
    };
  };
  return {
    id: snapshot.id,
    calculationVersion: snapshot.calculationVersion,
    calculatedAt: snapshot.calculatedAt,
    items,
    totals: {
      energyMillicalories: aggregate('energyMillicalories', snapshot.energyMillicalories),
      carbohydrateMg: aggregate('carbohydrateMg', snapshot.carbohydrateMg),
      proteinMg: aggregate('proteinMg', snapshot.proteinMg),
      fatMg: aggregate('fatMg', snapshot.fatMg),
      fiberMg: aggregate('fiberMg', snapshot.fiberMg),
    },
  };
}

function snapshotServingSource(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { id: null, sourceRegistryId: null, qualityGrade: null };
  }
  const serving = value as Record<string, unknown>;
  return {
    id: typeof serving.id === 'string' ? serving.id : null,
    sourceRegistryId:
      typeof serving.sourceRegistryId === 'string'
        ? serving.sourceRegistryId
        : null,
    qualityGrade:
      serving.qualityGrade === 'verified' ||
      serving.qualityGrade === 'estimated' ||
      serving.qualityGrade === 'unverified'
        ? serving.qualityGrade
        : null,
  };
}


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
    .where(eq(mealItems.mealLogId, mealLogId))
    .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
}

async function projectCurrentItemAuthority(
  database: Database,
  item: Awaited<ReturnType<typeof findMealItems>>[number],
) {
  if (
    item.foodId === null
  ) return manualReviewAuthority(item);
  const [active] = await database
    .select({
      id: activeCatalogReleasePointers.activationId,
      catalogReleaseId: releaseActivations.catalogReleaseId,
    })
    .from(activeCatalogReleasePointers)
    .innerJoin(
      releaseActivations,
      eq(activeCatalogReleasePointers.activationId, releaseActivations.id),
    )
    .limit(1);
  if (!active) return nullAuthority(item.id, 'STALE_AUTHORITY');
  const [observation] = await database
    .select({
      id: storedObservations.id,
      canonicalContent: storedObservations.canonicalContent,
      contentSha256: storedObservations.contentSha256,
    })
    .from(storedObservations)
    .where(eq(storedObservations.mealLogId, item.mealLogId))
    .orderBy(desc(storedObservations.createdAt), desc(storedObservations.id))
    .limit(1);
  const localObservationId =
    item.origin === 'model_estimate' && item.recognitionRegionIndex !== null
      ? observationLocalId(observation?.canonicalContent, item.recognitionRegionIndex)
      : `manual:${item.id}`;
  if (!observation) {
    if (item.foodId === null || item.origin === 'model_estimate')
      return nullAuthority(item.id);
    const resolutions = await resolveCurrentMealItems(database, [item]);
    const resolution = resolutions[0];
    const gramsMg = item.gramsMg ??
      (item.unit === 'g'
        ? item.amountMilliunits
        : resolution?.serving
          ? servingAmountToGrams(
              item.amountMilliunits,
              resolution.serving.amountMilliunits,
              resolution.serving.gramsMg,
            )
          : null);
    if (!gramsMg) return nullAuthority(item.id, 'STALE_AUTHORITY');
    return projectMealItemAuthority(catalogEligibilityAdapter(database), {
      item: {
        id: item.id,
        revision: item.itemRevision,
        foodId: item.foodId,
        amountMilliunits: item.amountMilliunits,
        unit: item.unit,
        gramsMg,
      },
      activation: active,
      mapping: { method: 'manual', decisionId: null, contentSha256: null },
      calculation: {
        version: 'meal-nutrition-v1',
        previewId: null,
        previewSha256: null,
        mealDecompositionRevisionId: null,
        mealDecompositionSha256: null,
      },
    });
  }
  if (!localObservationId) return nullAuthority(item.id);
  const mappings = await database
    .select({
      id: mappingDecisions.id,
      method: mappingDecisions.method,
      selectedFoodId: mappingDecisions.selectedFoodId,
      catalogReleaseId: mappingDecisions.catalogReleaseId,
      releaseActivationId: mappingDecisions.releaseActivationId,
      storedObservationId: mappingDecisions.storedObservationId,
      localObservationId: mappingDecisions.localObservationId,
    })
    .from(mappingDecisions)
    .where(and(
      eq(mappingDecisions.storedObservationId, observation.id),
      eq(mappingDecisions.localObservationId, localObservationId),
    ))
    .orderBy(desc(mappingDecisions.createdAt), desc(mappingDecisions.id));
  const mapping = mappings[0];
  if (!mapping || mapping.selectedFoodId !== item.foodId)
    return nullAuthority(item.id);
  if (
    mapping.catalogReleaseId !== active.catalogReleaseId ||
    mapping.releaseActivationId !== active.id
  ) return nullAuthority(item.id, 'STALE_AUTHORITY');
  const previews = await database
    .select({
      id: calculationPreviews.id,
      contentSha256: calculationPreviews.contentSha256,
      mealLogId: calculationPreviews.mealLogId,
      rootMappingDecisionId: calculationPreviews.rootMappingDecisionId,
      rootRevision: calculationPreviews.rootRevision,
      catalogReleaseId: calculationPreviews.catalogReleaseId,
      releaseActivationId: calculationPreviews.releaseActivationId,
      identity: calculationPreviews.identity,
    })
    .from(calculationPreviews)
    .where(and(
      eq(calculationPreviews.mealLogId, item.mealLogId),
      eq(calculationPreviews.rootMappingDecisionId, mapping.id),
      eq(calculationPreviews.rootRevision, item.itemRevision),
    ))
    .orderBy(desc(calculationPreviews.createdAt), desc(calculationPreviews.id));
  const preview = previews[0];
  if (
    !preview ||
    preview.catalogReleaseId !== active.catalogReleaseId ||
    preview.releaseActivationId !== active.id
  ) return nullAuthority(item.id, 'STALE_AUTHORITY');
  const decompositions = await database
    .select({
      id: mealDecompositionRevisions.id,
      mealLogId: mealDecompositionRevisions.mealLogId,
      rootMappingDecisionId: mealDecompositionRevisions.rootMappingDecisionId,
      rootCalculationPreviewId: mealDecompositionRevisions.rootCalculationPreviewId,
    })
    .from(mealDecompositionRevisions)
    .where(and(
      eq(mealDecompositionRevisions.mealLogId, item.mealLogId),
      eq(mealDecompositionRevisions.rootMappingDecisionId, mapping.id),
      eq(mealDecompositionRevisions.rootCalculationPreviewId, preview.id),
    ))
    .orderBy(desc(mealDecompositionRevisions.revision), desc(mealDecompositionRevisions.id));
  const decomposition = decompositions[0];
  if (
    !isPreviewIdentityCurrent(
      preview.identity,
      mapping.id,
      item.itemRevision,
      active.catalogReleaseId,
      active.id,
    ) ||
    !await previewAuthorityFactsMatch(
      database,
      preview.identity,
      active.catalogReleaseId,
      active.id,
      decomposition,
    )
  ) return nullAuthority(item.id, 'STALE_AUTHORITY');
  const resolutions = await resolveCurrentMealItems(database, [item]);
  const resolution = resolutions[0];
  const gramsMg = item.gramsMg ??
    (item.unit === 'g'
      ? item.amountMilliunits
      : resolution?.serving
        ? servingAmountToGrams(
            item.amountMilliunits,
            resolution.serving.amountMilliunits,
            resolution.serving.gramsMg,
          )
        : null);
  if (!gramsMg) return nullAuthority(item.id, 'STALE_AUTHORITY');
  return projectMealItemAuthority(catalogEligibilityAdapter(database), {
    item: {
      id: item.id,
      revision: item.itemRevision,
      foodId: item.foodId,
      amountMilliunits: item.amountMilliunits,
      unit: item.unit,
      gramsMg,
    },
    activation: active,
    mapping: {
      method: mapping.method,
      decisionId: mapping.id,
      contentSha256: observation.contentSha256,
    },
    calculation: {
      version: 'meal-nutrition-v1',
      previewId: preview.id,
      previewSha256: preview.contentSha256,
      mealDecompositionRevisionId: decomposition?.id ?? null,
      mealDecompositionSha256: null,
    },
  });
}

function manualReviewAuthority(
  item: Awaited<ReturnType<typeof findMealItems>>[number],
) {
  const canonicalFingerprintInput = {
    version: MANUAL_REVIEW_FINGERPRINT_VERSION,
    itemId: item.id,
    itemRevision: item.itemRevision,
    recognizedLabel: item.recognizedLabel.normalize('NFC'),
    amountMilliunits: item.amountMilliunits,
    unit: item.unit,
    origin: item.origin,
  };
  const fingerprint = hash(JSON.stringify(canonicalFingerprintInput));
  return {
    version: 'meal-item-authority-projection-v1' as const,
    itemId: item.id,
    selected: null,
    officialSource: null,
    invalidReason: null,
    calculationIdentity: null,
    canonicalFingerprintInput,
    fingerprintVersion: MANUAL_REVIEW_FINGERPRINT_VERSION,
    fingerprint,
    canonicalFingerprintHash: fingerprint,
  };
}

function nullAuthority(
  itemId: string,
  invalidReason: 'MISSING_FOOD_MAPPING' | 'STALE_AUTHORITY' = 'MISSING_FOOD_MAPPING',
) {
  return {
    version: 'meal-item-authority-projection-v1' as const,
    itemId,
    selected: null,
    officialSource: null,
    invalidReason,
    calculationIdentity: null,
    canonicalFingerprintInput: null,
    fingerprintVersion: MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
    fingerprint: null,
    canonicalFingerprintHash: null,
  };
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

type RecognitionRecovery =
  | { mode: 'none'; reason: 'in_progress' | 'recognition_complete' | 'not_applicable'; retryAt: null }
  | { mode: 'retry_now'; reason: 'recoverable_failure'; retryAt: null }
  | { mode: 'retry_after'; reason: 'cooldown' | 'daily_quota'; retryAt: string }
  | { mode: 'manual_only'; reason: 'asset_unavailable' | 'recovery_exhausted' | 'terminal_failure'; retryAt: null };

function publicInitialAssessment(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const assessment = value as Record<string, unknown>;
  const productKeys = [
    'rawLabel', 'normalizedLabel', 'foodConfidenceBps', 'portionConfidenceBps',
    'foodCandidateMarginBps', 'questions', 'alternatives', 'initialMappingSource',
    'initialMatchedLabel', 'initialFoodId', 'initialNutrientProfileId',
  ] as const;
  const result: Record<string, unknown> = {};
  for (const key of productKeys) {
    if (assessment[key] !== undefined) result[key] = publicAssessmentValue(assessment[key]);
  }
  return result;
}

function publicAssessmentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicAssessmentValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const allowed = ['label', 'rawLabel', 'normalizedLabel', 'confidenceBps', 'foodConfidenceBps', 'portionConfidenceBps', 'amountMilliunits', 'unit', 'question', 'answer', 'reason'] as const;
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = publicAssessmentValue(source[key]);
  }
  return result;
}

async function withRequestAbortSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>,
  responseLost?: () => Promise<void> | undefined,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfIncomplete = () => {
    if (request.raw.aborted || !request.raw.complete) abort();
  };
  const cleanupLifecycle = observeResponseLifecycle(
    reply.raw,
    () => {
      abort();
      void responseLost?.();
    },
  );
  request.raw.once('aborted', abort);
  request.raw.once('close', abortIfIncomplete);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.removeListener('aborted', abort);
    request.raw.removeListener('close', abortIfIncomplete);
    // Keep reply observation active until Fastify delivers or loses the response.
    if (reply.sent) cleanupLifecycle();
  }
}

type ResponseLifecycleEmitter = {
  once(event: 'finish' | 'close', listener: () => void): unknown;
  removeListener(event: 'finish' | 'close', listener: () => void): unknown;
};

export function observeResponseLifecycle(
  reply: ResponseLifecycleEmitter,
  responseLost: () => void,
) {
  let finished = false;
  let closed = false;
  const cleanup = () => {
    reply.removeListener('finish', finish);
    reply.removeListener('close', close);
  };
  const finish = () => {
    finished = true;
    cleanup();
  };
  const close = () => {
    if (!finished && !closed) responseLost();
    closed = true;
    cleanup();
  };
  reply.once('finish', finish);
  reply.once('close', close);
  return cleanup;
}

/**
 * This is deliberately projected from durable state rather than coordinator
 * outcomes: a dropped HTTP response must not alter the recovery contract.
 */
async function recognitionRecoveryResponse(
  database: Database,
  mealLog: {
    id: string;
    userId?: string;
    status: string;
    recognitionStatus: string;
    imageAssetId: string | null;
  },
  dailyQuota = 20,
  recoveryEnabled = false,
  v2OneCallAdmitted = false,
  cohortPercent = 0,
): Promise<RecognitionRecovery> {
  if (mealLog.status !== 'draft' || mealLog.recognitionStatus === 'manual') {
    return { mode: 'none', reason: 'not_applicable', retryAt: null };
  }
  if (mealLog.recognitionStatus === 'ready') {
    return { mode: 'none', reason: 'recognition_complete', retryAt: null };
  }
  if (mealLog.recognitionStatus === 'pending' || mealLog.recognitionStatus === 'processing') {
    return { mode: 'none', reason: 'in_progress', retryAt: null };
  }
  if (mealLog.recognitionStatus !== 'failed' || !mealLog.imageAssetId) {
    return { mode: 'manual_only', reason: 'terminal_failure', retryAt: null };
  }
  if (
    !recoveryEnabled ||
    !v2OneCallAdmitted ||
    !mealLog.userId ||
    !isInRecognitionCohort(mealLog.userId, cohortPercent)
  ) return { mode: 'manual_only', reason: 'terminal_failure', retryAt: null };

  const [[observation], [asset], [workflow]] = await Promise.all([
    database.select({ id: storedObservations.id }).from(storedObservations)
      .where(eq(storedObservations.mealLogId, mealLog.id)).limit(1),
    database.select({
      userId: imageAssets.userId,
      status: imageAssets.status,
      purpose: imageAssets.purpose,
      expiresAt: imageAssets.expiresAt,
      byteSize: imageAssets.byteSize,
      detectedContentType: imageAssets.detectedContentType,
      sha256: imageAssets.sha256,
    }).from(imageAssets).where(eq(imageAssets.id, mealLog.imageAssetId)).limit(1),
    database.select({
      imageAssetId: recognitionAttempts.imageAssetId,
      userGrantState: recognitionAttempts.userGrantState,
      nextAttemptAt: recognitionAttempts.nextAttemptAt,
      lastErrorCode: recognitionAttempts.lastErrorCode,
    }).from(recognitionAttempts).where(eq(recognitionAttempts.mealLogId, mealLog.id)).limit(1),
  ]);
  if (observation) return { mode: 'none', reason: 'recognition_complete', retryAt: null };
  const usableAsset =
    asset &&
    asset.userId === mealLog.userId &&
    asset.purpose === 'inference' &&
    asset.status === 'processed' &&
    asset.expiresAt !== null &&
    asset.expiresAt.getTime() > Date.now() &&
    asset.byteSize !== null &&
    asset.byteSize > 0 &&
    asset.detectedContentType !== null &&
    ['image/jpeg', 'image/png', 'image/webp'].includes(asset.detectedContentType) &&
    asset.sha256 !== null;
  if (!usableAsset) return { mode: 'manual_only', reason: 'asset_unavailable', retryAt: null };
  // Historical drafts predate durable workflows. Core creates an equivalent,
  // asset-bound v2 workflow atomically when the user submits recovery.
  if (!workflow) {
    return { mode: 'retry_now', reason: 'recoverable_failure', retryAt: null };
  }
  if (
    workflow.imageAssetId !== undefined &&
    workflow.imageAssetId !== mealLog.imageAssetId
  ) {
    return { mode: 'manual_only', reason: 'terminal_failure', retryAt: null };
  }
  if (workflow.userGrantState !== 'available') {
    return { mode: 'manual_only', reason: 'recovery_exhausted', retryAt: null };
  }
  const day = new Date().toISOString().slice(0, 10);
  const [usage] = await database.select({ attemptCount: recognitionDailyUsages.attemptCount })
    .from(recognitionDailyUsages)
    .where(and(
      eq(recognitionDailyUsages.userId, mealLog.userId!),
      eq(recognitionDailyUsages.attemptDate, day),
    ))
    .limit(1);
  // The route uses the configured public quota projection before claiming a
  // user execution. Core repeats this check atomically at reservation.
  if (usage && usage.attemptCount >= dailyQuota) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return { mode: 'retry_after', reason: 'daily_quota', retryAt: tomorrow.toISOString() };
  }
  const retryAt = workflow.nextAttemptAt;
  if (retryAt && retryAt.getTime() > Date.now()) {
    return {
      mode: 'retry_after',
      reason: workflow.lastErrorCode === 'DAILY_QUOTA_RESERVED' ? 'daily_quota' : 'cooldown',
      retryAt: retryAt.toISOString(),
    };
  }
  const terminalCodes = new Set([
    'ASSET_MISMATCH',
    'ASSET_TYPE_INVALID',
    'PROVIDER_REQUEST_INVALID',
    'PROVIDER_AUTH_INVALID',
    'PROVIDER_REJECTED',
    'PERSISTENCE_UNAVAILABLE',
    'INTEGRITY_FAILURE',
    'CONFIG_INVALID',
    'AUTH_INVALID',
    'REQUEST_INVALID',
    'PROCESS_OUTCOME_UNKNOWN',
  ]);
  if (workflow.lastErrorCode && terminalCodes.has(workflow.lastErrorCode)) {
    return { mode: 'manual_only', reason: 'terminal_failure', retryAt: null };
  }
  return { mode: 'retry_now', reason: 'recoverable_failure', retryAt: null };
}

async function buildMealLogResponse(
  database: Database,
  mealLog: any,
  items: any[],
  _reviewPolicy: ApiEnvironment['mealRecognition']['reviewPolicy'],
  recoveryPolicy: RecognitionRecoveryPolicy = {
    enabled: false, dailyQuota: 20, v2OneCallAdmitted: false, cohortPercent: 0,
  },
  recognitionCoordinator?: MealRecognitionRunner,
  signal?: AbortSignal,
  responseReserveMs = 0,
  initialResponseDeadlineAt?: Date,
) {
  const runner = recognitionCoordinator;
  let responseDeadlineAt = initialResponseDeadlineAt;
  if (runner && mealLog.userId) {
    // Immediate outcomes supply their durable deadline. GET obtains exactly
    // one from reconciliation before any response-state reload.
    if (!responseDeadlineAt) {
      const outcome = await runner.reconcile(mealLog.id, mealLog.userId, signal);
      responseDeadlineAt = (outcome as ResponseDeadlineOutcome).responseDeadlineAt;
    }
    assertResponseBudget(responseDeadlineAt, responseReserveMs);
    mealLog = await withinResponseBudget(
      findOwnedMealLog(database, mealLog.id, mealLog.userId),
      responseDeadlineAt,
      responseReserveMs,
    ) ?? mealLog;
    items = await withinResponseBudget(
      findMealItems(database, mealLog.id),
      responseDeadlineAt,
      responseReserveMs,
    );
    assertResponseBudget(responseDeadlineAt, responseReserveMs);
  }
  const recognitionRecovery = await withinResponseBudget(
    recognitionRecoveryResponse(
      database,
      mealLog,
      recoveryPolicy.dailyQuota,
      recoveryPolicy.enabled,
      recoveryPolicy.v2OneCallAdmitted,
      recoveryPolicy.cohortPercent,
    ),
    responseDeadlineAt,
    responseReserveMs,
  );
  const resolutions = await withinResponseBudget(
    resolveCurrentMealItems(database, items),
    responseDeadlineAt,
    responseReserveMs,
  );
  assertResponseBudget(responseDeadlineAt, responseReserveMs);
  const resolutionByItemId = new Map(resolutions.map((resolution) => [resolution.itemId, resolution]));
  const authorities = await withinResponseBudget(
    Promise.all(items.map((item) => projectCurrentItemAuthority(database, item))),
    responseDeadlineAt,
    responseReserveMs,
  );
  assertResponseBudget(responseDeadlineAt, responseReserveMs);
  const authorityByItemId = new Map(
    authorities.map((authority) => [authority.itemId, authority]),
  );
  const isV3Recognition = mealLog.recognitionResult?.version === 3;
  const resolutionMetadata = isV3Recognition
    ? await withinResponseBudget(
      loadResolutionMetadata(database, mealLog.id, items),
      responseDeadlineAt,
      responseReserveMs,
    )
    : emptyResolutionMetadata();
  assertResponseBudget(responseDeadlineAt, responseReserveMs);
  const recognition = (
    isRecognitionResultV2(mealLog.recognitionResult) ||
    isRecognitionResultV3(mealLog.recognitionResult)
  )
    ? mealLog.recognitionResult
    : null;
  const responseItems = items.map((item) => {
    const resolution = resolutionByItemId.get(item.id);
    const authority = authorityByItemId.get(item.id)!;
    const reviewed =
      authority.fingerprint !== null &&
      item.reviewedItemRevision === item.itemRevision &&
      item.reviewedAuthorityFingerprintVersion === authority.fingerprintVersion &&
      item.reviewedAuthorityFingerprint === authority.fingerprint;
    const checkpoint = deriveCurrentItemReviewCheckpoint({
      itemId: item.id,
      itemRevision: item.itemRevision,
      selectedFoodId:
        authority.invalidReason === 'MISSING_FOOD_MAPPING' ? null : item.foodId,
      manualAuthority:
        item.foodId === null &&
        authority.fingerprintVersion === MANUAL_REVIEW_FINGERPRINT_VERSION,
      officialSourceRevision:
        authority.invalidReason === 'STALE_AUTHORITY'
          ? 1
          : authority.officialSource
            ? 1
            : null,
      currentOfficialSourceRevision:
        authority.invalidReason === 'STALE_AUTHORITY'
          ? 1
          : authority.officialSource
            ? 1
            : null,
      reviewedItemRevision: reviewed ? item.reviewedItemRevision : null,
    });
    return {
      ...item,
      initialAssessment: publicInitialAssessment(item.initialEstimateAssessment),
      checkpoint,
    };
  });
  const mealCheckpoint = deriveMealConfirmability({
    items: responseItems.map((item) => item.checkpoint),
  });
  const preview = await withinResponseBudget(
    calculateResolvedMealNutrition(database, items, resolutions),
    responseDeadlineAt,
    responseReserveMs,
  );
  assertResponseBudget(responseDeadlineAt, responseReserveMs);
  const nutritionPreview = 'details' in preview
    ? null
    : nutritionPreviewResponse(preview.nutrition, resolutionByItemId);
  type RecognizedEstimate = {
    regionIndex: number;
    amountMilliunits: number;
    unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
  };
  const recognizedEstimates: RecognizedEstimate[] =
    recognition?.outcome !== 'recognized'
      ? []
      : isRecognitionResultV2(recognition)
        ? recognition.foods
        : recognition.observations
            .filter(
              (observation: { parentRegionIndex: number | null }) =>
                observation.parentRegionIndex === null,
            );
  const recognizedFoodByRegion = new Map<number, RecognizedEstimate>(
    recognizedEstimates.map((food) => [food.regionIndex, food] as const),
  );
  const publicItems = responseItems.map((item) => {
    const authority = authorityByItemId.get(item.id)!;
    const reviewed =
      authority.fingerprint !== null &&
      item.reviewedItemRevision === item.itemRevision &&
      item.reviewedAuthorityFingerprintVersion === authority.fingerprintVersion &&
      item.reviewedAuthorityFingerprint === authority.fingerprint;
    const metadata = resolutionMetadata.byItemId.get(item.id);
    const originalEstimate =
      item.origin === 'model_estimate' && item.recognitionRegionIndex !== null
        ? recognizedFoodByRegion.get(item.recognitionRegionIndex)
        : null;
    return {
      id: item.id,
      recognizedLabel: item.recognizedLabel,
      amountMilliunits: item.amountMilliunits,
      unit: item.unit,
      estimatedAmountMilliunits: originalEstimate?.amountMilliunits ?? null,
      estimatedUnit: originalEstimate?.unit ?? null,
      recognitionRegionIndex: item.recognitionRegionIndex,
      recognitionConfidenceBps: item.recognitionConfidenceBps,
      portionConfidenceBps: item.portionConfidenceBps,
      userCorrected: item.userCorrected,
      foodId: item.foodId,
      nutrientProfileId: item.nutrientProfileId,
      mappingConfidenceBps: item.mappingConfidenceBps,
      gramsMg: item.gramsMg,
      origin: item.origin,
      initialAssessment: item.initialAssessment,
      currentResolutionSource: item.currentResolutionSource,
      itemRevision: item.itemRevision,
      foodRevision: item.foodRevision,
      portionRevision: item.portionRevision,
      review: {
        status: reviewed ? 'current' as const : 'required' as const,
        checkpointStatus: item.checkpoint,
        checkpoint: item.reviewedAt
          ? {
              reviewedItemRevision: item.reviewedItemRevision,
              authorityFingerprintVersion: item.reviewedAuthorityFingerprintVersion,
              authorityFingerprint: item.reviewedAuthorityFingerprint,
              reviewedAt: item.reviewedAt,
            }
          : null,
        authority: {
          fingerprintVersion: authority.fingerprintVersion,
          fingerprint: authority.fingerprint,
          officialSource: authority.officialSource,
          invalidReason: authority.invalidReason,
        },
        nextAction: reviewed ? null : 'review_item',
      },
      confirmationProof: metadata?.decisionId && metadata.previewId
        ? {
            mappingDecisionId: metadata.decisionId,
            calculationPreviewId: metadata.previewId,
            ...(metadata.decompositionRevisionId
              ? { decompositionRevisionId: metadata.decompositionRevisionId }
              : {}),
          }
        : null,
    };
  });
  const reviewedNutrition = reviewedNutritionSummary(items, authorityByItemId);
  return {
    mealLog: {
      id: mealLog.id,
      eatenAt: mealLog.eatenAt,
      timezone: mealLog.timezone,
      localDate: mealLog.localDate,
      mealType: mealLog.mealType,
      status: mealLog.status,
      imageAssetId: mealLog.imageAssetId,
      recognitionStatus: mealLog.recognitionStatus,
      draftRevision: mealLog.draftRevision,
      confirmedAt: mealLog.confirmedAt,
      recognitionOutcome: recognition?.outcome ?? null,
      recognitionEvidenceReason: recognition?.outcome === 'insufficient_evidence'
        ? recognition.evidenceReason ?? null
        : null,
      recognitionRecovery,
    },
    items: publicItems,
    recommendedNextItemId:
      publicItems.find((item) => item.review.status !== 'current')?.id ?? null,
    review: {
      confirmable: mealCheckpoint.confirmable,
      nextAction: mealCheckpoint.nextAction,
      nextItemId: mealCheckpoint.nextItemId,
      reasons: responseItems.flatMap((item) => {
        if (item.checkpoint.nextAction === 'none') return [];
        return [{
          code: item.checkpoint.nextAction === 'select_item'
            ? 'FOOD_MAPPING_MISSING'
            : item.checkpoint.nextAction === 'refresh_official_source'
              ? 'OFFICIAL_SOURCE_MISSING'
              : authorityByItemId.get(item.id)?.invalidReason === 'STALE_AUTHORITY'
                ? 'MEAL_ITEM_AUTHORITY_STALE'
                : 'MEAL_ITEM_REVIEW_REQUIRED',
          itemId: item.id,
        }];
      }),
      nutrition: nutritionPreview,
      reviewedNutrition,
    },
  };
}

function reviewedNutritionSummary(
  items: Awaited<ReturnType<typeof findMealItems>>,
  authorityByItemId: Map<string, Awaited<ReturnType<typeof projectCurrentItemAuthority>>>,
) {
  let reviewedItemCount = 0;
  let reviewedUnknownItemCount = 0;
  const inputs = items.flatMap((item) => {
    const authority = authorityByItemId.get(item.id);
    const reviewed =
      authority !== undefined &&
      item.reviewedItemRevision === item.itemRevision &&
      item.reviewedAuthorityFingerprintVersion === authority.fingerprintVersion &&
      item.reviewedAuthorityFingerprint === authority.fingerprint;
    if (reviewed) reviewedItemCount += 1;
    if (!authority?.selected) {
      if (reviewed) reviewedUnknownItemCount += 1;
      return [];
    }
    if (!reviewed) return [];
    return [{
      mealItemId: item.id,
      amountMilliunits: item.amountMilliunits,
      unit: item.unit,
      nutrientProfile: {
        basisAmountMg: authority.selected.profile.basisAmountMg,
        energyMillicalories: authority.selected.profile.energyMillicalories,
        carbohydrateMg: authority.selected.profile.carbohydrateMg,
        proteinMg: authority.selected.profile.proteinMg,
        fatMg: authority.selected.profile.fatMg,
        fiberMg: authority.selected.profile.fiberMg,
      },
      ...(item.unit !== 'g' &&
      authority.selected.serving &&
      authority.selected.serving.unit !== 'g'
        ? {
            serving: {
              id: authority.selected.serving.id,
              unit: item.unit,
              amountMilliunits:
                authority.selected.serving.amountMilliunits,
              gramsMg: authority.selected.serving.gramsMg,
              sourceRegistryId:
                authority.selected.serving.sourceRegistryId,
              qualityGrade: authority.selected.serving.qualityGrade,
            },
          }
        : {}),
    }];
  });
  const nutrition = calculateMealNutrition(inputs);
  const unreviewedItemCount = items.length - reviewedItemCount;
  const totals = Object.fromEntries(
    nutritionKeysForComposition.map((key) => {
      const aggregate = nutrition.totals[key];
      const missingItemCount =
        aggregate.missingItemCount + reviewedUnknownItemCount;
      const status =
        reviewedItemCount === 0
          ? 'pending' as const
          : unreviewedItemCount === 0 && missingItemCount === 0
            ? 'complete' as const
            : 'subtotal' as const;
      return [key, {
        value: status === 'complete' ? aggregate.knownValue : null,
        knownValue: aggregate.knownValue,
        missingItemCount,
        status,
      }];
    }),
  ) as Record<
    (typeof nutritionKeysForComposition)[number],
    {
      value: number | null;
      knownValue: number;
      missingItemCount: number;
      status: 'pending' | 'subtotal' | 'complete';
          }
  >;
  return {
    status:
      reviewedItemCount === 0
        ? 'pending' as const
        : unreviewedItemCount === 0 &&
            Object.values(totals).every((total) => total.status === 'complete')
          ? 'complete' as const
          : 'subtotal' as const,
    reviewedItemCount,
    unreviewedItemCount,
    items: nutrition.items,
    totals,
    };
}

type ResolutionMetadata = {
  observationId: string | null;
  status: 'pending' | 'processing' | 'resolved' | 'failed' | null;
  reason: string | null;
  retryAt: Date | null;
  byItemId: Map<string, {
    observationId: string;
    decisionId: string | null;
    previewId: string | null;
    decompositionRevisionId: string | null;
    resolutionStatus: 'pending' | 'processing' | 'resolved' | 'failed' | null;
    resolutionReason: string | null;
    resolutionRetryAt: Date | null;
    candidates: Array<{
      foodId: string;
      labelKo: string;
      scoreBps: number;
      availability: 'available' | 'unavailable' | 'unknown';
      reason: string | null;
    }>;
  }>;
};

function emptyResolutionMetadata(): ResolutionMetadata {
  return {
    observationId: null,
    status: null,
    reason: null,
    retryAt: null,
    byItemId: new Map(),
  };
}

/** Read-only hydration of immutable V3 resolution provenance for draft responses. */
async function loadResolutionMetadata(
  database: Database,
  mealLogId: string,
  items: Array<{ id: string; recognitionRegionIndex: number | null }>,
): Promise<ResolutionMetadata> {
  const [observation] = await database
    .select({ id: storedObservations.id, canonicalContent: storedObservations.canonicalContent })
    .from(storedObservations)
    .where(eq(storedObservations.mealLogId, mealLogId))
    .limit(1);
  if (!observation) return emptyResolutionMetadata();

  const [attempt] = await database
    .select({
      status: resolutionAttempts.status,
      lastErrorCode: resolutionAttempts.lastErrorCode,
      nextAttemptAt: resolutionAttempts.nextAttemptAt,
    })
    .from(resolutionAttempts)
    .where(eq(resolutionAttempts.storedObservationId, observation.id))
    .limit(1);
  const decisions = await database
    .select({
      id: mappingDecisions.id,
      localObservationId: mappingDecisions.localObservationId,
      candidates: mappingDecisions.candidates,
      evidence: mappingDecisions.evidence,
      createdAt: mappingDecisions.createdAt,
    })
    .from(mappingDecisions)
    .where(eq(mappingDecisions.storedObservationId, observation.id))
    .orderBy(desc(mappingDecisions.createdAt), desc(mappingDecisions.id));
  const latestDecisionByLocalId = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) {
    if (!latestDecisionByLocalId.has(decision.localObservationId)) {
      latestDecisionByLocalId.set(decision.localObservationId, decision);
    }
  }
  const decisionIds = [...latestDecisionByLocalId.values()].map((decision) => decision.id);
  const previews = decisionIds.length === 0
    ? []
    : await database
      .select({
        id: calculationPreviews.id,
        rootMappingDecisionId: calculationPreviews.rootMappingDecisionId,
        createdAt: calculationPreviews.createdAt,
      })
      .from(calculationPreviews)
      .where(inArray(calculationPreviews.rootMappingDecisionId, decisionIds))
      .orderBy(desc(calculationPreviews.createdAt), desc(calculationPreviews.id));
  const previewByDecisionId = new Map<string, string>();
  for (const preview of previews) {
    if (!previewByDecisionId.has(preview.rootMappingDecisionId)) {
      previewByDecisionId.set(preview.rootMappingDecisionId, preview.id);
    }
  }
  const previewIds = [...previewByDecisionId.values()];
  const decompositions = previewIds.length === 0
    ? []
    : await database
      .select({
        id: mealDecompositionRevisions.id,
        rootCalculationPreviewId: mealDecompositionRevisions.rootCalculationPreviewId,
        revision: mealDecompositionRevisions.revision,
      })
      .from(mealDecompositionRevisions)
      .where(and(
        eq(mealDecompositionRevisions.mealLogId, mealLogId),
        inArray(mealDecompositionRevisions.rootCalculationPreviewId, previewIds),
      ))
      .orderBy(desc(mealDecompositionRevisions.revision));
  const decompositionByPreviewId = new Map<string, string>();
  for (const decomposition of decompositions) {
    if (!decompositionByPreviewId.has(decomposition.rootCalculationPreviewId))
      decompositionByPreviewId.set(decomposition.rootCalculationPreviewId, decomposition.id);
  }
  const status = attempt?.status ?? null;
  const reason = attempt?.lastErrorCode ?? null;
  const retryAt = attempt?.nextAttemptAt ?? null;
  const localIdByRegion = new Map<number, string>();
  const canonical = observation.canonicalContent as {
    version?: number;
    observations?: Array<{ regionIndex: number; localObservationId: string }>;
  };
  if (canonical.version === 3) {
    for (const entry of canonical.observations ?? []) localIdByRegion.set(entry.regionIndex, entry.localObservationId);
  }
  return {
    observationId: observation.id,
    status,
    reason,
    retryAt,
    byItemId: new Map(items.map((item) => {
      const localObservationId =
        item.recognitionRegionIndex === null
          ? `manual:${item.id}`
          : localIdByRegion.get(item.recognitionRegionIndex) ?? '';
      const decision =
        latestDecisionByLocalId.get(localObservationId) ?? null;
      return [item.id, {
        observationId: observation.id,
        decisionId: decision?.id ?? null,
        previewId: decision ? previewByDecisionId.get(decision.id) ?? null : null,
        decompositionRevisionId: decision
          ? decompositionByPreviewId.get(previewByDecisionId.get(decision.id) ?? '') ?? null
          : null,
        resolutionStatus: status,
        resolutionReason: reason,
        resolutionRetryAt: retryAt,
        candidates: decision ? publicResolutionCandidates(decision) : [],
      }];
    })),
  };
}

function publicResolutionCandidates(decision: {
  candidates: unknown;
  evidence: unknown;
}): Array<{
  foodId: string;
  labelKo: string;
  scoreBps: number;
  availability: 'available' | 'unavailable' | 'unknown';
  reason: string | null;
}> {
  const candidates = Array.isArray(decision.candidates)
    ? decision.candidates
    : [];
  const assessments =
    decision.evidence &&
    typeof decision.evidence === 'object' &&
    !Array.isArray(decision.evidence) &&
    Array.isArray(
      (decision.evidence as { candidateAssessment?: unknown })
        .candidateAssessment,
    )
      ? (decision.evidence as { candidateAssessment: unknown[] })
          .candidateAssessment
      : [];
  return candidates.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    )
      return [];
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.foodId !== 'string' ||
      typeof value.displayTextKo !== 'string' ||
      !Number.isInteger(value.scoreBps)
    )
      return [];
    const assessment = assessments.find(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as { foodId?: unknown }).foodId === value.foodId,
    ) as
      | {
          availability?: unknown;
          reason?: unknown;
        }
      | undefined;
    const availability: 'available' | 'unavailable' | 'unknown' =
      assessment?.availability === 'available' ||
      assessment?.availability === 'unavailable'
        ? assessment.availability
        : 'unknown';
    return [{
      foodId: value.foodId,
      labelKo: value.displayTextKo,
      scoreBps: value.scoreBps as number,
      availability,
      reason:
        availability === 'unavailable' &&
        typeof assessment?.reason === 'string'
          ? assessment.reason
          : null,
    }];
  }).slice(0, 8);
}
async function calculateResolvedMealNutrition(
  database: Parameters<typeof resolveCurrentMealItems>[0],
  items: any[],
  resolvedItems?: Awaited<ReturnType<typeof resolveCurrentMealItems>>,
  previewsByItemId = new Map<string, unknown>(),
) {
  const resolutions = resolvedItems ?? await resolveCurrentMealItems(database, items);
  const unknownItemIds = new Set(
    items
      .filter((item) => item.foodId === null)
      .map((item) => item.id),
  );
  const details = resolutions.flatMap((resolution) =>
    unknownItemIds.has(resolution.itemId) ||
    resolution.reason === null ||
      isCalculationPreviewIdentity(previewsByItemId.get(resolution.itemId))
      ? []
      : [{ itemId: resolution.itemId, code: resolution.reason }],
  );
  if (details.length > 0) return { details };
  const resolutionsByItemId = new Map(resolutions.map((resolution) => [resolution.itemId, resolution]));
  const compositeRoots = new Map<string, Array<{ mealItemId: string; amountMilliunits: number; unit: 'g'; nutrientProfile: any }>>();
  const inputs: MealNutritionInput[] = items.flatMap((item) => {
    if (unknownItemIds.has(item.id)) return [];
    const identity = previewsByItemId.get(item.id);
    if (isCalculationPreviewIdentity(identity)) {
      const leaves = identity.leaves.map((leaf) => ({
        mealItemId:
          identity.basis === 'finished_profile'
            ? item.id
            : `${item.id}:${leaf.ordinal}`,
        amountMilliunits: leaf.edibleAmountMg,
        unit: 'g' as const,
        nutrientProfile: leaf.nutrientProfile,
      }));
      if (identity.basis !== 'finished_profile')
        compositeRoots.set(item.id, leaves);
      return leaves;
    }
    const resolution = resolutionsByItemId.get(item.id)!;
    const profile = resolution.profile!;
    const base = {
      mealItemId: item.id,
      amountMilliunits: item.amountMilliunits,
      unit: item.unit,
      nutrientProfile: {
        basisAmountMg: profile.basisAmountMg,
        energyMillicalories: profile.energyMillicalories,
        carbohydrateMg: profile.carbohydrateMg,
        proteinMg: profile.proteinMg,
        fatMg: profile.fatMg,
        fiberMg: profile.fiberMg,
      },
    };
    if (item.unit === 'g') return [base];
    const serving = resolution.serving!;
    return [{
      ...base,
      serving: {
        id: serving.id,
        unit: serving.unit as 'ml' | 'serving' | 'bowl' | 'piece',
        amountMilliunits: serving.amountMilliunits,
        gramsMg: serving.gramsMg,
        sourceRegistryId: serving.sourceRegistryId,
        qualityGrade: serving.qualityGrade,
      },
    }];
  });
  try {
    const leafNutrition = calculateMealNutrition(inputs);
    const unknownNutritionItems = items
      .filter((item) => unknownItemIds.has(item.id))
      .map((item) => ({
        mealItemId: item.id,
        gramsMg: item.unit === 'g' ? item.amountMilliunits : null,
        nutrients: Object.fromEntries(
          nutritionKeysForComposition.map((key) => [key, null]),
        ) as Record<(typeof nutritionKeysForComposition)[number], null>,
      }));
    const withUnknownItems = (nutritionItems: Array<{
      mealItemId: string;
      gramsMg: number | null;
      nutrients: Record<(typeof nutritionKeysForComposition)[number], number | null>;
    }>) => {
      const totals = Object.fromEntries(nutritionKeysForComposition.map((key) => {
        const total = leafNutrition.totals[key];
        const missingItemCount =
          total.missingItemCount + unknownNutritionItems.length;
        return [key, {
          value: missingItemCount === 0 ? total.knownValue : null,
          knownValue: total.knownValue,
          missingItemCount,
          completeness: missingItemCount === 0
            ? 'complete' as const
            : 'partial' as const,
        }];
      })) as Record<
        (typeof nutritionKeysForComposition)[number],
        {
          value: number | null;
          knownValue: number;
          missingItemCount: number;
          completeness: 'complete' | 'partial';
        }
      >;
      return { items: nutritionItems, totals };
    };
    if (compositeRoots.size === 0)
      return {
        nutrition: withUnknownItems([
          ...leafNutrition.items,
          ...unknownNutritionItems,
        ]),
        resolutionsByItemId,
      };
    const byLeafId = new Map(leafNutrition.items.map((item) => [item.mealItemId, item]));
    const rootItems = items.map((item) => {
      if (unknownItemIds.has(item.id))
        return unknownNutritionItems.find(
          (candidate) => candidate.mealItemId === item.id,
        )!;
      const leaves = compositeRoots.get(item.id);
      if (!leaves) return byLeafId.get(item.id)!;
      const leafValues = leaves.map((leaf) => byLeafId.get(leaf.mealItemId)!);
      return {
        mealItemId: item.id,
        gramsMg: leafValues.reduce((total, leaf) => total + leaf.gramsMg, 0),
        nutrients: Object.fromEntries(nutritionKeysForComposition.map((key) => {
          const values = leafValues.map((leaf) => leaf.nutrients[key]);
          if (values.some((value) => value === null)) return [key, null];
          return [
            key,
            values.reduce<number>((total, value) => total + (value ?? 0), 0),
          ];
        })) as any,
      };
    });
    return {
      nutrition: withUnknownItems(rootItems),
      resolutionsByItemId,
    };
  } catch (error) {
    return {
      details: [{
        code: error instanceof NutritionCalculationError ? error.code : 'CALCULATION_FAILED',
      }],
    };
  }
}

const nutritionKeysForComposition = [
  'energyMillicalories',
  'carbohydrateMg',
  'proteinMg',
  'fatMg',
  'fiberMg',
] as const;

function isCompositePreviewIdentity(value: unknown): value is {
  basis: 'source_recipe' | 'meal_decomposition';
  leaves: Array<{
    ordinal: number;
    foodId: string;
    edibleAmountMg: number;
    nutrientProfile: MealNutritionInput['nutrientProfile'];
  }>;
} {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (((value as { basis?: unknown }).basis === 'source_recipe') ||
      ((value as { basis?: unknown }).basis === 'meal_decomposition')) &&
    Array.isArray((value as { leaves?: unknown }).leaves);
}

function isCalculationPreviewIdentity(
  value: unknown,
): value is CalculationPreviewIdentity {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ['finished_profile', 'source_recipe', 'meal_decomposition'].includes(
      String((value as { basis?: unknown }).basis),
    ) &&
    Array.isArray((value as { leaves?: unknown }).leaves)
  );
}

function confirmationFingerprint(input: z.infer<typeof confirmMealSchema>): string {
  const items = [...input.items]
    .map((item) => ({
      itemId: item.itemId,
      expectedItemRevision: item.expectedItemRevision,
      mappingDecisionId: item.mappingDecisionId ?? null,
      calculationPreviewId: item.calculationPreviewId ?? null,
      decompositionRevisionId: item.decompositionRevisionId ?? null,
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  return createHash('sha256')
    .update(JSON.stringify({ expectedDraftRevision: input.expectedDraftRevision, items }))
    .digest('hex');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function observationLocalId(content: unknown, regionIndex: number): string | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const canonical = content as { version?: unknown; observations?: unknown };
  if (canonical.version !== 3 || !Array.isArray(canonical.observations)) return null;
  const observation = canonical.observations.find((entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    (entry as { regionIndex?: unknown }).regionIndex === regionIndex,
  ) as { localObservationId?: unknown } | undefined;
  return typeof observation?.localObservationId === 'string'
    ? observation.localObservationId
    : null;
}

function previewLeaf(
  componentIdentity: string,
  ordinal: number,
  edibleAmountMg: number,
  unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece',
  selection: Awaited<ReturnType<typeof selectTrustedNutrition>> & { kind: 'selected' },
) {
  return {
    ordinal,
    componentIdentity,
    foodId: selection.food.id,
    edibleAmountMg,
    unit,
    nutrientProfileId: selection.profile.id,
    sourceItemId: selection.profile.sourceItemId,
    profileQualityGrade: selection.profile.qualityGrade,
    servingId: unit === 'g' ? null : selection.serving?.id ?? null,
    servingAmountMilliunits:
      unit === 'g' ? null : selection.serving?.amountMilliunits ?? null,
    servingGramsMg:
      unit === 'g' ? null : selection.serving?.gramsMg ?? null,
    servingSourceRegistryId:
      unit === 'g' ? null : selection.serving?.sourceRegistryId ?? null,
    servingQualityGrade:
      unit === 'g' ? null : selection.serving?.qualityGrade ?? null,
    sourceRegistryId: selection.profile.sourceRegistryId,
    sourceReleaseId: selection.provenance.sourceReleaseId,
    sourceReleaseVersion: selection.provenance.sourceReleaseVersion,
    catalogReleaseId: selection.provenance.catalogReleaseId,
    catalogManifestSha256: selection.provenance.catalogManifestSha256,
    nutrientProfile: {
      basisAmountMg: selection.profile.basisAmountMg,
      energyMillicalories: selection.profile.energyMillicalories,
      carbohydrateMg: selection.profile.carbohydrateMg,
      proteinMg: selection.profile.proteinMg,
      fatMg: selection.profile.fatMg,
      fiberMg: selection.profile.fiberMg,
    },
  };
}

function servingAmountToGrams(
  amountMilliunits: number,
  servingAmountMilliunits: number | undefined,
  servingGramsMg: number | undefined,
): number | null {
  if (!servingAmountMilliunits || !servingGramsMg) return null;
  const value = (BigInt(amountMilliunits) * BigInt(servingGramsMg) + BigInt(servingAmountMilliunits) / 2n)
    / BigInt(servingAmountMilliunits);
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/**
 * V3 resolution artifacts are immutable, but their IDs alone are not a
 * confirmation contract.  Re-read the exact root tuple while the draft and
 * roots are locked.  Legacy/manual rows have no V3 root decision and continue
 * through the existing persisted food/profile tuple.
 */
async function revalidateConfirmationResolutionTuples(
  database: Database,
  mealLogId: string,
  roots: Array<{
    id: string;
    recognitionRegionIndex: number | null;
    itemRevision: number;
    origin: string;
    foodId: string | null;
  }>,
  requested: Array<{
    itemId: string;
    mappingDecisionId?: string | undefined;
    calculationPreviewId?: string | undefined;
    decompositionRevisionId?: string | undefined;
  }>,
) {
  const details: Array<{ itemId: string; code: string }> = [];
  const previewsByItemId = new Map<string, unknown>();
  const requestedByItemId = new Map(requested.map((item) => [item.itemId, item]));
  const authoritativeRoots = roots.filter((root) => {
    const request = requestedByItemId.get(root.id);
    return root.foodId !== null ||
      request?.mappingDecisionId !== undefined ||
      request?.calculationPreviewId !== undefined ||
      request?.decompositionRevisionId !== undefined;
  });
  if (authoritativeRoots.length === 0) {
    return { details, previewsByItemId, stale: false };
  }
  const [observation] = await database
    .select({
      id: storedObservations.id,
      canonicalContent: storedObservations.canonicalContent,
      contentSha256: storedObservations.contentSha256,
    })
    .from(storedObservations)
    .where(eq(storedObservations.mealLogId, mealLogId))
    .for('update')
    .limit(1);
  const localIdByRegion = new Map<number, string>();
  const canonical = observation?.canonicalContent as {
    version?: number;
    observations?: Array<{ regionIndex: number; localObservationId: string }>;
  } | undefined;
  if (canonical?.version === 3) {
    for (const entry of canonical.observations ?? [])
      localIdByRegion.set(entry.regionIndex, entry.localObservationId);
  } else {
    return {
      details,
      previewsByItemId,
      // Legacy/manual drafts predate immutable V3 roots. Their persisted
      // food/profile authority remains guarded by review fingerprints and
      // unknown-nutrition checks in the normal confirmation path.
      stale: false,
    };
  }
  const [active] = await database
    .select({ activationId: activeCatalogReleasePointers.activationId })
    .from(activeCatalogReleasePointers)
    .for('update')
    .limit(1);
  if (!active) return { details, previewsByItemId, stale: true };
  const localIdForRoot = (root: (typeof roots)[number]) =>
    root.recognitionRegionIndex === null
      ? `manual:${root.id}`
      : localIdByRegion.get(root.recognitionRegionIndex) ?? null;
  if (authoritativeRoots.some((root) => localIdForRoot(root) === null))
    return { details, previewsByItemId, stale: true };
  const rootLocalIds = authoritativeRoots.map((root) => localIdForRoot(root)!);
  if (rootLocalIds.length === 0) return { details, previewsByItemId, stale: false };
  const decisions = await database
    .select({
      id: mappingDecisions.id,
      localObservationId: mappingDecisions.localObservationId,
      catalogReleaseId: mappingDecisions.catalogReleaseId,
      releaseActivationId: mappingDecisions.releaseActivationId,
      selectedFoodId: mappingDecisions.selectedFoodId,
      status: mappingDecisions.status,
    })
    .from(mappingDecisions)
    .innerJoin(storedObservations, eq(mappingDecisions.storedObservationId, storedObservations.id))
    .where(and(
      eq(storedObservations.mealLogId, mealLogId),
      inArray(mappingDecisions.localObservationId, rootLocalIds),
    ))
    .orderBy(desc(mappingDecisions.createdAt), desc(mappingDecisions.id))
    .for('update');
  const decisionByLocalId = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) {
    // A newer decision supersedes the tuple visible to the user.  Multiple
    // historical decisions are therefore stale rather than interchangeable.
    if (!decisionByLocalId.has(decision.localObservationId))
      decisionByLocalId.set(decision.localObservationId, decision);
  }
  for (const root of authoritativeRoots) {
    const decision = decisionByLocalId.get(localIdForRoot(root)!);
    if (
      !decision ||
      decision.status !== 'selected' ||
      !decision.selectedFoodId ||
      decision.releaseActivationId !== active.activationId
    )
      return { details, previewsByItemId, stale: true };
    const tuple = requestedByItemId.get(root.id);
    if (
      !tuple?.mappingDecisionId ||
      !tuple.calculationPreviewId ||
      tuple.mappingDecisionId !== decision.id
    ) {
      details.push({ itemId: root.id, code: 'RESOLUTION_TUPLE_STALE' });
      continue;
    }
    const [preview] = await database
      .select({
        id: calculationPreviews.id,
        rootMappingDecisionId: calculationPreviews.rootMappingDecisionId,
        rootRevision: calculationPreviews.rootRevision,
        catalogReleaseId: calculationPreviews.catalogReleaseId,
        releaseActivationId: calculationPreviews.releaseActivationId,
        discriminant: calculationPreviews.discriminant,
        identity: calculationPreviews.identity,
      })
      .from(calculationPreviews)
      .where(and(
        eq(calculationPreviews.id, tuple.calculationPreviewId),
        eq(calculationPreviews.mealLogId, mealLogId),
        eq(calculationPreviews.rootMappingDecisionId, decision.id),
      ))
      .for('update')
      .limit(1);
    if (
      !preview ||
      !isPreviewIdentityCurrent(preview.identity, decision.id, root.itemRevision, decision.catalogReleaseId, decision.releaseActivationId) ||
      preview.rootRevision !== root.itemRevision ||
      preview.catalogReleaseId !== decision.catalogReleaseId ||
      preview.releaseActivationId !== decision.releaseActivationId
    ) {
      details.push({ itemId: root.id, code: 'CALCULATION_PREVIEW_STALE' });
      continue;
    }
    const currentPreview = await database
      .select({ id: calculationPreviews.id })
      .from(calculationPreviews)
      .where(and(
        eq(calculationPreviews.mealLogId, mealLogId),
        eq(calculationPreviews.rootMappingDecisionId, decision.id),
        eq(calculationPreviews.rootRevision, root.itemRevision),
      ))
      .orderBy(desc(calculationPreviews.createdAt), desc(calculationPreviews.id))
      .for('update')
      .limit(1);
    if (currentPreview[0]?.id !== preview.id) {
      return { details, previewsByItemId, stale: true };
    }
    const previewIdentity = preview.identity as { basis?: string };
    if (
      (previewIdentity.basis === 'meal_decomposition' && !tuple.decompositionRevisionId) ||
      (previewIdentity.basis !== 'meal_decomposition' && tuple.decompositionRevisionId)
    ) {
      return { details, previewsByItemId, stale: true };
    }
    if (isCompositePreviewIdentity(preview.identity))
      previewsByItemId.set(root.id, preview.identity);
    if (!tuple.decompositionRevisionId) continue;
    const [decomposition] = await database
      .select({
        id: mealDecompositionRevisions.id,
        rootMappingDecisionId: mealDecompositionRevisions.rootMappingDecisionId,
        rootCalculationPreviewId: mealDecompositionRevisions.rootCalculationPreviewId,
      })
      .from(mealDecompositionRevisions)
      .where(and(
        eq(mealDecompositionRevisions.id, tuple.decompositionRevisionId),
        eq(mealDecompositionRevisions.mealLogId, mealLogId),
      ))
      .orderBy(desc(mealDecompositionRevisions.revision), desc(mealDecompositionRevisions.id))
      .for('update')
      .limit(1);
    if (
      !decomposition ||
      decomposition.rootMappingDecisionId !== decision.id ||
      decomposition.rootCalculationPreviewId !== preview.id
    ) {
      details.push({ itemId: root.id, code: 'MEAL_DECOMPOSITION_STALE' });
      continue;
    }
  }
  return { details, previewsByItemId, stale: details.length > 0 };
}

async function selectPreviewLeaves(
  database: Database,
  identity: unknown,
  catalogReleaseId: string,
) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity))
    return null;
  const leaves = (identity as { leaves?: unknown }).leaves;
  if (!Array.isArray(leaves) || leaves.length === 0) return null;
  const adapter = catalogEligibilityAdapter(database);
  const selected = [];
  for (const leaf of leaves) {
    if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) return null;
    const value = leaf as { foodId?: unknown; unit?: unknown };
    if (typeof value.foodId !== 'string' ||
      !['g', 'ml', 'serving', 'bowl', 'piece'].includes(String(value.unit)))
      return null;
    const result = await selectTrustedNutrition(adapter, {
      catalogReleaseId,
      foodId: value.foodId,
      unit: value.unit as 'g' | 'ml' | 'serving' | 'bowl' | 'piece',
    });
    if (result.kind !== 'selected') return null;
    selected.push(result);
  }
  return selected;
}

/** Compares the immutable preview's complete authority tuple with fresh selector output. */
function previewFactsMatch(selected: Awaited<ReturnType<typeof selectPreviewLeaves>>, identity: unknown) {
  if (!selected || !identity || typeof identity !== 'object' || Array.isArray(identity))
    return false;
  const leaves = (identity as { leaves?: unknown }).leaves;
  if (!Array.isArray(leaves) || leaves.length !== selected.length) return false;
  return leaves.every((leaf, index) => {
    if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) return false;
    const actual = leaf as Record<string, unknown>;
    const fresh = selected[index]!;
    return actual.foodId === fresh.food.id &&
      actual.nutrientProfileId === fresh.profile.id &&
      actual.sourceItemId === fresh.profile.sourceItemId &&
      actual.profileQualityGrade === fresh.profile.qualityGrade &&
      actual.servingId === (fresh.serving?.id ?? null) &&
      actual.servingAmountMilliunits ===
        (fresh.serving?.amountMilliunits ?? null) &&
      actual.servingGramsMg === (fresh.serving?.gramsMg ?? null) &&
      actual.servingSourceRegistryId ===
        (fresh.serving?.sourceRegistryId ?? null) &&
      actual.servingQualityGrade === (fresh.serving?.qualityGrade ?? null) &&
      actual.sourceRegistryId === fresh.profile.sourceRegistryId &&
      actual.sourceReleaseId === fresh.provenance.sourceReleaseId &&
      actual.sourceReleaseVersion === fresh.provenance.sourceReleaseVersion &&
      actual.catalogReleaseId === fresh.provenance.catalogReleaseId &&
      actual.catalogManifestSha256 ===
        fresh.provenance.catalogManifestSha256 &&
      JSON.stringify(actual.nutrientProfile) === JSON.stringify({
        basisAmountMg: fresh.profile.basisAmountMg,
        energyMillicalories: fresh.profile.energyMillicalories,
        carbohydrateMg: fresh.profile.carbohydrateMg,
        proteinMg: fresh.profile.proteinMg,
        fatMg: fresh.profile.fatMg,
        fiberMg: fresh.profile.fiberMg,
      });
  });
}

async function previewAuthorityFactsMatch(
  database: Database,
  identity: unknown,
  catalogReleaseId: string,
  releaseActivationId: string,
  decomposition: {
    id: string;
    rootMappingDecisionId: string;
    rootCalculationPreviewId: string;
  } | undefined,
) {
  if (!previewFactsMatch(
    await selectPreviewLeaves(database, identity, catalogReleaseId),
    identity,
  )) return false;
  const basis = identity && typeof identity === 'object' && !Array.isArray(identity)
    ? (identity as { basis?: unknown }).basis
    : null;
  if (basis !== 'meal_decomposition') return !decomposition;
  if (!decomposition) return false;
  const decompositionLeaves = (identity as { leaves?: unknown }).leaves;
  const components = await database
    .select({
      ordinal: mealDecompositionComponents.ordinal,
      mappingDecisionId: mealDecompositionComponents.mappingDecisionId,
      calculationPreviewId: mealDecompositionComponents.calculationPreviewId,
      edibleAmountMg: mealDecompositionComponents.edibleAmountMg,
    })
    .from(mealDecompositionComponents)
    .where(eq(mealDecompositionComponents.mealDecompositionRevisionId, decomposition.id))
    .orderBy(asc(mealDecompositionComponents.ordinal));
  if (
    components.length === 0 ||
    components.length > 12 ||
    !Array.isArray(decompositionLeaves) ||
    decompositionLeaves.length !== components.length ||
    components.some((component, index) => component.ordinal !== index)
  ) return false;
  for (const [index, component] of components.entries()) {
    const [componentDecision] = await database
      .select({
        id: mappingDecisions.id,
        catalogReleaseId: mappingDecisions.catalogReleaseId,
        releaseActivationId: mappingDecisions.releaseActivationId,
        selectedFoodId: mappingDecisions.selectedFoodId,
        status: mappingDecisions.status,
      })
      .from(mappingDecisions)
      .where(eq(mappingDecisions.id, component.mappingDecisionId))
      .limit(1);
    const [componentPreview] = await database
      .select({
        id: calculationPreviews.id,
        rootMappingDecisionId: calculationPreviews.rootMappingDecisionId,
        catalogReleaseId: calculationPreviews.catalogReleaseId,
        releaseActivationId: calculationPreviews.releaseActivationId,
        identity: calculationPreviews.identity,
      })
      .from(calculationPreviews)
      .where(eq(calculationPreviews.id, component.calculationPreviewId))
      .limit(1);
    if (
      !componentDecision ||
      componentDecision.status !== 'selected' ||
      !componentDecision.selectedFoodId ||
      !componentPreview ||
      !isComponentPreviewIdentityCurrent(
        componentPreview.identity,
        componentDecision.id,
        catalogReleaseId,
        releaseActivationId,
      ) ||
      componentPreview.rootMappingDecisionId !== componentDecision.id ||
      componentDecision.catalogReleaseId !== catalogReleaseId ||
      componentDecision.releaseActivationId !== releaseActivationId ||
      componentPreview.catalogReleaseId !== catalogReleaseId ||
      componentPreview.releaseActivationId !== releaseActivationId
    ) return false;
    const componentLeaf = componentPreview.identity &&
      typeof componentPreview.identity === 'object' &&
      !Array.isArray(componentPreview.identity)
      ? (componentPreview.identity as { leaves?: Array<Record<string, unknown>> }).leaves?.[0]
      : null;
    const decompositionLeaf = decompositionLeaves[index];
    if (
      !decompositionLeaf ||
      typeof decompositionLeaf !== 'object' ||
      Array.isArray(decompositionLeaf) ||
      (decompositionLeaf as Record<string, unknown>).componentIdentity !== component.mappingDecisionId ||
      (decompositionLeaf as Record<string, unknown>).foodId !== componentDecision.selectedFoodId ||
      (decompositionLeaf as Record<string, unknown>).edibleAmountMg !== component.edibleAmountMg ||
      !componentLeaf ||
      JSON.stringify(decompositionLeaf) !== JSON.stringify({ ...componentLeaf, ordinal: index }) ||
      !previewFactsMatch(
        await selectPreviewLeaves(database, componentPreview.identity, catalogReleaseId),
        componentPreview.identity,
      )
    ) return false;
  }
  return true;
}

function isPreviewIdentityCurrent(
  identity: unknown,
  rootMappingDecisionId: string,
  rootRevision: number,
  catalogReleaseId: string,
  releaseActivationId: string,
) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  const value = identity as Record<string, unknown>;
  if (
    value.rootMappingDecisionId !== rootMappingDecisionId ||
    value.rootRevision !== rootRevision ||
    value.catalogReleaseId !== catalogReleaseId ||
    value.releaseActivationId !== releaseActivationId ||
    !Array.isArray(value.leaves) ||
    value.leaves.length === 0
  ) return false;
  return value.leaves.every((leaf, ordinal) => {
    if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) return false;
    const provenance = leaf as Record<string, unknown>;
    return provenance.ordinal === ordinal &&
      provenance.catalogReleaseId === catalogReleaseId &&
      typeof provenance.foodId === 'string' &&
      typeof provenance.nutrientProfileId === 'string' &&
      typeof provenance.sourceReleaseId === 'string' &&
      typeof provenance.edibleAmountMg === 'number' &&
      provenance.edibleAmountMg > 0;
  });
}

function isComponentPreviewIdentityCurrent(
  identity: unknown,
  rootMappingDecisionId: string,
  catalogReleaseId: string,
  releaseActivationId: string,
) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  const value = identity as Record<string, unknown>;
  return value.rootMappingDecisionId === rootMappingDecisionId &&
    typeof value.rootRevision === 'number' &&
    value.rootRevision > 0 &&
    value.catalogReleaseId === catalogReleaseId &&
    value.releaseActivationId === releaseActivationId &&
    Array.isArray(value.leaves) &&
    value.leaves.length > 0;
}
function nutritionPreviewResponse(
  nutrition: {
    items: Array<{
      mealItemId: string;
      gramsMg: number | null;
      nutrients: Record<
        (typeof nutritionKeysForComposition)[number],
        number | null
      >;
    }>;
    totals: Record<
      (typeof nutritionKeysForComposition)[number],
      {
        value: number | null;
        knownValue: number;
        missingItemCount: number;
        completeness: 'complete' | 'partial';
      }
    >;
  },
  resolutionsByItemId: Map<string, Awaited<ReturnType<typeof resolveCurrentMealItems>>[number]>,
) {
  const items = nutrition.items.map((item) => {
    const resolution = resolutionsByItemId.get(item.mealItemId);
    const profile = resolution?.profile;
    return {
      mealItemId: item.mealItemId,
      gramsMg: item.gramsMg,
      nutrients: item.nutrients,
      source: {
        foodId: resolution?.food?.id ?? null,
        nutrientProfileId: profile?.id ?? null,
        sourceRegistryId: profile?.sourceRegistryId ?? null,
        sourceItemId: profile?.sourceItemId ?? null,
        datasetVersion: profile?.datasetVersion ?? null,
        qualityGrade: profile?.qualityGrade ?? null,
        servingId: resolution?.serving?.id ?? null,
        servingSourceRegistryId:
          resolution?.serving?.sourceRegistryId ?? null,
        servingQualityGrade: resolution?.serving?.qualityGrade ?? null,
      },
    };
  });
  const aggregate = (
    key: 'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
    value: number | null,
  ) => {
    const missingItemCount = items.filter((item) => item.nutrients[key] === null).length;
    const knownValue = items.reduce((total, item) => total + (item.nutrients[key] ?? 0), 0);
    return { value: missingItemCount === 0 ? value : null, knownValue, missingItemCount, completeness: missingItemCount === 0 ? 'complete' as const : 'partial' as const };
  };
  return {
    id: 'preview',
    calculationVersion: 'meal-nutrition-v1-preview',
    calculatedAt: new Date().toISOString(),
    items,
    totals: {
      energyMillicalories: aggregate('energyMillicalories', nutrition.totals.energyMillicalories.value),
      carbohydrateMg: aggregate('carbohydrateMg', nutrition.totals.carbohydrateMg.value),
      proteinMg: aggregate('proteinMg', nutrition.totals.proteinMg.value),
      fatMg: aggregate('fatMg', nutrition.totals.fatMg.value),
      fiberMg: aggregate('fiberMg', nutrition.totals.fiberMg.value),
    },
  };
}
function resolverReasonToReviewReason(reason: string) {
  return ({
    MISSING_MAPPING: 'FOOD_MAPPING_MISSING',
    MISSING_FOOD: 'FOOD_NOT_FOUND',
    DEPRECATED_FOOD: 'FOOD_DEPRECATED',
    MISSING_PROFILE: 'NUTRIENT_PROFILE_MISSING',
    MISMATCHED_PROFILE: 'NUTRIENT_PROFILE_MISMATCHED',
    UNTRUSTED_PROFILE_SOURCE: 'NUTRIENT_PROFILE_UNTRUSTED',
    INCOMPLETE_PROFILE: 'CORE_NUTRIENTS_MISSING',
    MISSING_SERVING_CONVERSION: 'SERVING_CONVERSION_MISSING',
    UNTRUSTED_SERVING_SOURCE: 'SERVING_CONVERSION_UNTRUSTED',
    AMBIGUOUS_SERVING_CONVERSION: 'SERVING_CONVERSION_AMBIGUOUS',
  } as Record<string, string>)[reason] ?? 'FOOD_MAPPING_MISSING';
}

async function findUserTimezone(database: Database, userId: string) {
  const [profile] = await database
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return profile?.timezone ?? null;
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
function inferMealType(value: Date, timezone: string) {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(value)
    .find((part) => part.type === 'hour')?.value;
  const hour = Number(hourPart);
  if (!Number.isInteger(hour)) throw new Error('Unable to infer meal type');
  if (hour >= 5 && hour <= 10) return 'breakfast' as const;
  if (hour >= 11 && hour <= 15) return 'lunch' as const;
  if (hour >= 16 && hour <= 21) return 'dinner' as const;
  return 'snack' as const;
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

function applyMealConfirmationCutover(
  request: FastifyRequest,
  reply: FastifyReply,
  options: MealLogRouteOptions,
) {
  const protocol = request.headers['x-nueat-meal-confirmation-protocol'];
  const decision = classifyMealConfirmationCutover(
    typeof protocol === 'string' ? protocol : undefined,
    options.mealConfirmationCutover,
  );
  if (decision.action === 'proceed') return true;
  if (decision.statusCode === 503)
    reply.header('Retry-After', String(decision.retryAfterSeconds));
  reply.status(decision.statusCode).send({
    error: {
      code: decision.errorCode,
      message:
        decision.statusCode === 426
          ? '식사 확인 프로토콜을 업데이트해야 합니다.'
          : '식사 확인 기능을 점검 중입니다.',
      ...(decision.statusCode === 426
        ? { details: { requiredProtocol: decision.requiredProtocol } }
        : {}),
      requestId: request.id,
    },
  });
  return false;
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
function staleMealConfirmation(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(409).send({
    error: {
      code: 'STALE_MEAL_CONFIRMATION',
      message: '식사 초안 또는 영양 근거가 변경되어 확인할 수 없습니다.',
      requestId: request.id,
    },
  });
}
function invalidMealConfirmation(
  reply: FastifyReply,
  request: FastifyRequest,
  details: Array<{ itemId?: string; code: string }>,
) {
  return reply.status(409).send({
    error: {
      code: 'MEAL_CONFIRMATION_INVALID',
      message: '식사 항목의 영양 정보를 확정할 수 없습니다.',
      details: { items: details },
      requestId: request.id,
    },
  });
}
function mealConfirmationRetryable(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(409).send({
    error: {
      code: 'MEAL_CONFIRMATION_RETRY',
      message: '식사 확정이 동시에 처리되었습니다. 다시 시도해 주세요.',
      retryable: true,
      details: { items: [] },
      requestId: request.id,
    },
  });
}

function foodNutrientProfileUnavailable(
  reply: FastifyReply,
  request: FastifyRequest,
  reason?: string,
) {
  return reply.status(409).send({
    error: {
      code: 'FOOD_NUTRIENT_PROFILE_UNAVAILABLE',
      message: '사용 가능한 영양 정보를 찾을 수 없습니다.',
      ...(reason ? { details: { reason } } : {}),
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
async function sendStaleMealResponse(
  database: Database,
  reviewPolicy: ApiEnvironment['mealRecognition']['reviewPolicy'],
  recoveryPolicy: RecognitionRecoveryPolicy,
  recognitionCoordinator: MealRecognitionRunner,
  reply: FastifyReply,
  request: FastifyRequest,
  code: 'MEAL_DRAFT_STALE' | 'MEAL_ITEM_STALE',
  latest: { mealLog: unknown; items: unknown[] },
) {
  const mealLog = latest.mealLog;
  const items = latest.items;
  const fullLatest = mealLog && Array.isArray(items)
    ? await buildMealLogResponse(
        database,
        mealLog as Record<string, any>,
        items as Array<Record<string, any>>,
        reviewPolicy,
        recoveryPolicy,
        recognitionCoordinator,
      )
    : latest;
  return reply.status(409).send({
    error: {
      code,
      message: '식사 초안이 다른 변경으로 최신 상태가 아닙니다.',
      details: { latest: fullLatest },
      requestId: request.id,
    },
  });
}
