import { fromNodeHeaders } from 'better-auth/node';
import {
  calculationSnapshots,
  mealItems,
  mealLogs,
  parseCalculationInputSnapshot,
  projectCalculationInputSnapshot,
  type Database,
} from '@nueat/database';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';
import {
  classifyMealConfirmationCutover,
  type MealConfirmationCutoverConfig,
} from '../services/meal-confirmation-cutover';

interface MealConfirmationBridgeRouteOptions {
  auth: Auth;
  database: Database;
  cutover: MealConfirmationCutoverConfig;
}

const mealLogIdParamsSchema = z.object({ mealLogId: z.uuid() }).strict();

export const mealConfirmationBridgeRoutes: FastifyPluginAsync<
  MealConfirmationBridgeRouteOptions
> = async (app, options) => {
  app.get('/api/meal-logs/:mealLogId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const params = mealLogIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request);

    const [mealLog] = await options.database
      .select(legacyMealLogSelection)
      .from(mealLogs)
      .where(
        and(
          eq(mealLogs.id, params.data.mealLogId),
          eq(mealLogs.userId, userId),
        ),
      )
      .limit(1);
    if (!mealLog) return mealLogNotFound(reply, request);
    const items = await options.database
      .select(legacyMealItemSelection)
      .from(mealItems)
      .where(eq(mealItems.mealLogId, mealLog.id))
      .orderBy(asc(mealItems.recognitionRegionIndex), asc(mealItems.id));

    if (mealLog.status !== 'confirmed') {
      return legacyDraftResponse(mealLog, items);
    }

    const [snapshot] = await options.database
      .select(legacyCalculationSnapshotSelection)
      .from(calculationSnapshots)
      .where(eq(calculationSnapshots.mealLogId, mealLog.id))
      .orderBy(desc(calculationSnapshots.sequence))
      .limit(1);
    const response = snapshot && confirmedMealSnapshotResponse(mealLog, snapshot);
    if (response) return response;
    return reply.status(500).send({
      error: {
        code: 'CONFIRMED_MEAL_INTEGRITY_ERROR',
        message: '확정된 식사 기록을 안전하게 읽을 수 없습니다.',
        requestId: request.id,
      },
    });
  });

  const blockWrite = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const header = request.headers['x-nueat-meal-confirmation-protocol'];
    const decision = classifyMealConfirmationCutover(
      typeof header === 'string' ? header : undefined,
      options.cutover,
    );
    if (decision.action === 'proceed') {
      return reply.status(503).send({
        error: {
          code: 'MEAL_CONFIRMATION_MAINTENANCE',
          message: '식사 확인 기능을 점검 중입니다.',
          requestId: request.id,
        },
      });
    }
    if (decision.statusCode === 503) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
    }
    return reply.status(decision.statusCode).send({
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
  };

  for (const url of ['/api/meal-logs', '/api/meal-logs/*']) {
    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url,
      handler: blockWrite,
    });
  }
};

const legacyMealLogSelection = {
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
  draftRevision: mealLogs.draftRevision,
  confirmedAt: mealLogs.confirmedAt,
};

const legacyMealItemSelection = {
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
};

const legacyCalculationSnapshotSelection = {
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

function legacyDraftResponse(mealLog: any, items: any[]) {
  const missingItemCount = items.length;
  const nutritionTotal = {
    value: null,
    knownValue: 0,
    missingItemCount,
    status: 'pending' as const,
  };
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
      confirmedAt: null,
      recognitionOutcome: null,
      recognitionEvidenceReason: null,
      recognitionManualOverride: null,
      observationId: null,
      resolutionStatus: null,
      resolutionReason: null,
      resolutionRetryAt: null,
    },
    items: items.map((item) => ({
      id: item.id,
      recognizedLabel: item.recognizedLabel,
      amountMilliunits: item.amountMilliunits,
      unit: item.unit,
      estimatedAmountMilliunits: null,
      estimatedUnit: null,
      recognitionRegionIndex: item.recognitionRegionIndex,
      recognitionConfidenceBps: item.recognitionConfidenceBps,
      portionConfidenceBps: item.portionConfidenceBps,
      userCorrected: item.userCorrected,
      foodId: item.foodId,
      nutrientProfileId: item.nutrientProfileId,
      mappingConfidenceBps: item.mappingConfidenceBps,
      gramsMg: item.gramsMg,
      currentResolutionSource: item.currentResolutionSource,
      itemRevision: item.itemRevision,
      foodRevision: item.foodRevision,
      portionRevision: item.portionRevision,
      origin: item.origin,
      initialAssessment: item.initialEstimateAssessment ?? null,
      review: {
        status: 'required' as const,
        checkpoint: null,
        authority: {
          fingerprintVersion: 'legacy-maintenance-bridge-v1',
          fingerprint: null,
          officialSource: null,
          invalidReason: 'LEGACY_MAINTENANCE_UNKNOWN',
        },
        nextAction: 'review_item' as const,
      },
      currentResolution: {
        status: 'unresolved' as const,
        reason: 'LEGACY_MAINTENANCE_UNKNOWN',
        observationId: null,
        decisionId: null,
        previewId: null,
        decompositionRevisionId: null,
        composition: null,
        resolutionStatus: null,
        resolutionReason: null,
        resolutionRetryAt: null,
        candidates: [],
      },
    })),
    review: {
      confirmable: false,
      reasons: items.map((item) => ({
        code: 'LEGACY_REVIEW_REQUIRED',
        itemId: item.id,
      })),
      nutrition: {
        status: 'pending' as const,
        reviewedItemCount: 0,
        unreviewedItemCount: missingItemCount,
        totals: {
          energyMillicalories: nutritionTotal,
          carbohydrateMg: nutritionTotal,
          proteinMg: nutritionTotal,
          fatMg: nutritionTotal,
          fiberMg: nutritionTotal,
        },
      },
    },
  };
}

function confirmedMealSnapshotResponse(
  mealLog: any,
  snapshot: any,
) {
  const parsed = parseCalculationInputSnapshot(snapshot.inputSnapshot);
  if (!parsed) return null;
  const inputSnapshot = parsed.snapshot;
  const projection = projectCalculationInputSnapshot(parsed);
  const nutritionItems = inputSnapshot.mealItems.map((item) => {
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
  const total = (
    key: 'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
    value: number | null,
  ) => {
    const missingItemCount = nutritionItems.filter(
      (item) => item.nutrients[key] === null,
    ).length;
    return {
      value: missingItemCount === 0 ? value : null,
      knownValue: nutritionItems.reduce(
        (sum, item) => sum + (item.nutrients[key] ?? 0),
        0,
      ),
      missingItemCount,
      completeness: missingItemCount === 0 ? 'complete' as const : 'partial' as const,
    };
  };
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
    nutrition: {
      id: snapshot.id,
      calculationVersion: snapshot.calculationVersion,
      calculatedAt: snapshot.calculatedAt,
      items: nutritionItems,
      totals: {
        energyMillicalories: total('energyMillicalories', snapshot.energyMillicalories),
        carbohydrateMg: total('carbohydrateMg', snapshot.carbohydrateMg),
        proteinMg: total('proteinMg', snapshot.proteinMg),
        fatMg: total('fatMg', snapshot.fatMg),
        fiberMg: total('fiberMg', snapshot.fiberMg),
      },
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
