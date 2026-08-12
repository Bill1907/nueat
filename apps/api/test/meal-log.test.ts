import { afterEach, describe, expect, test } from 'bun:test';
import {
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
import type { FastifyInstance } from 'fastify';

import type { Auth } from '../src/auth/auth';
import { parseEnvironment } from '../src/config/env';
import { buildServer } from '../src/server';
import { calculateCatalogRegistrySha256 } from '../src/services/catalog-registry-verifier';

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
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('meal log routes', () => {
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
    expect(body.review.requiredReviewFields).toContainEqual({
      itemId,
      fields: ['food', 'portion'],
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


  test('returns the existing draft when the validated image is retried', async () => {
    const { server, state } = await createServer(true);
    state.meal = draftMeal();
    state.asset.status = 'processed';
    state.items = [
      {
        id: itemId,
        mealLogId: mealId,
        recognizedLabel: '흰쌀밥',
        amountMilliunits: 1000,
        unit: 'bowl',
        recognitionConfidenceBps: 9500,
        portionConfidenceBps: 9200,
        userCorrected: false,
      },
    ];

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
      portionAcknowledgedRevision: 2,
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
      foodAcknowledgedRevision: null,
      portionRevision: 2,
      portionAcknowledgedRevision: 2,
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
  test('acknowledges only the current low-confidence revisions through review', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');
    state.items = [{
      id: itemId,
      mealLogId: mealId,
      recognizedLabel: '흰쌀밥',
      amountMilliunits: 1_000,
      unit: 'g',
      foodId,
      nutrientProfileId,
      origin: 'model_estimate',
      itemRevision: 3,
      foodRevision: 2,
      portionRevision: 2,
      foodAcknowledgedRevision: null,
      portionAcknowledgedRevision: null,
      currentResolutionSource: 'model_primary',
      initialEstimateAssessment: {
        rawLabel: '흰쌀밥',
        normalizedLabel: '흰쌀밥',
        foodConfidenceBps: 7_000,
        portionConfidenceBps: 7_000,
        foodCandidateMarginBps: null,
        questions: [],
        alternatives: [],
        initialMappingSource: 'model_primary',
        initialMatchedLabel: '흰쌀밥',
        policyVersion: 'meal-estimate-review-v1',
      },
    }];

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/review`,
      payload: {
        expectedDraftRevision: 1,
        items: [{
          itemId,
          expectedItemRevision: 3,
          foodAcknowledgedRevision: 2,
          portionAcknowledgedRevision: 2,
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).items[0]).toMatchObject({
      foodAcknowledgedRevision: 2,
      portionAcknowledgedRevision: 2,
    });
    const acknowledgedDraftRevision = state.meal!.draftRevision;
    const acknowledgedItemRevision = state.items[0]!.itemRevision;
    const noOp = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/review`,
      payload: {
        expectedDraftRevision: acknowledgedDraftRevision,
        items: [{
          itemId,
          expectedItemRevision: acknowledgedItemRevision,
          foodAcknowledgedRevision: 2,
          portionAcknowledgedRevision: 2,
        }],
      },
    });
    expect(noOp.statusCode).toBe(200);
    expect(state.meal!.draftRevision).toBe(acknowledgedDraftRevision);
    expect(state.items[0]!.itemRevision).toBe(acknowledgedItemRevision);

    const staleField = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/review`,
      payload: {
        expectedDraftRevision: acknowledgedDraftRevision,
        items: [{
          itemId,
          expectedItemRevision: acknowledgedItemRevision,
          foodAcknowledgedRevision: 1,
        }],
      },
    });
    expect(staleField.statusCode).toBe(409);
    expect(JSON.parse(staleField.body).error.code).toBe('MEAL_ITEM_STALE');
    expect(state.meal!.draftRevision).toBe(acknowledgedDraftRevision);
    expect(state.items[0]!.itemRevision).toBe(acknowledgedItemRevision);
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
  test('keeps PATCH and same-food PUT semantic no-ops revision-neutral', async () => {
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
    expect(mapping.statusCode).toBe(200);
    expect(state.meal!.draftRevision).toBe(draftRevision);
    expect(state.items[0]!.itemRevision).toBe(itemRevision);
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
  test('exposes a resolved mapped draft as a one-CTA confirmable review', async () => {
    const { server, state } = await createServer(true);
    configureConfirmableDraft(state, 'g');

    const response = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).review).toMatchObject({
      confirmable: true,
      reasons: [],
      requiredReviewFields: [],
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
  test('confirms a high-confidence mapped model estimate without review mutation', async () => {
    const { server, state } = await createServer(true, { reviewMode: 'quick_confirm' });
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
      currentResolutionSource: 'model_primary',
      foodAcknowledgedRevision: null,
      portionAcknowledgedRevision: null,
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
    const before = {
      draftRevision: state.meal!.draftRevision,
      itemRevision: state.items[0]!.itemRevision,
    };

    const draft = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    expect(JSON.parse(draft.body).review.requiredReviewFields).toEqual([]);

    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });

    expect(response.statusCode).toBe(200);
    expect(state.items[0]!.itemRevision).toBe(before.itemRevision);
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
  test('requires a current review vector before review-only model confirmation', async () => {
    const { server, state } = await createServer(true, { reviewMode: 'review_only' });
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
      currentResolutionSource: 'model_primary',
      foodAcknowledgedRevision: null,
      portionAcknowledgedRevision: null,
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

    const draft = await server.inject({
      method: 'GET',
      url: `/api/meal-logs/${mealId}`,
    });
    expect(JSON.parse(draft.body).review).toMatchObject({
      confirmable: false,
      reasons: [{ code: 'QUICK_CONFIRM_POLICY_DISABLED', itemId: null }],
      requiredReviewFields: [{ itemId, fields: ['food', 'portion'] }],
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

    const directConfirm = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: confirmPayload(state),
    });
    expect(directConfirm.statusCode).toBe(409);
    expect(JSON.parse(directConfirm.body).error.code).toBe('MEAL_CONFIRMATION_INVALID');

    const review = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/review`,
      payload: {
        expectedDraftRevision: 1,
        items: [{
          itemId,
          expectedItemRevision: 1,
          foodAcknowledgedRevision: 1,
          portionAcknowledgedRevision: 1,
        }],
      },
    });
    expect(review.statusCode).toBe(200);
    expect(JSON.parse(review.body).review).toMatchObject({
      confirmable: true,
      reasons: [],
      requiredReviewFields: [],
    });

    const reviewedDraft = JSON.parse(review.body);
    const confirmed = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: {
        expectedDraftRevision: reviewedDraft.mealLog.draftRevision,
        items: reviewedDraft.items.map((item: { id: string; itemRevision: number }) => ({
          itemId: item.id,
          expectedItemRevision: item.itemRevision,
        })),
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(state.snapshots).toHaveLength(1);
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
        payload: confirmPayload(state),
      });
      expect(confirm.statusCode).toBe(409);
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
  test('rejects retry and manual conversion after recognition is ready', async () => {
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

    expect(retry.statusCode).toBe(409);
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
    const response = await server.inject({
      method: 'POST',
      url: `/api/meal-logs/${mealId}/confirm`,
      payload: { expectedDraftRevision: 1, items: [{ itemId, expectedItemRevision: 1 }] },
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
      items: [{ gramsMg: 1_500 }],
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
    expect(state.snapshots[0]!.inputSnapshot).toEqual({
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
        origin: 'user_added',
        initialEstimateAssessment: null,
        currentResolutionSource: 'user_selected',
        itemRevision: 1,
        foodRevision: 1,
        portionRevision: 1,
        foodAcknowledgedRevision: 1,
        portionAcknowledgedRevision: 1,
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
    expect(body.items[0].gramsMg).toBe(300_000);
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
      expect(JSON.parse(response.body).error.details.items[0].code).toBe(
        invalid === 'mapping'
          ? 'MISSING_MAPPING'
          : invalid === 'profile'
            ? 'MISSING_PROFILE'
            : 'MISSING_SERVING_CONVERSION',
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
    expect(JSON.parse(response.body).error.details.items[0].code).toBe('MISMATCHED_PROFILE');
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
      expect(JSON.parse(response.body).error.details.items[0].code).toBe(
        invalid === 'food'
          ? 'DEPRECATED_FOOD'
          : invalid === 'profile'
            ? 'UNTRUSTED_PROFILE_SOURCE'
            : 'UNTRUSTED_SERVING_SOURCE',
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

async function createServer(
  authenticated: boolean,
  overrides: {
    assetStatus?: string;
    mealUserId?: string;
    profileTimezone?: string;
    reviewMode?: 'review_only' | 'quick_confirm';
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
    overrides.reviewMode === 'quick_confirm'
      ? await calculateCatalogRegistrySha256(database)
      : environment.mealRecognition.reviewPolicy.catalogRegistrySha256;
  const server = await buildServer({
    environment: {
      ...environment,
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
                foodAcknowledgedRevision: null,
                portionAcknowledgedRevision: null,
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
                foodAcknowledgedRevision: null,
                portionAcknowledgedRevision: null,
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
                foodAcknowledgedRevision: null,
                portionAcknowledgedRevision: null,
              },
            );
          }
          state.asset.status = 'processed';
        }
        return { status: 'ready' };
      },
    },
  });
  servers.push(server);
  return { server, state };
}
function confirmPayload(state: { items: Record<string, unknown>[] }) {
  return {
    expectedDraftRevision: 1,
    items: state.items.map((item) => ({
      itemId: item.id,
      expectedItemRevision: item.itemRevision ?? 1,
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
    recognitionRegionIndex: 0,
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
    foodAcknowledgedRevision: 1,
    portionAcknowledgedRevision: 1,
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
}

function applyValuesWithRevisionIncrements(
  target: Record<string, unknown>,
  values: Record<string, unknown>,
  revisionKeys: string[],
) {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'foodAcknowledgedRevision' && value !== null && typeof value !== 'number') {
      target[key] = target.foodRevision;
    } else if (
      key === 'portionAcknowledgedRevision' &&
      value !== null &&
      typeof value !== 'number'
    ) {
      target[key] = target.portionRevision;
    } else if (revisionKeys.includes(key) && typeof value !== 'number') {
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
}) {
  const canClaimImage = state.asset.status === 'validated';
  const query = (value: unknown) => ({
    for: () => query(value),
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
                : table === foods
                  ? state.foods
                  : table === nutrientProfiles
                    ? state.profiles
                    : table === foodServings
                      ? state.servings
                      : table === sourceRegistries
                        ? state.registries
                        : table === calculationSnapshots
                          ? state.snapshots
                          : undefined;
        const joinedRows =
          table === nutrientProfiles
            ? state.profiles.map((profile) => ({
                ...profile,
                sourceKind: state.registries.find(
                  (registry) => registry.id === profile.sourceRegistryId,
                )?.kind,
              }))
            : table === foodServings
              ? state.servings.map((serving) => ({
                  ...serving,
                  sourceKind: state.registries.find(
                    (registry) => registry.id === serving.sourceRegistryId,
                  )?.kind,
                }))
              : rows;
        return {
          where: () => query(rows),
          orderBy: () => query(rows),
          innerJoin: () => ({ where: () => query(joinedRows) }),
        };
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
              foodAcknowledgedRevision: row.foodAcknowledgedRevision ?? null,
              portionAcknowledgedRevision: row.portionAcknowledgedRevision ?? null,
            }));
            state.items.push(...inserted);
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
