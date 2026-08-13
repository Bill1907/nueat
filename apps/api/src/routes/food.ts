import {
  activeCatalogReleasePointers,
  catalogReleaseSearchDocuments,
  foods,
  foodServings,
  nutrientProfiles,
  releaseActivations,
  sourceRegistries,
  type Database,
} from '@nueat/database';
import { and, asc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';
import { selectTrustedNutrition } from '../services/catalog-eligibility-selector';
import { catalogEligibilityAdapter } from '../services/meal-resolution-coordinator';

const searchQuerySchema = z
  .object({
    q: z.string().max(100),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  })
  .strict();
const foodParamsSchema = z
  .object({
    foodId: z.string().uuid(),
  })
  .strict();
const foodQuerySchema = z
  .object({
    nutrientProfileId: z.string().uuid().optional(),
  })
  .strict();
interface FoodRouteOptions {
  auth: Auth;
  database: Database;
}

export const foodRoutes: FastifyPluginAsync<FoodRouteOptions> = async (
  app,
  options,
) => {
  app.get('/api/foods/search', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, request);

    const normalizedQuery = normalizeFoodQuery(parsed.data.q);
    if (!normalizedQuery) return invalidRequest(reply, request);
    const catalogReleaseId = await activeCatalogReleaseId(options.database);
    if (!catalogReleaseId) return { foods: [] };

    const aliasMatchRank = sql<number>`
      case
        when ${catalogReleaseSearchDocuments.normalizedCompact} = ${normalizedQuery} then 0
        when ${catalogReleaseSearchDocuments.normalizedCompact} like ${`${normalizedQuery}%`} then 1
        else 2
      end
    `;
    const bestAliasRank = sql<number>`min(${aliasMatchRank})`;
    const bestAlias = sql<string>`min(${catalogReleaseSearchDocuments.displayTextKo})`;
    const foodMatches = await options.database
      .select({
        foodId: foods.id,
        canonicalNameKo: foods.canonicalNameKo,
        category: foods.category,
        preparation: foods.preparation,
        alias: bestAlias,
      })
      .from(catalogReleaseSearchDocuments)
      .innerJoin(foods, eq(catalogReleaseSearchDocuments.foodId, foods.id))
      .where(
        and(
          eq(catalogReleaseSearchDocuments.catalogReleaseId, catalogReleaseId),
          eq(foods.isDeprecated, false),
          or(
            eq(catalogReleaseSearchDocuments.normalizedCompact, normalizedQuery),
            like(catalogReleaseSearchDocuments.normalizedCompact, `%${normalizedQuery}%`),
          ),
        ),
      )
      .groupBy(
        foods.id,
        foods.canonicalNameKo,
        foods.category,
        foods.preparation,
      )
      .orderBy(
        bestAliasRank,
        bestAlias,
        asc(foods.canonicalNameKo),
        asc(foods.id),
      )
      .limit(parsed.data.limit);

    if (!foodMatches.length) return { foods: [] };

    const eligibility = catalogEligibilityAdapter(options.database);
    const selections = await Promise.all(foodMatches.map(async (food) => {
      const selected = await selectTrustedNutrition(eligibility, {
        catalogReleaseId, foodId: food.foodId, unit: 'g',
      });
      return selected.kind === 'selected' ? [food.foodId, selected] as const : null;
    }));
    const selectedByFood = new Map(
      selections.flatMap((selection) => selection ? [selection] : []),
    );
    const selectedProfileIds = [...selectedByFood.values()].map(
      (selection) => selection.profile.id,
    );
    const nonGramUnits = ['ml', 'serving', 'bowl', 'piece'] as const;
    const servingSelections = await Promise.all(
      [...selectedByFood.keys()].flatMap((foodId) =>
        nonGramUnits.map(async (unit) => {
          const selected = await selectTrustedNutrition(eligibility, {
            catalogReleaseId, foodId, unit,
          });
          return selected.kind === 'selected' && selected.serving
            ? [foodId, selected.serving.id] as const
            : null;
        }),
      ),
    );
    const selectedServingIds = servingSelections.flatMap(
      (selection) => selection ? [selection[1]] : [],
    );
    const [profiles, servings] = await Promise.all([
      selectedProfileIds.length === 0 ? [] : options.database.select({
          id: nutrientProfiles.id,
          foodId: nutrientProfiles.foodId,
          sourceRegistryId: nutrientProfiles.sourceRegistryId,
          sourceCode: sourceRegistries.code,
          sourceDisplayName: sourceRegistries.displayName,
          sourceItemId: nutrientProfiles.sourceItemId,
          datasetVersion: nutrientProfiles.datasetVersion,
          basisAmountMg: nutrientProfiles.basisAmountMg,
          energyMillicalories: nutrientProfiles.energyMillicalories,
          carbohydrateMg: nutrientProfiles.carbohydrateMg,
          proteinMg: nutrientProfiles.proteinMg,
          fatMg: nutrientProfiles.fatMg,
          fiberMg: nutrientProfiles.fiberMg,
          qualityGrade: nutrientProfiles.qualityGrade,
        })
        .from(nutrientProfiles)
        .innerJoin(
          sourceRegistries,
          eq(nutrientProfiles.sourceRegistryId, sourceRegistries.id),
        )
        .where(inArray(nutrientProfiles.id, selectedProfileIds)),
      selectedServingIds.length === 0 ? [] : options.database
        .select({
          id: foodServings.id,
          foodId: foodServings.foodId,
          unit: foodServings.unit,
          labelKo: foodServings.labelKo,
          amountMilliunits: foodServings.amountMilliunits,
          gramsMg: foodServings.gramsMg,
          qualityGrade: foodServings.qualityGrade,
        })
        .from(foodServings)
        .where(inArray(foodServings.id, selectedServingIds))
        .orderBy(asc(foodServings.labelKo), asc(foodServings.id)),
    ]);
    const servingsByFood = new Map<string, (typeof servings)[number][]>();
    for (const serving of servings) {
      const current = servingsByFood.get(serving.foodId) ?? [];
      current.push(serving);
      servingsByFood.set(serving.foodId, current);
    }

    return {
      foods: foodMatches
        .filter((food) => selectedByFood.has(food.foodId))
        .map((food) => {
          const selected = selectedByFood.get(food.foodId);
          const profile = selected && profiles.find((candidate) => candidate.id === selected.profile.id);
          if (!profile) throw new Error('Preferred nutrient profile is missing');
          return {
            id: food.foodId,
            canonicalNameKo: food.canonicalNameKo,
            category: food.category,
            preparation: food.preparation,
            nutrientProfile: {
              id: profile.id,
              sourceRegistryId: profile.sourceRegistryId,
              sourceCode: profile.sourceCode,
              sourceDisplayName: profile.sourceDisplayName,
              sourceItemId: profile.sourceItemId,
              datasetVersion: profile.datasetVersion,
              basisAmountMg: profile.basisAmountMg,
              energyMillicalories: profile.energyMillicalories,
              carbohydrateMg: profile.carbohydrateMg,
              proteinMg: profile.proteinMg,
              fatMg: profile.fatMg,
              fiberMg: profile.fiberMg,
              qualityGrade: profile.qualityGrade,
            },
            servings: servingsByFood.get(food.foodId) ?? [],
          };
        }),
    };
  });
  app.get('/api/foods/:foodId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const parsed = foodParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, request);
    const parsedQuery = foodQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return invalidRequest(reply, request);
    const catalogReleaseId = await activeCatalogReleaseId(options.database);
    if (!catalogReleaseId) return foodNotFound(reply, request);

    const [food] = await options.database
      .select({
        id: foods.id,
        canonicalNameKo: foods.canonicalNameKo,
        category: foods.category,
        preparation: foods.preparation,
      })
      .from(foods)
      .where(and(eq(foods.id, parsed.data.foodId), eq(foods.isDeprecated, false)))
      .limit(1);
    if (!food) return foodNotFound(reply, request);
    const selected = await selectTrustedNutrition(catalogEligibilityAdapter(options.database), {
      catalogReleaseId,
      foodId: food.id,
      unit: 'g',
    });
    if (selected.kind === 'unavailable') return foodNotFound(reply, request);
    if (
      parsedQuery.data.nutrientProfileId &&
      parsedQuery.data.nutrientProfileId !== selected.profile.id
    ) {
      return foodNotFound(reply, request);
    }
    const servingSelections = await Promise.all(
      (['ml', 'serving', 'bowl', 'piece'] as const).map(async (unit) => {
        const servingSelection = await selectTrustedNutrition(
          catalogEligibilityAdapter(options.database),
          { catalogReleaseId, foodId: food.id, unit },
        );
        return servingSelection.kind === 'selected' && servingSelection.serving
          ? servingSelection.serving.id
          : null;
      }),
    );
    const selectedServingIds = servingSelections.filter(
      (id): id is string => id !== null,
    );

    const [profile, servings] = await Promise.all([
      options.database
        .select({
          id: nutrientProfiles.id,
          foodId: nutrientProfiles.foodId,
          sourceRegistryId: nutrientProfiles.sourceRegistryId,
          sourceCode: sourceRegistries.code,
          sourceDisplayName: sourceRegistries.displayName,
          sourceItemId: nutrientProfiles.sourceItemId,
          datasetVersion: nutrientProfiles.datasetVersion,
          basisAmountMg: nutrientProfiles.basisAmountMg,
          energyMillicalories: nutrientProfiles.energyMillicalories,
          carbohydrateMg: nutrientProfiles.carbohydrateMg,
          proteinMg: nutrientProfiles.proteinMg,
          fatMg: nutrientProfiles.fatMg,
          fiberMg: nutrientProfiles.fiberMg,
          qualityGrade: nutrientProfiles.qualityGrade,
        })
        .from(nutrientProfiles)
        .innerJoin(
          sourceRegistries,
          eq(nutrientProfiles.sourceRegistryId, sourceRegistries.id),
        )
        .where(
          and(
            eq(nutrientProfiles.id, selected.profile.id),
            eq(nutrientProfiles.foodId, food.id),
          ),
        ),
      selectedServingIds.length === 0 ? [] : options.database
        .select({
          id: foodServings.id,
          foodId: foodServings.foodId,
          unit: foodServings.unit,
          labelKo: foodServings.labelKo,
          amountMilliunits: foodServings.amountMilliunits,
          gramsMg: foodServings.gramsMg,
          qualityGrade: foodServings.qualityGrade,
        })
        .from(foodServings)
        .where(inArray(foodServings.id, selectedServingIds))
        .orderBy(asc(foodServings.labelKo), asc(foodServings.id)),
    ]);
    const selectedProfile = profile.find(
      (candidate) => candidate.id === selected.profile.id,
    );
    if (!selectedProfile) return foodNotFound(reply, request);

    return {
      id: food.id,
      canonicalNameKo: food.canonicalNameKo,
      category: food.category,
      preparation: food.preparation,
      nutrientProfile: {
        id: selectedProfile.id,
        sourceRegistryId: selectedProfile.sourceRegistryId,
        sourceCode: selectedProfile.sourceCode,
        sourceDisplayName: selectedProfile.sourceDisplayName,
        sourceItemId: selectedProfile.sourceItemId,
        datasetVersion: selectedProfile.datasetVersion,
        basisAmountMg: selectedProfile.basisAmountMg,
        energyMillicalories: selectedProfile.energyMillicalories,
        carbohydrateMg: selectedProfile.carbohydrateMg,
        proteinMg: selectedProfile.proteinMg,
        fatMg: selectedProfile.fatMg,
        fiberMg: selectedProfile.fiberMg,
        qualityGrade: selectedProfile.qualityGrade,
      },
      servings,
    };
  });
};

export function normalizeFoodQuery(value: string) {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

async function activeCatalogReleaseId(database: Pick<Database, 'select'>) {
  const [active] = await database
    .select({ catalogReleaseId: releaseActivations.catalogReleaseId })
    .from(activeCatalogReleasePointers)
    .innerJoin(
      releaseActivations,
      eq(activeCatalogReleasePointers.activationId, releaseActivations.id),
    )
    .limit(1);
  return active?.catalogReleaseId ?? null;
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
function foodNotFound(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(404).send({
    error: {
      code: 'FOOD_NOT_FOUND',
      message: '음식을 찾을 수 없습니다.',
      requestId: request.id,
    },
  });
}
