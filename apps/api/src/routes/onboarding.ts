import {
  consents,
  nutritionProfiles,
  userProfiles,
  type Database,
} from '@nueat/database';
import {
  ACTIVITY_OPTIONS,
  calculateNutritionTargets,
  CONSENT_DOCUMENTS,
  GOAL_OPTIONS,
  hasRequiredConsents,
  toNutritionTargetInput,
  type ActivityLevel,
  type GoalType,
  type OnboardingConsentType,
} from '@nueat/domain';
import { and, eq, isNull } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';

interface OnboardingRouteOptions {
  auth: Auth;
  database: Database;
}

const profileSchema = z
  .object({
    goalType: z.enum(
      GOAL_OPTIONS.map((option) => option.value) as [GoalType, ...GoalType[]],
    ),
    birthYear: z.int().min(1900).max(new Date().getUTCFullYear()),
    calculationSex: z.enum(['female', 'male']).nullable(),
    heightMm: z.int().min(1200).max(2200),
    weightG: z.int().min(35000).max(250000),
    activityLevel: z.enum(
      ACTIVITY_OPTIONS.map((option) => option.value) as [
        ActivityLevel,
        ...ActivityLevel[],
      ],
    ),
    isPregnantOrLactating: z.boolean(),
    hasEatingDisorderRisk: z.boolean(),
    requiresMedicalNutrition: z.boolean(),
  })
  .strict();

const completeSchema = z
  .object({
    profile: profileSchema,
    acceptedConsentTypes: z
      .array(
        z.enum(
          CONSENT_DOCUMENTS.map((document) => document.type) as [
            OnboardingConsentType,
            ...OnboardingConsentType[],
          ],
        ),
      )
      .refine((types) => new Set(types).size === types.length),
  })
  .strict();

export const onboardingRoutes: FastifyPluginAsync<
  OnboardingRouteOptions
> = async (app, options) => {
  app.get('/api/onboarding/status', async (request, reply) => {
    const session = await getSession(request, options.auth);
    if (!session) return unauthorized(reply, request);

    const [profile] = await options.database
      .select({
        status: userProfiles.onboardingStatus,
        safetyModeReasonCodes: userProfiles.safetyModeReasonCodes,
      })
      .from(userProfiles)
      .where(eq(userProfiles.userId, session.user.id))
      .limit(1);

    return {
      status: profile?.status ?? 'pending',
      safetyModeReasonCodes: profile?.safetyModeReasonCodes ?? [],
    };
  });

  app.post('/api/onboarding/preview', async (request, reply) => {
    const session = await getSession(request, options.auth);
    if (!session) return unauthorized(reply, request);

    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, request);

    return calculateNutritionTargets(
      toNutritionTargetInput(parsed.data, new Date()),
    );
  });

  app.put('/api/onboarding/complete', async (request, reply) => {
    const session = await getSession(request, options.auth);
    if (!session) return unauthorized(reply, request);

    const parsed = completeSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, request);
    if (!hasRequiredConsents(parsed.data.acceptedConsentTypes)) {
      return reply.status(400).send({
        error: {
          code: 'REQUIRED_CONSENTS_MISSING',
          message: '필수 약관에 동의해야 합니다.',
          requestId: request.id,
        },
      });
    }

    const now = new Date();
    const result = calculateNutritionTargets(
      toNutritionTargetInput(parsed.data.profile, now),
    );
    const onboardingStatus =
      result.status === 'calculated' ? 'completed' : 'limited';
    const safetyModeReasonCodes =
      result.status === 'limited' ? result.reasons : [];

    try {
      const profileId = await options.database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ status: userProfiles.onboardingStatus })
          .from(userProfiles)
          .where(eq(userProfiles.userId, session.user.id))
          .limit(1);
        if (
          existing?.status === 'completed' ||
          existing?.status === 'limited'
        ) {
          throw new OnboardingAlreadyCompleteError();
        }

        const updatedProfiles = await tx
          .insert(userProfiles)
          .values({
            userId: session.user.id,
            locale: 'ko-KR',
            timezone: 'Asia/Seoul',
            onboardingStatus,
            safetyModeReasonCodes,
            onboardingCompletedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: userProfiles.userId,
            set: {
              locale: 'ko-KR',
              timezone: 'Asia/Seoul',
              onboardingStatus,
              safetyModeReasonCodes,
              onboardingCompletedAt: now,
              updatedAt: now,
            },
            setWhere: eq(userProfiles.onboardingStatus, 'pending'),
          })
          .returning({ userId: userProfiles.userId });
        if (updatedProfiles.length === 0)
          throw new OnboardingAlreadyCompleteError();

        await tx.insert(consents).values(
          CONSENT_DOCUMENTS.map((document) => {
            const action: 'granted' | 'revoked' =
              parsed.data.acceptedConsentTypes.includes(document.type)
                ? 'granted'
                : 'revoked';

            return {
              userId: session.user.id,
              type: document.type,
              action,
              documentVersion: document.version,
              documentSha256: document.documentSha256,
              occurredAt: now,
            };
          }),
        );

        if (result.status === 'limited') return null;
        const calculationSex = parsed.data.profile.calculationSex;
        if (calculationSex === null) {
          throw new Error(
            'Calculated nutrition target requires a calculation sex',
          );
        }

        await tx
          .update(nutritionProfiles)
          .set({ effectiveTo: now })
          .where(
            and(
              eq(nutritionProfiles.userId, session.user.id),
              isNull(nutritionProfiles.effectiveTo),
            ),
          );

        const [nutritionProfile] = await tx
          .insert(nutritionProfiles)
          .values({
            userId: session.user.id,
            goalType: parsed.data.profile.goalType,
            birthYear: parsed.data.profile.birthYear,
            calculationSex,
            heightMm: parsed.data.profile.heightMm,
            weightG: parsed.data.profile.weightG,
            activityLevel: parsed.data.profile.activityLevel,
            ...result.targets,
            equationSource: result.provenance.standard.equationSource,
            equationVersion: result.provenance.standard.equationVersion,
            corrigendaVersion: result.provenance.standard.corrigendaVersion,
            engineVersion: result.provenance.standard.engineVersion,
            safetyRulesVersion: result.provenance.standard.safetyRulesVersion,
            calculationInputSnapshot: {
              ageYears: now.getUTCFullYear() - parsed.data.profile.birthYear,
              calculationSex,
              heightMm: parsed.data.profile.heightMm,
              weightG: parsed.data.profile.weightG,
              activityLevel: parsed.data.profile.activityLevel,
              goalType: parsed.data.profile.goalType,
            },
            activityCoefficientBps: Math.round(
              result.provenance.activityCoefficient * 10_000,
            ),
            baseEerMillicalories: Math.round(
              result.provenance.baseEerKcal * 1_000,
            ),
            goalAdjustment: result.provenance.goalAdjustment,
            macroRatioSnapshot: result.provenance.macroEnergyPercent,
            effectiveFrom: now,
          })
          .returning({ id: nutritionProfiles.id });
        if (!nutritionProfile)
          throw new Error('Nutrition profile insert returned no row');

        return nutritionProfile.id;
      });

      return reply.status(201).send({
        status: onboardingStatus,
        targetResult: result,
        ...(profileId === null ? {} : { profileId }),
      });
    } catch (error) {
      if (error instanceof OnboardingAlreadyCompleteError) {
        return reply.status(409).send({
          error: {
            code: 'ONBOARDING_ALREADY_COMPLETED',
            message: '온보딩이 이미 완료되었습니다.',
            requestId: request.id,
          },
        });
      }
      throw error;
    }
  });
};

async function getSession(request: FastifyRequest, auth: Auth) {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
}

function unauthorized(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(401).send({
    error: {
      code: 'UNAUTHORIZED',
      message: '로그인이 필요합니다.',
      requestId: request.id,
    },
  });
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

class OnboardingAlreadyCompleteError extends Error {}
