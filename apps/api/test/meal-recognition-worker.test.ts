import { describe, expect, test } from 'bun:test';
import type { Database } from '@nueat/database';

import type {
  MealRecognitionRunner,
} from '../src/services/meal-recognition-coordinator';
import {
  MealRecognitionWorker,
} from '../src/services/meal-recognition-worker';

function databaseWithDueMeals(
  meals: Array<{ id: string; userId: string }>,
): Database {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    async limit(limit: number) {
                      return meals.slice(0, limit);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

function runnerWithCalls(calls: string[]): MealRecognitionRunner {
  return {
    async enqueueInitial(mealLogId, userId) {
      calls.push(`enqueue:${mealLogId}:${userId}`);
    },
    async recognize(mealLogId, userId, trigger) {
      calls.push(`recognize:${mealLogId}:${userId}:${trigger}`);
      return { status: 'ready' };
    },
    async reconcile() {
      return { status: 'ready' };
    },
  };
}

describe('MealRecognitionWorker', () => {
  test('admits and executes due drafts in stable queue order', async () => {
    const calls: string[] = [];
    const worker = new MealRecognitionWorker({
      database: databaseWithDueMeals([
        { id: 'meal-a', userId: 'user-a' },
        { id: 'meal-b', userId: 'user-b' },
      ]),
      runner: runnerWithCalls(calls),
      batchSize: 2,
    });

    expect(await worker.runOnce()).toBe(2);
    expect(calls).toEqual([
      'enqueue:meal-a:user-a',
      'recognize:meal-a:user-a:initial',
      'enqueue:meal-b:user-b',
      'recognize:meal-b:user-b:initial',
    ]);
  });

  test('does not claim another draft after shutdown aborts a batch', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const runner = runnerWithCalls(calls);
    const originalRecognize = runner.recognize.bind(runner);
    runner.recognize = async (...args) => {
      const result = await originalRecognize(...args);
      controller.abort();
      return result;
    };
    const worker = new MealRecognitionWorker({
      database: databaseWithDueMeals([
        { id: 'meal-a', userId: 'user-a' },
        { id: 'meal-b', userId: 'user-b' },
      ]),
      runner,
    });

    expect(await worker.runOnce(controller.signal)).toBe(1);
    expect(calls).toEqual([
      'enqueue:meal-a:user-a',
      'recognize:meal-a:user-a:initial',
    ]);
  });
});
