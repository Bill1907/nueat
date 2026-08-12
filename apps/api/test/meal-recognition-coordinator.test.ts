import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { foodAliases, imageAssets, nutrientProfiles, recognitionDailyUsages } from '@nueat/database';

import { MealRecognitionCoordinator } from '../src/services/meal-recognition-coordinator';
import {
  ImageObjectReadAbortedError,
  type ImageObjectStore,
} from '../src/services/image-object-store';
import {
  MEAL_RECOGNITION_PROMPT_VERSION,
  MEAL_RECOGNITION_SCHEMA_VERSION,
  MealRecognitionFailure,
  type MealRecognizer,
  type RecognitionResultV2,
} from '../src/services/meal-recognizer';

const bytes = new Uint8Array([1, 2, 3]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const result: RecognitionResultV2 = {
  outcome: 'recognized',
  imageQualityConfidenceBps: 9_000,
  foods: [
    {
      regionIndex: 0,
      rawLabel: 'rice',
      foodConfidenceBps: 9000,
      portionConfidenceBps: 8000,
      amountMilliunits: 200,
      unit: 'g' as const,
      questions: [],
      alternatives: [],
    },
  ],
};

type State = {
  status: 'pending' | 'processing' | 'failed' | 'ready' | 'manual';
  leaseToken: string | null;
  claimedLeaseToken: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date | null;
  attempts: number;
  error: string | null;
  dailyUsage: number;
  deleted: boolean;
  items: Record<string, unknown>[];
  assetStatus: 'processing' | 'processed';
  transactions: number;
  transactionOpen: boolean;
  aliasQueries: { foodId: string; isDeprecated: boolean; isComposite?: boolean }[][];
  profiles: { id: string; qualityGrade: string; datasetVersion: string }[];
  mappingLookupFails: boolean;
};

function state(overrides: Partial<State> = {}): State {
  return {
    status: 'pending',
    leaseToken: null,
    claimedLeaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    attempts: 0,
    error: null,
    dailyUsage: 0,
    deleted: false,
    items: [],
    assetStatus: 'processing',
    transactions: 0,
    transactionOpen: false,
    aliasQueries: [],
    profiles: [],
    mappingLookupFails: false,
    ...overrides,
  };
}

function fakeDatabase(s: State) {
  const select = (fields: Record<string, unknown>) => ({
    from(table: unknown) {
      const applyWhere = () => {
        const rows = async () => {
          if (table === foodAliases) {
            if (s.mappingLookupFails) throw new Error('mapping lookup failed');
            return s.aliasQueries.shift() ?? [];
          }
          if (table === nutrientProfiles) {
            if (s.mappingLookupFails) throw new Error('mapping lookup failed');
            return s.profiles;
          }
          if (table === imageAssets) {
            return s.assetStatus === 'processing'
              ? [{ id: 'asset', objectKey: 'private/key', byteSize: bytes.byteLength, contentType: 'image/png', sha256 }]
              : [];
          }
          if (table === recognitionDailyUsages) return [];
          if (s.deleted) return [];
          return [{
            id: 'meal', recognitionStatus: s.status,
            recognitionLeaseExpiresAt: s.leaseExpiresAt,
            recognitionNextAttemptAt: s.nextAttemptAt,
            recognitionAttemptCount: s.attempts,
            imageAssetId: 'asset', eatenLocalDate: '2026-08-11',
          }];
        };
        return {
          limit: rows,
          orderBy: () => applyWhere(),
          then(
            resolve: (value: Awaited<ReturnType<typeof rows>>) => void,
            reject: (reason: unknown) => void,
          ) {
            return rows().then(resolve, reject);
          },
        };
      };
      return {
        where: applyWhere,
        innerJoin() {
          return { where: applyWhere };
        },
      };
    },
  });

  const update = (table: unknown) => ({
    set(values: Record<string, unknown>) {
      const apply = () => {
        if (table === imageAssets) {
          s.assetStatus = values.status as State['assetStatus'];
          return true;
        }
        if (s.deleted) return false;
        if (values.recognitionStatus === 'processing') {
          const eligible =
            s.status === 'pending' ||
            (s.status === 'failed' && !!s.nextAttemptAt && s.nextAttemptAt <= new Date()) ||
            (s.status === 'processing' && !!s.leaseExpiresAt && s.leaseExpiresAt <= new Date());
          if (!eligible) return false;
          s.status = 'processing';
          s.leaseToken = values.recognitionLeaseToken as string;
          s.claimedLeaseToken = s.leaseToken;
          s.leaseExpiresAt = values.recognitionLeaseExpiresAt as Date;
          s.attempts = values.recognitionAttemptCount as number;
          s.error = null;
          return true;
        }
        if (values.recognitionLeaseExpiresAt && !values.recognitionStatus) {
          if (s.status !== 'processing' || s.leaseToken !== s.claimedLeaseToken) return false;
          s.leaseExpiresAt = values.recognitionLeaseExpiresAt as Date;
          return true;
        }
        if (values.recognitionStatus === 'ready') return true;
        if (values.recognitionStatus === 'failed') {
          if (s.status !== 'processing' && s.status !== 'pending') return false;
          s.status = 'failed';
          s.leaseToken = null;
          s.leaseExpiresAt = null;
          s.nextAttemptAt = values.recognitionNextAttemptAt as Date;
          s.error = values.recognitionLastErrorCode as string;
          return true;
        }
        return true;
      };
      return {
        where() {
          const returning = async () => {
            if (values.recognitionStatus === 'ready') {
              if (
                s.deleted ||
                s.status !== 'processing' ||
                s.leaseToken !== s.claimedLeaseToken
              )
                return [];
              s.status = 'ready';
              s.leaseToken = null;
              s.leaseExpiresAt = null;
              s.nextAttemptAt = null;
              s.error = null;
              return [{ id: 'meal' }];
            }
            return apply() ? [{ id: 'meal' }] : [];
          };
          return {
            returning,
            then<TResult1 = unknown, TResult2 = never>(
              resolve?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
              reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              return Promise.resolve(apply()).then(resolve, reject);
            },
          };
        },
      };
    },
  });

  const db = {
    select,
    update,
    insert(table: unknown) {
      return {
        values(rows: Record<string, unknown> | Record<string, unknown>[]) {
          if (table === recognitionDailyUsages) {
            return {
              onConflictDoUpdate() {
                return {
                  returning: async () => {
                    if (s.dailyUsage >= 10) return [];
                    s.dailyUsage++;
                    return [{ attemptCount: s.dailyUsage }];
                  },
                };
              },
            };
          }
          return { then: async (resolve: (value: unknown) => unknown) => resolve(s.items.push(...(Array.isArray(rows) ? rows : [rows]))) };
        },
      };
    },
    async transaction<T>(callback: (tx: any) => Promise<T>) {
      s.transactions++;
      s.transactionOpen = true;
      try {
        return await callback(db);
      } finally {
        s.transactionOpen = false;
      }
    },
  };
  return db;
}

function makeCoordinator(s: State, options: {
  object?: Partial<{ bytes: Uint8Array; contentType: string; byteSize: number; error: Error }>;
  onRead?: () => void;
  recognize?: (input: Parameters<MealRecognizer['recognize']>[0]) => ReturnType<MealRecognizer['recognize']>;
  result?: RecognitionResultV2;
} = {}) {
  const objectStore: ImageObjectStore = {
    createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => {},
    readObject: async () => {
      options.onRead?.();
      if (options.object?.error) throw options.object.error;
      return {
        bytes: options.object?.bytes ?? bytes,
        contentType: options.object?.contentType ?? 'image/png',
        byteSize: options.object?.byteSize ?? bytes.byteLength,
      };
    },
  };
  const recognizer: MealRecognizer = {
    recognize: options.recognize ?? (async () => ({
      provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
      schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result: options.result ?? result,
    })),
  };
  return new MealRecognitionCoordinator({
    database: fakeDatabase(s) as never, objectStore, recognizer,
    maxBytes: 1024, timeoutMs: 100, leaseMs: 60_000, maxAttempts: 3, dailyQuota: 10,
  });
}

describe('MealRecognitionCoordinator', () => {
  test('claims, privately reads and verifies bytes, then finalizes recognition-only items', async () => {
    const s = state();
    let providerAfterClaim = false;
    const coordinator = makeCoordinator(s, { recognize: async () => {
      providerAfterClaim = !s.transactionOpen;
      return { provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION, schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result };
    } });

    await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(providerAfterClaim).toBe(true);
    expect(s.status).toBe('ready');
    expect(s.assetStatus).toBe('processed');
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      foodId: null,
      nutrientProfileId: null,
      gramsMg: null,
      mappingConfidenceBps: null,
    });
    const assessmentJson = JSON.stringify(s.items[0]!.initialEstimateAssessment);
    expect(assessmentJson).toContain('initialFoodId');
    expect(assessmentJson).toContain('initialNutrientProfileId');
    expect(assessmentJson).toContain('recognitionProvider');
    expect(assessmentJson).toContain('recognitionModel');
  });
  test('fails closed when a normalized alias maps to multiple canonical foods', async () => {
    const s = state({
      aliasQueries: [[
        {
          foodId: 'food-a',
          canonicalNameKo: '쌀밥',
          normalizedAliasKo: 'rice',
          isDeprecated: false,
        },
        {
          foodId: 'food-b',
          canonicalNameKo: '현미밥',
          normalizedAliasKo: 'rice',
          isDeprecated: false,
        },
      ]] as never,
      profiles: [
        { id: 'profile-a', foodId: 'food-a', qualityGrade: 'verified', datasetVersion: '2026-01' },
        { id: 'profile-b', foodId: 'food-b', qualityGrade: 'verified', datasetVersion: '2026-01' },
      ] as never,
    });

    await expect(makeCoordinator(s).recognize('meal', 'user')).resolves.toEqual({
      status: 'ready',
    });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      foodId: null,
      nutrientProfileId: null,
      mappingConfidenceBps: null,
    });
  });
  test('keeps canonical mapping infrastructure failures retryable instead of finalizing unmapped', async () => {
    const s = state({ mappingLookupFails: true });

    await expect(makeCoordinator(s).recognize('meal', 'user')).resolves.toMatchObject({
      status: 'unavailable',
      code: 'CATALOG_UNAVAILABLE',
      retryable: true,
    });
    expect(s.status).toBe('failed');
    expect(s.items).toHaveLength(0);
  });

  test('returns active with a retry interval for a live lease', async () => {
    const s = state({ status: 'processing', leaseToken: 'other', leaseExpiresAt: new Date(Date.now() + 4_000) });
    await expect(makeCoordinator(s).recognize('meal', 'user')).resolves.toMatchObject({ status: 'active' });
  });

  test('allows only one concurrent claim and provider invocation', async () => {
    const s = state();
    let calls = 0;
    const coordinator = makeCoordinator(s, { recognize: async () => { calls++; return { provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION, schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result }; } });
    const outcomes = await Promise.all([coordinator.recognize('meal', 'user'), coordinator.recognize('meal', 'user')]);
    expect(calls).toBe(1);
    expect(outcomes).toContainEqual({ status: 'ready' });
    expect(outcomes.some((outcome) => outcome.status === 'active')).toBe(true);
  });

  test('recovers an expired lease', async () => {
    const s = state({ status: 'processing', leaseToken: 'old', leaseExpiresAt: new Date(Date.now() - 1) });
    await expect(makeCoordinator(s).recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(s.attempts).toBe(1);
  });

  test('does not claim at maximum attempts or daily quota', async () => {
    const maximum = state({ attempts: 3 });
    await expect(makeCoordinator(maximum).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'MAX_ATTEMPTS_EXCEEDED', retryable: false });
    expect(maximum.nextAttemptAt).toBeNull();
    await expect(makeCoordinator(state({ dailyUsage: 10 })).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'DAILY_QUOTA_EXCEEDED', retryable: true });
  });

  test('sanitizes timeout and provider 429-style failures', async () => {
    const timeout = state();
    await expect(makeCoordinator(timeout, { object: { error: new ImageObjectReadAbortedError() } }).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'DEADLINE_EXCEEDED', retryable: true });
    expect(timeout.error).toBe('DEADLINE_EXCEEDED');
    const unavailable = state();
    await expect(makeCoordinator(unavailable, { recognize: async () => { throw new MealRecognitionFailure('PROVIDER_UNAVAILABLE'); } }).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(unavailable.error).toBe('PROVIDER_UNAVAILABLE');
  });

  test('rejects invalid provider results and mismatched assets without calling the provider', async () => {
    const invalid = state();
    await makeCoordinator(invalid, { recognize: async () => ({ provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION, schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result: { foods: [] } as never }) }).recognize('meal', 'user');
    expect(invalid.error).toBe('INVALID_PROVIDER_RESPONSE');
    const mismatch = state();
    let calls = 0;
    await makeCoordinator(mismatch, { object: { bytes: new Uint8Array([9]) }, recognize: async () => { calls++; throw new Error('must not run'); } }).recognize('meal', 'user');
    expect(calls).toBe(0);
    expect(mismatch.error).toBe('ASSET_MISMATCH');
  });

  test('does not dispatch to the provider after lease loss during the private image read', async () => {
    const s = state();
    let calls = 0;
    const coordinator = makeCoordinator(s, {
      onRead: () => { s.status = 'manual'; },
      recognize: async () => {
        calls++;
        return { provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION, schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result };
      },
    });
    await expect(coordinator.recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable' });
    expect(calls).toBe(0);
  });

  test('does not insert items when a stale lease, manual update, or delete wins before finalize', async () => {
    for (const mutation of ['stale', 'manual', 'delete'] as const) {
      const s = state();
      const coordinator = makeCoordinator(s, { recognize: async () => {
        if (mutation === 'stale') s.leaseToken = 'replacement';
        if (mutation === 'manual') s.status = 'manual';
        if (mutation === 'delete') s.deleted = true;
        return { provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION, schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result };
      } });
      const outcome = await coordinator.recognize('meal', 'user');
      expect(outcome.status).toBe(mutation === 'stale' ? 'active' : 'unavailable');
      expect(s.items).toHaveLength(0);
    }
  });
  test('persists no_food as a ready, zero-item immutable recognition result', async () => {
    const s = state();
    const noFood: RecognitionResultV2 = { outcome: 'no_food', imageQualityConfidenceBps: 9_100, foods: [] };
    await expect(makeCoordinator(s, { result: noFood }).recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(s.status).toBe('ready');
    expect(s.items).toEqual([]);
  });

  test('persists insufficient_evidence with reason and no invented meal item', async () => {
    const s = state();
    const insufficient: RecognitionResultV2 = { outcome: 'insufficient_evidence', imageQualityConfidenceBps: 1_500, evidenceReason: 'blurred', foods: [] };
    await expect(makeCoordinator(s, { result: insufficient }).recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(s.status).toBe('ready');
    expect(s.items).toEqual([]);
  });

  test('persists recognized model origin and immutable V2 assessment', async () => {
    const s = state();
    await expect(makeCoordinator(s).recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(s.items[0]).toMatchObject({ origin: 'model_estimate', itemRevision: 1, foodRevision: 1, portionRevision: 1 });
  });
});
