import { describe, expect, test } from 'bun:test';

import {
  catalogEligibilityAdapter,
  MealResolutionCoordinator,
  resolveAutomaticMappingSelection,
  type ResolutionExecutionContext,
  type VerifiedCatalogAutoSelectionPolicy,
} from '../src/services/meal-resolution-coordinator';
import {
  CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
  CATALOG_AUTO_SELECTION_POLICY_VERSION,
} from '../src/services/catalog-auto-selection-policy';

const hash = 'a'.repeat(64);
const activation = { id: 'activation-1', catalogReleaseId: 'catalog-1', identitySha256: hash };
const winner = { foodId: 'food-1', scoreBps: 9_500, eligible: true };
const runnerUp = { foodId: 'food-2', scoreBps: 8_000 };
const verifiedPolicy: VerifiedCatalogAutoSelectionPolicy = {
  policy: {
    version: CATALOG_AUTO_SELECTION_POLICY_VERSION,
    comparatorVersion: CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
    minimumWinnerScoreBps: 9_000,
    minimumMarginBps: 1_000,
    identitySha256: hash,
  },
  verifiedPolicyIdentitySha256: hash,
};

describe('meal resolution coordinator automatic mapping', () => {
  test('requires a verified policy and otherwise abstains to review', () => {
    expect(resolveAutomaticMappingSelection({
      winner, runnerUp, activation, verifiedPolicy: null,
    })).toEqual({ kind: 'abstain', reason: 'POLICY_UNAVAILABLE' });
  });

  test('selects only when the supplied policy is verified and thresholds pass', () => {
    expect(resolveAutomaticMappingSelection({
      winner, runnerUp, activation, verifiedPolicy,
    })).toMatchObject({
      kind: 'selected',
      foodId: 'food-1',
      winnerScoreBps: 9_500,
      marginBps: 1_500,
    });
  });

  test('abstains when a supplied policy identity is not verified', () => {
    expect(resolveAutomaticMappingSelection({
      winner,
      runnerUp,
      activation,
      verifiedPolicy: { ...verifiedPolicy, verifiedPolicyIdentitySha256: 'b'.repeat(64) },
    })).toEqual({ kind: 'abstain', reason: 'POLICY_UNTRUSTED' });
  });
});

describe('meal resolution execution deadline', () => {
  test('keeps confirmation eligibility reads free of local timeout settings without a context', async () => {
    let executeCalls = 0;
    const database: any = {
      transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
        execute: async () => { executeCalls++; },
        select() {
          const query: any = {
            from() { return query; },
            innerJoin() { return query; },
            where() { return query; },
            limit: async () => [],
            then(resolve: (value: unknown[]) => unknown) { return Promise.resolve([]).then(resolve); },
          };
          return query;
        },
      }),
    };
    await catalogEligibilityAdapter(database).load({ catalogReleaseId: 'catalog', foodId: 'food', unit: 'g' });
    expect(executeCalls).toBe(0);
  });

  test('cancels and rolls back a later eligibility read at the deadline', async () => {
    let selectCount = 0;
    let committed = false;
    const database: any = {
      transaction: async (callback: (tx: any) => Promise<unknown>) => {
        try {
          const result = await callback({
            execute: async () => undefined,
            select() {
              const ordinal = ++selectCount;
              const value = ordinal === 5
                ? new Promise((resolve) => setTimeout(() => resolve([]), 10))
                : Promise.resolve([]);
              const query: any = {
                from() { return query; },
                innerJoin() { return query; },
                where() { return query; },
                limit: async () => value,
                then(resolve: (rows: unknown) => unknown) { return value.then(resolve); },
              };
              return query;
            },
          });
          committed = true;
          return result;
        } catch (error) {
          throw error;
        }
      },
    };
    const context: ResolutionExecutionContext = {
      signal: new AbortController().signal,
      monotonicDeadline: performance.now() + 3,
      wallDeadlineAt: new Date(Date.now() + 3),
      dbLockCapMs: 5,
      dbStatementCapMs: 5,
      commitReserveMs: 1,
    };
    await expect(catalogEligibilityAdapter(database, context).load({
      catalogReleaseId: 'catalog', foodId: 'food', unit: 'g',
    })).rejects.toThrow();
    expect(selectCount).toBe(5);
    expect(committed).toBe(false);
  });

  test('cancels a delayed catalog query and leaves no active lease or late mutation', async () => {
    let released = false;
    let mappingWrites = 0;
    let activeQueries = 0;
    let statementTimeoutSet = false;
    let leaseExpiresAt: Date | null = new Date(Date.now() + 5);
    const database: any = {
      transaction(callback: (tx: any) => Promise<unknown>) {
        return callback({
          execute(query: { queryChunks?: Array<{ value?: string[] }> }) {
            statementTimeoutSet ||= JSON.stringify(query).includes('statement_timeout');
            return Promise.resolve();
          },
          select() {
            const query = {
              from() { return query; },
              innerJoin() { return query; },
              where() { return query; },
              limit() {
                activeQueries++;
                return new Promise((_, reject) => setTimeout(() => {
                  activeQueries--;
                  reject(new Error('canceling statement due to statement timeout'));
                }, 5));
              },
            };
            return query;
          },
          update() {
            return { set: (values: Record<string, unknown>) => ({
              where: async () => {
                if (values.status === 'failed') {
                  released = true;
                  leaseExpiresAt = null;
                }
                return [];
              },
            }) };
          },
          insert() {
            mappingWrites++;
            return { values: () => ({ returning: async () => [] }) };
          },
        });
      },
    };
    const coordinator = new MealResolutionCoordinator(database, 60_000, 3);
    (coordinator as any).claim = async () => ({
      kind: 'claimed', attemptId: 'attempt', observationId: 'observation', leaseToken: 'lease',
      content: { outcome: 'no_food', observations: [] }, imageAssetId: 'asset',
    });
    const controller = new AbortController();
    const context: ResolutionExecutionContext = {
      signal: controller.signal,
      monotonicDeadline: performance.now() + 5,
      wallDeadlineAt: new Date(Date.now() + 5),
      dbLockCapMs: 5,
      dbStatementCapMs: 5,
      commitReserveMs: 1,
    };
    const started = performance.now();
    await expect(coordinator.resolve('meal', 'user', context)).resolves.toEqual({
      status: 'unavailable', code: 'EXECUTION_DEADLINE', retryable: false,
    });
    expect(performance.now() - started).toBeLessThan(30);
    expect(statementTimeoutSet).toBe(true);
    expect(activeQueries).toBe(0);
    expect(released).toBe(true);
    expect(mappingWrites).toBe(0);
    expect(leaseExpiresAt === null || leaseExpiresAt <= context.wallDeadlineAt).toBe(true);
  });

  test('bounds blocked cleanup after an expired resolution deadline', async () => {
    let transactionNumber = 0;
    let activeCleanupUpdates = 0;
    let cleanupStatementTimeoutSet = false;
    const database: any = {
      transaction: async (callback: (tx: any) => Promise<unknown>) => {
        const number = ++transactionNumber;
        return callback({
          execute(query: { queryChunks?: Array<{ value?: string[] }> }) {
            if (number === 2) {
              cleanupStatementTimeoutSet ||= JSON.stringify(query).includes('statement_timeout');
            }
            return Promise.resolve();
          },
          select() {
            const query = {
              from() { return query; },
              innerJoin() { return query; },
              where() { return query; },
              limit: () => new Promise((_, reject) => setTimeout(
                () => reject(new Error('canceling statement due to statement timeout')),
                8,
              )),
            };
            return query;
          },
          update() {
            return {
              set: () => ({
                where: () => new Promise((resolve) => {
                  activeCleanupUpdates++;
                  setTimeout(() => {
                    activeCleanupUpdates--;
                    resolve([]);
                  }, 20);
                }),
              }),
            };
          },
        });
      },
    };
    const coordinator = new MealResolutionCoordinator(database, 60_000, 3);
    (coordinator as any).claim = async () => ({
      kind: 'claimed', attemptId: 'attempt', observationId: 'observation', leaseToken: 'lease',
      content: { outcome: 'no_food', observations: [] }, imageAssetId: 'asset',
    });
    const context: ResolutionExecutionContext = {
      signal: new AbortController().signal,
      monotonicDeadline: performance.now() + 3,
      wallDeadlineAt: new Date(Date.now() + 3),
      dbLockCapMs: 10,
      dbStatementCapMs: 10,
      commitReserveMs: 2,
    };
    const started = performance.now();
    await expect(coordinator.resolve('meal', 'user', context)).resolves.toEqual({
      status: 'unavailable', code: 'EXECUTION_DEADLINE', retryable: false,
    });
    expect(performance.now() - started).toBeLessThan(18);
    expect(cleanupStatementTimeoutSet).toBe(true);
    expect(activeCleanupUpdates === 0 || new Date() >= context.wallDeadlineAt).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(activeCleanupUpdates).toBe(0);
  });

  test('rolls back when finalization crosses the deadline', async () => {
    let transactionNumber = 0;
    let committedFinalization = false;
    let callbackReturned = false;
    const database: any = {
      transaction: async (callback: (tx: any) => Promise<unknown>) => {
        const number = ++transactionNumber;
        let stagedFinalization = false;
        const rows = number === 1
          ? [[{ activationId: 'activation', catalogReleaseId: 'catalog', policyVersion: 'policy', policySha256: hash, activationIdentitySha256: hash }], [{ id: 'catalog', status: 'active', normalizerVersion: 'v1' }], []]
          : [[{ id: 'attempt' }]];
        const tx = {
          execute: async () => undefined,
          select() {
            const query = {
              from() { return query; },
              innerJoin() { return query; },
              where() { return query; },
              for() { return query; },
              limit: async () => rows.shift() ?? [],
            };
            return query;
          },
          insert() {
            return { values: () => ({ returning: async () => [] }) };
          },
          update() {
            return {
              set(values: Record<string, unknown>) {
                if (values.status === 'resolved') stagedFinalization = true;
                const query = {
                  where() { return query; },
                  returning: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return [{ id: 'attempt' }];
                  },
                };
                return query;
              },
            };
          },
        };
        try {
          const result = await callback(tx);
          if (number === 2) callbackReturned = true;
          committedFinalization = stagedFinalization;
          return result;
        } catch (error) {
          throw error;
        }
      },
    };
    const coordinator = new MealResolutionCoordinator(database, 60_000, 3);
    (coordinator as any).claim = async () => ({
      kind: 'claimed', attemptId: 'attempt', observationId: 'observation', leaseToken: 'lease',
      content: { outcome: 'no_food', observations: [] }, imageAssetId: 'asset',
    });
    const context: ResolutionExecutionContext = {
      signal: new AbortController().signal,
      monotonicDeadline: performance.now() + 3,
      wallDeadlineAt: new Date(Date.now() + 3),
      dbLockCapMs: 10,
      dbStatementCapMs: 10,
      commitReserveMs: 5,
    };
    await expect(coordinator.resolve('meal', 'user', context)).resolves.toMatchObject({
      status: 'unavailable', code: 'EXECUTION_DEADLINE',
    });
    expect(committedFinalization).toBe(false);
    expect(callbackReturned).toBe(false);
  });

  test('leaves its commit reserve for a delayed transaction commit', async () => {
    let transactionNumber = 0;
    let committed = false;
    const database: any = {
      transaction: async (callback: (tx: any) => Promise<unknown>) => {
        const number = ++transactionNumber;
        const rows = number === 1
          ? [[{ activationId: 'activation', catalogReleaseId: 'catalog', policyVersion: 'policy', policySha256: hash, activationIdentitySha256: hash }], [{ id: 'catalog', status: 'active', normalizerVersion: 'v1' }]]
          : [[{ id: 'attempt' }]];
        const tx = {
          execute: async () => undefined,
          select() {
            const query = {
              from() { return query; },
              innerJoin() { return query; },
              where() { return query; },
              for() { return query; },
              limit: async () => rows.shift() ?? [],
            };
            return query;
          },
          insert() { return { values: () => ({ returning: async () => [] }) }; },
          update() {
            return {
              set() {
                const query = {
                  where() { return query; },
                  returning: async () => [{ id: 'attempt' }],
                };
                return query;
              },
            };
          },
        };
        const result = await callback(tx);
        await new Promise((resolve) => setTimeout(resolve, 5));
        committed = true;
        return result;
      },
    };
    const coordinator = new MealResolutionCoordinator(database, 60_000, 3);
    (coordinator as any).claim = async () => ({
      kind: 'claimed', attemptId: 'attempt', observationId: 'observation', leaseToken: 'lease',
      content: { outcome: 'no_food', observations: [] }, imageAssetId: 'asset',
    });
    const context: ResolutionExecutionContext = {
      signal: new AbortController().signal,
      monotonicDeadline: performance.now() + 80,
      wallDeadlineAt: new Date(Date.now() + 80),
      dbLockCapMs: 10,
      dbStatementCapMs: 10,
      commitReserveMs: 25,
    };
    const started = performance.now();
    await expect(coordinator.resolve('meal', 'user', context)).resolves.toEqual({ status: 'ready' });
    expect(committed).toBe(true);
    expect(performance.now() - started).toBeLessThan(80);
  });
});
