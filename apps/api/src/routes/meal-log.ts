import {
  assetDeletionJobs,
  calculationSnapshots,
  foods,
  foodServings,
  imageAssets,
  mealItems,
  mealLogs,
  nutrientProfiles,
  sourceRegistries,
  userProfiles,
  type Database,
} from '@nueat/database';
import {
  calculateMealNutrition,
  NutritionCalculationError,
  type CalculatedNutritionValues,
  type MealNutritionInput,
} from '@nueat/domain';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
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

      await tx
        .insert(mealItems)
        .values({ mealLogId: mealLog.id, ...body.data, userCorrected: true });
      const items = await tx
        .select(mealItemSelection)
        .from(mealItems)
        .where(eq(mealItems.mealLogId, mealLog.id))
        .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
      return { kind: 'created' as const, mealLog, items };
    });
    if (created.kind === 'not_found') return mealLogNotFound(reply, request);
    if (created.kind === 'invalid_state')
      return invalidMealLogState(reply, request);
    return reply.status(201).send(mealLogResponse(created.mealLog, created.items));
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

        const [item] = await tx
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
        if (!item) return { kind: 'item_not_found' as const };
        const items = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(eq(mealItems.mealLogId, mealLog.id))
          .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
        return { kind: 'updated' as const, mealLog, items };
      });
      if (updated.kind === 'not_found' || updated.kind === 'item_not_found')
        return mealLogNotFound(reply, request);
      if (updated.kind === 'invalid_state')
        return invalidMealLogState(reply, request);
      return mealLogResponse(updated.mealLog, updated.items);
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

        const [food] = await tx
          .select({ id: foods.id, canonicalNameKo: foods.canonicalNameKo })
          .from(foods)
          .where(and(eq(foods.id, body.data.foodId), eq(foods.isDeprecated, false)))
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
        if (!item) return { kind: 'item_not_found' as const };
        const items = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(eq(mealItems.mealLogId, mealLog.id))
          .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
        return { kind: 'mapped' as const, mealLog, items };
      });
      if (mapped.kind === 'not_found' || mapped.kind === 'item_not_found')
        return mealLogNotFound(reply, request);
      if (mapped.kind === 'invalid_state')
        return invalidMealLogState(reply, request);
      if (mapped.kind === 'food_not_found') return foodNotFound(reply, request);
      if (mapped.kind === 'profile_unavailable')
        return foodNutrientProfileUnavailable(reply, request);
      return mealLogResponse(mapped.mealLog, mapped.items);
    },
  );
  app.post('/api/meal-logs/:mealLogId/confirm', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request);

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

      const mappedItems = items.filter(
        (item) => item.foodId !== null && item.nutrientProfileId !== null,
      );
      const selectedFoods =
        mappedItems.length === 0
          ? []
          : await tx
              .select({ id: foods.id, isDeprecated: foods.isDeprecated })
              .from(foods)
              .where(
                inArray(
                  foods.id,
                  [...new Set(mappedItems.map((item) => item.foodId!))],
                ),
              );
      const foodById = new Map(selectedFoods.map((food) => [food.id, food]));
      const profiles =
        mappedItems.length === 0
          ? []
          : await tx
              .select(nutrientProfileCalculationSelection)
              .from(nutrientProfiles)
              .where(
                inArray(
                  nutrientProfiles.id,
                  mappedItems.map((item) => item.nutrientProfileId!),
                ),
              );
      const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
      const nonGramItems = mappedItems.filter((item) => item.unit !== 'g');
      const servings =
        nonGramItems.length === 0
          ? []
          : await tx
              .select(foodServingCalculationSelection)
              .from(foodServings)
              .where(
                inArray(
                  foodServings.foodId,
                  [...new Set(nonGramItems.map((item) => item.foodId!))],
                ),
              );
      const registries =
        profiles.length === 0 && servings.length === 0
          ? []
          : await tx
              .select({ id: sourceRegistries.id, kind: sourceRegistries.kind })
              .from(sourceRegistries)
              .where(
                inArray(
                  sourceRegistries.id,
                  [
                    ...new Set([
                      ...profiles.map((profile) => profile.sourceRegistryId),
                      ...servings.map((serving) => serving.sourceRegistryId),
                    ]),
                  ],
                ),
              );
      const registryById = new Map(
        registries.map((registry) => [registry.id, registry]),
      );

      const details = items.flatMap((item) => {
        if (!item.foodId || !item.nutrientProfileId)
          return [{ itemId: item.id, code: 'MISSING_MAPPING' }];
        const food = foodById.get(item.foodId);
        if (!food) return [{ itemId: item.id, code: 'MISSING_FOOD' }];
        if (food.isDeprecated) return [{ itemId: item.id, code: 'DEPRECATED_FOOD' }];
        const profile = profileById.get(item.nutrientProfileId);
        if (!profile) return [{ itemId: item.id, code: 'MISSING_PROFILE' }];
        if (profile.foodId !== item.foodId)
          return [{ itemId: item.id, code: 'MISMATCHED_PROFILE' }];
        if (
          profile.qualityGrade !== 'verified' &&
          profile.qualityGrade !== 'estimated'
        )
          return [{ itemId: item.id, code: 'UNTRUSTED_PROFILE_SOURCE' }];
        const profileRegistry = registryById.get(profile.sourceRegistryId);
        if (
          !profileRegistry ||
          !isTrustedNutritionSourceKind(profileRegistry.kind)
        )
          return [{ itemId: item.id, code: 'UNTRUSTED_PROFILE_SOURCE' }];
        if (
          profile.energyMillicalories === null ||
          profile.carbohydrateMg === null ||
          profile.proteinMg === null ||
          profile.fatMg === null
        )
          return [{ itemId: item.id, code: 'INCOMPLETE_PROFILE' }];
        if (item.unit === 'g') return [];
        const matchingServings = servings.filter(
          (serving) => serving.foodId === item.foodId && serving.unit === item.unit,
        );
        if (matchingServings.length === 0)
          return [{ itemId: item.id, code: 'MISSING_SERVING_CONVERSION' }];
        if (matchingServings.length > 1)
          return [{ itemId: item.id, code: 'AMBIGUOUS_SERVING_CONVERSION' }];
        const serving = matchingServings[0]!;
        if (
          serving.qualityGrade !== 'verified' &&
          serving.qualityGrade !== 'estimated'
        )
          return [{ itemId: item.id, code: 'UNTRUSTED_SERVING_SOURCE' }];
        const servingRegistry = registryById.get(serving.sourceRegistryId);
        if (
          !servingRegistry ||
          !isTrustedNutritionSourceKind(servingRegistry.kind)
        )
          return [{ itemId: item.id, code: 'UNTRUSTED_SERVING_SOURCE' }];
        return [];
      });
      if (details.length > 0) return { kind: 'invalid' as const, details };

      const nutritionInputs: MealNutritionInput[] = items.map((item) => {
        const profile = profileById.get(item.nutrientProfileId!)!;
        const baseInput = {
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
        if (item.unit === 'g') return baseInput;
        const serving = servings.find(
          (candidate) =>
            candidate.foodId === item.foodId && candidate.unit === item.unit,
        );
        if (!serving || serving.unit === 'g')
          throw new Error('Validated serving conversion is missing');
        return {
          ...baseInput,
          unit: item.unit,
          serving: {
            id: serving.id,
            unit: serving.unit,
            amountMilliunits: serving.amountMilliunits,
            gramsMg: serving.gramsMg,
            sourceRegistryId: serving.sourceRegistryId,
            qualityGrade: serving.qualityGrade,
          },
        };
      });

      let nutrition;
      try {
        nutrition = calculateMealNutrition(nutritionInputs);
      } catch (error) {
        return {
          kind: 'invalid' as const,
          details: [
            {
              code:
                error instanceof NutritionCalculationError
                  ? error.code
                  : 'CALCULATION_FAILED',
            },
          ],
        };
      }

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
            mealItems: items.map((item) => {
              const profile = profileById.get(item.nutrientProfileId!)!;
              const calculated = calculatedByItemId.get(item.id)!;
              const serving =
                item.unit === 'g'
                  ? undefined
                  : servings.find(
                      (candidate) =>
                        candidate.foodId === item.foodId && candidate.unit === item.unit,
                    );
              return {
                mealItemId: item.id,
                foodId: item.foodId!,
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
                serving: serving && serving.unit !== 'g'
                  ? {
                      id: serving.id,
                      unit: serving.unit,
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
    if (confirmed.kind === 'not_found') return mealLogNotFound(reply, request);
    if (confirmed.kind === 'invalid_state') return invalidMealLogState(reply, request);
    if (confirmed.kind === 'invalid')
      return invalidMealConfirmation(reply, request, confirmed.details);
    return {
      ...mealLogResponse(confirmed.mealLog, confirmed.items),
      nutrition: nutritionSnapshotResponse(confirmed.snapshot),
    };
  });

  app.delete(
    '/api/meal-logs/:mealLogId/items/:itemId',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      const params = mealItemIdParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply, request);
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
        const [item] = await tx
          .delete(mealItems)
          .where(
            and(
              eq(mealItems.id, params.data.itemId),
              eq(mealItems.mealLogId, mealLog.id),
            ),
          )
          .returning({ id: mealItems.id });
        if (!item) return { kind: 'item_not_found' as const };
        const items = await tx
          .select(mealItemSelection)
          .from(mealItems)
          .where(eq(mealItems.mealLogId, mealLog.id))
          .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));
        return { kind: 'deleted' as const, mealLog, items };
      });
      if (deleted.kind === 'not_found' || deleted.kind === 'item_not_found')
        return mealLogNotFound(reply, request);
      if (deleted.kind === 'invalid_state')
        return invalidMealLogState(reply, request);
      return mealLogResponse(deleted.mealLog, deleted.items);
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
const nutrientProfileCalculationSelection = {
  id: nutrientProfiles.id,
  foodId: nutrientProfiles.foodId,
  sourceRegistryId: nutrientProfiles.sourceRegistryId,
  sourceItemId: nutrientProfiles.sourceItemId,
  datasetVersion: nutrientProfiles.datasetVersion,
  qualityGrade: nutrientProfiles.qualityGrade,
  basisAmountMg: nutrientProfiles.basisAmountMg,
  energyMillicalories: nutrientProfiles.energyMillicalories,
  carbohydrateMg: nutrientProfiles.carbohydrateMg,
  proteinMg: nutrientProfiles.proteinMg,
  fatMg: nutrientProfiles.fatMg,
  fiberMg: nutrientProfiles.fiberMg,
};
const foodServingCalculationSelection = {
  id: foodServings.id,
  foodId: foodServings.foodId,
  unit: foodServings.unit,
  amountMilliunits: foodServings.amountMilliunits,
  gramsMg: foodServings.gramsMg,
  sourceRegistryId: foodServings.sourceRegistryId,
  qualityGrade: foodServings.qualityGrade,
};

function isTrustedNutritionSourceKind(
  kind: 'public_dataset' | 'manufacturer' | 'commercial_dataset' | 'recipe_estimate' | 'user_entered',
) {
  return (
    kind === 'public_dataset' ||
    kind === 'manufacturer' ||
    kind === 'commercial_dataset'
  );
}
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

function mealLogResponse<TMeal, TItem>(mealLog: TMeal, items: TItem[]) {
  return { mealLog, items };
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
