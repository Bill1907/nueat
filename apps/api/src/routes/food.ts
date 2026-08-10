import {
  foodAliases,
  foods,
  foodServings,
  nutrientProfiles,
  sourceRegistries,
  type Database,
} from '@nueat/database';
import { and, asc, eq, inArray, like, or } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';

const searchQuerySchema = z
  .object({
    q: z.string().max(100),
    limit: z.coerce.number().int().min(1).max(20).default(10),
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

    const matches = await options.database
      .select({
        foodId: foods.id,
        canonicalNameKo: foods.canonicalNameKo,
        category: foods.category,
        preparation: foods.preparation,
        alias: foodAliases.normalizedAliasKo,
      })
      .from(foodAliases)
      .innerJoin(foods, eq(foodAliases.foodId, foods.id))
      .where(
        and(
          eq(foods.isDeprecated, false),
          or(
            eq(foodAliases.normalizedAliasKo, normalizedQuery),
            like(foodAliases.normalizedAliasKo, `%${normalizedQuery}%`),
          ),
        ),
      );

    const foodMatches = [...matches]
      .sort((left, right) => {
        const leftRank = matchRank(left.alias, normalizedQuery);
        const rightRank = matchRank(right.alias, normalizedQuery);
        return (
          leftRank - rightRank ||
          left.alias.localeCompare(right.alias, 'ko') ||
          left.canonicalNameKo.localeCompare(right.canonicalNameKo, 'ko') ||
          left.foodId.localeCompare(right.foodId)
        );
      })
      .filter((match, index, all) =>
        all.slice(0, index).every((candidate) => candidate.foodId !== match.foodId),
      )
      .slice(0, parsed.data.limit);

    if (!foodMatches.length) return { foods: [] };

    const foodIds = foodMatches.map((match) => match.foodId);
    const [profiles, servings] = await Promise.all([
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
            inArray(nutrientProfiles.foodId, foodIds),
            or(
              eq(nutrientProfiles.qualityGrade, 'verified'),
              eq(nutrientProfiles.qualityGrade, 'estimated'),
            ),
          ),
        ),
      options.database
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
        .where(inArray(foodServings.foodId, foodIds))
        .orderBy(asc(foodServings.labelKo), asc(foodServings.id)),
    ]);

    const preferredProfiles = new Map<string, (typeof profiles)[number]>();
    for (const profile of profiles.sort(compareProfiles)) {
      if (!preferredProfiles.has(profile.foodId))
        preferredProfiles.set(profile.foodId, profile);
    }
    const servingsByFood = new Map<string, (typeof servings)[number][]>();
    for (const serving of servings) {
      const values = servingsByFood.get(serving.foodId) ?? [];
      values.push(serving);
      servingsByFood.set(serving.foodId, values);
    }

    return {
      foods: foodMatches
        .filter((food) => preferredProfiles.has(food.foodId))
        .map((food) => {
          const profile = preferredProfiles.get(food.foodId);
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
};

export function normalizeFoodQuery(value: string) {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function matchRank(alias: string, query: string) {
  if (alias === query) return 0;
  if (alias.startsWith(query)) return 1;
  return 2;
}

function compareProfiles(
  left: { qualityGrade: string; datasetVersion: string; id: string },
  right: { qualityGrade: string; datasetVersion: string; id: string },
) {
  const qualityRank = (qualityGrade: string) =>
    qualityGrade === 'verified' ? 0 : qualityGrade === 'estimated' ? 1 : 2;
  return (
    qualityRank(left.qualityGrade) - qualityRank(right.qualityGrade) ||
    right.datasetVersion.localeCompare(left.datasetVersion) ||
    left.id.localeCompare(right.id)
  );
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
