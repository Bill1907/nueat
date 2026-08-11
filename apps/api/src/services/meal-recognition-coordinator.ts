import { createHash, randomUUID } from 'node:crypto';

import { imageAssets, mealItems, mealLogs, recognitionDailyUsages, type Database } from '@nueat/database';
import { and, eq, lte, or, sql } from 'drizzle-orm';

import {
  ImageObjectNotFoundError,
  ImageObjectReadAbortedError,
  ImageObjectStoreError,
  ImageObjectTooLargeError,
  type ImageObjectStore,
} from './image-object-store';
import {
  MealRecognitionFailure,
  RecognitionResultV1,
  type MealRecognizer,
} from './meal-recognizer';

export type MealRecognitionCoordinatorResult =
  | { status: 'ready' }
  | { status: 'active'; retryAfterSeconds: number }
  | { status: 'unavailable'; code: string; retryable: boolean };
export interface MealRecognitionRunner {
  recognize(mealLogId: string, userId: string): Promise<MealRecognitionCoordinatorResult>;
}

export interface MealRecognitionCoordinatorOptions {
  database: Database;
  objectStore: ImageObjectStore;
  recognizer: MealRecognizer;
  maxBytes: number;
  timeoutMs: number;
  leaseMs: number;
  maxAttempts: number;
  dailyQuota: number;
}

export class MealRecognitionCoordinator implements MealRecognitionRunner {
  constructor(private readonly options: MealRecognitionCoordinatorOptions) {}

  async recognize(mealLogId: string, userId: string): Promise<MealRecognitionCoordinatorResult> {
    const claimed = await this.claim(mealLogId, userId);
    if (claimed.kind === 'active') return { status: 'active', retryAfterSeconds: claimed.retryAfterSeconds };
    if (claimed.kind === 'unavailable') return claimed.outcome;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const object = await this.options.objectStore.readObject({
        objectKey: claimed.objectKey,
        maxBytes: this.options.maxBytes,
        signal: controller.signal,
      });
      if (
        object.byteSize !== claimed.byteSize ||
        object.contentType !== claimed.contentType ||
        createHash('sha256').update(object.bytes).digest('hex') !== claimed.sha256 ||
        !isImageContentType(object.contentType)
      ) return this.fail(claimed, 'ASSET_MISMATCH');

      // The object read is deliberately outside the lease transaction. Revalidate immediately
      // before the paid request so a manual/delete/reclaim winner cannot trigger a provider call.
      if (!(await this.renew(claimed))) return this.currentOutcome(claimed.mealLogId, claimed.userId);

      const output = await this.options.recognizer.recognize({
        imageBytes: object.bytes,
        imageContentType: object.contentType,
      });
      const parsed = RecognitionResultV1.safeParse(output.result);
      if (!parsed.success) return this.fail(claimed, 'INVALID_PROVIDER_RESPONSE');
      return this.finalize(claimed, output, parsed.data);
    } catch (error) {
      return this.fail(claimed, recognitionErrorCode(error, controller.signal.aborted));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async claim(mealLogId: string, userId: string) {
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(this.options.leaseMs, this.options.timeoutMs));
    try {
      return await this.options.database.transaction(async (tx) => {
      const [mealLog] = await tx.select({
        id: mealLogs.id,
        recognitionStatus: mealLogs.recognitionStatus,
        recognitionLeaseExpiresAt: mealLogs.recognitionLeaseExpiresAt,
        recognitionNextAttemptAt: mealLogs.recognitionNextAttemptAt,
        recognitionAttemptCount: mealLogs.recognitionAttemptCount,
        imageAssetId: mealLogs.imageAssetId,
      }).from(mealLogs).where(and(eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId), eq(mealLogs.status, 'draft'))).limit(1);
      if (!mealLog || !mealLog.imageAssetId) return { kind: 'unavailable' as const, outcome: unavailable('RECOGNITION_UNAVAILABLE', false) };
      if (mealLog.recognitionStatus === 'processing' && mealLog.recognitionLeaseExpiresAt && mealLog.recognitionLeaseExpiresAt > now)
        return { kind: 'active' as const, retryAfterSeconds: retryAfter(mealLog.recognitionLeaseExpiresAt, now) };
      if (!isEligible(mealLog, now)) return { kind: 'unavailable' as const, outcome: outcomeForState(mealLog, now) };
      if (mealLog.recognitionAttemptCount >= this.options.maxAttempts)
        return { kind: 'unavailable' as const, outcome: await this.denyPending(tx, mealLog, 'MAX_ATTEMPTS_EXCEEDED', false, now) };

      const [asset] = await tx.select({
        id: imageAssets.id,
        objectKey: imageAssets.objectKey,
        byteSize: imageAssets.byteSize,
        contentType: imageAssets.detectedContentType,
        sha256: imageAssets.sha256,
      }).from(imageAssets).where(and(eq(imageAssets.id, mealLog.imageAssetId), eq(imageAssets.userId, userId), eq(imageAssets.status, 'processing'))).limit(1);
      if (!asset || !asset.byteSize || !asset.contentType || !asset.sha256)
        return { kind: 'unavailable' as const, outcome: await this.denyPending(tx, mealLog, 'ASSET_UNAVAILABLE', true, now) };

      const [updated] = await tx.update(mealLogs).set({
        recognitionStatus: 'processing', recognitionLeaseToken: leaseToken,
        recognitionLeaseExpiresAt: leaseExpiresAt,
        recognitionAttemptCount: mealLog.recognitionAttemptCount + 1,
        recognitionLastErrorCode: null, updatedAt: now,
      }).where(and(
        eq(mealLogs.id, mealLog.id),
        eq(mealLogs.userId, userId),
        eq(mealLogs.status, 'draft'),
        eligibleRecognitionWhere(now),
      )).returning({ id: mealLogs.id });
      if (!updated)
        return {
          kind: 'unavailable' as const,
          outcome: await this.currentOutcomeFrom(tx, mealLogId, userId),
        };

      const attemptDate = now.toISOString().slice(0, 10);
      const usage = this.options.dailyQuota > 0 ? await tx.insert(recognitionDailyUsages).values({
        userId,
        attemptDate,
        attemptCount: 1,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [recognitionDailyUsages.userId, recognitionDailyUsages.attemptDate],
        set: { attemptCount: sql`${recognitionDailyUsages.attemptCount} + 1`, updatedAt: now },
        where: lte(recognitionDailyUsages.attemptCount, this.options.dailyQuota - 1),
      }).returning({ attemptCount: recognitionDailyUsages.attemptCount }) : [];
      if (!usage[0]) throw new DailyQuotaExceededError();

      return { kind: 'claimed' as const, mealLogId: mealLog.id, userId, leaseToken, imageAssetId: asset.id, objectKey: asset.objectKey, byteSize: asset.byteSize, contentType: asset.contentType, sha256: asset.sha256, attemptCount: mealLog.recognitionAttemptCount + 1 };
      });
    } catch (error) {
      if (!(error instanceof DailyQuotaExceededError)) throw error;
      const [mealLog] = await this.options.database
        .select({
          id: mealLogs.id,
          recognitionAttemptCount: mealLogs.recognitionAttemptCount,
        })
        .from(mealLogs)
        .where(
          and(
            eq(mealLogs.id, mealLogId),
            eq(mealLogs.userId, userId),
            eq(mealLogs.status, 'draft'),
          ),
        )
        .limit(1);
      if (!mealLog)
        return {
          kind: 'unavailable' as const,
          outcome: unavailable('RECOGNITION_UNAVAILABLE', false),
        };
      return {
        kind: 'unavailable' as const,
        outcome: await this.denyPending(
          this.options.database,
          mealLog,
          'DAILY_QUOTA_EXCEEDED',
          true,
          now,
          userId,
        ),
      };
    }
  }

  private async denyPending(tx: any, mealLog: { id: string; recognitionAttemptCount: number }, code: string, retryable: boolean, now: Date, userId?: string) {
    const nextAttemptAt = nextRetryAt(
      code,
      now,
      retryable && mealLog.recognitionAttemptCount < this.options.maxAttempts,
    );
    const [updated] = await tx.update(mealLogs).set({ recognitionStatus: 'failed', recognitionLeaseToken: null, recognitionLeaseExpiresAt: null, recognitionLastErrorCode: code, recognitionNextAttemptAt: nextAttemptAt, updatedAt: now }).where(and(
      eq(mealLogs.id, mealLog.id),
      eq(mealLogs.status, 'draft'),
      eligibleRecognitionWhere(now),
    )).returning({ id: mealLogs.id });
    if (updated) return unavailable(code, retryable && nextAttemptAt !== null);
    return this.currentOutcomeFrom(tx, mealLog.id, userId);
  }

  private async renew(claim: ClaimedRecognition) {
    const now = new Date();
    const [updated] = await this.options.database.transaction((tx) => tx.update(mealLogs).set({
      recognitionLeaseExpiresAt: new Date(now.getTime() + Math.max(this.options.leaseMs, this.options.timeoutMs)),
      updatedAt: now,
    }).where(and(eq(mealLogs.id, claim.mealLogId), eq(mealLogs.userId, claim.userId), eq(mealLogs.status, 'draft'), eq(mealLogs.recognitionStatus, 'processing'), eq(mealLogs.recognitionLeaseToken, claim.leaseToken))).returning({ id: mealLogs.id }));
    return !!updated;
  }

  private async finalize(claim: ClaimedRecognition, output: Awaited<ReturnType<MealRecognizer['recognize']>>, result: RecognitionResultV1): Promise<MealRecognitionCoordinatorResult> {
    const now = new Date();
    const completed = await this.options.database.transaction(async (tx) => {
      const [updated] = await tx.update(mealLogs).set({
        recognitionStatus: 'ready', recognitionProvider: output.provider, recognitionModel: output.model,
        recognitionPromptVersion: output.promptVersion, recognitionSchemaVersion: output.schemaVersion,
        recognitionResult: result, recognitionCompletedAt: now, recognitionProviderRequestId: output.providerRequestId ?? null,
        recognitionInputTokens: output.inputTokens, recognitionOutputTokens: output.outputTokens,
        recognitionLeaseToken: null, recognitionLeaseExpiresAt: null, recognitionNextAttemptAt: null, recognitionLastErrorCode: null, updatedAt: now,
      }).where(and(eq(mealLogs.id, claim.mealLogId), eq(mealLogs.userId, claim.userId), eq(mealLogs.status, 'draft'), eq(mealLogs.recognitionStatus, 'processing'), eq(mealLogs.recognitionLeaseToken, claim.leaseToken))).returning({ id: mealLogs.id });
      if (!updated) return false;
      await tx.insert(mealItems).values(result.foods.map((food) => ({ mealLogId: claim.mealLogId, recognizedLabel: food.recognizedLabel, amountMilliunits: food.amountMilliunits, unit: food.unit, recognitionRegionIndex: food.regionIndex, recognitionConfidenceBps: food.recognitionConfidenceBps, portionConfidenceBps: food.portionConfidenceBps, foodId: null, nutrientProfileId: null, mappingConfidenceBps: null, gramsMg: null, userCorrected: false })));
      await tx.update(imageAssets).set({ status: 'processed', processingCompletedAt: now }).where(and(eq(imageAssets.id, claim.imageAssetId), eq(imageAssets.status, 'processing')));
      return true;
    });
    return completed ? { status: 'ready' } : this.currentOutcome(claim.mealLogId, claim.userId);
  }

  private async fail(claim: ClaimedRecognition, code: string): Promise<MealRecognitionCoordinatorResult> {
    const now = new Date();
    const retryable = isRetryable(code);
    const nextAttemptAt = retryable && claim.attemptCount < this.options.maxAttempts ? new Date(now.getTime() + 60_000) : null;
    const [updated] = await this.options.database.update(mealLogs).set({ recognitionStatus: 'failed', recognitionLeaseToken: null, recognitionLeaseExpiresAt: null, recognitionLastErrorCode: code, recognitionNextAttemptAt: nextAttemptAt, updatedAt: now }).where(and(eq(mealLogs.id, claim.mealLogId), eq(mealLogs.status, 'draft'), eq(mealLogs.recognitionStatus, 'processing'), eq(mealLogs.recognitionLeaseToken, claim.leaseToken))).returning({ id: mealLogs.id });
    return updated ? unavailable(code, retryable && nextAttemptAt !== null) : this.currentOutcome(claim.mealLogId, claim.userId);
  }

  private currentOutcome(mealLogId: string, userId: string) {
    return this.currentOutcomeFrom(this.options.database, mealLogId, userId);
  }

  private async currentOutcomeFrom(
    database: any,
    mealLogId: string,
    userId?: string,
  ): Promise<MealRecognitionCoordinatorResult> {
    const predicates = [eq(mealLogs.id, mealLogId)];
    if (userId) predicates.push(eq(mealLogs.userId, userId));
    const [mealLog] = await database
      .select({
        recognitionStatus: mealLogs.recognitionStatus,
        recognitionLeaseExpiresAt: mealLogs.recognitionLeaseExpiresAt,
        recognitionLastErrorCode: mealLogs.recognitionLastErrorCode,
        recognitionNextAttemptAt: mealLogs.recognitionNextAttemptAt,
      })
      .from(mealLogs)
      .where(and(...predicates))
      .limit(1);
    return mealLog
      ? outcomeForState(mealLog, new Date())
      : unavailable('RECOGNITION_UNAVAILABLE', false);
  }
}

type ClaimedRecognition = { mealLogId: string; userId: string; leaseToken: string; imageAssetId: string; objectKey: string; byteSize: number; contentType: string; sha256: string; attemptCount: number };
function unavailable(code: string, retryable: boolean): MealRecognitionCoordinatorResult { return { status: 'unavailable', code, retryable }; }
function isImageContentType(value: string | undefined): value is 'image/jpeg' | 'image/png' | 'image/webp' { return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'; }
function retryAfter(expiry: Date, now: Date) { return Math.max(1, Math.ceil((expiry.getTime() - now.getTime()) / 1000)); }
function isEligible(mealLog: { recognitionStatus: string; recognitionNextAttemptAt: Date | null; recognitionLeaseExpiresAt: Date | null }, now: Date) { return mealLog.recognitionStatus === 'pending' || (mealLog.recognitionStatus === 'failed' && !!mealLog.recognitionNextAttemptAt && mealLog.recognitionNextAttemptAt <= now) || (mealLog.recognitionStatus === 'processing' && !!mealLog.recognitionLeaseExpiresAt && mealLog.recognitionLeaseExpiresAt <= now); }
function eligibleRecognitionWhere(now: Date) {
  return or(
    eq(mealLogs.recognitionStatus, 'pending'),
    and(
      eq(mealLogs.recognitionStatus, 'failed'),
      lte(mealLogs.recognitionNextAttemptAt, now),
    ),
    and(
      eq(mealLogs.recognitionStatus, 'processing'),
      lte(mealLogs.recognitionLeaseExpiresAt, now),
    ),
  );
}
function outcomeForState(mealLog: { recognitionStatus: string; recognitionLeaseExpiresAt?: Date | null; recognitionLastErrorCode?: string | null; recognitionNextAttemptAt?: Date | null }, now: Date): MealRecognitionCoordinatorResult { if (mealLog.recognitionStatus === 'ready') return { status: 'ready' }; if (mealLog.recognitionStatus === 'processing' && mealLog.recognitionLeaseExpiresAt && mealLog.recognitionLeaseExpiresAt > now) return { status: 'active', retryAfterSeconds: retryAfter(mealLog.recognitionLeaseExpiresAt, now) }; return unavailable(mealLog.recognitionLastErrorCode ?? 'RECOGNITION_UNAVAILABLE', !!mealLog.recognitionNextAttemptAt && mealLog.recognitionNextAttemptAt > now); }
function isRetryable(code: string) { return code === 'DEADLINE_EXCEEDED' || code === 'ASSET_NOT_FOUND' || code === 'ASSET_UNAVAILABLE' || code === 'PROVIDER_UNAVAILABLE'; }
function nextRetryAt(code: string, now: Date, retryable: boolean) {
  if (!retryable) return null;
  if (code === 'DAILY_QUOTA_EXCEEDED') {
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
      ),
    );
  }
  return new Date(now.getTime() + 60_000);
}
function recognitionErrorCode(error: unknown, timedOut: boolean) { if (timedOut || error instanceof ImageObjectReadAbortedError) return 'DEADLINE_EXCEEDED'; if (error instanceof ImageObjectNotFoundError) return 'ASSET_NOT_FOUND'; if (error instanceof ImageObjectTooLargeError) return 'ASSET_TOO_LARGE'; if (error instanceof ImageObjectStoreError) return 'ASSET_UNAVAILABLE'; if (error instanceof MealRecognitionFailure) return error.code; return 'PROVIDER_UNAVAILABLE'; }
class DailyQuotaExceededError extends Error {}
