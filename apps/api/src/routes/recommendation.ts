import {
  calculationSnapshots,
  dietaryConstraints,
  foodAliases,
  foods,
  mealItems,
  mealLogs,
  nutrientProfiles,
  nutritionProfiles,
  recommendationMealDrafts,
  recommendations,
  sourceRegistries,
  userProfiles,
  type Database,
} from '@nueat/database';
import {
  CURATED_MEAL_RECOMMENDATION_TEMPLATES,
  MEAL_RECOMMENDATION_ENGINE_VERSION,
  calculateMealNutrition,
  rankMealRecommendations,
} from '@nueat/domain';
import { and, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';
import { normalizeFoodQuery } from './food';

interface RecommendationRouteOptions {
  auth: Auth;
  database: Database;
}

const bodySchema = z.object({ excludeFoodIds: z.array(z.string().uuid()).max(20).optional() }).strict();
const mealDraftBodySchema = z.object({ candidateRank: z.number().int().min(1).max(3) }).strict();
const snapshotSchema = z.object({
  mealItems: z.array(z.object({ nutrients: z.object({ fiberMg: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }).passthrough() }).passthrough()).min(1),
}).passthrough();
const trustedKinds = ['public_dataset', 'manufacturer', 'commercial_dataset'] as const;

type Nutrients = {
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
};

export const recommendationRoutes: FastifyPluginAsync<RecommendationRouteOptions> = async (app, options) => {
  app.post('/api/recommendations/next', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const body = bodySchema.safeParse(request.body ?? {});
    if (!body.success) return invalidRequest(reply, request);

    const [userProfile] = await options.database
      .select({ timezone: userProfiles.timezone, onboardingStatus: userProfiles.onboardingStatus })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    const timezone = userProfile?.timezone ?? 'Asia/Seoul';
    const now = new Date();
    const date = localDate(now, timezone);
    const [target] = await options.database
      .select({
        id: nutritionProfiles.id,
        energyMillicalories: nutritionProfiles.calorieTargetMillicalories,
        carbohydrateMg: nutritionProfiles.carbohydrateTargetMg,
        proteinMg: nutritionProfiles.proteinTargetMg,
        fatMg: nutritionProfiles.fatTargetMg,
        fiberMg: nutritionProfiles.fiberTargetMg,
      })
      .from(nutritionProfiles)
      .where(and(
        eq(nutritionProfiles.userId, userId),
        lte(nutritionProfiles.effectiveFrom, now),
        or(sql`${nutritionProfiles.effectiveTo} is null`, gt(nutritionProfiles.effectiveTo, now)),
      ))
      .orderBy(desc(nutritionProfiles.effectiveFrom), desc(nutritionProfiles.id))
      .limit(1);
    if (!target || !userProfile || userProfile.onboardingStatus !== 'completed') {
      return reply.status(409).send({
        error: { code: 'NUTRITION_TARGET_UNAVAILABLE', message: '영양 목표를 사용할 수 없습니다.', requestId: request.id },
      });
    }

    const meals = await options.database
      .select({ id: mealLogs.id })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), eq(mealLogs.status, 'confirmed'), eq(mealLogs.eatenLocalDate, date)));
    const mealIds = meals.map((meal) => meal.id);
    const consumed = emptyNutrients();
    let snapshotInvalid = false;
    const calculationSnapshotRefs: Array<{ id: string; mealLogId: string; sequence: number }> = [];
    if (mealIds.length) {
      const snapshots = await options.database
        .select({ id: calculationSnapshots.id, mealLogId: calculationSnapshots.mealLogId, sequence: calculationSnapshots.sequence, inputSnapshot: calculationSnapshots.inputSnapshot, energyMillicalories: calculationSnapshots.energyMillicalories, carbohydrateMg: calculationSnapshots.carbohydrateMg, proteinMg: calculationSnapshots.proteinMg, fatMg: calculationSnapshots.fatMg })
        .from(calculationSnapshots)
        .where(inArray(calculationSnapshots.mealLogId, mealIds))
        .orderBy(desc(calculationSnapshots.sequence));
      const latest = new Map<string, (typeof snapshots)[number]>();
      for (const snapshot of snapshots) if (!latest.has(snapshot.mealLogId)) latest.set(snapshot.mealLogId, snapshot);
      for (const mealId of mealIds) {
        const snapshot = latest.get(mealId);
        const parsed = snapshot && snapshotSchema.safeParse(snapshot.inputSnapshot);
        if (!snapshot || !parsed?.success) { snapshotInvalid = true; break; }
        calculationSnapshotRefs.push({ id: snapshot.id, mealLogId: snapshot.mealLogId, sequence: snapshot.sequence });
        consumed.energyMillicalories = addKnown(consumed.energyMillicalories, snapshot.energyMillicalories);
        consumed.carbohydrateMg = addKnown(consumed.carbohydrateMg, snapshot.carbohydrateMg);
        consumed.proteinMg = addKnown(consumed.proteinMg, snapshot.proteinMg);
        consumed.fatMg = addKnown(consumed.fatMg, snapshot.fatMg);
        const fiber = parsed.data.mealItems.every((item) => item.nutrients.fiberMg !== null)
          ? parsed.data.mealItems.reduce((sum, item) => safeAdd(sum, item.nutrients.fiberMg ?? 0), 0)
          : null;
        consumed.fiberMg = addNullable(consumed.fiberMg, fiber);
      }
    }

    const constraints = await options.database
      .select({ id: dietaryConstraints.id, type: dietaryConstraints.type, foodId: dietaryConstraints.foodId, labelKo: dietaryConstraints.labelKo })
      .from(dietaryConstraints)
      .where(and(eq(dietaryConstraints.userId, userId), inArray(dietaryConstraints.type, ['allergy', 'exclusion'])));
    const blockedFoodIds = new Set(body.data.excludeFoodIds ?? []);
    let unresolvedConstraint = constraints.length > 0 || (body.data.excludeFoodIds?.length ?? 0) > 0;
    for (const constraint of constraints) {
      if (constraint.foodId) { blockedFoodIds.add(constraint.foodId); continue; }
      if (!constraint.labelKo) { unresolvedConstraint = true; continue; }
      const normalized = normalizeFoodQuery(constraint.labelKo);
      const matches = await options.database
        .select({ foodId: foods.id })
        .from(foodAliases)
        .innerJoin(foods, eq(foodAliases.foodId, foods.id))
        .where(and(eq(foodAliases.normalizedAliasKo, normalized), eq(foods.isDeprecated, false)));
      const ids = [...new Set(matches.map((match) => match.foodId))];
      if (ids.length !== 1) unresolvedConstraint = true;
      else blockedFoodIds.add(ids[0]!);
    }

    const recentMeals = await options.database
      .select({ id: mealLogs.id })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), eq(mealLogs.status, 'confirmed')))
      .orderBy(desc(mealLogs.eatenAt), desc(mealLogs.id))
      .limit(3);
    const recentMealIds = recentMeals.map((meal) => meal.id);
    const recentItems = recentMealIds.length
      ? await options.database.select({ foodId: mealItems.foodId }).from(mealItems).where(inArray(mealItems.mealLogId, recentMealIds))
      : [];

    const safetyFlags = [
      ...(snapshotInvalid ? ['CALCULATION_SNAPSHOT_UNAVAILABLE'] : []),
      ...(unresolvedConstraint ? ['UNRESOLVED_DIETARY_CONSTRAINT'] : []),
    ];
    const gaps = snapshotInvalid
      ? { energyMillicalories: null, proteinMg: null, fiberMg: null }
      : remaining(target, consumed);
    let candidates: ReturnType<typeof rankMealRecommendations> = [];
    const selectedNutrientProfiles: Array<{
      id: string;
      sourceRegistryId: string;
      sourceItemId: string;
      datasetVersion: string;
      foodId: string;
    }> = [];
    if (!snapshotInvalid && !unresolvedConstraint) {
      const sourceItemIds = [...new Set(CURATED_MEAL_RECOMMENDATION_TEMPLATES.flatMap((template) => template.components.map((component) => component.sourceItemId)))];
      const profiles = await options.database
        .select({ id: nutrientProfiles.id, sourceRegistryId: nutrientProfiles.sourceRegistryId, sourceItemId: nutrientProfiles.sourceItemId, datasetVersion: nutrientProfiles.datasetVersion, qualityGrade: nutrientProfiles.qualityGrade, foodId: foods.id, nameKo: foods.canonicalNameKo, basisAmountMg: nutrientProfiles.basisAmountMg, energyMillicalories: nutrientProfiles.energyMillicalories, carbohydrateMg: nutrientProfiles.carbohydrateMg, proteinMg: nutrientProfiles.proteinMg, fatMg: nutrientProfiles.fatMg, fiberMg: nutrientProfiles.fiberMg })
        .from(nutrientProfiles)
        .innerJoin(sourceRegistries, eq(nutrientProfiles.sourceRegistryId, sourceRegistries.id))
        .innerJoin(foods, eq(nutrientProfiles.foodId, foods.id))
        .where(and(
          inArray(nutrientProfiles.sourceItemId, sourceItemIds),
          inArray(sourceRegistries.kind, [...trustedKinds]),
          or(eq(nutrientProfiles.qualityGrade, 'verified'), eq(nutrientProfiles.qualityGrade, 'estimated')),
          eq(foods.isDeprecated, false),
          sql`${nutrientProfiles.energyMillicalories} is not null`,
          sql`${nutrientProfiles.carbohydrateMg} is not null`,
          sql`${nutrientProfiles.proteinMg} is not null`,
          sql`${nutrientProfiles.fatMg} is not null`,
        ));
      const profilesBySource = new Map<string, (typeof profiles)[number]>();
      for (const profile of profiles.sort(compareProfiles)) if (!profilesBySource.has(profile.sourceItemId)) profilesBySource.set(profile.sourceItemId, profile);
      selectedNutrientProfiles.push(...profilesBySource.values().map((profile) => ({
        id: profile.id,
        sourceRegistryId: profile.sourceRegistryId,
        sourceItemId: profile.sourceItemId,
        datasetVersion: profile.datasetVersion,
        foodId: profile.foodId,
      })));
      if (profilesBySource.size !== sourceItemIds.length) {
        safetyFlags.push('NUTRIENT_PROFILE_UNAVAILABLE');
      } else {
        const resolved = CURATED_MEAL_RECOMMENDATION_TEMPLATES.flatMap((template) => {
          const components = template.components.map((component) => {
            const profile = profilesBySource.get(component.sourceItemId);
            if (!profile) return null;
            const nutrition = calculateMealNutrition([{ mealItemId: profile.id, amountMilliunits: component.gramsMg, unit: 'g', nutrientProfile: profile }]);
            return { foodId: profile.foodId, nutrientProfileId: profile.id, nameKo: profile.nameKo, gramsMg: component.gramsMg, nutrients: nutrition.items[0]!.nutrients };
          });
          if (components.some((component) => component === null)) return [];
          const value = components as Array<{ foodId: string; nutrientProfileId: string; nameKo: string; gramsMg: number; nutrients: Nutrients }>;
          const nutrition = value.reduce<Nutrients>((total, component) => addNutrients(total, component.nutrients), emptyNutrients());
          return [{ templateId: template.id, titleKo: template.titleKo, components: value.map(({ foodId, nutrientProfileId, nameKo, gramsMg }) => ({ foodId, nutrientProfileId, nameKo, gramsMg })), nutrients: nutrition }];
        });
        candidates = rankMealRecommendations({ targets: target, consumed, candidates: resolved, blockedFoodIds: [...blockedFoodIds], recentFoodIds: recentItems.flatMap((item) => item.foodId ? [item.foodId] : []) });
      }
    }

    const candidateItems = candidates.map((candidate) => ({
      rank: candidate.rank,
      templateId: candidate.templateId,
      titleKo: candidate.titleKo,
      scoreBps: candidate.scoreBps,
      components: candidate.components.map((component) => ({ ...component })),
      nutrition: candidate.nutrients,
      projectedTotals: candidate.projectedTotals,
      rationaleFacts: candidate.rationaleFacts,
      warnings: candidate.warnings,
    }));
    const [saved] = await options.database.insert(recommendations).values({
      userId,
      contextSnapshot: {
        requestedAt: now.toISOString(),
        timezone,
        targetId: target.id,
        remainingTargets: gaps,
        recentMealIds,
        calculationSnapshots: calculationSnapshotRefs,
        dietaryConstraintIds: constraints.map((constraint) => constraint.id),
        selectedNutrientProfiles,
      },
      candidateItems,
      engineVersion: MEAL_RECOMMENDATION_ENGINE_VERSION,
      modelVersion: null,
      promptVersion: null,
      safetyFlags,
    }).returning({ id: recommendations.id, createdAt: recommendations.createdAt });
    if (!saved) throw new Error('Recommendation insert did not return a row');
    return { recommendationId: saved.id, generatedAt: saved.createdAt.toISOString(), date, timezone, engineVersion: MEAL_RECOMMENDATION_ENGINE_VERSION, gaps, safetyFlags, candidates: candidateItems };
  });
  app.post('/api/recommendations/:recommendationId/meal-draft', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = z.object({ recommendationId: z.string().uuid() }).safeParse(request.params);
    const body = mealDraftBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalidRequest(reply, request);

    const result = await options.database.transaction(async (tx) => {
      // A recommendation has no lockable child before its first action, so serialize on
      // its immutable UUID for the whole read/validate/create operation.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended((${params.data.recommendationId}::uuid)::text, 0))`);

      const [existing] = await tx
        .select({
          candidateRank: recommendationMealDrafts.candidateRank,
          mealLog: mealLogSelection,
        })
        .from(recommendationMealDrafts)
        .innerJoin(mealLogs, eq(recommendationMealDrafts.mealLogId, mealLogs.id))
        .where(and(
          eq(recommendationMealDrafts.recommendationId, params.data.recommendationId),
          eq(mealLogs.userId, userId),
        ))
        .limit(1);
      if (existing) {
        if (existing.candidateRank !== body.data.candidateRank) return { kind: 'actioned' as const };
        if (
          existing.mealLog.status !== 'draft' ||
          existing.mealLog.recognitionStatus !== 'manual' ||
          existing.mealLog.imageAssetId !== null
        ) return { kind: 'actioned' as const };
        const items = await tx.select(mealItemSelection).from(mealItems).where(eq(mealItems.mealLogId, existing.mealLog.id));
        return { kind: 'existing' as const, mealLog: existing.mealLog, items };
      }

      const [recommendation] = await tx
        .select({
          id: recommendations.id,
          contextSnapshot: recommendations.contextSnapshot,
          candidateItems: recommendations.candidateItems,
          safetyFlags: recommendations.safetyFlags,
        })
        .from(recommendations)
        .where(and(eq(recommendations.id, params.data.recommendationId), eq(recommendations.userId, userId)))
        .limit(1);
      if (!recommendation) return { kind: 'notFound' as const };
      if (!Array.isArray(recommendation.safetyFlags) || recommendation.safetyFlags.length > 0)
        return { kind: 'unsafe' as const };

      const provenance = recommendationProvenanceSchema.safeParse(recommendation.contextSnapshot);
      const candidates = recommendationCandidatesSchema.safeParse(recommendation.candidateItems);
      const matchingCandidates = candidates.success
        ? candidates.data.filter((value) => value.rank === body.data.candidateRank)
        : [];
      const candidate = matchingCandidates.length === 1 ? matchingCandidates[0] : undefined;
      if (!provenance.success || !candidate) return { kind: 'invalidProvenance' as const };

      const now = new Date();
      const [profile] = await tx
        .select({ timezone: userProfiles.timezone, onboardingStatus: userProfiles.onboardingStatus })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);
      if (!profile || profile.onboardingStatus !== 'completed') return { kind: 'profileUnavailable' as const };

      const snapshotProfiles = provenance.data.selectedNutrientProfiles;
      const snapshotByProfileId = new Map<string, typeof snapshotProfiles[number]>();
      for (const snapshot of snapshotProfiles) {
        if (snapshotByProfileId.has(snapshot.id)) return { kind: 'invalidProvenance' as const };
        snapshotByProfileId.set(snapshot.id, snapshot);
      }
      const components = candidate.components.map((component) => ({
        component,
        snapshot: snapshotByProfileId.get(component.nutrientProfileId),
      }));
      if (components.some(({ component, snapshot }) => !snapshot || snapshot.foodId !== component.foodId)) {
        return { kind: 'invalidProvenance' as const };
      }

      const profiles = await tx
        .select({
          id: nutrientProfiles.id,
          foodId: nutrientProfiles.foodId,
          sourceRegistryId: nutrientProfiles.sourceRegistryId,
          sourceItemId: nutrientProfiles.sourceItemId,
          datasetVersion: nutrientProfiles.datasetVersion,
          qualityGrade: nutrientProfiles.qualityGrade,
          foodDeprecated: foods.isDeprecated,
          sourceKind: sourceRegistries.kind,
        })
        .from(nutrientProfiles)
        .innerJoin(foods, eq(nutrientProfiles.foodId, foods.id))
        .innerJoin(sourceRegistries, eq(nutrientProfiles.sourceRegistryId, sourceRegistries.id))
        .where(inArray(nutrientProfiles.id, [...new Set(components.map(({ snapshot }) => snapshot!.id))]));
      const profileById = new Map(profiles.map((value) => [value.id, value]));
      for (const { snapshot } of components) {
        const persisted = profileById.get(snapshot!.id);
        if (
          !persisted ||
          persisted.foodId !== snapshot!.foodId ||
          persisted.sourceRegistryId !== snapshot!.sourceRegistryId ||
          persisted.sourceItemId !== snapshot!.sourceItemId ||
          persisted.datasetVersion !== snapshot!.datasetVersion ||
          (persisted.qualityGrade !== 'verified' && persisted.qualityGrade !== 'estimated') ||
          persisted.foodDeprecated ||
          !trustedKinds.includes(persisted.sourceKind as typeof trustedKinds[number])
        ) return { kind: 'invalidProvenance' as const };
      }

      const [mealLog] = await tx
        .insert(mealLogs)
        .values({
          userId,
          eatenAt: now,
          eatenTimezone: profile.timezone,
          eatenLocalDate: localDate(now, profile.timezone),
          mealType: inferMealType(now, profile.timezone),
          status: 'draft',
          imageAssetId: null,
          recognitionStatus: 'manual',
          recognitionNextAttemptAt: null,
        })
        .returning(mealLogSelection);
      if (!mealLog) throw new Error('MealLog insert did not return a row');
      const items = await tx
        .insert(mealItems)
        .values(components.map(({ component, snapshot }) => ({
          mealLogId: mealLog.id,
          recognizedLabel: component.nameKo,
          foodId: snapshot!.foodId,
          nutrientProfileId: snapshot!.id,
          amountMilliunits: component.gramsMg,
          gramsMg: component.gramsMg,
          unit: 'g' as const,
          userCorrected: false,
        })))
        .returning(mealItemSelection);
      await tx.insert(recommendationMealDrafts).values({
        recommendationId: recommendation.id,
        mealLogId: mealLog.id,
        candidateRank: body.data.candidateRank,
      });
      return { kind: 'created' as const, mealLog, items };
    });

    if (result.kind === 'notFound') return recommendationNotFound(reply, request);
    if (result.kind === 'actioned') return reply.status(409).send({ error: { code: 'RECOMMENDATION_ALREADY_ACTIONED', message: '이미 다른 추천을 기록했습니다.', requestId: request.id } });
    if (result.kind === 'unsafe') return recommendationDraftUnavailable(reply, request, 'RECOMMENDATION_SAFETY_UNAVAILABLE');
    if (result.kind === 'invalidProvenance') return recommendationDraftUnavailable(reply, request, 'RECOMMENDATION_PROVENANCE_UNAVAILABLE');
    if (result.kind === 'profileUnavailable') return recommendationDraftUnavailable(reply, request, 'USER_PROFILE_UNAVAILABLE');
    return reply.status(result.kind === 'created' ? 201 : 200).send({ mealLog: result.mealLog, items: result.items });
  });
};

function emptyNutrients(): Nutrients { return { energyMillicalories: 0, carbohydrateMg: 0, proteinMg: 0, fatMg: 0, fiberMg: 0 }; }
function addKnown(left: number | null, right: number) { return left === null ? null : safeAdd(left, right); }
function addNullable(left: number | null, right: number | null) { return left === null || right === null ? null : safeAdd(left, right); }
function addNutrients(left: Nutrients, right: Nutrients): Nutrients { return { energyMillicalories: addNullable(left.energyMillicalories, right.energyMillicalories), carbohydrateMg: addNullable(left.carbohydrateMg, right.carbohydrateMg), proteinMg: addNullable(left.proteinMg, right.proteinMg), fatMg: addNullable(left.fatMg, right.fatMg), fiberMg: addNullable(left.fiberMg, right.fiberMg) }; }
function remaining(target: Nutrients, consumed: Nutrients) { return { energyMillicalories: subtractToZero(target.energyMillicalories, consumed.energyMillicalories), proteinMg: subtractToZero(target.proteinMg, consumed.proteinMg), fiberMg: target.fiberMg === null || consumed.fiberMg === null ? null : subtractToZero(target.fiberMg, consumed.fiberMg) }; }
function safeAdd(left: number, right: number) { const result = BigInt(left) + BigInt(right); if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('RECOMMENDATION_TOTAL_OUT_OF_RANGE'); return Number(result); }
function subtractToZero(target: number | null, consumed: number | null) { if (target === null || consumed === null) return null; const result = BigInt(target) - BigInt(consumed); return result > 0n ? Number(result) : 0; }
function compareProfiles(left: { qualityGrade: string; datasetVersion: string; id: string }, right: { qualityGrade: string; datasetVersion: string; id: string }) { const quality = (value: string) => value === 'verified' ? 0 : value === 'estimated' ? 1 : 2; return quality(left.qualityGrade) - quality(right.qualityGrade) || right.datasetVersion.localeCompare(left.datasetVersion) || left.id.localeCompare(right.id); }
function localDate(value: Date, timezone: string) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value); const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value; return `${get('year')}-${get('month')}-${get('day')}`; }
async function requireUserId(request: FastifyRequest, reply: FastifyReply, auth: Auth) { const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) }); if (session) return session.user.id; reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.', requestId: request.id } }); return null; }
function invalidRequest(reply: FastifyReply, request: FastifyRequest) { return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.', requestId: request.id } }); }
function recommendationNotFound(reply: FastifyReply, request: FastifyRequest) { return reply.status(404).send({ error: { code: 'RECOMMENDATION_NOT_FOUND', message: '추천을 찾을 수 없습니다.', requestId: request.id } }); }
function recommendationDraftUnavailable(reply: FastifyReply, request: FastifyRequest, code: string) { return reply.status(409).send({ error: { code, message: '추천을 기록할 수 없습니다.', requestId: request.id } }); }
const recommendationProvenanceSchema = z.object({
  selectedNutrientProfiles: z.array(z.object({
    id: z.string().uuid(),
    sourceRegistryId: z.string().uuid(),
    sourceItemId: z.string().min(1),
    datasetVersion: z.string().min(1),
    foodId: z.string().uuid(),
  }).strict()).min(1),
}).passthrough();
const recommendationCandidatesSchema = z.array(z.object({
  rank: z.number().int().min(1).max(3),
  components: z.array(z.object({
    foodId: z.string().uuid(),
    nutrientProfileId: z.string().uuid(),
    nameKo: z.string().min(1),
    gramsMg: z.number().int().positive(),
  }).strict()).min(1),
}).passthrough());
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
function inferMealType(value: Date, timezone: string) {
  const hourPart = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(value).find((part) => part.type === 'hour')?.value;
  const hour = Number(hourPart);
  if (!Number.isInteger(hour)) throw new Error('Unable to infer meal type');
  if (hour >= 5 && hour <= 10) return 'breakfast' as const;
  if (hour >= 11 && hour <= 15) return 'lunch' as const;
  if (hour >= 16 && hour <= 21) return 'dinner' as const;
  return 'snack' as const;
}
