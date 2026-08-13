import {
  calculationSnapshots,
  mealItems,
  mealLogs,
  nutritionProfiles,
  userProfiles,
  type Database,
} from '@nueat/database';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';

interface DailyDashboardRouteOptions {
  auth: Auth;
  database: Database;
}

const dailyDashboardQuerySchema = z.object({ date: z.string().optional() }).strict();
const snapshotInputSchema = z
  .object({
    mealItems: z
      .array(
        z
          .object({
            nutrientProfileQualityGrade: z.enum(['verified', 'estimated', 'unverified']),
            nutrients: z
              .object({
                energyMillicalories: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
                carbohydrateMg: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
                proteinMg: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
                fatMg: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
                fiberMg: z
                  .number()
                  .int()
                  .min(0)
                  .max(Number.MAX_SAFE_INTEGER)
                  .nullable(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();


export const dailyDashboardRoutes: FastifyPluginAsync<DailyDashboardRouteOptions> = async (
  app,
  options,
) => {
  app.get('/api/dashboard/daily', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;

    const query = dailyDashboardQuerySchema.safeParse(request.query);
    if (!query.success || (query.data.date !== undefined && !isLocalDate(query.data.date))) {
      return invalidRequest(reply, request);
    }

    const [userProfile] = await options.database
      .select({
        timezone: userProfiles.timezone,
        onboardingStatus: userProfiles.onboardingStatus,
        safetyModeReasonCodes: userProfiles.safetyModeReasonCodes,
      })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    const timezone = userProfile?.timezone ?? 'Asia/Seoul';
    const date = query.data.date ?? localDate(new Date(), timezone);

    const [profiles, meals] = await Promise.all([
      options.database
        .select({
          id: nutritionProfiles.id,
          goalType: nutritionProfiles.goalType,
          energyMillicalories: nutritionProfiles.calorieTargetMillicalories,
          carbohydrateMg: nutritionProfiles.carbohydrateTargetMg,
          proteinMg: nutritionProfiles.proteinTargetMg,
          fatMg: nutritionProfiles.fatTargetMg,
          fiberMg: nutritionProfiles.fiberTargetMg,
          effectiveFrom: nutritionProfiles.effectiveFrom,
          effectiveTo: nutritionProfiles.effectiveTo,
        })
        .from(nutritionProfiles)
        .where(eq(nutritionProfiles.userId, userId))
        .orderBy(desc(nutritionProfiles.effectiveFrom)),
      options.database
        .select({
          id: mealLogs.id,
          eatenAt: mealLogs.eatenAt,
          mealType: mealLogs.mealType,
        })
        .from(mealLogs)
        .where(
          and(
            eq(mealLogs.userId, userId),
            eq(mealLogs.status, 'confirmed'),
            eq(mealLogs.eatenLocalDate, date),
          ),
        )
        .orderBy(asc(mealLogs.eatenAt), asc(mealLogs.id)),
    ]);

    const targetProfile = profiles.find(
      (profile) =>
        localDate(profile.effectiveFrom, timezone) <= date &&
        (profile.effectiveTo === null || localDate(profile.effectiveTo, timezone) > date),
    );
    const target = targetProfile
      ? {
          profileId: targetProfile.id,
          goalType: targetProfile.goalType,
          energyMillicalories: targetProfile.energyMillicalories,
          carbohydrateMg: targetProfile.carbohydrateMg,
          proteinMg: targetProfile.proteinMg,
          fatMg: targetProfile.fatMg,
          fiberMg: targetProfile.fiberMg,
        }
      : null;
    const targetStatus = target
      ? 'active' as const
      : userProfile?.onboardingStatus === 'limited'
        ? 'limited' as const
        : userProfile?.onboardingStatus === 'pending' || !userProfile
          ? 'pending' as const
          : 'none' as const;
    const targetReasons =
      targetStatus === 'limited' ? (userProfile?.safetyModeReasonCodes ?? []) : [];


    if (meals.length === 0) {
      return {
        date,
        timezone,
        targetStatus,
        targetReasons,
        target,
        totals: emptyTotals(),
        meals: [],
      };
    }

    const mealIds = meals.map((meal) => meal.id);
    const [snapshots, currentItems] = await Promise.all([
      options.database
        .select({
          mealLogId: calculationSnapshots.mealLogId,
          sequence: calculationSnapshots.sequence,
          inputSnapshot: calculationSnapshots.inputSnapshot,
          energyMillicalories: calculationSnapshots.energyMillicalories,
          carbohydrateMg: calculationSnapshots.carbohydrateMg,
          proteinMg: calculationSnapshots.proteinMg,
          fatMg: calculationSnapshots.fatMg,
          fiberMg: calculationSnapshots.fiberMg,
          calculationVersion: calculationSnapshots.calculationVersion,
          calculatedAt: calculationSnapshots.calculatedAt,
        })
        .from(calculationSnapshots)
        .where(inArray(calculationSnapshots.mealLogId, mealIds))
        .orderBy(desc(calculationSnapshots.sequence)),
      options.database
        .select({
          mealLogId: mealItems.mealLogId,
          recognizedLabel: mealItems.recognizedLabel,
          recognitionRegionIndex: mealItems.recognitionRegionIndex,
          id: mealItems.id,
        })
        .from(mealItems)
        .where(inArray(mealItems.mealLogId, mealIds))
        .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id)),
    ]);

    const snapshotByMealId = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (!snapshotByMealId.has(snapshot.mealLogId)) {
        snapshotByMealId.set(snapshot.mealLogId, snapshot);
      }
    }
    if (meals.some((meal) => !snapshotByMealId.has(meal.id))) {
      throw new Error('CONFIRMED_MEAL_SNAPSHOT_MISSING');
    }
    const labelsByMealId = new Map<string, string[]>();
    for (const item of currentItems) {
      const labels = labelsByMealId.get(item.mealLogId) ?? [];
      labels.push(item.recognizedLabel);
      labelsByMealId.set(item.mealLogId, labels);
    }

    const dashboardMeals = meals.map((meal) => {
      const snapshot = snapshotByMealId.get(meal.id);
      if (!snapshot) throw new Error('CONFIRMED_MEAL_SNAPSHOT_MISSING');
      const parsedInput = snapshotInputSchema.safeParse(snapshot.inputSnapshot);
      if (!parsedInput.success) throw new Error('CALCULATION_SNAPSHOT_INVALID');
      const validatedSnapshot = { ...snapshot, inputSnapshot: parsedInput.data };
      const totals = snapshotTotals(validatedSnapshot);
      return {
        id: meal.id,
        eatenAt: meal.eatenAt,
        mealType: meal.mealType,
        itemLabels: labelsByMealId.get(meal.id) ?? [],
        totals,
        qualityGrade: parsedInput.data.mealItems.some(
          (item) => item.nutrientProfileQualityGrade !== 'verified',
        )
          ? 'estimated' as const
          : 'verified' as const,
        calculationVersion: snapshot.calculationVersion,
        calculatedAt: snapshot.calculatedAt,
      };
    });

    return {
      date,
      timezone,
      targetStatus,
      targetReasons,
      target,
      totals: sumTotals(dashboardMeals.map((meal) => meal.totals)),
      meals: dashboardMeals,
    };
  });
};

interface NutrientTotal {
  value: number | null;
  knownValue: number;
  missingItemCount: number;
  completeness: 'complete' | 'partial';
}

type DashboardTotals = Record<
  'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
  NutrientTotal
>;

const nutrientKeys = [
  'energyMillicalories',
  'carbohydrateMg',
  'proteinMg',
  'fatMg',
  'fiberMg',
] as const;

function snapshotTotals(snapshot: {
  inputSnapshot: z.infer<typeof snapshotInputSchema>;
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
}) {
  return Object.fromEntries(nutrientKeys.map((key) => {
    const missingItemCount = snapshot.inputSnapshot.mealItems.filter(
      (item) => item.nutrients[key] === null,
    ).length;
    const knownValue = snapshot.inputSnapshot.mealItems.reduce(
      (total, item) => safeAdd(total, item.nutrients[key] ?? 0),
      0,
    );
    const complete = missingItemCount === 0 && snapshot[key] !== null;
    return [key, {
      value: complete ? snapshot[key] : null,
      knownValue,
      missingItemCount,
      completeness: complete ? 'complete' : 'partial',
    }];
  })) as DashboardTotals;
}

function emptyTotals(): DashboardTotals {
  return Object.fromEntries(nutrientKeys.map((key) => [key, {
    value: 0,
    knownValue: 0,
    missingItemCount: 0,
    completeness: 'complete',
  }])) as DashboardTotals;
}

function sumTotals(totals: DashboardTotals[]) {
  const result = emptyTotals();
  for (const total of totals) {
    for (const key of nutrientKeys) {
      result[key].knownValue = safeAdd(result[key].knownValue, total[key].knownValue);
      result[key].missingItemCount += total[key].missingItemCount;
      result[key].completeness = result[key].missingItemCount === 0 ? 'complete' : 'partial';
      result[key].value = result[key].completeness === 'complete'
        ? result[key].knownValue
        : null;
    }
  }
  return result;
}
function safeAdd(left: number, right: number) {
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('DASHBOARD_TOTAL_OUT_OF_RANGE');
  }
  return Number(result);
}


function isLocalDate(value: string) {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

async function requireUserId(request: FastifyRequest, reply: FastifyReply, auth: Auth) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
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
