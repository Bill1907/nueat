import {
  assetDeletionJobs,
  calculationSnapshots,
  imageAssets,
  mealItems,
  mealLogs,
  userProfiles,
  isRecognitionResultV2,
  type Database,
} from '@nueat/database';
import {
  calculateMealNutrition,
  deriveItemReviewState,
  deriveMealReviewState,
  NutritionCalculationError,
  MEAL_ESTIMATE_REVIEW_POLICY_VERSION,
  MEAL_ESTIMATE_REVIEW_THRESHOLDS,
  type CalculatedNutritionValues,
  type MealNutritionInput,
} from '@nueat/domain';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';
import type { ApiEnvironment } from '../config/env';
import type { MealRecognitionRunner } from '../services/meal-recognition-coordinator';
import {
  resolveCurrentMealItems,
  resolveFoodSelection,
} from '../services/meal-item-resolution';

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
  items: z.array(z.object({
    itemId: z.uuid(),
    expectedItemRevision: z.int().positive(),
  }).strict()),
}).strict();
const reviewMealSchema = z.object({
  expectedDraftRevision: z.int().positive(),
  items: z.array(z.object({
    itemId: z.uuid(),
    expectedItemRevision: z.int().positive(),
    foodAcknowledgedRevision: z.int().positive().optional(),
    portionAcknowledgedRevision: z.int().positive().optional(),
  }).strict()).min(1),
}).strict();

interface MealLogRouteOptions {
  auth: Auth;
  database: Database;
  recognitionCoordinator: MealRecognitionRunner;
  reviewPolicy: ApiEnvironment['mealRecognition']['reviewPolicy'];
}
type ReviewPolicyConfig = ApiEnvironment['mealRecognition']['reviewPolicy'];
const resolutionReviewReasonCodes = new Set([
  'FOOD_MAPPING_MISSING',
  'FOOD_NOT_FOUND',
  'FOOD_DEPRECATED',
  'NUTRIENT_PROFILE_MISSING',
  'NUTRIENT_PROFILE_MISMATCHED',
  'NUTRIENT_PROFILE_UNTRUSTED',
  'CORE_NUTRIENTS_MISSING',
  'SERVING_CONVERSION_MISSING',
  'SERVING_CONVERSION_AMBIGUOUS',
  'SERVING_CONVERSION_UNTRUSTED',
]);

export const mealLogRoutes: FastifyPluginAsync<MealLogRouteOptions> = async (
  app,
  options,
) => {
  const mealLogResponse = (
    database: Database,
    mealLog: any,
    items: any[],
  ) => buildMealLogResponse(database, mealLog, items, options.reviewPolicy);
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
    },
    createdStatus?: number,
  ) => sendRecognitionResponse(
    database,
    options.reviewPolicy,
    reply,
    mealLog,
    items,
    outcome,
    createdStatus,
  );
  const staleMealResponse = (
    database: Database,
    reply: FastifyReply,
    request: FastifyRequest,
    code: 'MEAL_DRAFT_STALE' | 'MEAL_ITEM_STALE',
    latest: { mealLog: unknown; items: unknown[] },
  ) => sendStaleMealResponse(
    database,
    options.reviewPolicy,
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
      const outcome = await options.recognitionCoordinator.recognize(
        existing.id,
        userId,
      );
      const current = await findOwnedMealLog(options.database, existing.id, userId);
      if (!current) return mealLogNotFound(reply, request);
      return recognitionResponse(
        options.database,
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
      const outcome = await options.recognitionCoordinator.recognize(
        concurrent.id,
        userId,
      );
      const current = await findOwnedMealLog(options.database, concurrent.id, userId);
      if (!current) return mealLogNotFound(reply, request);
      return recognitionResponse(
        options.database,
        reply,
        current,
        await findMealItems(options.database, current.id),
        outcome,
      );
    }
    const outcome = await options.recognitionCoordinator.recognize(mealLog.id, userId);
    const current = await findOwnedMealLog(options.database, mealLog.id, userId);
    if (!current) return mealLogNotFound(reply, request);
    return recognitionResponse(options.database, reply, current, await findMealItems(options.database, current.id), outcome, 201);
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
    return await mealLogResponse(options.database, mealLog, items);
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
    return await mealLogResponse(options.database, mealLog, items);
  });

  app.post('/api/meal-logs/:mealLogId/items', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
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
        isRecognitionResultV2(mealLog.recognitionResult) &&
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
        .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
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
                  foodAcknowledgedRevision: null,
                }
              : {}),
            ...(amountChanged ? { amountMilliunits: changes.amountMilliunits } : {}),
            ...(unitChanged ? { unit: changes.unit } : {}),
            itemRevision: sql`${mealItems.itemRevision} + 1`,
            ...(foodChanged
              ? { foodRevision: sql`${mealItems.foodRevision} + 1` }
              : {}),
            ...(portionChanged
              ? {
                  portionRevision: sql`${mealItems.portionRevision} + 1`,
                  portionAcknowledgedRevision: sql`${mealItems.portionRevision} + 1`,
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
        const selection = await resolveFoodSelection(tx, body.data.foodId);
        if (selection.kind === 'food_not_found')
          return { kind: 'food_not_found' as const };
        if (selection.kind === 'profile_unavailable')
          return { kind: 'profile_unavailable' as const };
        if (
          currentItem.foodId === selection.food.id &&
          currentItem.nutrientProfileId === selection.nutrientProfileId
        ) {
          const items = await tx.select(mealItemSelection).from(mealItems)
            .where(eq(mealItems.mealLogId, mealLog.id))
            .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
          return { kind: 'mapped' as const, mealLog, items };
        }

        const [item] = await tx
          .update(mealItems)
          .set({
            recognizedLabel: selection.food.canonicalNameKo,
            foodId: selection.food.id,
            nutrientProfileId: selection.nutrientProfileId,
            mappingConfidenceBps: 10_000,
            currentResolutionSource: 'user_selected',
            itemRevision: sql`${mealItems.itemRevision} + 1`,
            foodRevision: sql`${mealItems.foodRevision} + 1`,
            foodAcknowledgedRevision: sql`${mealItems.foodRevision} + 1`,
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
      if (mapped.kind === 'food_not_found') return foodNotFound(reply, request);
      if (mapped.kind === 'profile_unavailable')
        return foodNutrientProfileUnavailable(reply, request);
      return await mealLogResponse(options.database, mapped.mealLog, mapped.items);
    },
  );
  app.post('/api/meal-logs/:mealLogId/review', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    const body = reviewMealSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request);
    const result = await options.database.transaction(async (tx) => {
      const [mealLog] = await tx.select(mealLogSelection).from(mealLogs).where(and(eq(mealLogs.id, params.data.mealLogId), eq(mealLogs.userId, userId))).for('update').limit(1);
      if (!mealLog) return { kind: 'not_found' as const };
      const items = await tx.select(mealItemSelection).from(mealItems).where(eq(mealItems.mealLogId, mealLog.id)).orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
      if (mealLog.status !== 'draft' || mealLog.draftRevision !== body.data.expectedDraftRevision) return { kind: 'stale' as const, mealLog, items };
      const requested = new Map(body.data.items.map((item) => [item.itemId, item]));
      const targets = items.filter((item) => requested.has(item.id));
      if (targets.length !== body.data.items.length || targets.some((item) => requested.get(item.id)!.expectedItemRevision !== item.itemRevision)) return { kind: 'stale' as const, mealLog, items };
      if (targets.some((item) => {
        const acknowledgement = requested.get(item.id)!;
        return (
          (acknowledgement.foodAcknowledgedRevision !== undefined &&
            acknowledgement.foodAcknowledgedRevision !== item.foodRevision) ||
          (acknowledgement.portionAcknowledgedRevision !== undefined &&
            acknowledgement.portionAcknowledgedRevision !== item.portionRevision)
        );
      })) return { kind: 'stale' as const, mealLog, items };
      const resolutions = await resolveCurrentMealItems(tx, targets);
      if (resolutions.some((resolution) => resolution.reason !== null)) return { kind: 'unacknowledgeable' as const };
      const changesAcknowledgement = targets.some((item) => {
        const acknowledgement = requested.get(item.id)!;
        return (
          (acknowledgement.foodAcknowledgedRevision !== undefined &&
            item.foodAcknowledgedRevision !== item.foodRevision) ||
          (acknowledgement.portionAcknowledgedRevision !== undefined &&
            item.portionAcknowledgedRevision !== item.portionRevision)
        );
      });
      if (!changesAcknowledgement)
        return { kind: 'reviewed' as const, mealLog, items };
      for (const item of targets) {
        const acknowledgement = requested.get(item.id)!;
        await tx.update(mealItems).set({
          ...(acknowledgement.foodAcknowledgedRevision === undefined ? {} : { foodAcknowledgedRevision: item.foodRevision }),
          ...(acknowledgement.portionAcknowledgedRevision === undefined ? {} : { portionAcknowledgedRevision: item.portionRevision }),
          itemRevision: sql`${mealItems.itemRevision} + 1`,
          updatedAt: new Date(),
        }).where(eq(mealItems.id, item.id));
      }
      const [updatedMealLog] = await tx.update(mealLogs).set({ draftRevision: sql`${mealLogs.draftRevision} + 1`, updatedAt: new Date() }).where(eq(mealLogs.id, mealLog.id)).returning(mealLogSelection);
      if (!updatedMealLog) throw new Error('Draft meal disappeared while reviewing');
      const updatedItems = await tx.select(mealItemSelection).from(mealItems).where(eq(mealItems.mealLogId, mealLog.id)).orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
      return { kind: 'reviewed' as const, mealLog: updatedMealLog, items: updatedItems };
    });
    if (result.kind === 'not_found') return mealLogNotFound(reply, request);
    if (result.kind === 'unacknowledgeable') return reply.status(409).send({ error: { code: 'MEAL_REVIEW_NOT_ACKNOWLEDGEABLE', message: '해결되지 않은 영양 근거는 확인할 수 없습니다.', requestId: request.id } });
    if (result.kind === 'stale') return await staleMealResponse(options.database, reply, request, 'MEAL_ITEM_STALE', result);
    return await mealLogResponse(options.database, result.mealLog, result.items);
  });
  app.post('/api/meal-logs/:mealLogId/confirm', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
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
        .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
      const [snapshot] = await tx
        .select(calculationSnapshotSelection)
        .from(calculationSnapshots)
        .where(eq(calculationSnapshots.mealLogId, mealLog.id))
        .orderBy(desc(calculationSnapshots.sequence))
        .limit(1);

      if (mealLog.status === 'draft' && mealLog.draftRevision !== body.data.expectedDraftRevision)
        return { kind: 'stale' as const, mealLog, items };
      const expectedItems = new Map(body.data.items.map((item) => [item.itemId, item.expectedItemRevision]));
      if (
        expectedItems.size !== items.length ||
        items.some((item) => expectedItems.get(item.id) !== item.itemRevision)
      ) return { kind: 'stale' as const, mealLog, items };
      if (mealLog.status === 'confirmed')
        return snapshot
          ? { kind: 'confirmed' as const, mealLog, items, snapshot }
          : { kind: 'invalid_state' as const };
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
      const authoritativeReview = await mealLogResponse(tx as unknown as Database, mealLog, items);
      const policyBlockingReasons = authoritativeReview.review.reasons.filter(
        (reason) => !resolutionReviewReasonCodes.has(reason.code),
      );
      if (policyBlockingReasons.length > 0)
        return {
          kind: 'invalid' as const,
          details: policyBlockingReasons,
        };

      const resolvedNutrition = await calculateResolvedMealNutrition(tx, items);
      if ('details' in resolvedNutrition) return { kind: 'invalid' as const, details: resolvedNutrition.details };
      const { nutrition, resolutionsByItemId } = resolvedNutrition;

      const now = new Date();
      const calculatedByItemId = new Map(
        nutrition.items.map((item) => [item.mealItemId, item]),
      );
      for (const item of items) {
        await tx
          .update(mealItems)
          .set({ gramsMg: calculatedByItemId.get(item.id)!.gramsMg, updatedAt: now })
          .where(eq(mealItems.id, item.id));
      }

      const [createdSnapshot] = await tx
        .insert(calculationSnapshots)
        .values({
          mealLogId: mealLog.id,
          sequence: snapshot ? snapshot.sequence + 1 : 1,
          inputSnapshot: {
            confirmationDecision: {
              originalRecognition: isRecognitionResultV2(mealLog.recognitionResult) && mealLog.recognitionProvider && mealLog.recognitionModel && mealLog.recognitionPromptVersion && mealLog.recognitionSchemaVersion && mealLog.recognitionCompletedAt
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
              manualOverride: mealLog.recognitionManualOverride ?? null,
              policy: {
                version: MEAL_ESTIMATE_REVIEW_POLICY_VERSION,
                activation: options.reviewPolicy.mode,
                approvedReportSha256: options.reviewPolicy.approvedReportSha256 ?? null,
                activeReportSha256: options.reviewPolicy.activeReportSha256 ?? null,
                approvedReportVersion: options.reviewPolicy.approvedReportVersion ?? null,
              },
            },
            mealItems: items.map((item) => {
              const resolution = resolutionsByItemId.get(item.id)!;
              const profile = resolution.profile!;
              const serving = resolution.serving;
              const calculated = calculatedByItemId.get(item.id)!;
              return {
                mealItemId: item.id,
                origin: item.origin,
                initialEstimateAssessment: item.initialEstimateAssessment,
                currentResolutionSource: item.currentResolutionSource,
                itemRevision: item.itemRevision,
                foodRevision: item.foodRevision,
                portionRevision: item.portionRevision,
                foodAcknowledgedRevision: item.foodAcknowledgedRevision,
                portionAcknowledgedRevision: item.portionAcknowledgedRevision,
                foodId: resolution.food!.id,
                nutrientProfileId: profile.id,
                amountMilliunits: item.amountMilliunits,
                unit: item.unit,
                gramsMg: calculated.gramsMg,
                sourceRegistryId: profile.sourceRegistryId,
                sourceItemId: profile.sourceItemId,
                datasetVersion: profile.datasetVersion,
                nutrientProfileQualityGrade: profile.qualityGrade,
                nutrientProfile: {
                  basisAmountMg: profile.basisAmountMg,
                  energyMillicalories: profile.energyMillicalories!,
                  carbohydrateMg: profile.carbohydrateMg!,
                  proteinMg: profile.proteinMg!,
                  fatMg: profile.fatMg!,
                  fiberMg: profile.fiberMg,
                },
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
                nutrients: requireCompleteCoreNutrients(calculated.nutrients),
              };
            }),
          },
          energyMillicalories: nutrition.totals.energyMillicalories.value!,
          carbohydrateMg: nutrition.totals.carbohydrateMg.value!,
          proteinMg: nutrition.totals.proteinMg.value!,
          fatMg: nutrition.totals.fatMg.value!,
          fiberMg: nutrition.totals.fiberMg.value,
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
      return await staleMealResponse(options.database, reply, request, 'MEAL_DRAFT_STALE', {
        mealLog: latest,
        items: await findMealItems(options.database, latest.id),
      });
    }
    if (confirmed.kind === 'not_found') return mealLogNotFound(reply, request);
    if (confirmed.kind === 'invalid_state') return invalidMealLogState(reply, request);
    if (confirmed.kind === 'invalid')
      return invalidMealConfirmation(reply, request, confirmed.details);
    return {
      ...(await mealLogResponse(options.database, confirmed.mealLog, confirmed.items)),
      nutrition: nutritionSnapshotResponse(confirmed.snapshot),
    };
  });

  app.delete(
    '/api/meal-logs/:mealLogId/items/:itemId',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
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
    return recognitionResponse(options.database, reply, mealLog, await findMealItems(options.database, mealLog.id), outcome);
  });

  app.post('/api/meal-logs/:mealLogId/recognition/manual', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
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
        isRecognitionResultV2(existing.recognitionResult) &&
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
        fromOutcome: isRecognitionResultV2(existing.recognitionResult)
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
  reviewPolicy: ReviewPolicyConfig,
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
    return reply.status(202).send({
      ...(await buildMealLogResponse(database, mealLog, items, reviewPolicy)),
      recognitionOutcome,
    });
  }
  return reply.status(createdStatus ?? 200).send({
    ...(await buildMealLogResponse(database, mealLog, items, reviewPolicy)),
    recognitionOutcome,
  });
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
  recognitionResult: mealLogs.recognitionResult,
  recognitionManualOverride: mealLogs.recognitionManualOverride,
  draftRevision: mealLogs.draftRevision,
  confirmedAt: mealLogs.confirmedAt,
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
  gramsMg: mealItems.gramsMg,
  origin: mealItems.origin,
  initialEstimateAssessment: mealItems.initialEstimateAssessment,
  currentResolutionSource: mealItems.currentResolutionSource,
  itemRevision: mealItems.itemRevision,
  foodRevision: mealItems.foodRevision,
  portionRevision: mealItems.portionRevision,
  foodAcknowledgedRevision: mealItems.foodAcknowledgedRevision,
  portionAcknowledgedRevision: mealItems.portionAcknowledgedRevision,
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
  calculationVersion: calculationSnapshots.calculationVersion,
  calculatedAt: calculationSnapshots.calculatedAt,
};
function requireCompleteCoreNutrients(
  nutrients: CalculatedNutritionValues,
): {
  energyMillicalories: number;
  carbohydrateMg: number;
  proteinMg: number;
  fatMg: number;
  fiberMg: number | null;
} {
  if (
    nutrients.energyMillicalories === null ||
    nutrients.carbohydrateMg === null ||
    nutrients.proteinMg === null ||
    nutrients.fatMg === null
  )
    throw new Error('Validated nutrient profile produced incomplete core nutrients');
  return {
    energyMillicalories: nutrients.energyMillicalories,
    carbohydrateMg: nutrients.carbohydrateMg,
    proteinMg: nutrients.proteinMg,
    fatMg: nutrients.fatMg,
    fiberMg: nutrients.fiberMg,
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
  const items = snapshot.inputSnapshot.mealItems.map((item) => ({
    mealItemId: item.mealItemId,
    amountMilliunits: item.amountMilliunits,
    unit: item.unit,
    gramsMg: item.gramsMg,
    nutrients: item.nutrients,
    source: {
      foodId: item.foodId,
      nutrientProfileId: item.nutrientProfileId,
      sourceRegistryId: item.sourceRegistryId,
      sourceItemId: item.sourceItemId,
      datasetVersion: item.datasetVersion,
      qualityGrade: item.nutrientProfileQualityGrade,
      servingId: item.serving?.id ?? null,
      servingSourceRegistryId: item.serving?.sourceRegistryId ?? null,
      servingQualityGrade: item.serving?.qualityGrade ?? null,
    },
  }));
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

async function buildMealLogResponse(
  database: Database,
  mealLog: any,
  items: any[],
  reviewPolicy: ReviewPolicyConfig,
) {
  const resolutions = await resolveCurrentMealItems(database, items);
  const resolutionByItemId = new Map(resolutions.map((resolution) => [resolution.itemId, resolution]));
  const recognition = isRecognitionResultV2(mealLog.recognitionResult)
    ? mealLog.recognitionResult
    : null;
  const imageQualityConfidenceBps = recognition?.imageQualityConfidenceBps ?? null;
  const policy = {
    version: MEAL_ESTIMATE_REVIEW_POLICY_VERSION,
    activation: reviewPolicy.mode,
    ...MEAL_ESTIMATE_REVIEW_THRESHOLDS,
  } as const;
  const responseItems = items.map((item) => {
    const resolution = resolutionByItemId.get(item.id);
    const hardReasons = resolution?.reason ? [resolverReasonToReviewReason(resolution.reason)] : [];
    const currentResolution = {
      mappingSource: item.currentResolutionSource,
      foodId: resolution?.food?.id ?? null,
      nutrientProfileId: resolution?.profile?.id ?? null,
      hardReasons,
      requiresServingConversion: item.unit !== 'g',
      hasTrustedServingConversion: item.unit === 'g' || !!resolution?.serving,
      hasCoreNutrients: !!resolution?.profile,
    };
    const review = deriveItemReviewState({
      origin: item.origin,
      itemRevision: item.itemRevision,
      foodRevision: item.foodRevision,
      portionRevision: item.portionRevision,
      foodAcknowledgedRevision: item.foodAcknowledgedRevision,
      portionAcknowledgedRevision: item.portionAcknowledgedRevision,
      initialEstimateAssessment: item.initialEstimateAssessment,
      currentResolution,
      imageQualityConfidenceBps,
      policy,
    });
    return {
      ...item,
      initialAssessment: item.initialEstimateAssessment ?? null,
      currentResolution: {
        status: resolution?.reason === null ? 'resolved' as const : 'unresolved' as const,
        reason: resolution?.reason === null
          ? null
          : resolverReasonToReviewReason(resolution?.reason ?? 'MISSING_MAPPING'),
        raw: item.initialEstimateAssessment?.rawLabel ?? item.recognizedLabel,
        matched: item.initialEstimateAssessment?.initialMatchedLabel ?? null,
        canonical: resolution?.food?.canonicalNameKo ?? null,
        food: resolution?.food ?? null,
        profile: resolution?.profile ?? null,
        serving: resolution?.serving ?? null,
      },
      itemReview: review,
    };
  });
  const mealReview = deriveMealReviewState({
    recognition,
    recognitionStatus: mealLog.recognitionStatus,
    manualOverride: mealLog.recognitionManualOverride ?? null,
    items: responseItems.map((item) => ({ origin: item.origin, review: item.itemReview })),
    policy,
  });
  const requiredReviewFields = responseItems.flatMap((item) => {
    const fields = new Set<'food' | 'portion'>();
    if (item.itemReview.foodReasons.length > 0) fields.add('food');
    if (item.itemReview.portionReasons.length > 0) fields.add('portion');
    if (policy.activation !== 'quick_confirm' && item.origin === 'model_estimate') {
      if (!item.itemReview.foodAcknowledged) fields.add('food');
      if (!item.itemReview.portionAcknowledged) fields.add('portion');
    }
    return fields.size === 0
      ? []
      : [{ itemId: item.id, fields: [...fields] }];
  });
  const preview = await calculateResolvedMealNutrition(database, items, resolutions);
  const nutritionPreview = 'details' in preview
    ? null
    : nutritionPreviewResponse(preview.nutrition, resolutionByItemId);
  const publicItems = responseItems.map((item) => ({
    id: item.id,
    recognizedLabel: item.recognizedLabel,
    amountMilliunits: item.amountMilliunits,
    unit: item.unit,
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
    foodAcknowledgedRevision: item.foodAcknowledgedRevision,
    portionAcknowledgedRevision: item.portionAcknowledgedRevision,
    currentResolution: {
      status: item.currentResolution.status,
      reason: item.currentResolution.reason,
    },
  }));
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
      recognitionProvider: mealLog.recognitionProvider,
      recognitionModel: mealLog.recognitionModel,
      recognitionPromptVersion: mealLog.recognitionPromptVersion,
      recognitionSchemaVersion: mealLog.recognitionSchemaVersion,
      recognitionCompletedAt: mealLog.recognitionCompletedAt,
      recognitionLastErrorCode: mealLog.recognitionLastErrorCode,
      recognitionAttemptCount: mealLog.recognitionAttemptCount,
      recognitionNextAttemptAt: mealLog.recognitionNextAttemptAt,
      draftRevision: mealLog.draftRevision,
      confirmedAt: mealLog.confirmedAt,
      recognitionOutcome: recognition?.outcome ?? null,
      recognitionEvidenceReason: recognition?.outcome === 'insufficient_evidence'
        ? recognition.evidenceReason ?? null
        : null,
      recognitionManualOverride: mealLog.recognitionManualOverride
        ? {
            decision: mealLog.recognitionManualOverride.decision,
            decisionVersion: mealLog.recognitionManualOverride.decisionVersion,
            fromStatus: mealLog.recognitionManualOverride.fromStatus,
            fromOutcome: mealLog.recognitionManualOverride.fromOutcome,
            fromErrorCode: mealLog.recognitionManualOverride.fromErrorCode,
            expectedDraftRevision: mealLog.recognitionManualOverride.expectedDraftRevision,
            actorUserId: mealLog.recognitionManualOverride.actorUserId,
            decidedAt: mealLog.recognitionManualOverride.decidedAt,
            changedFields: mealLog.recognitionManualOverride.changedFields,
          }
        : null,
    },
    items: publicItems,
    review: {
      confirmable: mealReview.reasons.length === 0,
      reasons: [
        ...mealReview.reasons
          .filter((code) =>
            code === 'NO_FOOD_DETECTED' ||
            code === 'INSUFFICIENT_IMAGE_EVIDENCE' ||
            code === 'QUICK_CONFIRM_POLICY_DISABLED' ||
            code === 'EMPTY_MEAL')
          .map((code) => ({ code, itemId: null })),
        ...responseItems.flatMap((item) =>
          item.itemReview.reasons.map((code: string) => ({ code, itemId: item.id }))),
      ],
      requiredReviewFields,
      nutrition: nutritionPreview,
    },
  };
}
async function calculateResolvedMealNutrition(
  database: Parameters<typeof resolveCurrentMealItems>[0],
  items: any[],
  resolvedItems?: Awaited<ReturnType<typeof resolveCurrentMealItems>>,
) {
  const resolutions = resolvedItems ?? await resolveCurrentMealItems(database, items);
  const details = resolutions.flatMap((resolution) =>
    resolution.reason === null ? [] : [{ itemId: resolution.itemId, code: resolution.reason }],
  );
  if (details.length > 0) return { details };
  const resolutionsByItemId = new Map(resolutions.map((resolution) => [resolution.itemId, resolution]));
  const inputs: MealNutritionInput[] = items.map((item) => {
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
    if (item.unit === 'g') return base;
    const serving = resolution.serving!;
    return {
      ...base,
      serving: {
        id: serving.id,
        unit: serving.unit as 'ml' | 'serving' | 'bowl' | 'piece',
        amountMilliunits: serving.amountMilliunits,
        gramsMg: serving.gramsMg,
        sourceRegistryId: serving.sourceRegistryId,
        qualityGrade: serving.qualityGrade,
      },
    };
  });
  try {
    return { nutrition: calculateMealNutrition(inputs), resolutionsByItemId };
  } catch (error) {
    return {
      details: [{
        code: error instanceof NutritionCalculationError ? error.code : 'CALCULATION_FAILED',
      }],
    };
  }
}
function nutritionPreviewResponse(
  nutrition: ReturnType<typeof calculateMealNutrition>,
  resolutionsByItemId: Map<string, Awaited<ReturnType<typeof resolveCurrentMealItems>>[number]>,
) {
  const items = nutrition.items.map((item) => {
    const resolution = resolutionsByItemId.get(item.mealItemId)!;
    const profile = resolution.profile!;
    return {
      mealItemId: item.mealItemId,
      gramsMg: item.gramsMg,
      nutrients: requireCompleteCoreNutrients(item.nutrients),
      source: {
        foodId: resolution.food!.id,
        nutrientProfileId: profile.id,
        sourceRegistryId: profile.sourceRegistryId,
        sourceItemId: profile.sourceItemId,
        datasetVersion: profile.datasetVersion,
        qualityGrade: profile.qualityGrade,
        servingId: resolution.serving?.id ?? null,
        servingSourceRegistryId: resolution.serving?.sourceRegistryId ?? null,
        servingQualityGrade: resolution.serving?.qualityGrade ?? null,
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
async function sendStaleMealResponse(
  database: Database,
  reviewPolicy: ReviewPolicyConfig,
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
