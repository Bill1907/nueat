import { createHash, randomUUID } from 'node:crypto';

import {
  imageAssets,
  mealItems,
  mealLogs,
  recognitionDailyUsages,
  recognitionAttempts,
  recognitionExecutions,
  recognitionProviderInvocations,
  resolutionAttempts,
  storedObservations,
  type Database,
} from '@nueat/database';
import { MEAL_REVIEW_POLICY_VERSION } from '@nueat/domain';
import { and, eq, lte, or, sql } from 'drizzle-orm';

import {
  ImageObjectNotFoundError,
  ImageObjectReadAbortedError,
  ImageObjectStoreError,
  ImageObjectTooLargeError,
  type ImageObjectStore,
} from './image-object-store';
import {
  MEAL_RECOGNITION_V3_PROMPT_VERSION,
  MEAL_RECOGNITION_V3_SCHEMA_VERSION,
  MealRecognitionFailure,
  RecognitionResultV2,
  RecognitionResultV3,
  normalizeRecognitionLabel,
  parseRecognitionResultV3,
  toStoredRecognitionResultV2,
  toStoredRecognitionResultV3,
  type MealRecognizer,
  type RecognitionSafeFailureCode,
} from './meal-recognizer';
import { resolveRecognitionCandidates } from './meal-item-resolution';
import {
  MealResolutionCoordinator,
  type ResolutionExecutionContext,
  type VerifiedCatalogAutoSelectionPolicy,
} from './meal-resolution-coordinator';

export type MealRecognitionCoordinatorResult =
  | { status: 'ready'; responseDeadlineAt?: Date }
  | { status: 'active'; retryAfterSeconds: number; responseDeadlineAt?: Date }
  | { status: 'unavailable'; code: string; retryable: boolean; responseDeadlineAt?: Date };
export type MealRecognitionTrigger = 'initial' | 'user_recovery';
export type RecognitionAssetState = 'processing' | 'processed';
export type UsableRecognitionAsset = {
  id?: string;
  objectKey?: string;
  status: RecognitionAssetState;
  byteSize: number;
  contentType: string;
  sha256: string;
  purpose?: string | null;
  expiresAt: Date;
};
export function isUsableRecognitionAsset(
  trigger: MealRecognitionTrigger,
  asset: {
    status: string;
    purpose?: string | null;
    expiresAt?: Date | null;
    byteSize: number | null;
    contentType: string | null;
    sha256: string | null;
  } | undefined,
  now = new Date(),
): asset is UsableRecognitionAsset {
  return !!asset
    && (trigger === 'initial' ? asset.status === 'processing' : asset.status === 'processed')
    && (asset.purpose === undefined || asset.purpose === 'inference')
    && !!asset.expiresAt && asset.expiresAt > now
    && asset.byteSize !== null && asset.byteSize > 0
    && isImageContentType(asset.contentType ?? undefined)
    && !!asset.sha256;
}

export function recognitionTerminalTransition(
  trigger: MealRecognitionTrigger,
  status: 'succeeded' | 'failed',
) {
  return {
    workflowStatus: status === 'succeeded' ? 'ready' : 'failed',
    clearLease: true,
    consumeUserGrant: trigger === 'user_recovery',
  } as const;
}

export function reconciliationTransition() {
  return {
    invocationStatus: 'outcome_unknown' as const,
    invocationCode: 'PROCESS_OUTCOME_UNKNOWN' as const,
    executionStatus: 'abandoned' as const,
    executionCode: 'PROCESS_OUTCOME_UNKNOWN' as const,
    allowAutomaticSuccessor: false,
  };
}

export type ReconciliationInvocationReceipt = {
  status: 'reserved' | 'succeeded' | 'cancelled_before_call' | 'failed_known' | 'outcome_unknown';
  terminalCode: string | null;
} | undefined;

export function reconciliationReceiptTransition(receipt: ReconciliationInvocationReceipt) {
  if (!receipt) {
    return {
      invocation: 'none' as const,
      executionStatus: 'failed' as const,
      executionCode: 'EXECUTION_DEADLINE',
      publicCode: 'EXECUTION_DEADLINE',
    };
  }
  if (receipt.status === 'reserved') {
    return {
      invocation: 'outcome_unknown' as const,
      invocationCode: 'PROCESS_OUTCOME_UNKNOWN',
      executionStatus: 'abandoned' as const,
      executionCode: 'PROCESS_OUTCOME_UNKNOWN',
      publicCode: 'PROCESS_OUTCOME_UNKNOWN',
    };
  }
  if (receipt.status === 'succeeded') {
    return {
      invocation: 'retain' as const,
      executionStatus: 'failed' as const,
      executionCode: 'PERSISTENCE_UNAVAILABLE',
      publicCode: 'PERSISTENCE_UNAVAILABLE',
    };
  }
  return {
    invocation: 'retain' as const,
    executionStatus: 'failed' as const,
    executionCode: receipt.terminalCode ?? 'EXECUTION_DEADLINE',
    publicCode: receipt.terminalCode ?? 'EXECUTION_DEADLINE',
  };
}

export function reconciliationGrantTransition(
  trigger: MealRecognitionTrigger | 'automatic_lease_recovery',
  grantState: 'available' | 'reserved' | 'consumed',
  grantExecutionId: string | null,
  executionId: string,
) {
  return {
    consumeGrant: trigger === 'user_recovery'
      && grantState === 'reserved'
      && grantExecutionId === executionId,
  } as const;
}

export function failureTransition(
  trigger: MealRecognitionTrigger,
  executionReserved: boolean,
) {
  return {
    clearMealLease: true,
    clearWorkflowLease: true,
    consumeUserGrant: trigger === 'user_recovery' && executionReserved,
    terminalizeExecution: executionReserved,
  } as const;
}
export interface MealRecognitionRunner {
  enqueueInitial?(mealLogId: string, userId: string): Promise<boolean>;
  recognize(
    mealLogId: string,
    userId: string,
    trigger?: MealRecognitionTrigger,
    signal?: AbortSignal,
  ): Promise<MealRecognitionCoordinatorResult>;
  reconcile(mealLogId: string, userId: string, signal?: AbortSignal): Promise<MealRecognitionCoordinatorResult>;
  responseLost?(mealLogId: string, userId: string): Promise<void>;
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
  finalizationReserveMs?: number;
  providerCallMaxMs?: number;
  providerCallMinMs?: number;
  dbLockCapMs?: number;
  dbStatementCapMs?: number;
  leaseMarginMs?: number;
  providerIdentity?: {
    provider: 'mock' | 'openai';
    model: string;
    promptVersion: string;
    schemaVersion: string;
  };
  eventSink?: (event: RecognitionExecutionEvent) => void;
  autoSelectionPolicy?: VerifiedCatalogAutoSelectionPolicy | null;
}

export type RecognitionExecutionEvent =
  | { type: 'execution_started' | 'invocation_reserved' | 'sdk_started' | 'provider_acknowledged'; executionId: string }
  | { type: 'phase'; executionId: string; phase: RecognitionPhase }
  | { type: 'terminal'; executionId: string; code: RecognitionSafeFailureCode | 'SUCCEEDED' | 'ABANDONED' }
  | { type: 'response_lost' | 'reconciled'; workflowId: string };
export type RecognitionAbortReason = 'caller_disconnect' | 'execution_deadline' | 'provider_cap';

export class MealRecognitionCoordinator implements MealRecognitionRunner {
  constructor(private readonly options: MealRecognitionCoordinatorOptions) {}

  private event(event: RecognitionExecutionEvent) {
    this.options.eventSink?.(event);
  }

  async enqueueInitial(mealLogId: string, userId: string): Promise<boolean> {
    const now = new Date();
    const workflowId = randomUUID();
    const executionId = randomUUID();
    return this.options.database.transaction(async (tx) => {
      const [mealLog] = await tx.select({
        id: mealLogs.id,
        imageAssetId: mealLogs.imageAssetId,
        recognitionStatus: mealLogs.recognitionStatus,
      }).from(mealLogs).where(and(
        eq(mealLogs.id, mealLogId),
        eq(mealLogs.userId, userId),
        eq(mealLogs.status, 'draft'),
      )).limit(1);
      if (
        !mealLog?.imageAssetId ||
        mealLog.recognitionStatus !== 'pending'
      ) return false;

      const [createdWorkflow] = await tx.insert(recognitionAttempts).values({
        id: workflowId,
        mealLogId,
        imageAssetId: mealLog.imageAssetId,
        status: 'pending',
        protocolVersion: 'v2_option_b',
        nextExecutionOrdinal: 2,
        automaticExecutionCount: 1,
        automaticInvocationReservationCount: 0,
        userGrantState: 'available',
        attemptCount: 0,
        nextAttemptAt: now,
        updatedAt: now,
      }).onConflictDoNothing({
        target: recognitionAttempts.mealLogId,
      }).returning({ id: recognitionAttempts.id });
      if (!createdWorkflow) {
        const [existingWorkflow] = await tx.select({
          protocolVersion: recognitionAttempts.protocolVersion,
        }).from(recognitionAttempts).where(
          eq(recognitionAttempts.mealLogId, mealLogId),
        ).limit(1);
        return existingWorkflow?.protocolVersion === 'v2_option_b';
      }

      await tx.insert(recognitionExecutions).values({
        id: executionId,
        workflowId,
        executionOrdinal: 1,
        trigger: 'initial',
        wallDeadlineAt: new Date(now.getTime() + this.options.timeoutMs),
        leaseToken: null,
        phase: 'claim',
        status: 'queued',
      });
      return true;
    });
  }

  private async setPhase(claim: ClaimedRecognition, phase: RecognitionPhase): Promise<boolean> {
    if (!claim.executionId) return false;
    const executionId = claim.executionId;
    let updated;
    try {
      [updated] = await this.options.database.transaction(async (tx) => {
        await applyTransactionTimeouts(tx, this.options, remainingMs(claim.deadline));
        return tx.update(recognitionExecutions).set({
          phase,
          updatedAt: new Date(),
        }).where(and(
          eq(recognitionExecutions.id, executionId),
          eq(recognitionExecutions.status, 'open'),
          eq(recognitionExecutions.leaseToken, claim.leaseToken),
        )).returning({ id: recognitionExecutions.id });
      });
    } catch (error) {
      throw new PhasePersistenceError(error);
    }
    if (updated) this.event({ type: 'phase', executionId, phase });
    return !!updated;
  }

  async recognize(
    mealLogId: string,
    userId: string,
    trigger: MealRecognitionTrigger = 'initial',
    callerSignal?: AbortSignal,
  ): Promise<MealRecognitionCoordinatorResult> {
    const deadline = executionDeadline(performance.now(), this.options.timeoutMs);
    let outcome: MealRecognitionCoordinatorResult;
    try {
      outcome = await this.recognizeWithinDeadline(mealLogId, userId, trigger, callerSignal, deadline);
    } catch (error) {
      outcome = unavailable(
        callerSignal?.aborted
          ? 'EXECUTION_CANCELLED'
          : error instanceof DeadlineExceededError ? 'EXECUTION_DEADLINE' : recognitionErrorCode(error, 'claim', false),
        false,
      );
    }
    return withResponseDeadline(
      outcome,
      deadline,
    );
  }

  private async recognizeWithinDeadline(
    mealLogId: string,
    userId: string,
    trigger: MealRecognitionTrigger,
    callerSignal: AbortSignal | undefined,
    deadline: ExecutionDeadline,
  ): Promise<MealRecognitionCoordinatorResult> {
    if (callerSignal?.aborted) return unavailable('EXECUTION_CANCELLED', false);
    const [storedObservation] = await awaitWithinDeadline(
      this.options.database.transaction(async (tx) => {
        await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
        return tx.select({ id: storedObservations.id })
          .from(storedObservations)
          .where(eq(storedObservations.mealLogId, mealLogId))
          .limit(1);
      }),
      deadline,
      callerSignal,
    );
    if (storedObservation) return this.resolvePendingObservation(mealLogId, userId, deadline, callerSignal);
    const reconciled = await this.reconcileWithinDeadline(mealLogId, userId, callerSignal, deadline);
    if (reconciled.status === 'unavailable' && reconciled.code === 'PROCESS_OUTCOME_UNKNOWN') {
      return reconciled;
    }
    let claimed;
    try {
      claimed = await this.claim(mealLogId, userId, trigger, deadline);
    } catch (error) {
      const code = recognitionErrorCode(error, 'claim', false);
      if (!(await this.durableClaimFailure(mealLogId, userId, code, deadline)))
        throw new MealRecognitionCoordinatorUnavailableError(code);
      return unavailable(code, false);
    }
    if (claimed.kind === 'active') return { status: 'active', retryAfterSeconds: claimed.retryAfterSeconds };
    if (claimed.kind === 'unavailable') return claimed.outcome;
    this.event({ type: 'execution_started', executionId: claimed.executionId! });

    const execution = executionSignal(callerSignal, remainingMs(deadline));
    let phase: RecognitionPhase = 'asset_read';
    let invocation: ReservedInvocation | undefined;
    try {
      if (execution.signal.aborted) return this.fail(claimed, abortCode(execution.reason()));
      const object = await awaitWithinDeadline(this.options.objectStore.readObject({
        objectKey: claimed.objectKey,
        maxBytes: this.options.maxBytes,
        signal: execution.signal,
      }), deadline, execution.signal);
      phase = 'asset_verify';
      if (!(await this.setPhase(claimed, phase))) return this.currentOutcome(claimed.mealLogId, claimed.userId);
      if (!isImageContentType(object.contentType)) return this.fail(claimed, 'ASSET_TYPE_INVALID');
      if (
        object.byteSize !== claimed.byteSize ||
        object.contentType !== claimed.contentType ||
        createHash('sha256').update(object.bytes).digest('hex') !== claimed.sha256
      ) return this.fail(claimed, 'ASSET_MISMATCH');

      // The object read is deliberately outside the lease transaction. Revalidate immediately
      // before the paid request so a manual/delete/reclaim winner cannot trigger a provider call.
      phase = 'invocation_reserve';
      if (!(await this.setPhase(claimed, phase))) return this.currentOutcome(claimed.mealLogId, claimed.userId);
      if (!(await this.renew(claimed))) return this.currentOutcome(claimed.mealLogId, claimed.userId);
      if (!hasProviderWindow(deadline, this.options)) {
        return this.fail(claimed, 'EXECUTION_DEADLINE');
      }
      invocation = await this.reserveInvocation(claimed);
      claimed = { ...claimed, executionId: invocation.executionId };
      this.event({ type: 'invocation_reserved', executionId: invocation.executionId });
      if (execution.signal.aborted) {
        const code = abortCode(execution.reason());
        await this.cancelInvocationBeforeCall(invocation, code, claimed.deadline);
        return this.fail(claimed, code, invocation);
      }

      phase = 'provider_call';
      if (!(await this.setPhase(claimed, phase))) return this.currentOutcome(claimed.mealLogId, claimed.userId);
      this.event({ type: 'sdk_started', executionId: invocation.executionId });
      const provider = providerSignal(
        execution.signal,
        Math.min(providerCallMaxMs(this.options), remainingMs(deadline) - finalizationReserveMs(this.options)),
      );
      let output;
      try {
        output = await awaitWithinDeadline(this.options.recognizer.recognize({
          imageBytes: object.bytes,
          imageContentType: object.contentType,
          signal: provider.signal,
        }), deadline, execution.signal);
      } catch (error) {
        if (provider.reason() === 'provider_cap') throw new ProviderCapError();
        throw error;
      } finally {
        provider.dispose();
      }
      if (!matchesReservedRecognizerIdentity(output, recognizerIdentity(this.options))) {
        throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE', 'provider_output');
      }
      phase = 'provider_output';
      if (!(await this.setPhase(claimed, phase))) return this.currentOutcome(claimed.mealLogId, claimed.userId);
      const parsedV3 = RecognitionResultV3.safeParse(output.result);
      if (!parsedV3.success) return this.fail(claimed, 'INVALID_PROVIDER_RESPONSE', invocation);
      phase = 'observation_persist';
      if (!(await this.setPhase(claimed, phase))) return this.currentOutcome(claimed.mealLogId, claimed.userId);
      await this.succeedInvocation(invocation, claimed.deadline);
      this.event({ type: 'provider_acknowledged', executionId: invocation.executionId });
      // Valid V3 output ends external work. Its finalization budget is
      // independent of the just-finished provider cap.
      const finalizationDeadline = deadline;
      if (remainingMs(finalizationDeadline) === 0) {
        return this.fail(claimed, 'PERSISTENCE_UNAVAILABLE', invocation);
      }
      const persisted = await this.persistV3Observation(
        claimed,
        invocation.id,
        output,
        parsedV3.data,
        finalizationDeadline,
      );
      if (persisted.status !== 'ready') return persisted;
      this.event({ type: 'terminal', executionId: invocation.executionId, code: 'SUCCEEDED' });
      try {
        await this.resolvePendingObservation(
          mealLogId,
          userId,
          deadline,
          execution.signal,
        );
      } catch {
        // The immutable observation is already committed. Catalog resolution
        // has its own durable retry state and cannot rewrite recognition.
      }
      return { status: 'ready' };
    } catch (error) {
      const code = execution.signal.aborted
        ? abortCode(execution.reason())
        : recognitionErrorCode(error, phase, false);
      return this.fail(claimed, code, invocation);
    } finally {
      execution.dispose();
    }
  }

  private async durableClaimFailure(
    mealLogId: string,
    userId: string,
    code: string,
    deadline: ExecutionDeadline,
  ): Promise<boolean> {
    try {
      const [updated] = await this.options.database.transaction(async (tx) => {
        await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
        return tx.update(mealLogs).set({
          recognitionStatus: 'failed', recognitionLeaseToken: null, recognitionLeaseExpiresAt: null,
          recognitionLastErrorCode: code, recognitionNextAttemptAt: null, updatedAt: new Date(),
        }).where(and(
          eq(mealLogs.id, mealLogId),
          eq(mealLogs.userId, userId),
          eq(mealLogs.status, 'draft'),
          or(eq(mealLogs.recognitionStatus, 'pending'), eq(mealLogs.recognitionStatus, 'processing')),
        )).returning({ id: mealLogs.id });
      });
      return !!updated;
    } catch {
      return false;
    }
  }

  async reconcile(
    mealLogId: string,
    userId: string,
    callerSignal?: AbortSignal,
  ): Promise<MealRecognitionCoordinatorResult> {
    const deadline = executionDeadline(performance.now(), this.options.timeoutMs);
    return withResponseDeadline(
      await this.reconcileWithinDeadline(mealLogId, userId, callerSignal, deadline),
      deadline,
    );
  }

  private async reconcileWithinDeadline(
    mealLogId: string,
    userId: string,
    callerSignal: AbortSignal | undefined,
    deadline: ExecutionDeadline,
  ): Promise<MealRecognitionCoordinatorResult> {
    if (callerSignal?.aborted) return unavailable('EXECUTION_CANCELLED', false);
    const now = new Date();
    const committedEvents: RecognitionExecutionEvent[] = [];
    const result = await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
      const [workflow] = await tx.select({
        id: recognitionAttempts.id,
        imageAssetId: recognitionAttempts.imageAssetId,
        protocolVersion: recognitionAttempts.protocolVersion,
        userGrantState: recognitionAttempts.userGrantState,
        userGrantExecutionId: recognitionAttempts.userGrantExecutionId,
      }).from(recognitionAttempts).where(eq(recognitionAttempts.mealLogId, mealLogId)).limit(1);
      if (!workflow || workflow.protocolVersion !== 'v2_option_b') {
        return this.currentOutcomeFrom(tx, mealLogId, userId);
      }
      const [meal] = await tx.select({
        recognitionStatus: mealLogs.recognitionStatus,
        recognitionLeaseToken: mealLogs.recognitionLeaseToken,
        recognitionLeaseExpiresAt: mealLogs.recognitionLeaseExpiresAt,
      }).from(mealLogs).where(and(eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId))).limit(1);
      const expired = await tx.select({
        id: recognitionExecutions.id,
        trigger: recognitionExecutions.trigger,
        leaseToken: recognitionExecutions.leaseToken,
      })
        .from(recognitionExecutions)
        .where(and(eq(recognitionExecutions.workflowId, workflow.id), eq(recognitionExecutions.status, 'open'), lte(recognitionExecutions.wallDeadlineAt, now)));
      const transition = reconciliationTransition();
      for (const execution of expired) {
        if (!execution.leaseToken) continue;
        const [invocation] = await tx.select({
          status: recognitionProviderInvocations.status,
          terminalCode: recognitionProviderInvocations.terminalCode,
        }).from(recognitionProviderInvocations).where(
          eq(recognitionProviderInvocations.executionId, execution.id),
        ).limit(1);
        const receiptTransition = reconciliationReceiptTransition(invocation);
        const [winner] = await tx.update(recognitionExecutions).set({
          status: receiptTransition.executionStatus,
          terminalCode: receiptTransition.executionCode as any,
          completedAt: now, updatedAt: now,
        }).where(and(
          eq(recognitionExecutions.id, execution.id),
          eq(recognitionExecutions.status, 'open'),
          eq(recognitionExecutions.leaseToken, execution.leaseToken),
        )).returning({ id: recognitionExecutions.id });
        if (!winner) continue;
        if (receiptTransition.invocation === 'outcome_unknown') {
          await tx.update(recognitionProviderInvocations).set({
            status: transition.invocationStatus, terminalCode: transition.invocationCode as any,
            completedAt: now, updatedAt: now,
          }).where(and(eq(recognitionProviderInvocations.executionId, execution.id), eq(recognitionProviderInvocations.status, 'reserved')));
        }
        const { consumeGrant } = reconciliationGrantTransition(
          execution.trigger,
          workflow.userGrantState,
          workflow.userGrantExecutionId,
          execution.id,
        );
        await tx.update(recognitionAttempts).set({
          status: 'failed', leaseToken: null, leaseExpiresAt: null,
          ...(consumeGrant ? { userGrantState: 'consumed' } : {}),
          lastErrorCode: receiptTransition.executionCode, nextAttemptAt: now, updatedAt: now,
        }).where(and(
          eq(recognitionAttempts.id, workflow.id),
          eq(recognitionAttempts.leaseToken, execution.leaseToken),
        ));
        const [mealFailure] = await tx.update(mealLogs).set({
          recognitionStatus: 'failed', recognitionLeaseToken: null, recognitionLeaseExpiresAt: null,
          recognitionLastErrorCode: receiptTransition.executionCode, recognitionNextAttemptAt: null, updatedAt: now,
        }).where(and(
          eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId),
          eq(mealLogs.recognitionStatus, 'processing'),
          eq(mealLogs.recognitionLeaseToken, execution.leaseToken),
        )).returning({ id: mealLogs.id });
        if (mealFailure) await tx.update(imageAssets).set({
          status: 'processed', processingCompletedAt: now,
        }).where(and(
          eq(imageAssets.id, workflow.imageAssetId),
          eq(imageAssets.status, 'processing'),
        ));
        committedEvents.push(
          { type: 'reconciled', workflowId: workflow.id },
          {
            type: 'terminal',
            executionId: execution.id,
            code: receiptTransition.executionStatus === 'abandoned'
              ? 'ABANDONED'
              : receiptTransition.executionCode as RecognitionSafeFailureCode,
          },
        );
        return unavailable(receiptTransition.publicCode, false);
      }
      if (meal?.recognitionStatus === 'processing'
        && meal.recognitionLeaseExpiresAt
        && meal.recognitionLeaseExpiresAt <= now) {
        const [crashed] = await tx.update(mealLogs).set({
          recognitionStatus: 'failed', recognitionLeaseToken: null, recognitionLeaseExpiresAt: null,
          recognitionLastErrorCode: 'PROCESS_OUTCOME_UNKNOWN', recognitionNextAttemptAt: null, updatedAt: now,
        }).where(and(
          eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId),
          eq(mealLogs.recognitionStatus, 'processing'),
          eq(mealLogs.recognitionLeaseToken, meal.recognitionLeaseToken!),
          lte(mealLogs.recognitionLeaseExpiresAt, now),
        )).returning({ id: mealLogs.id });
        if (crashed) {
          await tx.update(recognitionAttempts).set({
            status: 'failed', leaseToken: null, leaseExpiresAt: null,
            lastErrorCode: 'PROCESS_OUTCOME_UNKNOWN', nextAttemptAt: now, updatedAt: now,
          }).where(and(
            eq(recognitionAttempts.id, workflow.id),
            eq(recognitionAttempts.leaseToken, meal.recognitionLeaseToken!),
          ));
          await tx.update(imageAssets).set({
            status: 'processed', processingCompletedAt: now,
          }).where(and(
            eq(imageAssets.id, workflow.imageAssetId),
            eq(imageAssets.status, 'processing'),
          ));
          committedEvents.push({ type: 'reconciled', workflowId: workflow.id });
          return unavailable('PROCESS_OUTCOME_UNKNOWN', false);
        }
      }
      return this.currentOutcomeFrom(tx, mealLogId, userId);
    });
    for (const event of committedEvents) this.event(event);
    return result;
  }

  async responseLost(mealLogId: string, userId: string): Promise<void> {
    const [workflow] = await this.options.database.select({ id: recognitionAttempts.id })
      .from(recognitionAttempts)
      .innerJoin(mealLogs, eq(mealLogs.id, recognitionAttempts.mealLogId))
      .where(and(eq(recognitionAttempts.mealLogId, mealLogId), eq(mealLogs.userId, userId)))
      .limit(1);
    if (workflow) this.event({ type: 'response_lost', workflowId: workflow.id });
  }

  private async claim(
    mealLogId: string,
    userId: string,
    trigger: MealRecognitionTrigger,
    deadline: ExecutionDeadline,
  ) {
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(deadline.wallDeadlineAt.getTime() + leaseMarginMs(this.options));
    try {
      return await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
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
      if (trigger === 'initial' && mealLog.recognitionStatus !== 'pending')
        return { kind: 'unavailable' as const, outcome: outcomeForState(mealLog, now) };
      if (trigger === 'user_recovery' && mealLog.recognitionStatus !== 'failed')
        return { kind: 'unavailable' as const, outcome: outcomeForState(mealLog, now) };
      if (trigger === 'initial' && mealLog.recognitionAttemptCount >= this.options.maxAttempts)
        return { kind: 'unavailable' as const, outcome: await this.denyPending(tx, mealLog, 'MAX_ATTEMPTS_EXCEEDED', false, now) };

      const [asset] = await tx.select({
        id: imageAssets.id,
        objectKey: imageAssets.objectKey,
        byteSize: imageAssets.byteSize,
        contentType: imageAssets.detectedContentType,
        sha256: imageAssets.sha256,
        status: imageAssets.status,
        purpose: imageAssets.purpose,
        expiresAt: imageAssets.expiresAt,
      }).from(imageAssets).where(and(
        eq(imageAssets.id, mealLog.imageAssetId),
        eq(imageAssets.userId, userId),
        trigger === 'initial'
          ? eq(imageAssets.status, 'processing')
          : eq(imageAssets.status, 'processed'),
      )).limit(1);
      if (!isUsableRecognitionAsset(trigger, asset, now))
        return { kind: 'unavailable' as const, outcome: await this.denyPending(tx, mealLog, 'ASSET_UNAVAILABLE', false, now) };
      if (trigger === 'user_recovery') {
        const [workflow] = await tx.select({
          id: recognitionAttempts.id,
          imageAssetId: recognitionAttempts.imageAssetId,
          userGrantState: recognitionAttempts.userGrantState,
        }).from(recognitionAttempts).where(eq(recognitionAttempts.mealLogId, mealLog.id)).limit(1);
        if (workflow && (workflow.imageAssetId !== asset.id || workflow.userGrantState !== 'available')) {
          return {
            kind: 'unavailable' as const,
            outcome: unavailable('USER_RECOVERY_UNAVAILABLE', false),
          };
        }
        if (this.options.dailyQuota > 0) {
          const [usage] = await tx.select({
            attemptCount: recognitionDailyUsages.attemptCount,
          }).from(recognitionDailyUsages).where(and(
            eq(recognitionDailyUsages.userId, userId),
            eq(recognitionDailyUsages.attemptDate, now.toISOString().slice(0, 10)),
          )).limit(1);
          if (usage && usage.attemptCount >= this.options.dailyQuota) {
            return {
              kind: 'unavailable' as const,
              outcome: unavailable('DAILY_QUOTA_RESERVED', false),
            };
          }
        }
      }
      const [updated] = await tx.update(mealLogs).set({
        recognitionStatus: 'processing', recognitionLeaseToken: leaseToken,
        recognitionLeaseExpiresAt: leaseExpiresAt,
        recognitionAttemptCount: mealLog.recognitionAttemptCount + 1,
        recognitionLastErrorCode: null, updatedAt: now,
      }).where(and(
        eq(mealLogs.id, mealLog.id),
        eq(mealLogs.userId, userId),
        eq(mealLogs.status, 'draft'),
        claimEligibilityWhere(trigger, now),
      )).returning({ id: mealLogs.id });
      if (!updated)
        return {
          kind: 'unavailable' as const,
          outcome: await this.currentOutcomeFrom(tx, mealLogId, userId),
        };

      const [existingWorkflow] = await tx.select({
        id: recognitionAttempts.id,
        imageAssetId: recognitionAttempts.imageAssetId,
        status: recognitionAttempts.status,
        protocolVersion: recognitionAttempts.protocolVersion,
        nextExecutionOrdinal: recognitionAttempts.nextExecutionOrdinal,
        automaticExecutionCount: recognitionAttempts.automaticExecutionCount,
        automaticInvocationReservationCount: recognitionAttempts.automaticInvocationReservationCount,
        userGrantState: recognitionAttempts.userGrantState,
      }).from(recognitionAttempts).where(eq(recognitionAttempts.mealLogId, mealLog.id)).limit(1);

      if (
        trigger === 'initial' &&
        existingWorkflow?.protocolVersion === 'v2_option_b' &&
        existingWorkflow.imageAssetId === asset.id
      ) {
        const [queuedExecution] = await tx.select({
          id: recognitionExecutions.id,
          executionOrdinal: recognitionExecutions.executionOrdinal,
          wallDeadlineAt: recognitionExecutions.wallDeadlineAt,
        }).from(recognitionExecutions).where(and(
          eq(recognitionExecutions.workflowId, existingWorkflow.id),
          eq(recognitionExecutions.trigger, 'initial'),
          eq(recognitionExecutions.status, 'queued'),
        )).limit(1);
        if (queuedExecution) {
          if (queuedExecution.wallDeadlineAt <= now) {
            await tx.update(recognitionExecutions).set({
              status: 'failed',
              terminalCode: 'EXECUTION_DEADLINE',
              completedAt: now,
              updatedAt: now,
            }).where(and(
              eq(recognitionExecutions.id, queuedExecution.id),
              eq(recognitionExecutions.status, 'queued'),
            ));
            await tx.update(recognitionAttempts).set({
              status: 'failed',
              lastErrorCode: 'EXECUTION_DEADLINE',
              completedAt: now,
              updatedAt: now,
            }).where(eq(recognitionAttempts.id, existingWorkflow.id));
            await tx.update(mealLogs).set({
              recognitionStatus: 'failed',
              recognitionLeaseToken: null,
              recognitionLeaseExpiresAt: null,
              recognitionLastErrorCode: 'EXECUTION_DEADLINE',
              recognitionNextAttemptAt: null,
              updatedAt: now,
            }).where(eq(mealLogs.id, mealLog.id));
            return {
              kind: 'unavailable' as const,
              outcome: unavailable('EXECUTION_DEADLINE', false),
            };
          }
          const queuedDeadline = executionDeadline(
            performance.now(),
            queuedExecution.wallDeadlineAt.getTime() - now.getTime(),
          );
          const queuedLeaseExpiresAt = new Date(
            queuedExecution.wallDeadlineAt.getTime() +
              leaseMarginMs(this.options),
          );
          const [claimedExecution] = await tx.update(recognitionExecutions).set({
            status: 'open',
            leaseToken,
            phase: 'asset_read',
            updatedAt: now,
          }).where(and(
            eq(recognitionExecutions.id, queuedExecution.id),
            eq(recognitionExecutions.status, 'queued'),
          )).returning({ id: recognitionExecutions.id });
          if (!claimedExecution) {
            return {
              kind: 'unavailable' as const,
              outcome: await this.currentOutcomeFrom(tx, mealLogId, userId),
            };
          }
          await tx.update(recognitionAttempts).set({
            status: 'processing',
            attemptCount: sql`${recognitionAttempts.attemptCount} + 1`,
            leaseToken,
            leaseExpiresAt: queuedLeaseExpiresAt,
            updatedAt: now,
          }).where(and(
            eq(recognitionAttempts.id, existingWorkflow.id),
            eq(recognitionAttempts.status, 'pending'),
          ));
          await tx.update(mealLogs).set({
            recognitionLeaseExpiresAt: queuedLeaseExpiresAt,
            updatedAt: now,
          }).where(and(
            eq(mealLogs.id, mealLog.id),
            eq(mealLogs.recognitionStatus, 'processing'),
            eq(mealLogs.recognitionLeaseToken, leaseToken),
          ));
          return {
            kind: 'claimed' as const,
            mealLogId: mealLog.id,
            userId,
            leaseToken,
            imageAssetId: asset.id,
            objectKey: asset.objectKey,
            byteSize: asset.byteSize,
            contentType: asset.contentType,
            sha256: asset.sha256,
            attemptCount: mealLog.recognitionAttemptCount + 1,
            workflowId: existingWorkflow.id,
            executionId: queuedExecution.id,
            trigger,
            executionOrdinal: queuedExecution.executionOrdinal,
            deadline: queuedDeadline,
            expiresAt: asset.expiresAt,
          };
        }
      }

      if (trigger === 'user_recovery' && existingWorkflow && (
        existingWorkflow.imageAssetId !== asset.id
        || existingWorkflow.userGrantState !== 'available'
      )) {
        return {
          kind: 'unavailable' as const,
          outcome: await this.denyPending(tx, mealLog, 'USER_RECOVERY_UNAVAILABLE', false, now, userId),
        };
      }
      if (trigger === 'user_recovery' && !existingWorkflow) {
        const conservativeCount = Math.max(0, mealLog.recognitionAttemptCount);
        const workflowId = randomUUID();
        const executionId = randomUUID();
        await tx.insert(recognitionAttempts).values({
          id: workflowId, mealLogId: mealLog.id, imageAssetId: asset.id,
          status: 'processing', protocolVersion: 'v2_option_b',
          nextExecutionOrdinal: conservativeCount + 2,
          automaticExecutionCount: conservativeCount,
          automaticInvocationReservationCount: conservativeCount,
          userGrantState: 'reserved', userGrantExecutionId: executionId,
          attemptCount: mealLog.recognitionAttemptCount + 1,
          leaseToken, leaseExpiresAt, nextAttemptAt: now, updatedAt: now,
        });
        await tx.insert(recognitionExecutions).values({
          id: executionId, workflowId, executionOrdinal: conservativeCount + 1,
          trigger: 'user_recovery', wallDeadlineAt: deadline.wallDeadlineAt,
          leaseToken, phase: 'asset_read', status: 'open',
        });
        return { kind: 'claimed' as const, mealLogId: mealLog.id, userId, leaseToken, imageAssetId: asset.id, objectKey: asset.objectKey, byteSize: asset.byteSize, contentType: asset.contentType, sha256: asset.sha256, attemptCount: mealLog.recognitionAttemptCount + 1, workflowId, executionId, trigger, executionOrdinal: conservativeCount + 1, deadline, expiresAt: asset.expiresAt };
      }
      const allocatedExecutionId = randomUUID();
      let legacyGrantReserved = false;
      let reservedExecutionOrdinal: number | undefined;
      if (trigger === 'user_recovery' && existingWorkflow?.protocolVersion === 'legacy_v1') {
        const conservativeCount = Math.max(
          mealLog.recognitionAttemptCount,
          existingWorkflow.automaticExecutionCount ?? 0,
          existingWorkflow.automaticInvocationReservationCount ?? 0,
        );
        reservedExecutionOrdinal = existingWorkflow.nextExecutionOrdinal;
        const [upgraded] = await tx.update(recognitionAttempts).set({
          protocolVersion: 'v2_option_b',
          nextExecutionOrdinal: reservedExecutionOrdinal + 1,
          automaticExecutionCount: conservativeCount,
          automaticInvocationReservationCount: conservativeCount,
          userGrantState: 'reserved',
          userGrantExecutionId: allocatedExecutionId,
          updatedAt: now,
        }).where(and(
          eq(recognitionAttempts.id, existingWorkflow.id),
          eq(recognitionAttempts.protocolVersion, 'legacy_v1'),
          eq(recognitionAttempts.userGrantState, 'available'),
        )).returning({ id: recognitionAttempts.id });
        if (!upgraded) return {
          kind: 'unavailable' as const,
          outcome: await this.currentOutcomeFrom(tx, mealLogId, userId),
        };
        existingWorkflow.nextExecutionOrdinal = reservedExecutionOrdinal + 1;
        legacyGrantReserved = true;
      }
      const workflowId = existingWorkflow?.imageAssetId === asset.id
        ? existingWorkflow.id
        : randomUUID();
      const executionOrdinal = reservedExecutionOrdinal ?? (existingWorkflow?.imageAssetId === asset.id
        ? existingWorkflow.nextExecutionOrdinal
        : 1);
      if (trigger === 'initial' && (!existingWorkflow || existingWorkflow.imageAssetId !== asset.id)) {
        await tx.insert(recognitionAttempts).values({
          id: workflowId, mealLogId: mealLog.id, imageAssetId: asset.id,
          status: 'processing', protocolVersion: 'v2_option_b', nextExecutionOrdinal: 2,
          automaticExecutionCount: 1, automaticInvocationReservationCount: 0,
          userGrantState: 'available', attemptCount: mealLog.recognitionAttemptCount + 1,
          leaseToken, leaseExpiresAt, nextAttemptAt: now, updatedAt: now,
        });
      } else if (trigger === 'initial') {
        await tx.update(recognitionAttempts).set({
          protocolVersion: 'v2_option_b',
          nextExecutionOrdinal: executionOrdinal + 1,
          automaticExecutionCount: (existingWorkflow!.automaticExecutionCount ?? 0) + 1,
          status: 'processing', leaseToken, leaseExpiresAt, updatedAt: now,
        }).where(eq(recognitionAttempts.id, workflowId));
      }
      const executionId = allocatedExecutionId;
      if (trigger === 'user_recovery' && !legacyGrantReserved) {
        const [grant] = await tx.update(recognitionAttempts).set({
          nextExecutionOrdinal: executionOrdinal + 1,
          userGrantState: 'reserved',
          userGrantExecutionId: executionId,
          status: 'processing', leaseToken, leaseExpiresAt, updatedAt: now,
        }).where(and(
          eq(recognitionAttempts.id, workflowId),
          eq(recognitionAttempts.userGrantState, 'available'),
          eq(recognitionAttempts.nextExecutionOrdinal, executionOrdinal),
        )).returning({ id: recognitionAttempts.id });
        if (!grant) return {
          kind: 'unavailable' as const,
          outcome: await this.currentOutcomeFrom(tx, mealLogId, userId),
        };
      }
      await tx.insert(recognitionExecutions).values({
        id: executionId, workflowId, executionOrdinal, trigger,
        wallDeadlineAt: deadline.wallDeadlineAt, leaseToken, phase: 'asset_read', status: 'open',
      });

      return { kind: 'claimed' as const, mealLogId: mealLog.id, userId, leaseToken, imageAssetId: asset.id, objectKey: asset.objectKey, byteSize: asset.byteSize, contentType: asset.contentType, sha256: asset.sha256, attemptCount: mealLog.recognitionAttemptCount + 1, workflowId, executionId, trigger, executionOrdinal, deadline, expiresAt: asset.expiresAt };
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
          false,
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

  /** The commit of this row is the authorization to start one SDK operation. */
  private async reserveInvocation(claim: ClaimedRecognition): Promise<ReservedInvocation> {
    const now = new Date();
    const invocationId = randomUUID();
    const executionId = claim.executionId ?? randomUUID();
    const usage = await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(claim.deadline));
      if (claim.expiresAt <= now) throw new AssetExpiredError();
      const [asset] = await tx.select({
        status: imageAssets.status,
        purpose: imageAssets.purpose,
        expiresAt: imageAssets.expiresAt,
        byteSize: imageAssets.byteSize,
        contentType: imageAssets.detectedContentType,
        sha256: imageAssets.sha256,
      }).from(imageAssets).where(and(
        eq(imageAssets.id, claim.imageAssetId),
        eq(imageAssets.userId, claim.userId),
      )).limit(1);
      if (!isUsableRecognitionAsset(claim.trigger, asset, now)) throw new AssetExpiredError();
      const attemptDate = now.toISOString().slice(0, 10);
      const usage = this.options.dailyQuota > 0 ? await tx.insert(recognitionDailyUsages).values({
        userId: claim.userId, attemptDate, attemptCount: 1, updatedAt: now,
      }).onConflictDoUpdate({
        target: [recognitionDailyUsages.userId, recognitionDailyUsages.attemptDate],
        set: { attemptCount: sql`${recognitionDailyUsages.attemptCount} + 1`, updatedAt: now },
        where: lte(recognitionDailyUsages.attemptCount, this.options.dailyQuota - 1),
      }).returning({ attemptCount: recognitionDailyUsages.attemptCount }) : [{ attemptCount: 0 }];
      if (!usage[0]) throw new DailyQuotaExceededError();

      const [workflow] = await tx.select({
        automaticInvocationReservationCount: recognitionAttempts.automaticInvocationReservationCount,
      }).from(recognitionAttempts).where(eq(recognitionAttempts.id, claim.workflowId)).limit(1);
      const ordinal = claim.trigger === 'user_recovery'
        ? claim.executionOrdinal
        : (workflow?.automaticInvocationReservationCount ?? 0) + 1;
      if (claim.trigger === 'initial') {
        await tx.update(recognitionAttempts).set({
          automaticInvocationReservationCount: ordinal, updatedAt: now,
        }).where(eq(recognitionAttempts.id, claim.workflowId));
      }
      await tx.insert(recognitionProviderInvocations).values({
        id: invocationId, workflowId: claim.workflowId, executionId,
        invocationOrdinal: 1, workflowInvocationOrdinal: ordinal, status: 'reserved',
        ...recognizerIdentity(this.options),
      });
      return usage;
    });
    if (!usage[0]) throw new DailyQuotaExceededError();
    return { id: invocationId, executionId };
  }


  /** Valid closed output makes the provider operation terminal before persistence starts. */
  private async succeedInvocation(invocation: ReservedInvocation, deadline: ExecutionDeadline) {
    const now = new Date();
    const [updated] = await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
      return tx.update(recognitionProviderInvocations).set({
      status: 'succeeded',
      providerAcknowledgedAt: now,
      completedAt: now,
      updatedAt: now,
      }).where(and(
      eq(recognitionProviderInvocations.id, invocation.id),
      eq(recognitionProviderInvocations.status, 'reserved'),
      )).returning({ id: recognitionProviderInvocations.id });
    });
    if (!updated) throw new PersistenceTerminalizationError();
  }

  private async cancelInvocationBeforeCall(
    invocation: ReservedInvocation,
    code: RecognitionSafeFailureCode,
    deadline: ExecutionDeadline,
  ) {
    const now = new Date();
    await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
      await tx.update(recognitionProviderInvocations).set({
        status: 'cancelled_before_call', terminalCode: code,
        completedAt: now, updatedAt: now,
      }).where(and(eq(recognitionProviderInvocations.id, invocation.id), eq(recognitionProviderInvocations.status, 'reserved')));
    });
  }

  private async renew(claim: ClaimedRecognition) {
    const now = new Date();
    const [updated] = await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(claim.deadline));
      return tx.update(mealLogs).set({
      recognitionLeaseExpiresAt: new Date(claim.deadline.wallDeadlineAt.getTime() + leaseMarginMs(this.options)),
      updatedAt: now,
      }).where(and(eq(mealLogs.id, claim.mealLogId), eq(mealLogs.userId, claim.userId), eq(mealLogs.status, 'draft'), eq(mealLogs.recognitionStatus, 'processing'), eq(mealLogs.recognitionLeaseToken, claim.leaseToken))).returning({ id: mealLogs.id });
    });
    return !!updated;
  }

  private async resolveFoods(
    recognizedFoods: Extract<RecognitionResultV2, { outcome: 'recognized' }>['foods'],
  ) {
    try {
      return await resolveRecognitionCandidates(
        this.options.database,
        recognizedFoods.map((food) => ({
          rawLabel: food.rawLabel,
          alternatives: food.alternatives,
        })),
      );
    } catch (error) {
      throw new CanonicalFoodCatalogError(error);
    }
  }

  private async resolvePendingObservation(
    mealLogId: string,
    userId: string,
    deadline: ExecutionDeadline,
    callerSignal?: AbortSignal,
  ): Promise<MealRecognitionCoordinatorResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(callerSignal?.reason ?? 'execution_deadline');
    const timer = setTimeout(() => controller.abort('execution_deadline'), remainingMs(deadline));
    callerSignal?.addEventListener('abort', abort, { once: true });
    const context: ResolutionExecutionContext = {
      signal: controller.signal,
      monotonicDeadline: deadline.monotonicDeadline,
      wallDeadlineAt: deadline.wallDeadlineAt,
      dbLockCapMs: this.options.dbLockCapMs ?? 50,
      dbStatementCapMs: this.options.dbStatementCapMs ?? 50,
      commitReserveMs: finalizationReserveMs(this.options),
    };
    const work = new MealResolutionCoordinator(
      this.options.database,
      Math.max(this.options.leaseMs, this.options.timeoutMs),
      this.options.maxAttempts,
      this.options.autoSelectionPolicy,
    ).resolve(mealLogId, userId, context);
    try {
      return await work;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    }
  }

  private async finalize(
    claim: ClaimedRecognition,
    invocationId: string,
    output: Awaited<ReturnType<MealRecognizer['recognize']>>,
    result: RecognitionResultV2,
    mappings: Array<{
      foodId: string;
      nutrientProfileId: string;
      canonicalNameKo: string;
      matchedLabel: string | null;
      mappingSource: 'model_primary' | 'model_alternative';
    } | null>,
  ): Promise<MealRecognitionCoordinatorResult> {
    const now = new Date();
    const storedResult = toStoredRecognitionResultV2(result);
    const completed = await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(claim.deadline));
      if (claim.executionId) {
        const [execution] = await tx.update(recognitionExecutions).set({
          status: 'succeeded', phase: 'resolution_handoff', completedAt: now, updatedAt: now,
        }).where(and(
          eq(recognitionExecutions.id, claim.executionId),
          eq(recognitionExecutions.status, 'open'),
          eq(recognitionExecutions.leaseToken, claim.leaseToken),
        )).returning({ id: recognitionExecutions.id });
        if (!execution) return false;
      }
      const [updated] = await tx.update(mealLogs).set({
        recognitionStatus: 'ready', recognitionProvider: output.provider, recognitionModel: output.model,
        recognitionPromptVersion: output.promptVersion, recognitionSchemaVersion: output.schemaVersion,
        recognitionResult: jsonbSql(storedResult), recognitionCompletedAt: now, recognitionProviderRequestId: output.providerRequestId ?? null,
        recognitionInputTokens: output.inputTokens, recognitionOutputTokens: output.outputTokens,
        recognitionLeaseToken: null, recognitionLeaseExpiresAt: null, recognitionNextAttemptAt: null, recognitionLastErrorCode: null, updatedAt: now,
      }).where(and(eq(mealLogs.id, claim.mealLogId), eq(mealLogs.userId, claim.userId), eq(mealLogs.status, 'draft'), eq(mealLogs.recognitionStatus, 'processing'), eq(mealLogs.recognitionLeaseToken, claim.leaseToken))).returning({ id: mealLogs.id });
      if (!updated) return false;
      if (result.outcome === 'recognized') {
        await tx.insert(mealItems).values(result.foods.map((food, index) => {
          const mapping = mappings[index] ?? null;
          return {
            mealLogId: claim.mealLogId,
            recognizedLabel: food.rawLabel,
            amountMilliunits: food.amountMilliunits,
            unit: food.unit,
            recognitionRegionIndex: food.regionIndex,
            recognitionConfidenceBps: food.foodConfidenceBps,
            portionConfidenceBps: food.portionConfidenceBps,
            foodId: mapping?.foodId ?? null,
            nutrientProfileId: mapping?.nutrientProfileId ?? null,
            mappingConfidenceBps: mapping ? 10_000 : null,
            gramsMg: null,
            userCorrected: false,
            origin: 'model_estimate' as const,
            initialEstimateAssessment: jsonbSql({
              rawLabel: food.rawLabel,
              normalizedLabel: normalizeRecognitionLabel(food.rawLabel),
              foodConfidenceBps: food.foodConfidenceBps,
              portionConfidenceBps: food.portionConfidenceBps,
              foodCandidateMarginBps: food.alternatives[0]
                ? food.foodConfidenceBps - food.alternatives[0].confidenceBps
                : null,
              questions: food.questions,
              alternatives: food.alternatives,
              initialMappingSource: mapping?.mappingSource ?? null,
              initialMatchedLabel: mapping?.matchedLabel ?? null,
              initialFoodId: mapping?.foodId ?? null,
              initialNutrientProfileId: mapping?.nutrientProfileId ?? null,
              recognitionProvider: output.provider,
              recognitionModel: output.model,
              recognitionPromptVersion: output.promptVersion,
              recognitionSchemaVersion: output.schemaVersion,
              policyVersion: MEAL_REVIEW_POLICY_VERSION,
            }),
            currentResolutionSource: mapping?.mappingSource ?? null,
            currentResolutionSelectedAt: mapping ? now : null,
            itemRevision: 1,
            foodRevision: 1,
            portionRevision: 1,
          };
        }));
      }
      await tx.update(recognitionAttempts).set({
        status: 'ready', provider: output.provider, model: output.model,
        promptVersion: output.promptVersion, schemaVersion: output.schemaVersion,
        providerRequestId: output.providerRequestId ?? null, inputTokens: output.inputTokens,
        outputTokens: output.outputTokens, completedAt: now,
        ...(claim.trigger === 'user_recovery' ? { userGrantState: 'consumed' } : {}),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      }).where(eq(recognitionAttempts.id, claim.workflowId));
      await tx.update(imageAssets).set({ status: 'processed', processingCompletedAt: now }).where(and(eq(imageAssets.id, claim.imageAssetId), eq(imageAssets.status, 'processing')));
      await tx.update(recognitionProviderInvocations).set({
        status: 'succeeded', providerAcknowledgedAt: now, completedAt: now, updatedAt: now,
      }).where(and(eq(recognitionProviderInvocations.id, invocationId), eq(recognitionProviderInvocations.status, 'reserved')));
      return true;
    });
    return completed ? { status: 'ready' } : this.currentOutcome(claim.mealLogId, claim.userId);
  }

  /**
   * Provider output is durable before any catalog work. Resolution deliberately starts from
   * this immutable observation; it never needs image bytes or another paid provider request.
   */
  private async persistV3Observation(
    claim: ClaimedRecognition,
    invocationId: string,
    output: Awaited<ReturnType<MealRecognizer['recognize']>>,
    result: RecognitionResultV3,
    finalizationDeadline: ExecutionDeadline,
  ): Promise<MealRecognitionCoordinatorResult> {
    const now = new Date();
    const storedResult = toStoredRecognitionResultV3(result);
    const contentSha256 = createHash('sha256').update(JSON.stringify(storedResult)).digest('hex');
    const completed = await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(finalizationDeadline));
      const [mealState] = await tx.select({
        status: mealLogs.status,
        recognitionStatus: mealLogs.recognitionStatus,
        recognitionLeaseToken: mealLogs.recognitionLeaseToken,
      }).from(mealLogs).where(and(
        eq(mealLogs.id, claim.mealLogId),
        eq(mealLogs.userId, claim.userId),
      )).limit(1);
      const activeClaim =
        mealState?.status === 'draft' &&
        mealState.recognitionStatus === 'processing' &&
        mealState.recognitionLeaseToken === claim.leaseToken;
      const manualWinner =
        mealState?.status === 'draft' &&
        mealState.recognitionStatus === 'manual';
      if (!activeClaim && !manualWinner) return false;
      if (claim.executionId) {
        const [execution] = await tx.update(recognitionExecutions).set({
          status: 'succeeded', phase: 'resolution_handoff', completedAt: now, updatedAt: now,
        }).where(and(
          eq(recognitionExecutions.id, claim.executionId),
          eq(recognitionExecutions.status, 'open'),
          eq(recognitionExecutions.leaseToken, claim.leaseToken),
        )).returning({ id: recognitionExecutions.id });
        if (!execution) return false;
      }
      if (manualWinner) {
        await tx.update(recognitionAttempts).set({
          status: 'ready',
          provider: output.provider,
          model: output.model,
          promptVersion: output.promptVersion,
          schemaVersion: output.schemaVersion,
          providerRequestId: output.providerRequestId ?? null,
          inputTokens: output.inputTokens,
          outputTokens: output.outputTokens,
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        }).where(eq(recognitionAttempts.id, claim.workflowId));
        await tx.insert(storedObservations).values({
          mealLogId: claim.mealLogId,
          recognitionAttemptId: claim.workflowId,
          provider: output.provider,
          model: output.model,
          promptVersion: output.promptVersion,
          schemaVersion: output.schemaVersion,
          providerRequestId: output.providerRequestId ?? null,
          inputTokens: output.inputTokens,
          outputTokens: output.outputTokens,
          canonicalContent: storedResult,
          contentSha256,
        }).onConflictDoNothing();
        await tx.update(recognitionProviderInvocations).set({
          status: 'succeeded',
          providerAcknowledgedAt: now,
          completedAt: now,
          updatedAt: now,
        }).where(and(
          eq(recognitionProviderInvocations.id, invocationId),
          eq(recognitionProviderInvocations.status, 'reserved'),
        ));
        return true;
      }
      const [updated] = await tx.update(mealLogs).set({
        recognitionStatus: 'ready', recognitionProvider: output.provider, recognitionModel: output.model,
        recognitionPromptVersion: output.promptVersion, recognitionSchemaVersion: output.schemaVersion,
        recognitionResult: storedResult, recognitionCompletedAt: now,
        recognitionProviderRequestId: output.providerRequestId ?? null,
        recognitionInputTokens: output.inputTokens, recognitionOutputTokens: output.outputTokens,
        recognitionLeaseToken: null, recognitionLeaseExpiresAt: null, recognitionNextAttemptAt: null,
        recognitionLastErrorCode: null, updatedAt: now,
      }).where(and(
        eq(mealLogs.id, claim.mealLogId), eq(mealLogs.userId, claim.userId),
        eq(mealLogs.status, 'draft'), eq(mealLogs.recognitionStatus, 'processing'),
        eq(mealLogs.recognitionLeaseToken, claim.leaseToken),
      )).returning({ id: mealLogs.id });
      if (!updated) return false;
      await tx.update(recognitionAttempts).set({
        status: 'ready', provider: output.provider, model: output.model,
        promptVersion: output.promptVersion, schemaVersion: output.schemaVersion,
        providerRequestId: output.providerRequestId ?? null, inputTokens: output.inputTokens,
        outputTokens: output.outputTokens, completedAt: now,
        ...(claim.trigger === 'user_recovery' ? { userGrantState: 'consumed' } : {}),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      }).where(eq(recognitionAttempts.id, claim.workflowId));
      const [observation] = await tx.insert(storedObservations).values({
        mealLogId: claim.mealLogId, recognitionAttemptId: claim.workflowId,
        provider: output.provider, model: output.model, promptVersion: output.promptVersion,
        schemaVersion: output.schemaVersion, providerRequestId: output.providerRequestId ?? null,
        inputTokens: output.inputTokens, outputTokens: output.outputTokens,
        canonicalContent: storedResult, contentSha256,
      }).returning({ id: storedObservations.id });
      await tx.insert(resolutionAttempts).values({
        storedObservationId: observation!.id, status: 'pending', nextAttemptAt: now, updatedAt: now,
      });
      await tx.update(recognitionProviderInvocations).set({
        status: 'succeeded', providerAcknowledgedAt: now, completedAt: now, updatedAt: now,
      }).where(and(eq(recognitionProviderInvocations.id, invocationId), eq(recognitionProviderInvocations.status, 'reserved')));
      return true;
    });
    return completed ? { status: 'ready' } : this.currentOutcome(claim.mealLogId, claim.userId);
  }

  private async fail(
    claim: ClaimedRecognition,
    code: string,
    invocation?: ReservedInvocation,
  ): Promise<MealRecognitionCoordinatorResult> {
    const now = new Date();
    const retryable = isRetryable(code);
    const transition = failureTransition(claim.trigger, !!claim.executionId);
    const nextAttemptAt = retryable && claim.attemptCount < this.options.maxAttempts ? new Date(now.getTime() + 60_000) : null;
    const updated = await this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(claim.deadline));
      const [meal] = await tx.update(mealLogs).set({ recognitionStatus: 'failed', recognitionLeaseToken: null, recognitionLeaseExpiresAt: null, recognitionLastErrorCode: code, recognitionNextAttemptAt: nextAttemptAt, updatedAt: now }).where(and(eq(mealLogs.id, claim.mealLogId), eq(mealLogs.status, 'draft'), eq(mealLogs.recognitionStatus, 'processing'), eq(mealLogs.recognitionLeaseToken, claim.leaseToken))).returning({ id: mealLogs.id });
      if (!meal) return false;
      if (invocation) {
        await tx.update(recognitionProviderInvocations).set({
          status: code === 'PROCESS_OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'failed_known',
          terminalCode: code as any,
          completedAt: now,
          updatedAt: now,
        }).where(and(
          eq(recognitionProviderInvocations.id, invocation.id),
          eq(recognitionProviderInvocations.status, 'reserved'),
        ));
      }
      await tx.update(recognitionAttempts).set({
        status: 'failed', lastErrorCode: code, leaseToken: null, leaseExpiresAt: null,
        nextAttemptAt: now,
        ...(transition.consumeUserGrant
          ? { userGrantState: 'consumed' }
          : {}),
        updatedAt: now,
      }).where(eq(recognitionAttempts.id, claim.workflowId));
      if (transition.terminalizeExecution && claim.executionId) await tx.update(recognitionExecutions).set({
        status: 'failed', terminalCode: code as any, completedAt: now, updatedAt: now,
      }).where(and(eq(recognitionExecutions.id, claim.executionId), eq(recognitionExecutions.status, 'open')));
      if (claim.trigger === 'initial') {
        await tx.update(imageAssets).set({
          status: 'processed',
          processingCompletedAt: now,
        }).where(and(
          eq(imageAssets.id, claim.imageAssetId),
          eq(imageAssets.status, 'processing'),
        ));
      }
      return true;
    });
    if (updated) {
      if (claim.executionId) this.event({ type: 'terminal', executionId: claim.executionId, code: code as RecognitionSafeFailureCode });
      return unavailable(code, retryable && nextAttemptAt !== null);
    }
    return this.currentOutcome(claim.mealLogId, claim.userId);
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

/**
 * Compatibility runner for the legacy_observe cohort. It intentionally does not
 * touch the v2 execution/invocation ledger and rejects recovery triggers.
 */
export class LegacyObserveMealRecognitionRunner implements MealRecognitionRunner {
  private readonly activeCorrelations = new Map<string, string>();

  constructor(private readonly options: MealRecognitionCoordinatorOptions) {}

  async recognize(
    mealLogId: string,
    userId: string,
    trigger: MealRecognitionTrigger = 'initial',
    callerSignal?: AbortSignal,
  ): Promise<MealRecognitionCoordinatorResult> {
    const deadline = executionDeadline(performance.now(), this.options.timeoutMs);
    let outcome: MealRecognitionCoordinatorResult;
    try {
      outcome = await this.recognizeWithinDeadline(mealLogId, userId, trigger, callerSignal, deadline);
    } catch (error) {
      outcome = unavailable(
        callerSignal?.aborted
          ? 'EXECUTION_CANCELLED'
          : error instanceof DeadlineExceededError ? 'EXECUTION_DEADLINE' : recognitionErrorCode(error, 'claim', false),
        false,
      );
    }
    return withResponseDeadline(
      outcome,
      deadline,
    );
  }

  private async recognizeWithinDeadline(
    mealLogId: string,
    userId: string,
    trigger: MealRecognitionTrigger,
    callerSignal: AbortSignal | undefined,
    deadline: ExecutionDeadline,
  ): Promise<MealRecognitionCoordinatorResult> {
    if (trigger !== 'initial') return unavailable('USER_RECOVERY_UNAVAILABLE', false);
    const execution = executionSignal(callerSignal, remainingMs(deadline));
    if (execution.signal.aborted) {
      execution.dispose();
      return unavailable(abortCode(execution.reason()), false);
    }
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(this.options.leaseMs, this.options.timeoutMs));
    let claimed;
    try {
      claimed = await this.options.database.transaction(async (tx) => {
        await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
        const [meal] = await tx.select({
          id: mealLogs.id, recognitionStatus: mealLogs.recognitionStatus,
          recognitionLeaseExpiresAt: mealLogs.recognitionLeaseExpiresAt,
          recognitionNextAttemptAt: mealLogs.recognitionNextAttemptAt,
          recognitionAttemptCount: mealLogs.recognitionAttemptCount, imageAssetId: mealLogs.imageAssetId,
        }).from(mealLogs).where(and(
          eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId), eq(mealLogs.status, 'draft'),
        )).limit(1);
        if (!meal || !meal.imageAssetId) return { kind: 'unavailable' as const, outcome: unavailable('RECOGNITION_UNAVAILABLE', false) };
        if (meal.recognitionStatus === 'processing' && meal.recognitionLeaseExpiresAt && meal.recognitionLeaseExpiresAt > now)
          return { kind: 'active' as const, retryAfterSeconds: retryAfter(meal.recognitionLeaseExpiresAt, now) };
        if (!isEligible(meal, now) || meal.recognitionAttemptCount >= this.options.maxAttempts)
          return { kind: 'unavailable' as const, outcome: unavailable('RECOGNITION_UNAVAILABLE', false) };
        const [asset] = await tx.select({
          id: imageAssets.id, objectKey: imageAssets.objectKey, byteSize: imageAssets.byteSize,
          contentType: imageAssets.detectedContentType, sha256: imageAssets.sha256,
        }).from(imageAssets).where(and(
          eq(imageAssets.id, meal.imageAssetId),
          eq(imageAssets.userId, userId),
          eq(imageAssets.status, 'processing'),
          eq(imageAssets.purpose, 'inference'),
        )).limit(1);
        if (!asset || !asset.byteSize || !asset.contentType || !asset.sha256 || !isImageContentType(asset.contentType))
          return { kind: 'unavailable' as const, outcome: unavailable('ASSET_UNAVAILABLE', false) };
        const usage = this.options.dailyQuota > 0 ? await tx.insert(recognitionDailyUsages).values({
          userId, attemptDate: now.toISOString().slice(0, 10), attemptCount: 1, updatedAt: now,
        }).onConflictDoUpdate({
          target: [recognitionDailyUsages.userId, recognitionDailyUsages.attemptDate],
          set: { attemptCount: sql`${recognitionDailyUsages.attemptCount} + 1`, updatedAt: now },
          where: lte(recognitionDailyUsages.attemptCount, this.options.dailyQuota - 1),
        }).returning({ attemptCount: recognitionDailyUsages.attemptCount }) : [{ attemptCount: 0 }];
        if (!usage[0]) return { kind: 'unavailable' as const, outcome: unavailable('DAILY_QUOTA_RESERVED', false) };
        const [updated] = await tx.update(mealLogs).set({
          recognitionStatus: 'processing', recognitionLeaseToken: leaseToken,
          recognitionLeaseExpiresAt: leaseExpiresAt, recognitionAttemptCount: meal.recognitionAttemptCount + 1,
          recognitionLastErrorCode: null, updatedAt: now,
        }).where(and(eq(mealLogs.id, meal.id), eligibleRecognitionWhere(now))).returning({ id: mealLogs.id });
        if (!updated) return { kind: 'unavailable' as const, outcome: unavailable('RECOGNITION_UNAVAILABLE', false) };
        return { kind: 'claimed' as const, mealId: meal.id, asset, attemptCount: meal.recognitionAttemptCount + 1 };
      });
    } catch (error) {
      execution.dispose();
      return unavailable(
        execution.signal.aborted ? abortCode(execution.reason()) : recognitionErrorCode(error, 'claim', false),
        false,
      );
    }
    if (claimed.kind !== 'claimed') {
      execution.dispose();
      return claimed.kind === 'active'
        ? { status: 'active', retryAfterSeconds: claimed.retryAfterSeconds }
        : claimed.outcome;
    }

    const executionId = randomUUID();
    const correlationKey = `${userId}:${mealLogId}`;
    this.activeCorrelations.set(correlationKey, executionId);
    this.event({ type: 'execution_started', executionId });
    let phase: RecognitionPhase = 'asset_read';
    try {
      this.event({ type: 'phase', executionId, phase });
      const object = await awaitWithinDeadline(this.options.objectStore.readObject({
        objectKey: claimed.asset.objectKey, maxBytes: this.options.maxBytes, signal: execution.signal,
      }), deadline, execution.signal);
      phase = 'asset_verify';
      this.event({ type: 'phase', executionId, phase });
      if (object.byteSize !== claimed.asset.byteSize
        || object.contentType !== claimed.asset.contentType
        || createHash('sha256').update(object.bytes).digest('hex') !== claimed.asset.sha256
        || !isImageContentType(object.contentType)) throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
      phase = 'provider_call';
      this.event({ type: 'phase', executionId, phase });
      this.event({ type: 'sdk_started', executionId });
      const provider = providerSignal(
        execution.signal,
        Math.min(providerCallMaxMs(this.options), Math.max(0, remainingMs(deadline) - finalizationReserveMs(this.options))),
      );
      let output;
      try {
        output = await awaitWithinDeadline(this.options.recognizer.recognize({
          imageBytes: object.bytes, imageContentType: object.contentType, signal: provider.signal,
        }), deadline, execution.signal);
      } catch (error) {
        if (provider.reason() === 'provider_cap') throw new ProviderCapError();
        throw error;
      } finally {
        provider.dispose();
      }
      phase = 'provider_output';
      this.event({ type: 'provider_acknowledged', executionId });
      this.event({ type: 'phase', executionId, phase });
      const parsed = parseRecognitionResultV3(output.result);
      const completedAt = new Date();
      phase = 'observation_persist';
      this.event({ type: 'phase', executionId, phase });
      const completed = await this.options.database.transaction(async (tx) => {
        await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
        const [meal] = await tx.update(mealLogs).set({
          recognitionStatus: 'ready', recognitionProvider: output.provider, recognitionModel: output.model,
          recognitionPromptVersion: output.promptVersion, recognitionSchemaVersion: output.schemaVersion,
          recognitionResult: toStoredRecognitionResultV3(parsed), recognitionCompletedAt: completedAt,
          recognitionProviderRequestId: output.providerRequestId ?? null,
          recognitionInputTokens: output.inputTokens, recognitionOutputTokens: output.outputTokens,
          recognitionLeaseToken: null, recognitionLeaseExpiresAt: null, recognitionNextAttemptAt: null,
          recognitionLastErrorCode: null, updatedAt: completedAt,
        }).where(and(eq(mealLogs.id, claimed.mealId), eq(mealLogs.recognitionLeaseToken, leaseToken))).returning({ id: mealLogs.id });
        if (!meal) return false;
        const attemptId = randomUUID();
        await tx.insert(recognitionAttempts).values({
          id: attemptId, mealLogId: claimed.mealId, imageAssetId: claimed.asset.id, status: 'ready',
          provider: output.provider, model: output.model, promptVersion: output.promptVersion,
          schemaVersion: output.schemaVersion, providerRequestId: output.providerRequestId ?? null,
          inputTokens: output.inputTokens, outputTokens: output.outputTokens,
          attemptCount: claimed.attemptCount, nextAttemptAt: completedAt, completedAt, updatedAt: completedAt,
        });
        const stored = toStoredRecognitionResultV3(parsed);
        const observationId = randomUUID();
        await tx.insert(storedObservations).values({
          id: observationId, mealLogId: claimed.mealId, recognitionAttemptId: attemptId, provider: output.provider,
          model: output.model, promptVersion: output.promptVersion, schemaVersion: output.schemaVersion,
          providerRequestId: output.providerRequestId ?? null, inputTokens: output.inputTokens,
          outputTokens: output.outputTokens, canonicalContent: stored,
          contentSha256: createHash('sha256').update(JSON.stringify(stored)).digest('hex'),
        });
        await tx.insert(resolutionAttempts).values({
          storedObservationId: observationId, status: 'pending', nextAttemptAt: completedAt, updatedAt: completedAt,
        });
        await tx.update(imageAssets).set({
          status: 'processed', processingCompletedAt: completedAt,
        }).where(and(
          eq(imageAssets.id, claimed.asset.id),
          eq(imageAssets.status, 'processing'),
          eq(imageAssets.purpose, 'inference'),
        ));
        return true;
      });
      if (!completed) return unavailable('DRAFT_STATE_LOST', false);
      this.event({ type: 'terminal', executionId, code: 'SUCCEEDED' });
      return { status: 'ready' };
    } catch (error) {
      const code = execution.signal.aborted
        ? abortCode(execution.reason())
        : recognitionErrorCode(error, phase, false);
      const terminalized = await this.terminalizeFailure(claimed.mealId, claimed.asset.id, leaseToken, code, deadline);
      if (terminalized) this.event({ type: 'terminal', executionId, code: code as RecognitionSafeFailureCode });
      return unavailable(code, isRetryable(code));
    } finally {
      this.activeCorrelations.delete(correlationKey);
      execution.dispose();
    }
  }

  async reconcile(mealLogId: string, userId: string, callerSignal?: AbortSignal): Promise<MealRecognitionCoordinatorResult> {
    const deadline = executionDeadline(performance.now(), this.options.timeoutMs);
    return withResponseDeadline(
      await this.reconcileWithinDeadline(mealLogId, userId, callerSignal, deadline),
      deadline,
    );
  }

  private async reconcileWithinDeadline(
    mealLogId: string,
    userId: string,
    callerSignal?: AbortSignal,
    deadline?: ExecutionDeadline,
  ): Promise<MealRecognitionCoordinatorResult> {
    if (callerSignal?.aborted) return unavailable('EXECUTION_CANCELLED', false);
    const [meal] = await awaitWithinDeadline(this.options.database.transaction(async (tx) => {
      if (deadline) await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
      return tx.select({
      recognitionStatus: mealLogs.recognitionStatus,
      recognitionLeaseExpiresAt: mealLogs.recognitionLeaseExpiresAt,
      recognitionLastErrorCode: mealLogs.recognitionLastErrorCode,
      recognitionNextAttemptAt: mealLogs.recognitionNextAttemptAt,
      }).from(mealLogs).where(and(eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId))).limit(1);
    }), deadline ?? executionDeadline(performance.now(), this.options.timeoutMs), callerSignal);
    return meal ? outcomeForState(meal, new Date()) : unavailable('RECOGNITION_UNAVAILABLE', false);
  }

  async responseLost(mealLogId: string, userId: string): Promise<void> {
    const workflowId = this.activeCorrelations.get(`${userId}:${mealLogId}`);
    if (workflowId) this.event({ type: 'response_lost', workflowId });
  }

  private event(event: RecognitionExecutionEvent) {
    this.options.eventSink?.(event);
  }

  private async terminalizeFailure(
    mealLogId: string,
    assetId: string,
    leaseToken: string,
    code: string,
    deadline: ExecutionDeadline,
  ) {
    const now = new Date();
    return this.options.database.transaction(async (tx) => {
      await applyTransactionTimeouts(tx, this.options, remainingMs(deadline));
      const [updated] = await tx.update(mealLogs).set({
        recognitionStatus: 'failed', recognitionLeaseToken: null, recognitionLeaseExpiresAt: null,
        recognitionLastErrorCode: code, recognitionNextAttemptAt: null, updatedAt: now,
      }).where(and(
        eq(mealLogs.id, mealLogId),
        eq(mealLogs.recognitionLeaseToken, leaseToken),
      )).returning({ id: mealLogs.id });
      if (!updated) return false;
      await tx.update(imageAssets).set({
        status: 'processed',
        processingCompletedAt: now,
      }).where(and(
        eq(imageAssets.id, assetId),
        eq(imageAssets.status, 'processing'),
        eq(imageAssets.purpose, 'inference'),
      ));
      return true;
    });
  }
}

type ExecutionDeadline = { monotonicDeadline: number; wallDeadlineAt: Date };
function withResponseDeadline(
  result: MealRecognitionCoordinatorResult,
  deadline: ExecutionDeadline,
): MealRecognitionCoordinatorResult {
  Object.defineProperty(result, 'responseDeadlineAt', {
    value: deadline.wallDeadlineAt,
    enumerable: false,
  });
  return result;
}
type ClaimedRecognition = { mealLogId: string; userId: string; leaseToken: string; imageAssetId: string; objectKey: string; byteSize: number; contentType: string; sha256: string; expiresAt: Date; attemptCount: number; workflowId: string; executionId?: string | undefined; trigger: MealRecognitionTrigger; executionOrdinal: number; deadline: ExecutionDeadline };
type ReservedInvocation = { id: string; executionId: string };
type RecognitionPhase =
  | 'claim'
  | 'asset_read'
  | 'asset_verify'
  | 'invocation_reserve'
  | 'provider_call'
  | 'provider_output'
  | 'observation_persist'
  | 'resolution_handoff';
class CanonicalFoodCatalogError extends Error {
  constructor(readonly cause: unknown) {
    super('Canonical food catalog lookup failed');
    this.name = 'CanonicalFoodCatalogError';
  }
}
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
function claimEligibilityWhere(trigger: MealRecognitionTrigger, now: Date) {
  if (trigger === 'initial') return eq(mealLogs.recognitionStatus, 'pending');
  return or(
    eq(mealLogs.recognitionStatus, 'pending'),
    eq(mealLogs.recognitionStatus, 'failed'),
    and(eq(mealLogs.recognitionStatus, 'processing'), lte(mealLogs.recognitionLeaseExpiresAt, now)),
  );
}
function outcomeForState(mealLog: { recognitionStatus: string; recognitionLeaseExpiresAt?: Date | null; recognitionLastErrorCode?: string | null; recognitionNextAttemptAt?: Date | null }, now: Date): MealRecognitionCoordinatorResult { if (mealLog.recognitionStatus === 'ready') return { status: 'ready' }; if (mealLog.recognitionStatus === 'processing' && mealLog.recognitionLeaseExpiresAt && mealLog.recognitionLeaseExpiresAt > now) return { status: 'active', retryAfterSeconds: retryAfter(mealLog.recognitionLeaseExpiresAt, now) }; return unavailable(mealLog.recognitionLastErrorCode ?? 'RECOGNITION_UNAVAILABLE', !!mealLog.recognitionNextAttemptAt && mealLog.recognitionNextAttemptAt > now); }
/** Option B never replays an execution automatically; recovery is a separately granted execution. */
function isRetryable(_code: string) { return false; }
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
function recognitionErrorCode(
  error: unknown,
  phase: RecognitionPhase,
  timedOut: boolean,
) {
  if (error instanceof DeadlineExceededError) timedOut = true;
  if (error instanceof ProviderCapError) return 'PROVIDER_CALL_DEADLINE';
  if (error instanceof PhasePersistenceError) {
    return databaseTimeoutCode(error.cause) ?? 'DB_UNAVAILABLE';
  }
  if (error instanceof PersistenceTerminalizationError) return 'PERSISTENCE_UNAVAILABLE';
  if (error instanceof AssetExpiredError) return 'ASSET_EXPIRED';
  if (error instanceof DailyQuotaExceededError) return 'DAILY_QUOTA_RESERVED';
  if (phase === 'claim' || phase === 'invocation_reserve' || phase === 'observation_persist') {
    const databaseCode = databaseTimeoutCode(error);
    if (databaseCode) return databaseCode;
  }
  if (error instanceof MealRecognitionFailure && error.phase === 'provider_output') {
    return error.code;
  }
  if (phase === 'provider_call') {
    if (error instanceof MealRecognitionFailure) return error.code;
    return timedOut ? 'PROVIDER_CALL_DEADLINE' : 'PROVIDER_UNKNOWN';
  }
  if (phase === 'asset_read') {
    if (timedOut || error instanceof ImageObjectReadAbortedError) return 'ASSET_READ_TIMEOUT';
    if (error instanceof ImageObjectNotFoundError) return 'ASSET_NOT_FOUND';
    if (error instanceof ImageObjectTooLargeError) return 'ASSET_TOO_LARGE';
    if (error instanceof ImageObjectStoreError) return 'ASSET_UNAVAILABLE';
    return 'ASSET_UNAVAILABLE';
  }
  if (phase === 'asset_verify') return 'ASSET_MISMATCH';
  if (phase === 'invocation_reserve') return timedOut ? 'EXECUTION_DEADLINE' : 'DB_UNAVAILABLE';
  if (phase === 'provider_output') return 'INVALID_PROVIDER_RESPONSE';
  if (phase === 'observation_persist') return 'PERSISTENCE_UNAVAILABLE';
  if (phase === 'resolution_handoff') return 'COORDINATOR_INTERNAL';
  return 'COORDINATOR_INTERNAL';
}
class PhasePersistenceError extends Error {
  constructor(readonly cause: unknown) { super('Execution phase persistence failed'); }
}
class ProviderCapError extends Error {
  constructor() { super('Provider call cap elapsed'); }
}
class DeadlineExceededError extends Error {}
export class MealRecognitionCoordinatorUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`Meal recognition coordinator unavailable: ${code}`);
  }
}

function databaseTimeoutCode(error: unknown): 'DB_LOCK_TIMEOUT' | 'DB_STATEMENT_TIMEOUT' | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (code === '55P03') return 'DB_LOCK_TIMEOUT';
  if (code === '57014') return 'DB_STATEMENT_TIMEOUT';
  return undefined;
}
function jsonbSql(value: unknown) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Recognition result is not JSON serializable');
  return sql.raw(`'${json.replaceAll("'", "''")}'::jsonb`);
}
class DailyQuotaExceededError extends Error {}
class UserRecoveryGrantUnavailableError extends Error {}
class PersistenceTerminalizationError extends Error {}
class AssetExpiredError extends Error {}

function executionDeadline(startedAt: number, budgetMs: number): ExecutionDeadline {
  const budget = Math.max(1, budgetMs);
  return {
    monotonicDeadline: startedAt + budget,
    wallDeadlineAt: new Date(Date.now() + budget),
  };
}

function remainingMs(deadline: ExecutionDeadline): number {
  return Math.max(0, Math.floor(deadline.monotonicDeadline - performance.now()));
}

function awaitWithinDeadline<T>(
  operation: Promise<T>,
  deadline: ExecutionDeadline,
  callerSignal?: AbortSignal,
): Promise<T> {
  const remaining = remainingMs(deadline);
  if (remaining === 0) return Promise.reject(new DeadlineExceededError());
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new DeadlineExceededError()), remaining);
    const abort = () => reject(callerSignal?.reason ?? new DeadlineExceededError());
    callerSignal?.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abort);
    });
  });
}


function finalizationReserveMs(options: MealRecognitionCoordinatorOptions): number {
  return positiveBudget(options.finalizationReserveMs, Math.min(5_000, Math.floor(options.timeoutMs / 4)));
}

function providerCallMaxMs(options: MealRecognitionCoordinatorOptions): number {
  return positiveBudget(options.providerCallMaxMs, options.timeoutMs);
}

function providerCallMinMs(options: MealRecognitionCoordinatorOptions): number {
  return positiveBudget(options.providerCallMinMs, 1);
}

function leaseMarginMs(options: MealRecognitionCoordinatorOptions): number {
  return positiveBudget(options.leaseMarginMs, Math.max(0, options.leaseMs - options.timeoutMs));
}

function positiveBudget(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : Math.max(0, fallback);
}

function recognizerIdentity(options: MealRecognitionCoordinatorOptions) {
  return options.providerIdentity ?? {
    provider: 'openai' as const,
    model: 'gpt-5.4-mini-2026-03-17',
    promptVersion: MEAL_RECOGNITION_V3_PROMPT_VERSION,
    schemaVersion: MEAL_RECOGNITION_V3_SCHEMA_VERSION,
  };
}

function matchesReservedRecognizerIdentity(
  output: Awaited<ReturnType<MealRecognizer['recognize']>>,
  identity: ReturnType<typeof recognizerIdentity>,
) {
  return output.provider === identity.provider
    && output.model === identity.model
    && output.promptVersion === identity.promptVersion
    && output.schemaVersion === identity.schemaVersion;
}

function hasProviderWindow(deadline: ExecutionDeadline, options: MealRecognitionCoordinatorOptions): boolean {
  return remainingMs(deadline) >= providerCallMinMs(options) + finalizationReserveMs(options);
}

function providerSignal(parent: AbortSignal, capMs: number) {
  const controller = new AbortController();
  let reason: RecognitionAbortReason | undefined;
  const onAbort = () => {
    reason = sanitizeAbortReason(parent.reason) ?? 'execution_deadline';
    controller.abort(reason);
  };
  parent.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    reason = 'provider_cap';
    controller.abort(reason);
  }, Math.max(0, capMs));
  if (parent.aborted) onAbort();
  return {
    signal: controller.signal,
    reason: () => reason,
    dispose() {
      clearTimeout(timeout);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function executionSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let reason: RecognitionAbortReason | undefined;
  const abort = (next: RecognitionAbortReason) => {
    if (controller.signal.aborted) return;
    reason = next;
    controller.abort(next);
  };
  const onParentAbort = () => abort('caller_disconnect');
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  const timeout = setTimeout(() => abort('execution_deadline'), Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    reason: () => reason ?? sanitizeAbortReason(controller.signal.reason) ?? 'execution_deadline',
    dispose() {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}
function sanitizeAbortReason(value: unknown): RecognitionAbortReason | undefined {
  return value === 'caller_disconnect' || value === 'execution_deadline' || value === 'provider_cap'
    ? value
    : undefined;
}
function abortCode(reason: RecognitionAbortReason) {
  if (reason === 'caller_disconnect') return 'EXECUTION_CANCELLED';
  if (reason === 'provider_cap') return 'PROVIDER_CALL_DEADLINE';
  return 'EXECUTION_DEADLINE';
}

async function applyTransactionTimeouts(
  tx: unknown,
  options: MealRecognitionCoordinatorOptions,
  remaining: number,
) {
  const execute = (tx as { execute?: (query: unknown) => Promise<unknown> }).execute;
  if (!execute) return;
  const lock = Math.max(1, Math.min(positiveBudget(options.dbLockCapMs, remaining), remaining));
  const statement = Math.max(1, Math.min(positiveBudget(options.dbStatementCapMs, remaining), remaining));
  await execute.call(tx, sql.raw(`SET LOCAL lock_timeout = '${lock}ms'`));
  await execute.call(tx, sql.raw(`SET LOCAL statement_timeout = '${statement}ms'`));
}
