import {
  mealLogs,
  recognitionAttempts,
  recognitionExecutions,
  type Database,
} from '@nueat/database';
import { and, asc, eq, lte } from 'drizzle-orm';

import type { MealRecognitionRunner } from './meal-recognition-coordinator';

export interface MealRecognitionWorkerOptions {
  database: Database;
  runner: MealRecognitionRunner;
  pollIntervalMs?: number;
  batchSize?: number;
  onError?: (code: 'RECOGNITION_WORKER_POLL_FAILED') => void;
}

export type MealRecognitionWorkerStatus = 'idle' | 'running' | 'stopped';

export function recognitionWorkerEnabled(input: {
  reliabilityDisabled: boolean;
  isTest: boolean;
  hasInjectedRunner: boolean;
  hasObjectStore: boolean;
}) {
  return !input.reliabilityDisabled &&
    !input.isTest &&
    (input.hasInjectedRunner || input.hasObjectStore);
}

export class MealRecognitionWorker {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private activeRun: Promise<number> | undefined;
  private stopped = true;

  constructor(private readonly options: MealRecognitionWorkerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 4;
  }

  status(): MealRecognitionWorkerStatus {
    if (this.stopped) return 'stopped';
    return this.activeRun ? 'running' : 'idle';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.activeRun;
    this.activeRun = undefined;
    this.controller = undefined;
  }

  async runOnce(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return 0;
    const now = new Date();
    const expired = await this.options.database
      .select({
        id: mealLogs.id,
        userId: mealLogs.userId,
      })
      .from(recognitionExecutions)
      .innerJoin(
        recognitionAttempts,
        eq(recognitionAttempts.id, recognitionExecutions.workflowId),
      )
      .innerJoin(mealLogs, eq(mealLogs.id, recognitionAttempts.mealLogId))
      .where(and(
        eq(recognitionExecutions.status, 'open'),
        lte(recognitionExecutions.wallDeadlineAt, now),
        eq(mealLogs.status, 'draft'),
      ))
      .orderBy(
        asc(recognitionExecutions.wallDeadlineAt),
        asc(recognitionExecutions.id),
      )
      .limit(this.batchSize);
    let processed = 0;
    for (const mealLog of expired) {
      if (signal?.aborted) return processed;
      await this.options.runner.reconcile(mealLog.id, mealLog.userId, signal);
      processed += 1;
    }

    const due = await this.options.database
      .select({ id: mealLogs.id, userId: mealLogs.userId })
      .from(mealLogs)
      .where(and(
        eq(mealLogs.status, 'draft'),
        eq(mealLogs.recognitionStatus, 'pending'),
        lte(mealLogs.recognitionNextAttemptAt, now),
      ))
      .orderBy(asc(mealLogs.recognitionNextAttemptAt), asc(mealLogs.id))
      .limit(this.batchSize);

    for (const mealLog of due) {
      if (signal?.aborted) break;
      const queued =
        await this.options.runner.enqueueInitial?.(
          mealLog.id,
          mealLog.userId,
        ) ?? false;
      if (!queued) {
        await this.options.runner.recognize(
          mealLog.id,
          mealLog.userId,
          'initial',
          signal,
        );
        processed += 1;
      }
    }

    const queued = await this.options.database
      .select({
        id: mealLogs.id,
        userId: mealLogs.userId,
      })
      .from(recognitionExecutions)
      .innerJoin(
        recognitionAttempts,
        eq(recognitionAttempts.id, recognitionExecutions.workflowId),
      )
      .innerJoin(mealLogs, eq(mealLogs.id, recognitionAttempts.mealLogId))
      .where(and(
        eq(recognitionExecutions.status, 'queued'),
        eq(mealLogs.status, 'draft'),
        eq(mealLogs.recognitionStatus, 'pending'),
      ))
      .orderBy(
        asc(recognitionExecutions.createdAt),
        asc(recognitionExecutions.id),
      )
      .limit(this.batchSize);
    for (const mealLog of queued) {
      if (signal?.aborted) break;
      await this.options.runner.recognize(
        mealLog.id,
        mealLog.userId,
        'initial',
        signal,
      );
      processed += 1;
    }
    return processed;
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const signal = this.controller?.signal;
      this.activeRun = this.runOnce(signal)
        .catch(() => {
          this.options.onError?.('RECOGNITION_WORKER_POLL_FAILED');
          return 0;
        })
        .finally(() => {
          this.activeRun = undefined;
          this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }
}
