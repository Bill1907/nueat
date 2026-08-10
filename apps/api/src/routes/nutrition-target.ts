import { nutritionProfiles, userProfiles, type Database } from '@nueat/database';
import { NUTRITION_STANDARD } from '@nueat/domain';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync } from 'fastify';

import type { Auth } from '../auth/auth';

interface NutritionTargetRouteOptions {
  auth: Auth;
  database: Database;
}

export const nutritionTargetRoutes: FastifyPluginAsync<NutritionTargetRouteOptions> = async (
  app,
  options,
) => {
  app.get('/api/nutrition-targets/active', async (request, reply) => {
    const session = await options.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: '로그인이 필요합니다.',
          requestId: request.id,
        },
      });
    }

    const [userProfile] = await options.database
      .select({
        status: userProfiles.onboardingStatus,
        reasons: userProfiles.safetyModeReasonCodes,
      })
      .from(userProfiles)
      .where(eq(userProfiles.userId, session.user.id))
      .limit(1);

    if (!userProfile || userProfile.status === 'pending') {
      return { status: 'pending' as const };
    }
    if (userProfile.status === 'limited') {
      return { status: 'limited' as const, reasons: userProfile.reasons };
    }

    const [target] = await options.database
      .select({
        id: nutritionProfiles.id,
        goalType: nutritionProfiles.goalType,
        birthYear: nutritionProfiles.birthYear,
        calculationSex: nutritionProfiles.calculationSex,
        heightMm: nutritionProfiles.heightMm,
        weightG: nutritionProfiles.weightG,
        activityLevel: nutritionProfiles.activityLevel,
        calorieTargetMillicalories: nutritionProfiles.calorieTargetMillicalories,
        carbohydrateTargetMg: nutritionProfiles.carbohydrateTargetMg,
        proteinTargetMg: nutritionProfiles.proteinTargetMg,
        fatTargetMg: nutritionProfiles.fatTargetMg,
        fiberTargetMg: nutritionProfiles.fiberTargetMg,
        engineVersion: nutritionProfiles.engineVersion,
        effectiveFrom: nutritionProfiles.effectiveFrom,
      })
      .from(nutritionProfiles)
      .where(
        and(
          eq(nutritionProfiles.userId, session.user.id),
          isNull(nutritionProfiles.effectiveTo),
        ),
      )
      .orderBy(desc(nutritionProfiles.effectiveFrom))
      .limit(1);

    if (!target) {
      return reply.status(409).send({
        error: {
          code: 'ACTIVE_NUTRITION_TARGET_NOT_FOUND',
          message: '활성 영양 목표를 찾을 수 없습니다.',
          requestId: request.id,
        },
      });
    }

    return {
      status: 'active' as const,
      profile: target,
      standard: NUTRITION_STANDARD,
    };
  });
};
