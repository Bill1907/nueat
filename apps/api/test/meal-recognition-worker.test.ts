import { describe, expect, test } from 'bun:test';
import type { Database } from '@nueat/database';

import type {
  MealRecognitionRunner,
} from '../src/services/meal-recognition-coordinator';
import {
  MealRecognitionWorker,
  recognitionWorkerEnabled,
} from '../src/services/meal-recognition-worker';

type Work = { id: string; userId: string };

function databaseWithWork(
  ...queryResults: Work[][]
): Database {
  let queryIndex = 0;
  return {
    select() {
      const query = {
        from() {
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        async limit(limit: number) {
          return (queryResults[queryIndex++] ?? []).slice(0, limit);
        },
      };
      return query;
    },
  } as unknown as Database;
}

function runnerWithCalls(
  calls: string[],
  durableQueue = true,
): MealRecognitionRunner {
  return {
    async enqueueInitial(mealLogId, userId) {
      calls.push(`enqueue:${mealLogId}:${userId}`);
      return durableQueue;
    },
    async recognize(mealLogId, userId, trigger) {
      calls.push(`recognize:${mealLogId}:${userId}:${trigger}`);
      return { status: 'ready' };
    },
    async reconcile(mealLogId, userId) {
      calls.push(`reconcile:${mealLogId}:${userId}`);
      return { status: 'ready' };
    },
  };
}

const meals = [
  { id: 'meal-a', userId: 'user-a' },
  { id: 'meal-b', userId: 'user-b' },
];

describe('MealRecognitionWorker', () => {
  test('admits drafts and executes their durable rows on the next poll', async () => {
    const calls: string[] = [];
    const worker = new MealRecognitionWorker({
      database: databaseWithWork(
        [], [], meals,
        [], meals, [],
      ),
      runner: runnerWithCalls(calls),
      batchSize: 2,
    });

    expect(await worker.runOnce()).toBe(0);
    expect(await worker.runOnce()).toBe(2);
    expect(calls).toEqual([
      'enqueue:meal-a:user-a',
      'enqueue:meal-b:user-b',
      'recognize:meal-a:user-a:initial',
      'recognize:meal-b:user-b:initial',
    ]);
  });

  test('runs legacy work inline and stops after shutdown aborts a batch', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const runner = runnerWithCalls(calls, false);
    const originalRecognize = runner.recognize.bind(runner);
    runner.recognize = async (...args) => {
      const result = await originalRecognize(...args);
      controller.abort();
      return result;
    };
    const worker = new MealRecognitionWorker({
      database: databaseWithWork([], [], meals),
      runner,
    });

    expect(await worker.runOnce(controller.signal)).toBe(1);
    expect(calls).toEqual([
      'enqueue:meal-a:user-a',
      'recognize:meal-a:user-a:initial',
    ]);
  });

  test('reconciles expired open executions without a client request', async () => {
    const calls: string[] = [];
    const worker = new MealRecognitionWorker({
      database: databaseWithWork([meals[0]!], [], []),
      runner: runnerWithCalls(calls),
    });

    expect(await worker.runOnce()).toBe(1);
    expect(calls).toEqual(['reconcile:meal-a:user-a']);
  });

  test('relies on coordinator fencing when two replicas poll the same queue row', async () => {
    let claimed = false;
    let providerCalls = 0;
    const runner = runnerWithCalls([]);
    runner.recognize = async () => {
      if (claimed) return { status: 'active', retryAfterSeconds: 1 };
      claimed = true;
      providerCalls += 1;
      await Promise.resolve();
      return { status: 'ready' };
    };
    const workers = [0, 1].map(() => new MealRecognitionWorker({
      database: databaseWithWork([], [meals[0]!], []),
      runner,
    }));

    await Promise.all(workers.map((worker) => worker.runOnce()));
    expect(providerCalls).toBe(1);
  });

  test('starts one polling loop and stops it at a safe boundary', async () => {
    const worker = new MealRecognitionWorker({
      database: databaseWithWork([], [], []),
      runner: runnerWithCalls([]),
      pollIntervalMs: 100,
    });

    worker.start();
    worker.start();
    expect(['idle', 'running']).toContain(worker.status());
    await new Promise((resolve) => setTimeout(resolve, 120));
    await worker.stop();
    expect(worker.status()).toBe('stopped');
  });

  test('does not start with only unavailable internally constructed runners', () => {
    expect(recognitionWorkerEnabled({
      reliabilityDisabled: false,
      isTest: false,
      hasObjectStore: false,
    })).toBe(false);
    expect(recognitionWorkerEnabled({
      reliabilityDisabled: false,
      isTest: false,
      hasObjectStore: true,
    })).toBe(true);
  });
});
