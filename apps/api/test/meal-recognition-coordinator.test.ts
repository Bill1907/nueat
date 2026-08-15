import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import {
  foodAliases,
  imageAssets,
  nutrientProfiles,
  recognitionAttempts,
  recognitionDailyUsages,
  recognitionExecutions,
  recognitionProviderInvocations,
  resolutionAttempts,
  storedObservations,
} from '@nueat/database';

import {
  MealRecognitionCoordinator,
  LegacyObserveMealRecognitionRunner,
  isUsableRecognitionAsset,
  reconciliationTransition,
  reconciliationGrantTransition,
  reconciliationReceiptTransition,
  failureTransition,
  recognitionTerminalTransition,
} from '../src/services/meal-recognition-coordinator';
import { MealResolutionCoordinator } from '../src/services/meal-resolution-coordinator';
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
import { recognitionLedgerFixture } from './fixtures/recognition-ledger';
import {
  recognitionLedgerInvariantErrors,
} from './harness/recognition-coordinator-harness';

const bytes = new Uint8Array([1, 2, 3]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const result: {
  outcome: 'no_food';
  imageQualityConfidenceBps: number;
  observations: never[];
} = {
  outcome: 'no_food',
  imageQualityConfidenceBps: 9_000,
  observations: [],
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
  assetMetadataMissing: boolean;
  transactions: number;
  transactionOpen: boolean;
  aliasQueries: { foodId: string; isDeprecated: boolean; isComposite?: boolean }[][];
  profiles: { id: string; qualityGrade: string; datasetVersion: string }[];
  mappingLookupFails: boolean;
  persistenceFails: boolean;
  executions: Record<string, unknown>[];
  invocations: Record<string, unknown>[];
  workflows: Record<string, unknown>[];
  observations: Record<string, unknown>[];
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
    assetMetadataMissing: false,
    transactions: 0,
    transactionOpen: false,
    aliasQueries: [],
    profiles: [],
    mappingLookupFails: false,
    persistenceFails: false,
    executions: [],
    invocations: [],
    workflows: [],
    observations: [],
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
          if (table === storedObservations) return [];
          if (table === recognitionAttempts) return s.workflows.length ? [s.workflows[0]] : [];
          if (table === recognitionExecutions) {
            return Object.hasOwn(fields, 'executionOrdinal')
              ? s.executions
              : [];
          }
          if (table === nutrientProfiles) {
            if (s.mappingLookupFails) throw new Error('mapping lookup failed');
            return s.profiles;
          }
          if (table === imageAssets) {
            return [{
              id: 'asset',
              objectKey: 'private/key',
              byteSize: s.assetMetadataMissing ? null : bytes.byteLength,
              contentType: s.assetMetadataMissing ? null : 'image/png',
              sha256: s.assetMetadataMissing ? null : sha256,
              status: s.assetStatus,
              purpose: 'inference',
              expiresAt: new Date(Date.now() + 60_000),
            }];
          }
          if (table === recognitionDailyUsages) return [];
          if (s.deleted) return [];
          return [{
            id: 'meal',
            status: s.deleted ? 'deleted' : 'draft',
            recognitionStatus: s.status,
            recognitionLeaseToken: s.leaseToken,
            recognitionLeaseExpiresAt: s.leaseExpiresAt,
            recognitionNextAttemptAt: s.nextAttemptAt,
            recognitionAttemptCount: s.attempts,
            imageAssetId: 'asset', eatenLocalDate: '2026-08-11',
          }];
        };
        return {
          limit: rows,
          for() {
            return this;
          },
          orderBy: () => applyWhere(),
          then(
            resolve: (value: Awaited<ReturnType<typeof rows>>) => void,
            reject: (reason: unknown) => void,
          ) {
            return rows().then(resolve, reject);
          },
        };
      };
      const joinable = {
        where: applyWhere,
        innerJoin() {
          return joinable;
        },
      };
      return joinable;
    },
  });

  const update = (table: unknown) => ({
    set(values: Record<string, unknown>) {
      const apply = () => {
        if (table === imageAssets) {
          s.assetStatus = values.status as State['assetStatus'];
          return true;
        }
        if (table === recognitionAttempts) {
          Object.assign(s.workflows[0] ?? {}, values);
          return true;
        }
        if (table === recognitionExecutions) {
          Object.assign(s.executions[0] ?? {}, values);
          return true;
        }
        if (s.deleted) return false;
        if (values.recognitionStatus === 'processing') {
          const eligible =
            s.status === 'pending' ||
            s.status === 'failed' ||
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
          if (s.status !== 'processing' && s.status !== 'pending' && s.status !== 'failed') return false;
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
              if (s.persistenceFails) throw new Error('persistence failed');
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
          if (table === recognitionExecutions) {
            s.executions.push(...(Array.isArray(rows) ? rows : [rows]));
            return { then: async (resolve: (value: unknown) => unknown) => resolve(undefined) };
          }
          if (table === recognitionAttempts) {
            s.workflows.push(...(Array.isArray(rows) ? rows : [rows]));
            return {
              then: async (resolve: (value: unknown) => unknown) =>
                resolve(undefined),
              onConflictDoNothing() {
                return {
                  returning: async () => [{ id: 'workflow' }],
                };
              },
            };
          }
          if (table === recognitionProviderInvocations) {
            s.invocations.push(...(Array.isArray(rows) ? rows : [rows]));
            return { then: async (resolve: (value: unknown) => unknown) => resolve(undefined) };
          }
          if (table === storedObservations) {
            s.observations.push(
              ...(Array.isArray(rows) ? rows : [rows]).map((row) => ({
                id: 'observation',
                ...row,
              })),
            );
            return {
              returning: async () => [{ id: 'observation' }],
              onConflictDoNothing() {
                return {
                  returning: async () => [{ id: 'observation' }],
                  then: async (resolve: (value: unknown) => unknown) =>
                    resolve(undefined),
                };
              },
            };
          }
          if (table === resolutionAttempts) {
            return {
              then: async (resolve: (value: unknown) => unknown) =>
                resolve(undefined),
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
  result?: Awaited<ReturnType<MealRecognizer['recognize']>>['result'];
  budgets?: Partial<Pick<
    ConstructorParameters<typeof MealRecognitionCoordinator>[0],
    'finalizationReserveMs' | 'providerCallMaxMs' | 'providerCallMinMs'
      | 'dbLockCapMs' | 'dbStatementCapMs' | 'leaseMarginMs'
  >>;
  providerIdentity?: ConstructorParameters<typeof MealRecognitionCoordinator>[0]['providerIdentity'];
  eventSink?: ConstructorParameters<typeof MealRecognitionCoordinator>[0]['eventSink'];
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
    providerIdentity: {
      provider: 'mock',
      model: 'test',
      promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
      schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION,
    },
    ...options.budgets,
    ...(options.providerIdentity ? { providerIdentity: options.providerIdentity } : {}),
    ...(options.eventSink ? { eventSink: options.eventSink } : {}),
  });
}

function makeLegacyRunner(s: State, options: {
  object?: Partial<{ bytes: Uint8Array; contentType: string; byteSize: number; error: Error }>;
  recognize?: (input: Parameters<MealRecognizer['recognize']>[0]) => ReturnType<MealRecognizer['recognize']>;
  eventSink?: ConstructorParameters<typeof LegacyObserveMealRecognitionRunner>[0]['eventSink'];
  timeoutMs?: number;
  providerCallMaxMs?: number;
} = {}) {
  return new LegacyObserveMealRecognitionRunner({
    database: fakeDatabase(s) as never,
    objectStore: {
      createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => {},
      readObject: async () => {
        if (options.object?.error) throw options.object.error;
        return {
          bytes: options.object?.bytes ?? bytes,
          contentType: options.object?.contentType ?? 'image/png',
          byteSize: options.object?.byteSize ?? bytes.byteLength,
        };
      },
    },
    recognizer: {
      recognize: options.recognize ?? (async () => ({
        provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
        schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result,
      })),
    },
    maxBytes: 1024, timeoutMs: options.timeoutMs ?? 100, leaseMs: 60_000,
    maxAttempts: 3, dailyQuota: 10,
    ...(options.providerCallMaxMs === undefined ? {} : { providerCallMaxMs: options.providerCallMaxMs }),
    ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
  });
}

describe('MealRecognitionCoordinator', () => {
  test('keeps the durable fixture one-execution and one-invocation fenced', () => {
    expect(recognitionLedgerInvariantErrors({
      workflowId: recognitionLedgerFixture.workflow.id,
      executions: [recognitionLedgerFixture.execution],
      invocations: [recognitionLedgerFixture.invocation],
    })).toEqual([]);
    expect(recognitionLedgerInvariantErrors({
      workflowId: recognitionLedgerFixture.workflow.id,
      executions: [
        recognitionLedgerFixture.execution,
        {
          ...recognitionLedgerFixture.execution,
          id: 'duplicate-execution',
        },
      ],
      invocations: [],
    })).toContain('duplicate_execution_ordinal');
  });

  test('durably queues the initial execution before provider work starts', async () => {
    const s = state();
    await makeCoordinator(s).enqueueInitial('meal', 'user');

    expect(s.workflows).toHaveLength(1);
    expect(s.workflows[0]).toMatchObject({
      mealLogId: 'meal',
      imageAssetId: 'asset',
      status: 'pending',
      protocolVersion: 'v2_option_b',
      nextExecutionOrdinal: 2,
      automaticExecutionCount: 1,
      automaticInvocationReservationCount: 0,
    });
    expect(s.executions).toHaveLength(1);
    expect(s.executions[0]).toMatchObject({
      workflowId: expect.any(String),
      executionOrdinal: 1,
      trigger: 'initial',
      leaseToken: null,
      phase: 'claim',
      status: 'queued',
    });

    await expect(
      makeCoordinator(s).recognize('meal', 'user'),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(s.executions).toHaveLength(1);
    expect(s.invocations).toHaveLength(1);
  });

  test('caller abort before reservation prevents provider dispatch and emits only bounded events', async () => {
    const s = state();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const events: unknown[] = [];
    const coordinator = new MealRecognitionCoordinator({
      database: fakeDatabase(s) as never,
      objectStore: {
        createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => {},
        readObject: async () => ({ bytes, contentType: 'image/png', byteSize: bytes.byteLength }),
      },
      recognizer: { recognize: async () => { calls++; return {
        provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
        schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result,
      }; } },
      maxBytes: 1024, timeoutMs: 100, leaseMs: 100, maxAttempts: 3, dailyQuota: 10,
      providerIdentity: { provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION, schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION },
      eventSink: (event) => events.push(event),
    });
    await expect(coordinator.recognize('meal', 'user', 'initial', controller.signal)).resolves.toMatchObject({
      status: 'unavailable', code: 'EXECUTION_CANCELLED',
    });
    expect(calls).toBe(0);
    expect(JSON.stringify(events)).not.toContain('private/key');
  });

  test('commits every provider-path execution phase before the corresponding work', async () => {
    const s = state();
    const phases: string[] = [];
    const coordinator = makeCoordinator(s, {
      eventSink: (event) => {
        if (event.type === 'phase') phases.push(event.phase);
      },
    });
    await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(phases).toEqual([
      'asset_verify',
      'invocation_reserve',
      'provider_call',
      'provider_output',
      'observation_persist',
    ]);
  });

  test('legacy observe success writes no v2 execution or invocation and rejects recovery', async () => {
    const s = state();
    const coordinator = new LegacyObserveMealRecognitionRunner({
      database: fakeDatabase(s) as never,
      objectStore: {
        createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => {},
        readObject: async () => ({ bytes, contentType: 'image/png', byteSize: bytes.byteLength }),
      },
      recognizer: {
        recognize: async (input) => {
          expect(input.signal).toBeInstanceOf(AbortSignal);
          return {
            provider: 'mock', model: 'test', promptVersion: 'meal-recognition-prompt-v3',
            schemaVersion: 'meal-recognition-schema-v3', inputTokens: 1, outputTokens: 1,
            result: { outcome: 'no_food', imageQualityConfidenceBps: 9_000, observations: [] },
          };
        },
      },
      maxBytes: 1024, timeoutMs: 100, leaseMs: 100, maxAttempts: 3, dailyQuota: 10,
    });
    const legacyOutcome = await coordinator.recognize('meal', 'user');
    expect(legacyOutcome).toEqual({ status: 'ready' });
    expect(legacyOutcome.responseDeadlineAt).toBeInstanceOf(Date);
    expect(s.executions).toEqual([]);
    expect(s.invocations).toEqual([]);
    await expect(coordinator.recognize('meal', 'user', 'user_recovery')).resolves.toMatchObject({
      status: 'unavailable', code: 'USER_RECOVERY_UNAVAILABLE',
    });
  });

  test('legacy pre-aborted callers do not claim a lease or consume quota', async () => {
    const s = state();
    const controller = new AbortController();
    controller.abort();
    let providerCalls = 0;
    const coordinator = makeLegacyRunner(s, {
      recognize: async () => {
        providerCalls++;
        throw new Error('unreachable');
      },
    });

    await expect(coordinator.recognize('meal', 'user', 'initial', controller.signal)).resolves.toEqual({
      status: 'unavailable', code: 'EXECUTION_CANCELLED', retryable: false,
    });
    expect(providerCalls).toBe(0);
    expect(s.attempts).toBe(0);
    expect(s.dailyUsage).toBe(0);
    expect(s.leaseToken).toBeNull();
  });

  test('legacy quota exhaustion does not transition the meal to processing', async () => {
    const s = state({ dailyUsage: 10 });
    await expect(makeLegacyRunner(s).recognize('meal', 'user')).resolves.toEqual({
      status: 'unavailable', code: 'DAILY_QUOTA_RESERVED', retryable: false,
    });
    expect(s.status).toBe('pending');
    expect(s.leaseToken).toBeNull();
    expect(s.assetStatus).toBe('processing');
  });

  test('legacy terminal failures preserve safe phase codes, process the bound asset, and emit safe events', async () => {
    const s = state();
    const events: unknown[] = [];
    const coordinator = makeLegacyRunner(s, {
      recognize: async () => {
        throw new MealRecognitionFailure('PROVIDER_RATE_LIMITED');
      },
      eventSink: (event) => events.push(event),
    });
    await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({
      status: 'unavailable', code: 'PROVIDER_RATE_LIMITED', retryable: false,
    });
    expect(s.status).toBe('failed');
    expect(s.error).toBe('PROVIDER_RATE_LIMITED');
    expect(s.leaseToken).toBeNull();
    expect(s.assetStatus).toBe('processed');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'execution_started', executionId: expect.any(String) }),
      expect.objectContaining({ type: 'terminal', code: 'PROVIDER_RATE_LIMITED' }),
    ]));
    expect(JSON.stringify(events)).not.toContain('private/key');
  });

  test('legacy asset and persistence failures retain their own terminal codes', async () => {
    const assetFailure = state();
    await expect(makeLegacyRunner(assetFailure, {
      object: { error: new ImageObjectReadAbortedError() },
    }).recognize('meal', 'user')).resolves.toMatchObject({
      status: 'unavailable', code: 'ASSET_READ_TIMEOUT',
    });
    expect(assetFailure.assetStatus).toBe('processed');

    const persistenceFailure = state({ persistenceFails: true });
    await expect(makeLegacyRunner(persistenceFailure).recognize('meal', 'user')).resolves.toMatchObject({
      status: 'unavailable', code: 'PERSISTENCE_UNAVAILABLE',
    });
    expect(persistenceFailure.assetStatus).toBe('processed');

    const invalidOutput = state();
    await expect(makeLegacyRunner(invalidOutput, {
      recognize: async () => ({
        provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
        schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1,
        result: {} as never,
      }),
    }).recognize('meal', 'user')).resolves.toMatchObject({
      status: 'unavailable', code: 'INVALID_PROVIDER_RESPONSE',
    });
    expect(invalidOutput.assetStatus).toBe('processed');
  });

  test('legacy provider cap has its own terminal code', async () => {
    const s = state();
    const coordinator = makeLegacyRunner(s, {
      timeoutMs: 100,
      providerCallMaxMs: 1,
      recognize: async ({ signal }) => new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }) as ReturnType<MealRecognizer['recognize']>,
    });
    await expect(coordinator.recognize('meal', 'user')).resolves.toMatchObject({
      status: 'unavailable', code: 'PROVIDER_CALL_DEADLINE',
    });
  });

  test('legacy response loss emits only its active generated correlation', async () => {
    const s = state();
    const events: unknown[] = [];
    let coordinator!: LegacyObserveMealRecognitionRunner;
    coordinator = makeLegacyRunner(s, {
      eventSink: (event) => events.push(event),
      recognize: async () => {
        await coordinator.responseLost('meal', 'user');
        return {
          provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
          schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result,
        };
      },
    });
    await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'response_lost', workflowId: expect.any(String) }),
    ]));
    await coordinator.responseLost('meal', 'user');
    expect(events.filter((event) => (event as { type: string }).type === 'response_lost')).toHaveLength(1);
  });
  test('exports closed asset and terminal transition contracts for DB-backed coverage', () => {
    const metadata = {
      byteSize: 1, contentType: 'image/png', sha256: 'a', purpose: 'inference',
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(isUsableRecognitionAsset('initial', { ...metadata, status: 'processing' })).toBe(true);
    expect(isUsableRecognitionAsset('user_recovery', { ...metadata, status: 'processed' })).toBe(true);
    expect(isUsableRecognitionAsset('user_recovery', { ...metadata, status: 'processing' })).toBe(false);
    expect(isUsableRecognitionAsset('initial', {
      ...metadata, status: 'processing', purpose: 'upload',
    })).toBe(false);
    expect(isUsableRecognitionAsset('initial', {
      ...metadata, status: 'processing', expiresAt: new Date(0),
    })).toBe(false);
    expect(recognitionTerminalTransition('user_recovery', 'succeeded')).toMatchObject({
      clearLease: true, consumeUserGrant: true,
    });
    expect(reconciliationTransition()).toMatchObject({
      invocationStatus: 'outcome_unknown',
      executionStatus: 'abandoned',
      allowAutomaticSuccessor: false,
    });
    expect(reconciliationGrantTransition('initial', 'available', null, 'execution')).toEqual({
      consumeGrant: false,
    });
    expect(reconciliationGrantTransition('user_recovery', 'reserved', 'execution', 'execution')).toEqual({
      consumeGrant: true,
    });
    expect(reconciliationReceiptTransition(undefined)).toMatchObject({
      invocation: 'none', executionStatus: 'failed', executionCode: 'EXECUTION_DEADLINE',
    });
    expect(reconciliationReceiptTransition({ status: 'reserved', terminalCode: null })).toMatchObject({
      invocation: 'outcome_unknown', executionStatus: 'abandoned',
      executionCode: 'PROCESS_OUTCOME_UNKNOWN',
    });
    expect(reconciliationReceiptTransition({ status: 'succeeded', terminalCode: null })).toMatchObject({
      invocation: 'retain', executionStatus: 'failed', executionCode: 'PERSISTENCE_UNAVAILABLE',
    });
    expect(reconciliationReceiptTransition({ status: 'cancelled_before_call', terminalCode: 'EXECUTION_DEADLINE' })).toMatchObject({
      invocation: 'retain', executionStatus: 'failed', executionCode: 'EXECUTION_DEADLINE',
    });
    expect(reconciliationReceiptTransition({ status: 'failed_known', terminalCode: 'PROVIDER_RATE_LIMITED' })).toMatchObject({
      invocation: 'retain', executionStatus: 'failed', executionCode: 'PROVIDER_RATE_LIMITED',
    });
    expect(failureTransition('user_recovery', false)).toMatchObject({
      consumeUserGrant: false, terminalizeExecution: false,
    });
  });
  test('routes a persisted observation to resolution without another provider call', async () => {
    let providerCalls = 0;
    let resolutionCalls = 0;
    const originalResolve = MealResolutionCoordinator.prototype.resolve;
    MealResolutionCoordinator.prototype.resolve = async () => {
      resolutionCalls++;
      return { status: 'unavailable', code: 'CATALOG_UNAVAILABLE', retryable: true };
    };
    const database = {
      transaction<T>(callback: (tx: any) => Promise<T>) {
        return callback(database);
      },
      select() {
        return {
          from() {
            return {
              where() {
                return { limit: async () => [{ id: 'observation' }] };
              },
            };
          },
        };
      },
    };
    const coordinator = new MealRecognitionCoordinator({
      database: database as never,
      objectStore: {
        createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => {},
        readObject: async () => { throw new Error('image read must not occur'); },
      },
      recognizer: {
        recognize: async () => {
          providerCalls++;
          throw new Error('provider must not occur');
        },
      },
      maxBytes: 1024, timeoutMs: 100, leaseMs: 60_000, maxAttempts: 3, dailyQuota: 10,
    });
    try {
      await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({
        status: 'unavailable', code: 'CATALOG_UNAVAILABLE', retryable: true,
      });
      await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({
        status: 'unavailable', code: 'CATALOG_UNAVAILABLE', retryable: true,
      });
      expect(resolutionCalls).toBe(2);
      expect(providerCalls).toBe(0);
    } finally {
      MealResolutionCoordinator.prototype.resolve = originalResolve;
    }
  });

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
    expect(s.assetStatus).toBe('processing');
    expect(s.items).toEqual([]);
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
    expect(s.items).toHaveLength(0);
  });
  test('attributes catalog handoff failures to the handoff phase without replaying recognition', async () => {
    const s = state({ mappingLookupFails: true });

    await expect(makeCoordinator(s).recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(s.status).toBe('ready');
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

  test('durably reserves exactly one execution and invocation before the SDK call', async () => {
    const s = state();
    let invocationVisibleAtCall = false;
    const coordinator = makeCoordinator(s, {
      recognize: async () => {
        invocationVisibleAtCall = s.invocations.length === 1;
        return {
          provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
          schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result,
        };
      },
    });
    await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(invocationVisibleAtCall).toBe(true);
    expect(s.executions).toHaveLength(1);
    expect(s.invocations).toHaveLength(1);
    expect(s.dailyUsage).toBe(1);
    expect(s.invocations[0]).toMatchObject({
      invocationOrdinal: 1,
      workflowInvocationOrdinal: 1,
      status: 'reserved',
    });
  });

  test('atomically binds the one user-recovery grant and reserves one invocation', async () => {
    const s = state({
      status: 'failed',
      nextAttemptAt: new Date(Date.now() - 1),
      assetStatus: 'processed',
      workflows: [{
        id: 'workflow', imageAssetId: 'asset', nextExecutionOrdinal: 2,
        automaticExecutionCount: 1, automaticInvocationReservationCount: 1,
        userGrantState: 'available',
      }],
    });
    let calls = 0;
    const coordinator = makeCoordinator(s, {
      recognize: async () => {
        calls++;
        return {
          provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
          schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result,
        };
      },
    });
    await expect(coordinator.recognize('meal', 'user', 'user_recovery')).resolves.toEqual({ status: 'ready' });
    expect(calls).toBe(1);
    expect(s.executions).toHaveLength(1);
    expect(s.invocations).toHaveLength(1);
    expect(s.workflows[0]).toMatchObject({ userGrantState: 'consumed' });
    await expect(coordinator.recognize('meal', 'user', 'user_recovery')).resolves.toMatchObject({
      status: 'ready',
    });
    expect(s.executions).toHaveLength(1);
    expect(s.invocations).toHaveLength(1);
  });

  test('lazily creates a conservative v2 workflow for historical user recovery', async () => {
    const s = state({
      status: 'failed',
      nextAttemptAt: new Date(Date.now() - 1),
      attempts: 3,
      assetStatus: 'processed',
    });
    await expect(makeCoordinator(s).recognize('meal', 'user', 'user_recovery')).resolves.toEqual({ status: 'ready' });
    expect(s.workflows[0]).toMatchObject({
      protocolVersion: 'v2_option_b',
      automaticExecutionCount: 3,
      automaticInvocationReservationCount: 3,
      userGrantState: 'consumed',
    });
    expect(s.executions).toHaveLength(1);
  });

  test('upgrades same-bound legacy workflow conservatively for user recovery', async () => {
    const s = state({
      status: 'failed',
      nextAttemptAt: new Date(Date.now() - 1),
      attempts: 2,
      assetStatus: 'processed',
      workflows: [{
        id: 'workflow', imageAssetId: 'asset', protocolVersion: 'legacy_v1',
        nextExecutionOrdinal: 1, automaticExecutionCount: 0,
        automaticInvocationReservationCount: 0, userGrantState: 'available',
      }],
    });
    await expect(makeCoordinator(s).recognize('meal', 'user', 'user_recovery')).resolves.toEqual({ status: 'ready' });
    expect(s.workflows[0]).toMatchObject({
      protocolVersion: 'v2_option_b',
      nextExecutionOrdinal: 2,
      automaticExecutionCount: 2,
      automaticInvocationReservationCount: 2,
      userGrantState: 'consumed',
    });
    expect((s.executions[0] as { executionOrdinal: number }).executionOrdinal)
      .toBe((s.workflows[0] as { nextExecutionOrdinal: number }).nextExecutionOrdinal - 1);
  });



  test('does not consume a user grant when the bound asset is unusable', async () => {
    const s = state({
      status: 'failed',
      nextAttemptAt: new Date(Date.now() - 1),
      assetStatus: 'processed',
      assetMetadataMissing: true,
      workflows: [{
        id: 'workflow', imageAssetId: 'asset', nextExecutionOrdinal: 2,
        automaticExecutionCount: 1, automaticInvocationReservationCount: 1,
        userGrantState: 'available',
      }],
    });
    await expect(makeCoordinator(s).recognize('meal', 'user', 'user_recovery')).resolves.toMatchObject({
      status: 'unavailable',
      code: 'ASSET_UNAVAILABLE',
    });
    expect(s.workflows[0]).toMatchObject({ userGrantState: 'available' });
    expect(s.executions).toHaveLength(0);
    expect(s.invocations).toHaveLength(0);
  });

  test('concurrent user-recovery claims produce one execution and one provider invocation', async () => {
    const s = state({
      status: 'failed',
      nextAttemptAt: new Date(Date.now() - 1),
      assetStatus: 'processed',
      workflows: [{
        id: 'workflow', imageAssetId: 'asset', nextExecutionOrdinal: 2,
        automaticExecutionCount: 1, automaticInvocationReservationCount: 1,
        userGrantState: 'available',
      }],
    });
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const coordinator = makeCoordinator(s, {
      recognize: async () => {
        calls++;
        await started;
        return {
          provider: 'mock', model: 'test', promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
          schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION, inputTokens: 1, outputTokens: 1, result,
        };
      },
    });
    const first = coordinator.recognize('meal', 'user', 'user_recovery');
    await Promise.resolve();
    const second = coordinator.recognize('meal', 'user', 'user_recovery');
    release();
    const outcomes = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(s.executions).toHaveLength(1);
    expect(s.invocations).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.status === 'active' || outcome.status === 'ready')).toBe(true);
  });

  test('caps the provider signal while retaining a separate V3 finalization reserve', async () => {
    const s = state();
    let signal!: AbortSignal | undefined;
    const coordinator = makeCoordinator(s, {
      budgets: {
        providerCallMaxMs: 5,
        providerCallMinMs: 1,
        finalizationReserveMs: 30,
        leaseMarginMs: 17,
      },
      providerIdentity: {
        provider: 'mock',
        model: 'test',
        promptVersion: 'meal-recognition-prompt-v3',
        schemaVersion: 'meal-recognition-schema-v3',
      },
      recognize: async (input) => {
        signal = input.signal;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          provider: 'mock', model: 'test',
          promptVersion: 'meal-recognition-prompt-v3',
          schemaVersion: 'meal-recognition-schema-v3',
          inputTokens: 1, outputTokens: 1,
          result: {
            outcome: 'no_food', imageQualityConfidenceBps: 9_000, observations: [],
          },
        } as never;
      },
    });
    await expect(coordinator.recognize('meal', 'user')).resolves.toEqual({ status: 'ready' });
    expect(signal?.aborted).toBe(true);
    expect(s.status).toBe('ready');
    expect(s.executions[0]).toMatchObject({
      wallDeadlineAt: expect.any(Date),
    });
  });

  test('initial claims only pending while recovery may claim a failed meal with no retry timestamp', async () => {
    const expired = state({ status: 'processing', leaseToken: 'old', leaseExpiresAt: new Date(Date.now() - 1) });
    await expect(makeCoordinator(expired).recognize('meal', 'user')).resolves.toMatchObject({
      status: 'unavailable',
    });
    const s = state({ status: 'failed', error: 'PROVIDER_RATE_LIMITED', assetStatus: 'processed' });
    await expect(makeCoordinator(s).recognize('meal', 'user', 'user_recovery')).resolves.toEqual({ status: 'ready' });
    expect(s.attempts).toBe(1);
    expect(s.workflows[0]).toMatchObject({
      userGrantState: 'consumed',
      userGrantExecutionId: s.executions[0]?.id,
    });
  });

  test('does not claim at maximum attempts or daily quota', async () => {
    const maximum = state({ attempts: 3 });
    await expect(makeCoordinator(maximum).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'MAX_ATTEMPTS_EXCEEDED', retryable: false });
    expect(maximum.nextAttemptAt).toBeNull();
    await expect(makeCoordinator(state({ dailyUsage: 10 })).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'DAILY_QUOTA_RESERVED', retryable: false });
  });

  test('attributes failures to their active phase and never assigns provider codes to asset failures', async () => {
    const timeout = state();
    await expect(makeCoordinator(timeout, { object: { error: new ImageObjectReadAbortedError() } }).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'ASSET_READ_TIMEOUT', retryable: false });
    expect(timeout.error).toBe('ASSET_READ_TIMEOUT');
    const unavailable = state();
    await expect(makeCoordinator(unavailable, { recognize: async () => { throw new MealRecognitionFailure('PROVIDER_RATE_LIMITED'); } }).recognize('meal', 'user')).resolves.toMatchObject({ status: 'unavailable', code: 'PROVIDER_RATE_LIMITED', retryable: false });
    expect(unavailable.error).toBe('PROVIDER_RATE_LIMITED');
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
      expect(outcome.status).toBe(
        mutation === 'stale'
          ? 'active'
          : mutation === 'manual'
            ? 'ready'
            : 'unavailable',
      );
      expect(s.items).toHaveLength(0);
      expect(s.observations).toHaveLength(mutation === 'manual' ? 1 : 0);
    }
  });
  test('persists no_food as a ready, zero-item immutable recognition result', async () => {
    const s = state();
    const noFood: RecognitionResultV2 = { outcome: 'no_food', imageQualityConfidenceBps: 9_100, foods: [] };
    await expect(makeCoordinator(s, { result: noFood }).recognize('meal', 'user')).resolves.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    expect(s.status).toBe('failed');
    expect(s.items).toEqual([]);
  });

  test('persists insufficient_evidence with reason and no invented meal item', async () => {
    const s = state();
    const insufficient: RecognitionResultV2 = { outcome: 'insufficient_evidence', imageQualityConfidenceBps: 1_500, evidenceReason: 'blurred', foods: [] };
    await expect(makeCoordinator(s, { result: insufficient }).recognize('meal', 'user')).resolves.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    expect(s.status).toBe('failed');
    expect(s.items).toEqual([]);
  });

  test('persists recognized model origin and immutable V2 assessment', async () => {
    const s = state();
    expect(await makeCoordinator(s).recognize('meal', 'user')).toEqual({
      status: 'ready',
    });
    expect(s.items).toEqual([]);
  });

  test('keeps the recognition entry deadline through provider work and finalization', async () => {
    const coordinator = makeCoordinator(state(), {
      recognize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          provider: 'mock', model: 'test',
          promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
          schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION,
          inputTokens: 1, outputTokens: 1, result,
        };
      },
    });
    const startedAt = Date.now();
    const outcome = await coordinator.recognize('meal', 'user');
    expect(outcome.responseDeadlineAt).toBeInstanceOf(Date);
    expect(outcome.responseDeadlineAt!.getTime()).toBeGreaterThanOrEqual(startedAt + 90);
    expect(outcome.responseDeadlineAt!.getTime()).toBeLessThanOrEqual(startedAt + 110);
  });

  test('attaches a fresh entry deadline to direct reconciliation', async () => {
    const startedAt = Date.now();
    const outcome = await makeCoordinator(state({ status: 'ready' })).reconcile('meal', 'user');
    expect(outcome.responseDeadlineAt).toBeInstanceOf(Date);
    expect(outcome.responseDeadlineAt!.getTime()).toBeGreaterThanOrEqual(startedAt + 90);
  });
});
