import { afterEach, describe, expect, test } from 'bun:test';
import {
  activeCatalogReleasePointers,
  calculationPreviews,
  calculationSnapshots,
  catalogReleaseFoodServings,
  catalogReleaseFoods,
  catalogReleaseNutrientProfiles,
  catalogReleaseSources,
  catalogReleases,
  foods,
  foodServings,
  imageAssets,
  mealItems,
  mealDecompositionComponents,
  mealDecompositionRevisions,
  mealLogs,
  mappingDecisions,
  nutrientProfiles,
  recognitionAttempts,
  releaseActivations,
  sourceReleases,
  sourceRegistries,
  storedObservations,
  userProfiles,
  type Database,
} from '@nueat/database';
import {
  MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
  mealItemReviewFingerprint,
} from '@nueat/domain';
import type { FastifyInstance } from 'fastify';

import type { Auth } from '../src/auth/auth';
import { parseEnvironment } from '../src/config/env';
import { buildServer } from '../src/server';
import { calculateCatalogRegistrySha256 } from '../src/services/catalog-registry-verifier';
import { MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL } from '../src/services/meal-confirmation-cutover';
import type { MealRecognitionCoordinatorResult } from '../src/services/meal-recognition-coordinator';

const environment = parseEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api.example.test',
  RESEND_API_KEY: 're_test',
  TRUSTED_ORIGINS: 'nueat://',
});
const mealId = '00000000-0000-4000-8000-000000000001';
const imageId = '00000000-0000-4000-8000-000000000002';
const itemId = '00000000-0000-4000-8000-000000000003';
const foodId = '00000000-0000-4000-8000-000000000010';
const nutrientProfileId = '00000000-0000-4000-8000-000000000011';
const sourceRegistryId = '00000000-0000-4000-8000-000000000013';
const catalogReleaseId = '00000000-0000-4000-8000-000000000020';
const sourceReleaseId = '00000000-0000-4000-8000-000000000021';
const activationId = '00000000-0000-4000-8000-000000000022';
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('meal log routes', () => {
  test('reviews one current authority checkpoint once and replays the same key', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    const draft = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    const item = JSON.parse(draft.body).items[0];
    const payload = {
      expectedDraftRevision: 1,
      expectedItemRevision: item.itemRevision,
      idempotencyKey: 'review-key',
      displayedAuthorityFingerprintVersion:
        item.review.authority.fingerprintVersion,
      displayedAuthorityFingerprint: item.review.authority.fingerprint,
    };

    const first = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items/${itemId}/review`,
      payload,
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items/${itemId}/review`,
      payload,
    });
    const reused = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items/${itemId}/review`,
      payload: { ...payload, expectedDraftRevision: 2 },
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(reused.statusCode).toBe(409);
    expect(JSON.parse(reused.body).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.items[0]!.itemRevision).toBe(1);
    expect(state.meal!.draftRevision).toBe(2);
    expect(state.items[0]!.reviewIdempotencyKey).toBe('review-key');
  });

  test('rejects a historical matching mapping when a newer current decision supersedes it', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.mappingDecisions.unshift({
      ...state.mappingDecisions[0],
      id: '00000000-0000-4000-8000-000000000041',
      selectedFoodId: '00000000-0000-4000-8000-000000000099',
      createdAt: new Date('2026-08-11T00:00:00.000Z'),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.items[0].review.authority).toMatchObject({
      fingerprint: null,
      invalidReason: 'MISSING_FOOD_MAPPING',
    });
    expect(body.review.reasons).toContainEqual({
      code: 'FOOD_MAPPING_MISSING',
      itemId,
    });
    expect(body.review.nextAction).toBe('select_item');
  });

  test('blocks GET and review when preview leaf facts are stale', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    confirmPayload(state);
    const preview = state.calculationPreviews[0]!;
    (preview.identity as { leaves: Array<Record<string, unknown>> }).leaves[0]!
      .nutrientProfileId = '00000000-0000-4000-8000-000000000099';

    const draft = await server.inject({ method: 'GET', url: `/api/meal-logs/${mealId}` });
    const body = JSON.parse(draft.body);
    const review = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items/${itemId}/review`,
      payload: {
        expectedDraftRevision: 1,
        expectedItemRevision: 1,
        idempotencyKey: 'stale-preview-review',
        displayedAuthorityFingerprintVersion: MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
        displayedAuthorityFingerprint: 'a'.repeat(64),
      },
    });

    expect(body.items[0].review.authority).toMatchObject({
      fingerprint: null,
      invalidReason: 'STALE_AUTHORITY',
    });
    expect(body.review).toMatchObject({
      confirmable: false,
      nextAction: 'review_item',
    });
    expect(body.review.reasons).toContainEqual({
      code: 'MEAL_ITEM_AUTHORITY_STALE',
      itemId,
    });
    expect(review.statusCode).toBe(409);
    expect(JSON.parse(review.body).error.code).toBe('MEAL_ITEM_AUTHORITY_STALE');
  });

  test('blocks GET and review when decomposition facts are stale', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    confirmPayload(state);
    const preview = state.calculationPreviews[0]!;
    const identity = preview.identity as Record<string, unknown>;
    identity.basis = 'meal_decomposition';
    (identity.leaves as Array<Record<string, unknown>>)[0]!.componentIdentity = 'stale-component';
    state.decompositionRevisions.push({
      id: '00000000-0000-4000-8000-000000000060',
      mealLogId: mealId,
      rootMappingDecisionId: state.mappingDecisions[0]!.id,
      rootCalculationPreviewId: preview.id,
    });
    state.decompositionComponents.push({
      mealDecompositionRevisionId: state.decompositionRevisions[0]!.id,
      ordinal: 0,
      mappingDecisionId: state.mappingDecisions[0]!.id,
      calculationPreviewId: preview.id,
      edibleAmountMg: (identity.leaves as Array<Record<string, unknown>>)[0]!.edibleAmountMg,
    });

    const draft = await server.inject({ method: 'GET', url: `/api/meal-logs/${mealId}` });
    const review = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items/${itemId}/review`,
      payload: {
        expectedDraftRevision: 1,
        expectedItemRevision: 1,
        idempotencyKey: 'stale-decomposition-review',
        displayedAuthorityFingerprintVersion: MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
        displayedAuthorityFingerprint: 'a'.repeat(64),
      },
    });

    expect(JSON.parse(draft.body).items[0].review.authority).toMatchObject({
      fingerprint: null,
      invalidReason: 'STALE_AUTHORITY',
    });
    expect(review.statusCode).toBe(409);
    expect(JSON.parse(review.body).error.code).toBe('MEAL_ITEM_AUTHORITY_STALE');
  });

  test('reports only the reviewed item as a subtotal when another item is unmapped', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    confirmPayload(state);
    state.items.push({
      id: '00000000-0000-4000-8000-000000000004',
      mealLogId: mealId,
      recognizedLabel: '미매핑 음식',
      amountMilliunits: 1_000,
      unit: 'g',
      recognitionRegionIndex: null,
      recognitionConfidenceBps: null,
      portionConfidenceBps: null,
      mappingConfidenceBps: null,
      gramsMg: null,
      userCorrected: true,
      origin: 'user_added',
      initialEstimateAssessment: null,
      currentResolutionSource: 'user_selected',
      itemRevision: 1,
      foodRevision: 1,
      portionRevision: 1,
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    const reviewedNutrition = JSON.parse(response.body).review.reviewedNutrition;

    expect(response.statusCode).toBe(200);
    expect(reviewedNutrition).toMatchObject({
      status: 'subtotal',
      reviewedItemCount: 1,
      unreviewedItemCount: 1,
      totals: {
        energyMillicalories: {
          value: null,
          knownValue: 300,
          missingItemCount: 0,
          status: 'subtotal',
        },
        carbohydrateMg: {
          value: null,
          knownValue: 45,
          status: 'subtotal',
        },
      },
    });
  });

  test('applies the cutover barrier before malformed confirmation bodies or mutations', async () => {
    const { server, state } = await createServer(true, {
      clientProtocol: null,
    });
    configureConfirmableDraft(state, 'g');

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: { malformed: true },
    });

    expect(response.statusCode).toBe(426);
    expect(JSON.parse(response.body).error).toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
      details: { requiredProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL },
    });
    expect(state.meal?.status).toBe('draft');
    expect(state.snapshots).toHaveLength(0);
  });

  test('blocks exact-protocol confirmation mutations during maintenance without parsing the body', async () => {
    const { server, state } = await createServer(true, {
      clientProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
      cutoverMode: 'maintenance_bridge',
    });
    configureConfirmableDraft(state, 'g');

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: { malformed: true },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('60');
    expect(JSON.parse(response.body).error.code).toBe(
      'MEAL_CONFIRMATION_MAINTENANCE',
    );
    expect(state.meal?.status).toBe('draft');
    expect(state.snapshots).toHaveLength(0);
  });

  test('bridge preserves owned legacy reads, including confirmed meals, and blocks root and wildcard writes', async () => {
    const { server, state } = await createServer(true, {
      clientProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
      cutoverMode: 'maintenance_bridge',
    });
    configureConfirmableDraft(state, 'g');
    state.snapshots.push(legacyCalculationSnapshot(itemId));

    const draft = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    state.snapshots.push({
      id: '00000000-0000-4000-8000-000000000070',
      sequence: 1,
      inputSnapshot: {
        confirmationDecision: {
          originalRecognition: null,
          manualOverride: null,
          policy: {
            version: 'meal-estimate-review-v1',
            activation: 'review_only',
            approvedReportSha256: null,
            activeReportSha256: null,
            approvedReportVersion: null,
          },
        },
        mealItems: [{
          mealItemId: itemId,
          origin: 'legacy_unknown',
          initialEstimateAssessment: null,
          currentResolutionSource: 'legacy_existing',
          itemRevision: 1,
          foodRevision: 1,
          portionRevision: 1,
          foodAcknowledgedRevision: null,
          portionAcknowledgedRevision: null,
          foodId,
          nutrientProfileId,
          amountMilliunits: 1_500,
          unit: 'g',
          gramsMg: 1_500,
          sourceRegistryId,
          sourceItemId: 'test-source-item',
          datasetVersion: '2026-08',
          nutrientProfileQualityGrade: 'verified',
          nutrientProfile: { basisAmountMg: 100_000 },
          serving: null,
          nutrients: {
            energyMillicalories: 300,
            carbohydrateMg: 45,
            proteinMg: 15,
            fatMg: 8,
            fiberMg: null,
          },
        }],
      },
      energyMillicalories: 300,
      carbohydrateMg: 45,
      proteinMg: 15,
      fatMg: 8,
      fiberMg: null,
      calculationVersion: 'meal-nutrition-v1',
      calculatedAt: new Date(),
    });
    state.meal!.status = 'confirmed';
    const confirmed = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    const rootWrite = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: { malformed: true },
    });
    const wildcardWrite = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: { malformed: true },
    });

    expect(draft.statusCode).toBe(200);
    expect(JSON.parse(draft.body)).toEqual({
      mealLog: {
        id: mealId,
        eatenAt: '2026-08-10T03:00:00.000Z',
        timezone: 'Asia/Seoul',
        localDate: '2026-08-10',
        mealType: 'lunch',
        status: 'draft',
        imageAssetId: imageId,
        recognitionStatus: 'ready',
        recognitionProvider: 'mock',
        recognitionModel: 'mock-recognition-v2',
        recognitionPromptVersion: 'meal-recognition-prompt-v1',
        recognitionSchemaVersion: 'meal-recognition-schema-v1',
        recognitionCompletedAt: '2026-08-10T03:00:01.000Z',
        recognitionLastErrorCode: null,
        recognitionAttemptCount: 1,
        recognitionNextAttemptAt: null,
        draftRevision: 1,
        confirmedAt: null,
        recognitionOutcome: null,
        recognitionEvidenceReason: null,
        recognitionManualOverride: null,
        observationId: null,
        resolutionStatus: null,
        resolutionReason: null,
        resolutionRetryAt: null,
      },
      items: [{
        id: itemId,
        recognizedLabel: '테스트 음식',
        amountMilliunits: 1_500,
        unit: 'g',
        estimatedAmountMilliunits: null,
        estimatedUnit: null,
        recognitionRegionIndex: null,
        recognitionConfidenceBps: null,
        portionConfidenceBps: null,
        userCorrected: true,
        foodId,
        nutrientProfileId,
        mappingConfidenceBps: 10_000,
        gramsMg: null,
        currentResolutionSource: 'user_selected',
        itemRevision: 1,
        foodRevision: 1,
        portionRevision: 1,
        origin: 'user_added',
        initialAssessment: null,
        review: {
          status: 'required',
          checkpoint: null,
          authority: {
            fingerprintVersion: 'legacy-maintenance-bridge-v1',
            fingerprint: null,
            officialSource: null,
            invalidReason: 'LEGACY_MAINTENANCE_UNKNOWN',
          },
          nextAction: 'review_item',
        },
        currentResolution: {
          status: 'unresolved',
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
      }],
      review: {
        confirmable: false,
        reasons: [{ code: 'LEGACY_REVIEW_REQUIRED', itemId }],
        nutrition: {
          status: 'pending',
          reviewedItemCount: 0,
          unreviewedItemCount: 1,
          totals: {
            energyMillicalories: {
              value: null,
              knownValue: 0,
              missingItemCount: 1,
              status: 'pending',
            },
            carbohydrateMg: {
              value: null,
              knownValue: 0,
              missingItemCount: 1,
              status: 'pending',
            },
            proteinMg: {
              value: null,
              knownValue: 0,
              missingItemCount: 1,
              status: 'pending',
            },
            fatMg: {
              value: null,
              knownValue: 0,
              missingItemCount: 1,
              status: 'pending',
            },
            fiberMg: {
              value: null,
              knownValue: 0,
              missingItemCount: 1,
              status: 'pending',
            },
          },
        },
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(JSON.parse(confirmed.body)).toMatchObject({
      mealLog: { id: mealId, status: 'confirmed' },
      review: { confirmable: false, evidence: 'legacy_unknown', reasons: [] },
      nutrition: {
        id: '00000000-0000-4000-8000-000000000014',
        items: [{
          mealItemId: itemId,
          nutrients: { energyMillicalories: 300 },
        }],
        totals: { energyMillicalories: { value: 300, completeness: 'complete' } },
      },
    });
    expect(rootWrite.statusCode).toBe(503);
    expect(wildcardWrite.statusCode).toBe(503);
    expect(JSON.parse(wildcardWrite.body).error.code).toBe(
      'MEAL_CONFIRMATION_MAINTENANCE',
    );
  });

  test('keeps owned reads available and lets exact normal-protocol requests reach handlers', async () => {
    const { server, state } = await createServer(true, {
      clientProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
    });
    configureConfirmableDraft(state, 'g');

    const read = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });

    const mutation = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: { malformed: true },
    });

    expect(read.statusCode).toBe(200);
    expect(mutation.statusCode).toBe(400);
    expect(JSON.parse(mutation.body).error.code).toBe('INVALID_REQUEST');
  });

  test('rejects unauthenticated access', async () => {
    const { server } = await createServer(false);
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });

  test('creates a processed draft with the deterministic mock recognizer', async () => {
    const { server, state } = await createServer(true);
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(201);
    expect(body.mealLog).toMatchObject({
      id: mealId,
      imageAssetId: imageId,
      status: 'draft',
      recognitionStatus: 'ready',
      recognitionProvider: 'mock',
      recognitionModel: 'mock-recognition-v2',
      localDate: '2026-08-10',
    });
    expect(
      body.items.map(
        (item: {
          recognizedLabel: string;
          amountMilliunits: number;
          unit: string;
        }) => [item.recognizedLabel, item.amountMilliunits, item.unit],
      ),
    ).toEqual([
      ['흰쌀밥', 1000, 'bowl'],
      ['김치찌개', 1000, 'serving'],
      ['배추김치', 500, 'serving'],
    ]);
    expect(state.asset.status).toBe('processed');
    expect(body.review.confirmable).toBeFalse();
    expect(body.review.reasons).toContainEqual({
      code: 'FOOD_MAPPING_MISSING',
      itemId,
    });
    expect(body.review).toMatchObject({
      nextAction: 'select_item',
      nextItemId: itemId,
      reviewedNutrition: {
        status: 'pending',
        reviewedItemCount: 0,
        unreviewedItemCount: 3,
      },
    });
  });
  test('derives meal date and type from the persisted profile timezone', async () => {
    const { server } = await createServer(true, {
      profileTimezone: 'Pacific/Honolulu',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).mealLog).toMatchObject({
      timezone: 'Pacific/Honolulu',
      localDate: '2026-08-09',
      mealType: 'dinner',
    });
  });

  test('includes an additive recognition outcome without changing mealLog/items', async () => {
    const { server } = await createServer(true);
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      mealLog: { recognitionStatus: 'ready' },
      recognitionOutcome: { status: 'ready' },
    });
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('returns a retryable 503 when catalog resolution is unavailable', async () => {
    const { server } = await createServer(true, {
      recognitionOutcome: {
        status: 'unavailable',
        code: 'CATALOG_UNAVAILABLE',
        retryable: true,
      },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('60');
    expect(JSON.parse(response.body).error).toMatchObject({
      code: 'CATALOG_UNAVAILABLE',
    });
  });


  test('returns the existing draft when the validated image is retried', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.asset.status = 'processed';
    Object.assign(state.items[0]!, {
      recognizedLabel: '흰쌀밥',
      amountMilliunits: 1_000,
      unit: 'bowl',
      recognitionConfidenceBps: 9_500,
      portionConfidenceBps: 9_200,
      userCorrected: false,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).mealLog.id).toBe(mealId);
    expect(state.items).toHaveLength(1);
  });

  test('does not claim an unavailable image or disclose image storage details', async () => {
    const { server } = await createServer(true, { assetStatus: 'uploaded' });
    const response = await server.inject({
      method: 'POST',
      url: '/api/meal-logs',
      payload: createPayload(),
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('IMAGE_ASSET_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain('objectKey');
    expect(JSON.stringify(body)).not.toContain('bucketName');
  });

  test('hides other users meals as not found', async () => {
    const { server } = await createServer(true, { mealUserId: 'other-user' });
    const response = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('MEAL_LOG_NOT_FOUND');
  });

  test('adds, corrects, and deletes a draft item', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();
    const add = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items`,
      payload: {
        expectedDraftRevision: 1,
        recognizedLabel: '수정 음식',
        amountMilliunits: 250,
        unit: 'g',
      },
    });
    expect(add.statusCode).toBe(201);
    Object.assign(state.items[0]!, {
      foodId: '00000000-0000-4000-8000-000000000010',
      nutrientProfileId: '00000000-0000-4000-8000-000000000011',
      mappingConfidenceBps: 10_000,
    });
    const edit = await server.inject({
      method: 'PATCH',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
      payload: { expectedItemRevision: 1, amountMilliunits: 500 },
    });
    expect(edit.statusCode).toBe(200);
    expect(JSON.parse(edit.body).items[0].userCorrected).toBe(true);
    expect(JSON.parse(edit.body).items[0].foodId).not.toBeNull();
    expect(JSON.parse(edit.body).items[0]).toMatchObject({
      portionRevision: 2,
    });

    const rename = await server.inject({
      method: 'PATCH',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
      payload: {
        expectedItemRevision: 2,
        recognizedLabel: '새 음식 이름',
        amountMilliunits: 500,
        unit: 'g',
      },
    });
    expect(rename.statusCode).toBe(200);
    expect(JSON.parse(rename.body).items[0]).toMatchObject({
      foodId: null,
      nutrientProfileId: null,
      mappingConfidenceBps: null,
      foodRevision: 2,
      portionRevision: 2,
    });
    const remove = await server.inject({
      method: 'DELETE',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
      payload: { expectedDraftRevision: 4, expectedItemRevision: 3 },
    });
    expect(remove.statusCode).toBe(200);
  });
  test('rejects a stale draft PATCH with the latest representation and no mutation', async () => {
    const { server, state } = await createServer(true);
    state.meal = { ...draftMeal(), draftRevision: 2 };
    state.rejectMealUpdate = true;

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/meal-logs/${mealId}`,
      payload: { expectedDraftRevision: 1, mealType: 'dinner' },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: 'MEAL_DRAFT_STALE',
        details: { latest: { mealLog: { id: mealId, draftRevision: 2 } } },
      },
    });
    expect(state.meal.mealType).toBe('lunch');
  });
  test('rejects a stale food selection with latest item convergence and no mutation', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.items[0]!.itemRevision = 2;
    state.rejectItemUpdate = true;

    const response = await server.inject({
      method: 'PUT',
      url: `/api/meal-logs/${mealId}/items/${itemId}/food`,
      payload: { foodId, expectedItemRevision: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: 'MEAL_ITEM_STALE',
        details: { latest: { items: [{ id: itemId, itemRevision: 2 }] } },
      },
    });
    expect(state.items[0]!.foodId).toBe(foodId);
  });
  test('keeps PATCH and an already-authoritative same-food PUT revision-neutral', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    const draftRevision = state.meal!.draftRevision;
    const itemRevision = state.items[0]!.itemRevision;

    const patch = await server.inject({
      method: 'PATCH',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
      payload: {
        expectedItemRevision: itemRevision,
        recognizedLabel: state.items[0]!.recognizedLabel,
      },
    });
    const mapping = await server.inject({
      method: 'PUT',
      url: `/api/meal-logs/${mealId}/items/${itemId}/food`,
      payload: { foodId, expectedItemRevision: itemRevision },
    });

    expect(patch.statusCode).toBe(200);
    expect(mapping.statusCode, mapping.body).toBe(200);
    expect(state.meal!.draftRevision).toBe(draftRevision);
    expect(state.items[0]!.itemRevision).toBe(itemRevision);
    expect(state.mappingDecisions).toHaveLength(1);
    expect(state.calculationPreviews).toHaveLength(1);
  });

  test('rejects a stale conditional item delete without mutation', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.rejectItemDelete = true;

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/meal-logs/${mealId}/items/${itemId}`,
      payload: { expectedDraftRevision: 1, expectedItemRevision: 2 },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('MEAL_ITEM_STALE');
    expect(state.items).toHaveLength(1);
    expect(state.meal!.draftRevision).toBe(1);
  });
  test('requires an explicit item review before final confirmation', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');

    const response = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).review).toMatchObject({
      confirmable: false,
      nextAction: 'review_item',
      nextItemId: itemId,
      reasons: [{ code: 'MEAL_ITEM_REVIEW_REQUIRED', itemId }],
      reviewedNutrition: {
        status: 'pending',
        reviewedItemCount: 0,
        unreviewedItemCount: 1,
      },
      nutrition: {
        id: 'preview',
        calculationVersion: 'meal-nutrition-v1-preview',
        totals: {
          energyMillicalories: { completeness: 'complete' },
          fiberMg: { completeness: 'partial' },
        },
      },
    });
  });
  test('requires explicit review for a high-confidence mapped model estimate', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.meal = {
      ...state.meal,
      recognitionResult: {
        version: 2,
        outcome: 'recognized',
        imageQualityConfidenceBps: 7_000,
        foods: [{
          regionIndex: 0,
          rawLabel: '테스트 음식',
          normalizedLabel: '테스트음식',
          foodConfidenceBps: 7_000,
          amountMilliunits: 1_500,
          unit: 'g',
          portionConfidenceBps: 7_000,
          questions: [],
          alternatives: [],
        }],
      },
    };
    state.items[0] = {
      ...state.items[0]!,
      userCorrected: false,
      origin: 'model_estimate',
      recognitionRegionIndex: 0,
      currentResolutionSource: 'model_primary',
      initialEstimateAssessment: {
        rawLabel: '테스트 음식',
        normalizedLabel: '테스트음식',
        foodConfidenceBps: 7_000,
        portionConfidenceBps: 7_000,
        foodCandidateMarginBps: 1_000,
        questions: [],
        alternatives: [],
        initialMappingSource: 'model_primary',
        initialMatchedLabel: '테스트 음식',
        initialFoodId: foodId,
        initialNutrientProfileId: nutrientProfileId,
        recognitionProvider: 'mock',
        recognitionModel: 'mock-recognition-v2',
        recognitionPromptVersion: 'meal-recognition-prompt-v2',
        recognitionSchemaVersion: 'meal-recognition-schema-v2',
        policyVersion: 'meal-estimate-review-v1',
      },
    };
    confirmPayload(state, { populateReviewCheckpoint: false });
    const draft = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    const draftBody = JSON.parse(draft.body);
    expect(draftBody.review).toMatchObject({
      confirmable: false,
      nextAction: 'review_item',
      nextItemId: itemId,
      reasons: [{ code: 'MEAL_ITEM_REVIEW_REQUIRED', itemId }],
    });

    const review = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items/${itemId}/review`,
      payload: {
        expectedDraftRevision: 1,
        expectedItemRevision: draftBody.items[0].itemRevision,
        idempotencyKey: 'high-confidence-review-key',
        displayedAuthorityFingerprintVersion:
          draftBody.items[0].review.authority.fingerprintVersion,
        displayedAuthorityFingerprint:
          draftBody.items[0].review.authority.fingerprint,
      },
    });
    expect(review.statusCode, review.body).toBe(200);

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: {
        ...confirmPayload(state),
        expectedDraftRevision: 2,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(state.snapshots).toHaveLength(1);
    expect((state.snapshots[0]!.inputSnapshot as {
      mealItems: Record<string, unknown>[];
    }).mealItems[0]).toMatchObject({
      initialEstimateAssessment: {
        initialFoodId: foodId,
        initialNutrientProfileId: nutrientProfileId,
      },
      currentResolutionSource: 'model_primary',
    });
  });
  test('does not expose legacy bulk review fields for a model estimate', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.meal = {
      ...state.meal,
      recognitionResult: {
        version: 2,
        outcome: 'recognized',
        imageQualityConfidenceBps: 9_000,
        foods: [{
          regionIndex: 0,
          rawLabel: '테스트 음식',
          normalizedLabel: '테스트음식',
          foodConfidenceBps: 9_000,
          amountMilliunits: 1_500,
          unit: 'g',
          portionConfidenceBps: 9_000,
          questions: [],
          alternatives: [],
        }],
      },
    };
    Object.assign(state.items[0]!, {
      userCorrected: false,
      origin: 'model_estimate',
      recognitionRegionIndex: 0,
      currentResolutionSource: 'model_primary',
      initialEstimateAssessment: {
        rawLabel: '테스트 음식',
        normalizedLabel: '테스트음식',
        foodConfidenceBps: 9_000,
        portionConfidenceBps: 9_000,
        foodCandidateMarginBps: 1_000,
        questions: [],
        alternatives: [],
        initialMappingSource: 'model_primary',
        initialMatchedLabel: '테스트 음식',
        initialFoodId: foodId,
        initialNutrientProfileId: nutrientProfileId,
        recognitionProvider: 'mock',
        recognitionModel: 'mock-recognition-v2',
        recognitionPromptVersion: 'meal-recognition-prompt-v2',
        recognitionSchemaVersion: 'meal-recognition-schema-v2',
        policyVersion: 'meal-estimate-review-v1',
      },
    });
    confirmPayload(state, { populateReviewCheckpoint: false });

    const draft = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    expect(JSON.parse(draft.body).review).toMatchObject({
      confirmable: false,
      nextAction: 'review_item',
      nextItemId: itemId,
      reasons: [{ code: 'MEAL_ITEM_REVIEW_REQUIRED', itemId }],
    });
    const publicItem = JSON.parse(draft.body).items[0];
    expect(publicItem.itemReview).toBeUndefined();
    expect(publicItem.initialEstimateAssessment).toBeUndefined();
    expect(publicItem).toHaveProperty('currentResolutionSource', 'model_primary');
    expect(publicItem).toHaveProperty('recognitionRegionIndex');
    expect(publicItem).toHaveProperty('gramsMg');
    expect(publicItem).toMatchObject({
      estimatedAmountMilliunits: 1_500,
      estimatedUnit: 'g',
    });

    expect(JSON.parse(draft.body).review).not.toHaveProperty(
      'requiredReviewFields',
    );
  });
  test('preserves immutable initial mapping and final user-selected resolution in the snapshot', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.meal = {
      ...state.meal,
      recognitionResult: {
        version: 2,
        outcome: 'recognized',
        imageQualityConfidenceBps: 9_000,
        foods: [{
          regionIndex: 0,
          rawLabel: '이전 음식',
          normalizedLabel: '이전음식',
          foodConfidenceBps: 9_000,
          amountMilliunits: 1_500,
          unit: 'g',
          portionConfidenceBps: 9_000,
          questions: [],
          alternatives: [],
        }],
      },
    };
    state.items[0] = {
      ...state.items[0]!,
      origin: 'model_estimate',
      currentResolutionSource: 'user_selected',
      initialEstimateAssessment: {
        rawLabel: '이전 음식',
        normalizedLabel: '이전음식',
        foodConfidenceBps: 9_000,
        portionConfidenceBps: 9_000,
        foodCandidateMarginBps: null,
        questions: [],
        alternatives: [],
        initialMappingSource: 'model_primary',
        initialMatchedLabel: '이전 음식',
        initialFoodId: '00000000-0000-4000-8000-000000000099',
        initialNutrientProfileId: '00000000-0000-4000-8000-000000000098',
        recognitionProvider: 'openai',
        recognitionModel: 'gpt-5.4-mini-2026-03-17',
        recognitionPromptVersion: 'meal-recognition-prompt-v2',
        recognitionSchemaVersion: 'meal-recognition-schema-v2',
        policyVersion: 'meal-estimate-review-v1',
      },
    };

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    const snapshotItem = (state.snapshots[0]!.inputSnapshot as {
      mealItems: Record<string, unknown>[];
    }).mealItems[0];

    expect(response.statusCode).toBe(200);
    expect(snapshotItem).toMatchObject({
      initialEstimateAssessment: {
        initialFoodId: '00000000-0000-4000-8000-000000000099',
        initialNutrientProfileId: '00000000-0000-4000-8000-000000000098',
        recognitionModel: 'gpt-5.4-mini-2026-03-17',
      },
      currentResolutionSource: 'user_selected',
      foodId,
      nutrientProfileId,
    });
  });

  test('blocks item entry and confirmation for zero outcomes before manual override', async () => {
    for (const outcome of ['no_food', 'insufficient_evidence'] as const) {
      const { server, state } = await createServer(true);
      configureConfirmableDraft(state, 'g');
      state.meal = {
        ...state.meal,
        recognitionResult: {
          version: 2,
          outcome,
          imageQualityConfidenceBps: 9_000,
          foods: [],
          ...(outcome === 'insufficient_evidence' ? { evidenceReason: 'blurred' } : {}),
        },
      };
      state.items = [];
      state.meal = { ...state.meal!, draftRevision: 2 };
      const staleAdd = await server.inject({
        method: 'POST',
        url: `/api/meal-logs/${mealId}/items`,
        payload: {
          expectedDraftRevision: 1,
          recognizedLabel: '직접 입력',
          amountMilliunits: 100,
          unit: 'g',
        },
      });
      expect(staleAdd.statusCode).toBe(409);
      expect(JSON.parse(staleAdd.body).error.code).toBe('MEAL_DRAFT_STALE');
      state.meal = { ...state.meal!, draftRevision: 1 };

      const add = await server.inject({
        method: 'POST',
        url: `/api/meal-logs/${mealId}/items`,
        payload: {
          expectedDraftRevision: 1,
          recognizedLabel: '직접 입력',
          amountMilliunits: 100,
          unit: 'g',
        },
      });
      expect(add.statusCode).toBe(409);

      configureConfirmableDraft(state, 'g');
      state.meal = {
        ...state.meal,
        recognitionResult: {
          version: 2,
          outcome,
          imageQualityConfidenceBps: 9_000,
          foods: [],
          ...(outcome === 'insufficient_evidence' ? { evidenceReason: 'blurred' } : {}),
        },
      };
      const confirm = await server.inject({
        method: 'POST',
        url: `/api/meal-logs/${mealId}/confirm`,
        payload: confirmPayload(state, { populateReviewCheckpoint: false }),
      });
      expect(confirm.statusCode).toBe(409);
      expect(JSON.parse(confirm.body).error.code).toBe(
        'MEAL_CONFIRMATION_INVALID',
      );
      expect(state.snapshots).toHaveLength(0);
    }
  });



  test('soft deletes a draft and queues its image deletion', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/meal-logs/${mealId}`,
      payload: { expectedDraftRevision: 1 },
    });
    expect(response.statusCode).toBe(204);
    expect(state.meal?.status).toBe('deleted');
    expect(state.asset.status).toBe('deletion_pending');
    expect(state.deletionJob?.imageAssetId).toBe(imageId);
  });
  test('rejects a stale delete before queuing image deletion', async () => {
    const { server, state } = await createServer(true);
    state.meal = { ...draftMeal(), draftRevision: 2 };
    state.rejectMealUpdate = true;

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/meal-logs/${mealId}`,
      payload: { expectedDraftRevision: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('MEAL_DRAFT_STALE');
    expect(state.meal.status).toBe('draft');
    expect(state.deletionJob).toBeUndefined();
  });
  test('allows resolution retry but rejects manual conversion after recognition is ready', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();

    const retry = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/retry`,
    });
    const manual = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/manual`,
      payload: { expectedDraftRevision: 1 },
    });

    expect(retry.statusCode).toBe(200);
    expect(manual.statusCode).toBe(409);
    expect(state.meal.recognitionStatus).toBe('ready');
    expect(state.meal.recognitionProvider).toBe('mock');
  });
  test('records provenance for a zero-item no-food manual override without auto-confirming', async () => {
    const { server, state } = await createServer(true);
    state.meal = {
      ...draftMeal(),
      recognitionResult: { version: 2, outcome: 'no_food', imageQualityConfidenceBps: 9_500, foods: [] },
    };

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/manual`,
      payload: { expectedDraftRevision: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).mealLog).toMatchObject({
      status: 'draft',
      recognitionStatus: 'manual',
      recognitionManualOverride: {
        fromStatus: 'ready',
        fromOutcome: 'no_food',
        decision: 'direct_entry',
        decisionVersion: 'recognition-manual-override-v1',
      },
    });
    expect(state.items).toHaveLength(0);
    expect(state.snapshots).toHaveLength(0);
    const replay = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/manual`,
      payload: { expectedDraftRevision: 2 },
    });
    expect(replay.statusCode).toBe(409);
    expect(JSON.parse(replay.body).error.code).toBe('INVALID_MEAL_LOG_STATE');
    const add = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/items`,
      payload: {
        expectedDraftRevision: 2,
        recognizedLabel: '직접 입력',
        amountMilliunits: 100,
        unit: 'g',
      },
    });
    expect(add.statusCode).toBe(201);
    expect(state.items[0]!.origin).toBe('manual_entry');
    expect(state.meal!.recognitionResult).toEqual({
      version: 2,
      outcome: 'no_food',
      imageQualityConfidenceBps: 9_500,
      foods: [],
    });
  });
  test('rejects a stale manual transition with the latest draft and preserved evidence', async () => {
    const { server, state } = await createServer(true);
    state.meal = {
      ...draftMeal(),
      draftRevision: 2,
      recognitionStatus: 'failed',
      recognitionLastErrorCode: 'PROVIDER_TIMEOUT',
    };
    const originalResult = state.meal.recognitionResult;

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/manual`,
      payload: { expectedDraftRevision: 1 },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(409);
    expect(body.error).toMatchObject({
      code: 'MEAL_DRAFT_STALE',
      details: { latest: { mealLog: { id: mealId, draftRevision: 2 } } },
    });
    expect(state.meal.recognitionStatus).toBe('failed');
    expect(state.meal.recognitionResult).toEqual(originalResult);
    expect(state.meal.recognitionManualOverride).toBeNull();
  });
  test('records provenance when pending recognition transitions to manual entry', async () => {
    const { server, state } = await createServer(true);
    state.meal = {
      ...draftMeal(),
      recognitionStatus: 'pending',
      recognitionResult: null,
      recognitionLastErrorCode: null,
      recognitionLeaseToken: 'lease',
      recognitionLeaseExpiresAt: new Date(),
      recognitionNextAttemptAt: new Date(),
    };

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/recognition/manual`,
      payload: { expectedDraftRevision: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).mealLog.recognitionManualOverride).toMatchObject({
      fromStatus: 'pending',
      fromOutcome: null,
      fromErrorCode: null,
      actorUserId: 'user-id',
      expectedDraftRevision: 1,
      changedFields: ['recognitionStatus'],
      decision: 'direct_entry',
    });
    expect(state.meal.recognitionLeaseToken).toBeNull();
    expect(state.meal.recognitionNextAttemptAt).toBeNull();
  });
  test('requires all four core nutrients while preserving a null fiber partial result', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');

    const preview = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    expect(JSON.parse(preview.body).review.nutrition.totals.fiberMg).toMatchObject({
      value: null,
      knownValue: 0,
      missingItemCount: 1,
      completeness: 'partial',
    });
    const payload = confirmPayload(state);
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: {
        ...payload,
        idempotencyKey: '00000000-0000-4000-8000-000000000097',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).nutrition.totals).toMatchObject({
      energyMillicalories: { value: 300, completeness: 'complete' },
      carbohydrateMg: { value: 45, completeness: 'complete' },
      proteinMg: { value: 15, completeness: 'complete' },
      fatMg: { value: 8, completeness: 'complete' },
      fiberMg: { value: null, knownValue: 0, missingItemCount: 1, completeness: 'partial' },
    });
  });

  test('confirms mapped gram items with persisted profile values', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      mealLog: { status: 'confirmed' },
      items: [{
        mealItemId: itemId,
        foodId,
        nutrientProfileId,
        nutrients: { energyMillicalories: 300 },
      }],
      nutrition: {
        calculationVersion: 'meal-nutrition-v1',
        items: [{
          source: {
            nutrientProfileId,
            qualityGrade: 'verified',
            servingId: null,
            servingSourceRegistryId: null,
            servingQualityGrade: null,
          },
        }],
        totals: { energyMillicalories: { value: 300, completeness: 'complete' } },
      },
    });
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]!.inputSnapshot).toMatchObject({
      confirmationDecision: {
        originalRecognition: null,
        manualOverride: null,
        reviewProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
      },
      mealItems: [{
        mealItemId: itemId,
        origin: 'user_added',
        initialEstimateAssessment: null,
        currentResolutionSource: 'user_selected',
        itemRevision: 1,
        foodRevision: 1,
        portionRevision: 1,
        foodId,
        nutrientProfileId,
        amountMilliunits: 1_500,
        unit: 'g',
        gramsMg: 1_500,
        sourceRegistryId,
        sourceItemId: 'test-source-item',
        datasetVersion: '2026-08',
        nutrientProfileQualityGrade: 'verified',
        nutrientProfile: {
          basisAmountMg: 100_000,
          energyMillicalories: 20_000,
          carbohydrateMg: 3_000,
          proteinMg: 1_000,
          fatMg: 500,
          fiberMg: null,
        },
        serving: null,
        nutrients: {
          energyMillicalories: 300,
          carbohydrateMg: 45,
          proteinMg: 15,
          fatMg: 8,
          fiberMg: null,
        },
      }],
    });
    expect(state.snapshots[0]!.inputSnapshot).toMatchObject({
      version: 'meal-calculation-snapshot-v2',
      mealItems: [{
        authority: {
          fingerprintVersion: MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
        },
        checkpoint: {
          reviewedItemRevision: 1,
          reviewedAuthorityFingerprintVersion:
            MEAL_ITEM_REVIEW_FINGERPRINT_VERSION,
        },
        provenance: {
          calculationVersion: 'meal-nutrition-v1',
          nutrientProfileId,
          sourceRegistryId,
        },
      }],
    });
  });

  test('reopens a confirmation after its response is dropped with the same immutable projection', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');

    const confirmed = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    const reopened = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });

    expect(confirmed.statusCode).toBe(200);
    expect(reopened.statusCode).toBe(200);
    expect(JSON.parse(reopened.body)).toEqual(JSON.parse(confirmed.body));
  });

  test('converts non-gram items through their sole matching serving', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'serving');
    state.servings.push({
      id: '00000000-0000-4000-8000-000000000012',
      foodId: foodId,
      unit: 'serving',
      amountMilliunits: 1_000,
      gramsMg: 200_000,
      sourceRegistryId: sourceRegistryId,
      qualityGrade: 'verified',
    });
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.nutrition.items[0].gramsMg).toBe(300_000);
    expect(body.nutrition.items[0].source).toMatchObject({
      servingId: '00000000-0000-4000-8000-000000000012',
      servingSourceRegistryId: sourceRegistryId,
      servingQualityGrade: 'verified',
    });
  });

  test('rejects missing mappings, profiles, and serving conversions without mutation', async () => {
    for (const invalid of ['mapping', 'profile', 'serving'] as const) {
      const { server, state } = await createServer(true);
      configureConfirmableDraft(state, invalid === 'serving' ? 'serving' : 'g');
      if (invalid === 'mapping') {
        delete state.items[0]!.foodId;
        delete state.items[0]!.nutrientProfileId;
      }
      if (invalid === 'profile') state.profiles = [];
      const response = await server.inject({
        method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.code).toBe(
        'MEAL_CONFIRMATION_INVALID',
      );
      expect(state.meal?.status).toBe('draft');
      expect(state.items[0]!.gramsMg).toBeNull();
      expect(state.snapshots).toHaveLength(0);
    }
  });

  test('rejects mismatched food/profile ownership without mutation', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.profiles[0]!.foodId = '00000000-0000-4000-8000-000000000099';
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe(
      'MEAL_CONFIRMATION_INVALID',
    );
    expect(state.meal?.status).toBe('draft');
    expect(state.snapshots).toHaveLength(0);
  });

  test('rejects deprecated foods and untrusted profile or serving sources', async () => {
    for (const invalid of ['food', 'profile', 'serving'] as const) {
      const { server, state } = await createServer(true);
      configureConfirmableDraft(state, invalid === 'serving' ? 'serving' : 'g');
      if (invalid === 'food') state.foods[0]!.isDeprecated = true;
      if (invalid === 'profile')
        state.registries[0]!.kind = 'recipe_estimate';
      if (invalid === 'serving') {
        state.servings.push({
          id: '00000000-0000-4000-8000-000000000012',
          foodId,
          unit: 'serving',
          amountMilliunits: 1_000,
          gramsMg: 200_000,
          sourceRegistryId: '00000000-0000-4000-8000-000000000015',
          qualityGrade: 'verified',
        });
        state.registries.push({
          id: '00000000-0000-4000-8000-000000000015',
          kind: 'user_entered',
        });
      }
      const response = await server.inject({
        method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.code).toBe(
        'MEAL_CONFIRMATION_INVALID',
      );
      expect(state.meal?.status).toBe('draft');
      expect(state.snapshots).toHaveLength(0);
    }
  });
  test('does not confirm an empty ready draft and keeps it a draft', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatchObject({
      code: 'MEAL_CONFIRMATION_INVALID',
      details: { items: [{ code: 'EMPTY_MEAL' }] },
    });
    expect(state.meal.status).toBe('draft');
    expect(state.snapshots).toHaveLength(0);
  });
  test('replays the latest confirmation snapshot without creating another', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    const first = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body).nutrition.id).toBe(JSON.parse(first.body).nutrition.id);
    expect(state.snapshots).toHaveLength(1);
  });

  test('rejects changed confirmation payload reuse without creating sequence two', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    const payload = confirmPayload(state);
    const first = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload,
    });
    expect(first.statusCode).toBe(200);

    const reused = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: {
        ...payload,
        items: payload.items.map((item) => ({
          ...item,
          expectedItemRevision: Number(item.expectedItemRevision) + 1,
        })),
      },
    });

    expect(reused.statusCode).toBe(409);
    expect(JSON.parse(reused.body).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(state.snapshots).toHaveLength(1);
  });
});

function createPayload() {
  return {
    imageAssetId: imageId,
    eatenAt: '2026-08-10T03:00:00.000Z',
    timezone: 'Asia/Seoul',
    mealType: 'lunch',
  };
}
function draftMeal() {
  return {
    id: mealId,
    userId: 'user-id',
    eatenAt: new Date('2026-08-10T03:00:00.000Z'),
    timezone: 'Asia/Seoul',
    localDate: '2026-08-10',
    mealType: 'lunch',
    status: 'draft',
    imageAssetId: imageId,
    recognitionStatus: 'ready',
    recognitionProvider: 'mock',
    recognitionModel: 'mock-recognition-v2',
    recognitionPromptVersion: 'meal-recognition-prompt-v1',
    recognitionSchemaVersion: 'meal-recognition-schema-v1',
    recognitionCompletedAt: new Date('2026-08-10T03:00:01.000Z'),
    recognitionManualOverride: null,
    recognitionLastErrorCode: null,
    recognitionAttemptCount: 1,
    draftRevision: 1,
    recognitionNextAttemptAt: null,
  };
}

function legacyCalculationSnapshot(mealItemId: string) {
  return {
    id: '00000000-0000-4000-8000-000000000014',
    mealLogId: mealId,
    sequence: 1,
    inputSnapshot: {
      confirmationDecision: {
        originalRecognition: null,
        manualOverride: null,
        policy: {
          version: 'meal-confirmation-v1',
          activation: 'review_only',
          approvedReportSha256: null,
          activeReportSha256: null,
          approvedReportVersion: null,
        },
      },
      mealItems: [{
        mealItemId,
        origin: 'user_added',
        currentResolutionSource: 'user_selected',
        foodId,
        nutrientProfileId,
        amountMilliunits: 1_500,
        unit: 'g',
        gramsMg: 1_500,
        sourceRegistryId,
        sourceItemId: 'test-source-item',
        datasetVersion: '2026-08',
        nutrientProfileQualityGrade: 'verified',
        nutrients: {
          energyMillicalories: 300,
          carbohydrateMg: 45,
          proteinMg: 15,
          fatMg: 8,
          fiberMg: null,
        },
        initialEstimateAssessment: null,
        itemRevision: 1,
        foodRevision: 1,
        portionRevision: 1,
        foodAcknowledgedRevision: null,
        portionAcknowledgedRevision: null,
        nutrientProfile: null,
        serving: null,
      }],
    },
    energyMillicalories: 300,
    carbohydrateMg: 45,
    proteinMg: 15,
    fatMg: 8,
    fiberMg: null,
    calculationVersion: 'meal-nutrition-v1',
    calculatedAt: new Date('2026-08-13T00:01:00.000Z'),
  };
}

async function createServer(
  authenticated: boolean,
  overrides: {
    assetStatus?: string;
    mealUserId?: string;
    profileTimezone?: string;
    reviewMode?: 'review_only' | 'auto_selection';
    recognitionOutcome?: MealRecognitionCoordinatorResult;
    clientProtocol?: string | null;
    cutoverMode?: 'normal' | 'maintenance_bridge' | 'safe_review_maintenance';
  } = {},
) {
  const state: {
    asset: Record<string, unknown>;
    meal?: Record<string, unknown>;
    items: Record<string, unknown>[];
    foods: Record<string, unknown>[];
    profiles: Record<string, unknown>[];
    servings: Record<string, unknown>[];
    registries: Record<string, unknown>[];
    snapshots: Record<string, unknown>[];
    deletionJob?: Record<string, unknown>;
    profileTimezone: string | null;
    rejectMealUpdate?: boolean;
    rejectItemUpdate?: boolean;
    rejectItemDelete?: boolean;
    recognitionAttempt?: Record<string, unknown>;
    storedObservation?: Record<string, unknown>;
    mappingDecisions: Record<string, unknown>[];
    calculationPreviews: Record<string, unknown>[];
    decompositionRevisions: Record<string, unknown>[];
    decompositionComponents: Record<string, unknown>[];
  } = {
    asset: {
      id: imageId,
      userId: 'user-id',
      status: overrides.assetStatus ?? 'validated',
    },
    items: [],
    foods: [],
    profiles: [],
    servings: [],
    registries: [],
    snapshots: [],
    mappingDecisions: [],
    calculationPreviews: [],
    decompositionRevisions: [],
    decompositionComponents: [],
    profileTimezone: overrides.profileTimezone ?? null,
  };
  if (overrides.mealUserId)
    state.meal = { ...draftMeal(), userId: overrides.mealUserId };
  const auth = {
    api: {
      getSession: async () =>
        authenticated ? { user: { id: 'user-id' }, session: {} } : null,
    },
  } as unknown as Auth;
  const database = databaseMock(state);
  const catalogRegistrySha256 =
    overrides.reviewMode === 'auto_selection'
      ? await calculateCatalogRegistrySha256(database)
      : environment.mealRecognition.reviewPolicy.catalogRegistrySha256;
  const server = await buildServer({
    environment: {
      ...environment,
      mealConfirmationCutover: {
        ...environment.mealConfirmationCutover,
        mode: overrides.cutoverMode ?? environment.mealConfirmationCutover.mode,
      },
      mealRecognition: {
        ...environment.mealRecognition,
        reviewPolicy: {
          ...environment.mealRecognition.reviewPolicy,
          mode: overrides.reviewMode ?? environment.mealRecognition.reviewPolicy.mode,
          catalogRegistrySha256,
        },
      },
    },
    auth,
    database,
    recognitionCoordinator: {
      async recognize() {
        if (overrides.recognitionOutcome) return overrides.recognitionOutcome;
        if (state.meal?.recognitionStatus !== 'ready') {
          Object.assign(state.meal ?? {}, {
            recognitionStatus: 'ready',
            recognitionProvider: 'mock',
            recognitionModel: 'mock-recognition-v2',
            recognitionPromptVersion: 'meal-recognition-prompt-v1',
            recognitionSchemaVersion: 'meal-recognition-schema-v1',
            recognitionCompletedAt: new Date('2026-08-10T03:00:01.000Z'),
            recognitionLastErrorCode: null,
            recognitionAttemptCount: 1,
            recognitionNextAttemptAt: null,
          });
          if (state.items.length === 0) {
            state.items.push(
              {
                id: itemId,
                mealLogId: mealId,
                recognizedLabel: '흰쌀밥',
                amountMilliunits: 1_000,
                unit: 'bowl',
                recognitionRegionIndex: 0,
                recognitionConfidenceBps: 9_500,
                portionConfidenceBps: 9_200,
                userCorrected: false,
                origin: 'model_estimate',
                itemRevision: 1,
                foodRevision: 1,
                portionRevision: 1,
              },
              {
                id: `${itemId.slice(0, -1)}4`,
                mealLogId: mealId,
                recognizedLabel: '김치찌개',
                amountMilliunits: 1_000,
                unit: 'serving',
                recognitionRegionIndex: 1,
                recognitionConfidenceBps: 9_300,
                portionConfidenceBps: 9_000,
                userCorrected: false,
                origin: 'model_estimate',
                itemRevision: 1,
                foodRevision: 1,
                portionRevision: 1,
              },
              {
                id: `${itemId.slice(0, -1)}5`,
                mealLogId: mealId,
                recognizedLabel: '배추김치',
                amountMilliunits: 500,
                unit: 'serving',
                recognitionRegionIndex: 2,
                recognitionConfidenceBps: 9_100,
                portionConfidenceBps: 8_800,
                userCorrected: false,
                origin: 'model_estimate',
                itemRevision: 1,
                foodRevision: 1,
                portionRevision: 1,
              },
            );
          }
          state.asset.status = 'processed';
        }
        return { status: 'ready' };
      },
    },
  });
  const clientProtocol = Object.hasOwn(overrides, 'clientProtocol')
    ? overrides.clientProtocol
    : MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL;
  if (clientProtocol) {
    server.addHook('onRequest', (request, _reply, done) => {
      request.headers['x-nueat-meal-confirmation-protocol'] ??= clientProtocol;
      done();
    });
  }
  servers.push(server);
  return { server, state };
}
function confirmPayload(
  state: { items: Record<string, unknown>[] },
  options: { populateReviewCheckpoint?: boolean } = {},
) {
  const authority = state as {
    profiles?: Record<string, unknown>[];
    servings?: Record<string, unknown>[];
    storedObservation?: Record<string, unknown>;
    mappingDecisions?: Record<string, unknown>[];
    calculationPreviews?: Record<string, unknown>[];
    decompositionRevisions?: Record<string, unknown>[];
    decompositionComponents?: Record<string, unknown>[];
  };
  const item = state.items[0];
  const profile = authority.profiles?.[0];
  const serving = authority.servings?.find(
    (candidate) => candidate.unit === item?.unit,
  );
  const decision = authority.mappingDecisions?.[0];
  const preview = authority.calculationPreviews?.[0];
  if (item && profile && decision && preview) {
    const modelRoot = item.origin === 'model_estimate';
    item.recognitionRegionIndex = modelRoot ? 0 : null;
    if (authority.storedObservation) {
      authority.storedObservation.canonicalContent = {
        version: 3,
        authority: modelRoot ? 'provider_observation' : 'manual_entry',
        observations: modelRoot
          ? [{ regionIndex: 0, localObservationId: 'o0' }]
          : [],
      };
    }
    decision.localObservationId = modelRoot ? 'o0' : `manual:${item.id}`;
    const identity = {
      basis: 'finished_profile',
      rootMappingDecisionId: decision.id,
      rootRevision: item.itemRevision,
      catalogReleaseId,
      releaseActivationId: activationId,
      leaves: [{
        ordinal: 0,
        componentIdentity: decision.id,
        foodId: item.foodId,
        edibleAmountMg:
          item.unit === 'g'
            ? item.amountMilliunits
            : Math.round(
                Number(item.amountMilliunits) *
                Number(serving?.gramsMg ?? 0) /
                Number(serving?.amountMilliunits ?? 1),
              ),
        unit: item.unit,
        nutrientProfileId: profile.id,
        sourceItemId: profile.sourceItemId,
        profileQualityGrade: profile.qualityGrade,
        servingId: serving?.id ?? null,
        servingAmountMilliunits: serving?.amountMilliunits ?? null,
        servingGramsMg: serving?.gramsMg ?? null,
        servingSourceRegistryId: serving?.sourceRegistryId ?? null,
        servingQualityGrade: serving?.qualityGrade ?? null,
        sourceRegistryId: profile.sourceRegistryId,
        sourceReleaseId,
        sourceReleaseVersion: profile.datasetVersion,
        catalogReleaseId,
        catalogManifestSha256: 'a'.repeat(64),
        nutrientProfile: {
          basisAmountMg: profile.basisAmountMg,
          energyMillicalories: profile.energyMillicalories,
          carbohydrateMg: profile.carbohydrateMg,
          proteinMg: profile.proteinMg,
          fatMg: profile.fatMg,
          fiberMg: profile.fiberMg,
        },
      }],
    };
    preview.identity = identity;
    preview.rootRevision = item.itemRevision;
    const gramsMg =
      item.unit === 'g'
        ? Number(item.amountMilliunits)
        : Math.round(
            Number(item.amountMilliunits) *
              Number(serving?.gramsMg ?? 0) /
              Number(serving?.amountMilliunits ?? 1),
          );
    if (options.populateReviewCheckpoint !== false) {
      item.reviewedItemRevision = item.itemRevision;
      item.reviewedAuthorityFingerprintVersion =
        MEAL_ITEM_REVIEW_FINGERPRINT_VERSION;
      item.reviewedAuthorityFingerprint = mealItemReviewFingerprint({
        itemId: String(item.id),
        itemRevision: Number(item.itemRevision),
        foodId: String(item.foodId),
        nutrientProfileId: String(profile.id),
        amountMilliunits: Number(item.amountMilliunits),
        unit: item.unit as 'g' | 'ml' | 'serving' | 'bowl' | 'piece',
        gramsMg,
        catalogReleaseId,
        catalogActivationId: activationId,
        mappingMethod: 'manual',
        mappingDecisionId: String(decision.id),
        mappingContentSha256: String(authority.storedObservation?.contentSha256 ?? null),
        sourceRegistryId: String(profile.sourceRegistryId),
        sourceReleaseId,
        servingId: serving ? String(serving.id) : null,
        calculationPreviewId: String(preview.id),
        calculationPreviewSha256: String(preview.contentSha256 ?? null),
        mealDecompositionRevisionId: null,
        mealDecompositionSha256: null,
        calculationVersion: 'meal-nutrition-v1',
      });
      item.reviewIdempotencyKey = 'fixture-review';
      item.reviewRequestFingerprint = 'b'.repeat(64);
      item.reviewedAt = new Date();
    }
  }
  return {
    expectedDraftRevision: 1,
    idempotencyKey: '00000000-0000-4000-8000-000000000099',
    items: state.items.map((item) => ({
      itemId: item.id,
      expectedItemRevision: item.itemRevision ?? 1,
      ...(decision && preview
        ? {
            mappingDecisionId: decision.id,
            calculationPreviewId: preview.id,
          }
        : {}),
    })),
  };
}
function configureConfirmableDraft(
  state: {
    meal?: Record<string, unknown>;
    items: Record<string, unknown>[];
    foods: Record<string, unknown>[];
    profiles: Record<string, unknown>[];
    registries: Record<string, unknown>[];
    storedObservation?: Record<string, unknown>;
    mappingDecisions?: Record<string, unknown>[];
    calculationPreviews?: Record<string, unknown>[];
  },
  unit: 'g' | 'serving',
) {
  state.meal = draftMeal();
  state.items = [{
    id: itemId,
    mealLogId: mealId,
    recognizedLabel: '테스트 음식',
    foodId,
    nutrientProfileId,
    amountMilliunits: 1_500,
    unit,
    recognitionRegionIndex: null,
    recognitionConfidenceBps: null,
    portionConfidenceBps: null,
    mappingConfidenceBps: 10_000,
    gramsMg: null,
    userCorrected: true,
    origin: 'user_added',
    initialEstimateAssessment: null,
    currentResolutionSource: 'user_selected',
    itemRevision: 1,
    foodRevision: 1,
    portionRevision: 1,
  }];
  state.foods = [{ id: foodId, isDeprecated: false }];
  state.profiles = [{
    id: nutrientProfileId,
    foodId,
    sourceRegistryId,
    sourceItemId: 'test-source-item',
    datasetVersion: '2026-08',
    basisAmountMg: 100_000,
    energyMillicalories: 20_000,
    carbohydrateMg: 3_000,
    proteinMg: 1_000,
    fatMg: 500,
    qualityGrade: 'verified',
    fiberMg: null,
  }];
  state.registries = [{ id: sourceRegistryId, kind: 'public_dataset' }];
  state.storedObservation = {
    id: '00000000-0000-4000-8000-000000000032',
    mealLogId: mealId,
    canonicalContent: {
      version: 3,
      authority: 'manual_entry',
      observations: [],
    },
    contentSha256: '9'.repeat(64),
  };
  state.mappingDecisions = [{
    id: '00000000-0000-4000-8000-000000000040',
    storedObservationId: state.storedObservation.id,
    localObservationId: `manual:${itemId}`,
    catalogReleaseId,
    releaseActivationId: activationId,
    selectedFoodId: foodId,
    status: 'selected',
    method: 'manual',
    candidates: [],
    createdAt: new Date(),
  }];
  state.calculationPreviews = [{
    id: '00000000-0000-4000-8000-000000000050',
    mealLogId: mealId,
    rootMappingDecisionId: state.mappingDecisions[0]!.id,
    rootRevision: 1,
    catalogReleaseId,
    releaseActivationId: activationId,
    discriminant: 'finished_profile',
    identity: {},
    contentSha256: '8'.repeat(64),
    createdAt: new Date(),
  }];
  confirmPayload(state, { populateReviewCheckpoint: false });
}

function applyValuesWithRevisionIncrements(
  target: Record<string, unknown>,
  values: Record<string, unknown>,
  revisionKeys: string[],
) {
  for (const [key, value] of Object.entries(values)) {
    if (revisionKeys.includes(key) && typeof value !== 'number') {
      target[key] = Number(target[key] ?? 1) + 1;
    } else {
      target[key] = value;
    }
  }
}
function databaseMock(state: {
  asset: Record<string, unknown>;
  meal?: Record<string, unknown>;
  items: Record<string, unknown>[];
  foods: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  servings: Record<string, unknown>[];
  registries: Record<string, unknown>[];
  snapshots: Record<string, unknown>[];
  deletionJob?: Record<string, unknown>;
  profileTimezone: string | null;
  rejectMealUpdate?: boolean;
  rejectItemUpdate?: boolean;
  rejectItemDelete?: boolean;
  recognitionAttempt?: Record<string, unknown>;
  storedObservation?: Record<string, unknown>;
  mappingDecisions: Record<string, unknown>[];
  calculationPreviews: Record<string, unknown>[];
  decompositionRevisions: Record<string, unknown>[];
  decompositionComponents: Record<string, unknown>[];
}) {
  const canClaimImage = state.asset.status === 'validated';
  const query = (value: unknown) => ({
    for: () => query(value),
    where: () => query(value),
    orderBy: () => query(value),
    limit: async () =>
      value === undefined ? [] : Array.isArray(value) ? value.slice(0, 1) : [value],
    then<TResult1 = unknown, TResult2 = never>(
      ok?: ((result: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      fail?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(value === undefined ? [] : value).then(ok, fail);
    },
  });
  const database = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ ...database }),
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === userProfiles
            ? state.profileTimezone
              ? { timezone: state.profileTimezone }
              : undefined
            : table === mealLogs && state.meal?.userId === 'user-id'
              ? state.meal
              : table === mealItems
                ? state.items
                : table === activeCatalogReleasePointers
                  ? [{
                      id: activationId,
                      activationId,
                      catalogReleaseId,
                      policyVersion: 'catalog-release-v1',
                      policySha256: 'f'.repeat(64),
                    }]
                : table === releaseActivations
                  ? [{
                      id: activationId,
                      activationId,
                      catalogReleaseId,
                      policyVersion: 'catalog-release-v1',
                      policySha256: 'f'.repeat(64),
                    }]
                : table === catalogReleases
                  ? [{
                      id: catalogReleaseId,
                      status: 'published',
                      manifestSha256: 'a'.repeat(64),
                    }]
                : table === catalogReleaseFoods
                  ? state.foods.map((food) => ({
                      catalogReleaseId,
                      foodId: food.id,
                    }))
                : table === catalogReleaseNutrientProfiles
                  ? state.profiles.map((profile) => ({
                      catalogReleaseId,
                      nutrientProfileId: profile.id,
                    }))
                : table === catalogReleaseFoodServings
                  ? state.servings.map((serving) => ({
                      catalogReleaseId,
                      foodServingId: serving.id,
                    }))
                : table === sourceReleases
                  ? [{
                      id: sourceReleaseId,
                      sourceRegistryId,
                      version: '2026-08',
                      status: 'published',
                      kind:
                        state.registries.find(
                          (registry) => registry.id === sourceRegistryId,
                        )?.kind ?? 'public_dataset',
                      artifactKind: 'nutrition',
                      licenseSha256: 'b'.repeat(64),
                      artifactSha256: 'c'.repeat(64),
                      manifestSha256: 'd'.repeat(64),
                    }]
                : table === catalogReleaseSources
                  ? [{
                      catalogReleaseId,
                      sourceReleaseId,
                      priority: 100,
                      allowedArtifactKinds: ['nutrition'],
                      eligibilityManifestSha256: 'e'.repeat(64),
                    }]
                : table === recognitionAttempts
                  ? state.recognitionAttempt
                : table === storedObservations
                  ? state.storedObservation
                : table === mappingDecisions
                  ? state.mappingDecisions
                : table === calculationPreviews
                  ? state.calculationPreviews
                  : table === mealDecompositionRevisions
                    ? state.decompositionRevisions
                    : table === mealDecompositionComponents
                      ? state.decompositionComponents
                : table === foods
                  ? state.foods
                  : table === nutrientProfiles
                    ? state.profiles.map((profile) => ({
                        ...profile,
                        sourceReleaseId:
                          profile.sourceReleaseId ?? sourceReleaseId,
                      }))
                    : table === foodServings
                      ? state.servings.map((serving) => ({
                          ...serving,
                          sourceReleaseId:
                            serving.sourceReleaseId ?? sourceReleaseId,
                        }))
                      : table === sourceRegistries
                        ? state.registries
                        : table === calculationSnapshots
                          ? state.snapshots
                          : undefined;
        const joinedRows =
          table === nutrientProfiles
            ? state.profiles.map((profile) => ({
                ...profile,
                sourceReleaseId: profile.sourceReleaseId ?? sourceReleaseId,
                sourceKind: state.registries.find(
                  (registry) => registry.id === profile.sourceRegistryId,
                )?.kind,
              }))
            : table === foodServings
              ? state.servings.map((serving) => ({
                  ...serving,
                  sourceReleaseId: serving.sourceReleaseId ?? sourceReleaseId,
                  sourceKind: state.registries.find(
                    (registry) => registry.id === serving.sourceRegistryId,
                  )?.kind,
                }))
              : table === sourceReleases
                ? rows
                : rows;
        return Object.assign(query(rows), {
          innerJoin: () => query(joinedRows),
        });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const apply = () => {
            if (
              table === imageAssets &&
              (values.status !== 'processing' || canClaimImage)
            )
              Object.assign(state.asset, values);
            if (table === mealLogs && state.meal) {
              applyValuesWithRevisionIncrements(state.meal, values, ['draftRevision']);
            }
            if (table === mealItems && state.items[0]) {
              applyValuesWithRevisionIncrements(state.items[0], values, [
                'itemRevision',
                'foodRevision',
                'portionRevision',
              ]);
            }
          };
          return {
            returning: async () => {
              if (table === mealLogs && state.rejectMealUpdate) return [];
              if (table === mealItems && state.rejectItemUpdate) return [];
              apply();
              return table === imageAssets
                ? state.asset.status === 'processing'
                  ? [{ id: imageId }]
                  : []
                : table === mealLogs && state.meal
                  ? [state.meal]
                  : table === mealItems && state.items[0]
                    ? [state.items[0]]
                    : [];
            },
            then<TResult1 = unknown, TResult2 = never>(
              ok?:
                | ((result: unknown) => TResult1 | PromiseLike<TResult1>)
                | null,
              fail?:
                | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                | null,
            ) {
              apply();
              return Promise.resolve(undefined).then(ok, fail);
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(values) ? values : [values];
        const firstRow = rows[0];
        if (!firstRow) throw new Error('Expected at least one inserted row');
        const apply = () => {
          if (table === mealLogs) {
            state.meal = {
              ...firstRow,
              id: mealId,
              timezone: firstRow.eatenTimezone,
              localDate: firstRow.eatenLocalDate,
            };
            return [state.meal];
          }
          if (table === mealItems) {
            const inserted = rows.map((row, index) => ({
              ...row,
              id: index === 0 ? itemId : `${itemId.slice(0, -1)}${index + 1}`,
              userCorrected: row.userCorrected ?? false,
              itemRevision: row.itemRevision ?? 1,
              foodRevision: row.foodRevision ?? 1,
              portionRevision: row.portionRevision ?? 1,
            }));
            state.items.push(...inserted);
            return inserted;
          }
          if (table === recognitionAttempts) {
            const attempt = {
              ...firstRow,
              id: '00000000-0000-4000-8000-000000000031',
            };
            state.recognitionAttempt = attempt;
            return [attempt];
          }
          if (table === storedObservations) {
            const observation = {
              ...firstRow,
              id: '00000000-0000-4000-8000-000000000032',
            };
            state.storedObservation = observation;
            return [observation];
          }
          if (table === mappingDecisions) {
            const inserted = rows.map((row, index) => ({
              ...row,
              id: `00000000-0000-4000-8000-${String(40 + state.mappingDecisions.length + index).padStart(12, '0')}`,
              createdAt: new Date(),
            }));
            state.mappingDecisions.push(...inserted);
            return inserted;
          }
          if (table === calculationPreviews) {
            const inserted = rows.map((row, index) => ({
              ...row,
              id: `00000000-0000-4000-8000-${String(50 + state.calculationPreviews.length + index).padStart(12, '0')}`,
              createdAt: new Date(),
            }));
            state.calculationPreviews.push(...inserted);
            return inserted;
          }
          if (table === calculationSnapshots) {
            const snapshot = {
              ...firstRow,
              id: '00000000-0000-4000-8000-000000000014',
            };
            state.snapshots.push(snapshot);
            return [snapshot];
          }
          return [];
        };
        return {
          returning: async () => apply(),
          onConflictDoNothing: async () => {
            state.deletionJob = firstRow;
          },
          then<TResult1 = unknown, TResult2 = never>(
            ok?: ((result: unknown) => TResult1 | PromiseLike<TResult1>) | null,
            fail?:
              | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
              | null,
          ) {
            return Promise.resolve(apply()).then(ok, fail);
          },
        };
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (state.rejectItemDelete) return [];
          const item = state.items.shift();
          return item ? [{ id: item.id }] : [];
        },
      }),
    }),
  };
  return database as unknown as Database;
}
