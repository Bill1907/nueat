import { createHash, randomUUID } from 'node:crypto';

import {
  activeCatalogReleasePointers,
  calculationPreviews,
  catalogReleaseFoodServings,
  catalogReleaseFoods,
  catalogReleaseNutrientProfiles,
  catalogReleases,
  catalogReleaseSearchDocuments,
  catalogReleaseSources,
  foodServings,
  foods,
  imageAssets,
  mappingDecisions,
  mealItems,
  mealLogs,
  nutrientProfiles,
  releaseActivations,
  recognitionAttempts,
  resolutionAttempts,
  sourceRegistries,
  sourceReleases,
  storedObservations,
  type Database,
  type CalculationPreviewIdentity,
} from '@nueat/database';
import { and, eq, lte, or, sql } from 'drizzle-orm';

import {
  CATALOG_LEXICAL_RESOLVER_VERSION,
  resolveCatalogLexicalRows,
} from './catalog-lexical-resolver';
import {
  selectTrustedNutrition,
  type CatalogEligibilityQueryAdapter,
  type TrustedNutritionSelectorInput,
  type TrustedNutritionSelection,
} from './catalog-eligibility-selector';
import {
  selectCatalogAutomatically,
  type CatalogAutoSelectionPolicy,
} from './catalog-auto-selection-policy';
import { normalizeFoodText } from '@nueat/database/catalog-normalization';

export type MealResolutionResult =
  | { status: 'ready' }
  | { status: 'active'; retryAfterSeconds: number }
  | { status: 'unavailable'; code: string; retryable: boolean };

export type VerifiedCatalogAutoSelectionPolicy = {
  policy: CatalogAutoSelectionPolicy;
  verifiedPolicyIdentitySha256: string;
};

export type ResolutionExecutionContext = {
  signal: AbortSignal;
  monotonicDeadline: number;
  wallDeadlineAt: Date;
  dbLockCapMs: number;
  dbStatementCapMs: number;
  commitReserveMs: number;
};

export type ResolutionCleanupContext = {
  signal: AbortSignal;
  timeoutMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
};

export function resolveAutomaticMappingSelection(input: {
  winner: { foodId: string; scoreBps: number; eligible: boolean };
  runnerUp: { foodId: string; scoreBps: number } | null;
  activation: { id: string; catalogReleaseId: string; identitySha256: string };
  verifiedPolicy: VerifiedCatalogAutoSelectionPolicy | null;
}) {
  return selectCatalogAutomatically({
    winner: input.winner,
    runnerUp: input.runnerUp,
    resolvedStack: {
      activationId: input.activation.id,
      catalogReleaseId: input.activation.catalogReleaseId,
      activationIdentitySha256: input.activation.identitySha256,
    },
    currentStack: {
      activationId: input.activation.id,
      catalogReleaseId: input.activation.catalogReleaseId,
      activationIdentitySha256: input.activation.identitySha256,
    },
    policy: input.verifiedPolicy?.policy ?? null,
    verifiedPolicyIdentitySha256: input.verifiedPolicy?.verifiedPolicyIdentitySha256 ?? null,
  });
}

/**
 * Resolution is intentionally independent of recognition. Its only input is the immutable
 * StoredObservation, so a catalog retry cannot read an image or call a recognition provider.
 */
export class MealResolutionCoordinator {
  constructor(
    private readonly database: Database,
    private readonly leaseMs: number,
    private readonly maxAttempts: number,
    private readonly autoSelectionPolicy: VerifiedCatalogAutoSelectionPolicy | null = null,
  ) {}

  async resolve(
    mealLogId: string,
    userId: string,
    context?: ResolutionExecutionContext,
  ): Promise<MealResolutionResult> {
    try {
      return await this.resolveWithinContext(mealLogId, userId, context);
    } catch (error) {
      if (error instanceof ResolutionDeadlineError) {
        return { status: 'unavailable', code: 'EXECUTION_DEADLINE', retryable: false };
      }
      throw error;
    }
  }

  private async resolveWithinContext(
    mealLogId: string,
    userId: string,
    context?: ResolutionExecutionContext,
  ): Promise<MealResolutionResult> {
    assertActive(context);
    const claim = await this.claim(mealLogId, userId, context);
    if (claim.kind !== 'claimed') return claim.outcome;
    try {
      assertActive(context);
      const { active, release, documents } = await this.loadCatalog(context);
      if (!active) throw new ResolutionUnavailableError('CATALOG_UNAVAILABLE');
      const content = claim.content as { outcome: string; observations: Array<any> };
      const roots = content.outcome === 'recognized'
        ? content.observations
          .filter((observation) => observation.parentRegionIndex === null)
          .sort((left, right) => left.localObservationId.localeCompare(right.localObservationId))
        : [];
      const eligibility = catalogEligibilityAdapter(this.database, context);
      const decisions: Array<{ localObservationId: string; selectedFoodId: string | null; nutrientProfileId: string | null; selection: TrustedNutritionSelection | null; status: 'selected' | 'review_required' | 'unresolved'; method: 'exact' | 'lexical'; reasonCode: string; candidates: unknown[]; evidence: unknown }> = [];
      for (const observation of roots) {
        assertActive(context);
        const lexical = resolveCatalogLexicalRows(active.catalogReleaseId, {
          labelKo: observation.rawLabel, category: observation.categoryHint ?? null,
          preparation: observation.preparationCodes ?? null,
        }, { catalogRelease: release ?? null, documents });
        if (lexical.kind === 'unavailable') {
          if (lexical.review.reasons.some((reason) =>
            reason === 'CATALOG_RELEASE_UNAVAILABLE' ||
            reason === 'NORMALIZER_VERSION_MISMATCH' ||
            reason === 'NO_SEARCH_DOCUMENTS',
          )) {
            throw new ResolutionUnavailableError('CATALOG_UNAVAILABLE');
          }
          decisions.push({ localObservationId: observation.localObservationId, selectedFoodId: null, nutrientProfileId: null, selection: null, status: 'unresolved', method: 'lexical', reasonCode: lexical.review.reasons.join(','), candidates: lexical.winner ? [lexical.winner] : [], evidence: lexical.review });
          continue;
        }
        const compact = normalizeFoodText(observation.rawLabel).compact;
        const exactFoodIds = new Set(documents
          .filter((document) => document.normalizedCompact === compact)
          .map((document) => document.foodId));
        const exact = exactFoodIds.size === 1 && exactFoodIds.has(lexical.winner.foodId);
        const candidateAssessment = await Promise.all(lexical.candidates.map(async (candidate) => {
          assertActive(context);
          const selection = await selectTrustedNutrition(eligibility, {
            catalogReleaseId: active.catalogReleaseId, foodId: candidate.foodId, unit: observation.unit,
          });
          assertActive(context);
          return selection.kind === 'selected'
            ? {
                ...candidate,
                availability: 'available' as const,
                foodId: selection.food.id,
                profileId: selection.profile.id,
                servingId: selection.serving?.id ?? null,
                provenance: selection.provenance,
              }
            : { ...candidate, availability: 'unavailable' as const, reason: selection.reason };
        }));
        const selected = await selectTrustedNutrition(eligibility, {
          catalogReleaseId: active.catalogReleaseId, foodId: lexical.winner.foodId, unit: observation.unit,
        });
        assertActive(context);
        if (selected.kind === 'unavailable') {
          // The lexical winner is never replaced with an eligible runner-up.
          decisions.push({ localObservationId: observation.localObservationId, selectedFoodId: null, nutrientProfileId: null, selection: null, status: 'unresolved', method: exact ? 'exact' : 'lexical', reasonCode: selected.reason, candidates: lexical.candidates, evidence: { ...lexical.review, marginBps: lexical.marginBps, candidateAssessment } });
          continue;
        }
        const automatic = resolveAutomaticMappingSelection({
          winner: {
            foodId: selected.food.id,
            scoreBps: lexical.winner.scoreBps,
            eligible: true,
          },
          runnerUp: lexical.runnerUp
            ? { foodId: lexical.runnerUp.foodId, scoreBps: lexical.runnerUp.scoreBps }
            : null,
          activation: {
            id: active.activationId,
            catalogReleaseId: active.catalogReleaseId,
            identitySha256: active.activationIdentitySha256,
          },
          verifiedPolicy: this.autoSelectionPolicy,
        });
        const automaticallySelected = automatic.kind === 'selected';
        decisions.push({
          localObservationId: observation.localObservationId,
          selectedFoodId: automaticallySelected ? selected.food.id : null,
          nutrientProfileId: automaticallySelected ? selected.profile.id : null,
          selection: automaticallySelected ? selected : null,
          status: automaticallySelected ? 'selected' : 'review_required',
          method: exact ? 'exact' : 'lexical',
          reasonCode: automaticallySelected
            ? 'AUTO_SELECTION_POLICY'
            : automatic.reason,
          candidates: lexical.candidates,
          evidence: {
            ...lexical.review,
            marginBps: lexical.marginBps,
            candidateAssessment,
            autoSelection: automatic,
          },
        });
      }
      const completed = await this.database.transaction(async (tx) => {
        await applyResolutionTimeouts(tx, context);
        assertActive(context);
        const [lease] = await tx.select({ id: resolutionAttempts.id }).from(resolutionAttempts).where(and(
          eq(resolutionAttempts.id, claim.attemptId),
          eq(resolutionAttempts.status, 'processing'),
          eq(resolutionAttempts.leaseToken, claim.leaseToken),
        )).for('update').limit(1);
        assertActive(context);
        if (!lease) return false;
        await applyResolutionTimeouts(tx, context);
        assertFinalizationReserve(context);
        const inserted = decisions.length === 0 ? [] : await tx.insert(mappingDecisions).values(decisions.map((decision) => ({
          storedObservationId: claim.observationId, localObservationId: decision.localObservationId,
          catalogReleaseId: active.catalogReleaseId, releaseActivationId: active.activationId,
          resolverVersion: CATALOG_LEXICAL_RESOLVER_VERSION,
          resolverSha256: hash(CATALOG_LEXICAL_RESOLVER_VERSION), policyVersion: active.policyVersion,
          policySha256: active.policySha256, candidates: decision.candidates, selectedFoodId: decision.selectedFoodId,
          status: decision.status, method: decision.method, reasonCode: decision.reasonCode,
          evidence: decision.evidence,
        }))).returning({ id: mappingDecisions.id, localObservationId: mappingDecisions.localObservationId, selectedFoodId: mappingDecisions.selectedFoodId, status: mappingDecisions.status });
        assertFinalizationReserve(context);
        // A preview exists only for an eligibility-backed candidate, before UI projection.
        for (const decision of inserted.filter((decision) => decision.selectedFoodId !== null)) {
          await applyResolutionTimeouts(tx, context);
          assertFinalizationReserve(context);
          const selected = decisions.find((candidate) => candidate.localObservationId === decision.localObservationId)?.selection;
          if (!selected) throw new Error('Selected decision missing trusted nutrition provenance');
          const root = roots.find((observation) => observation.localObservationId === decision.localObservationId);
          if (!root) throw new Error('Selected decision missing root observation');
          const identity: CalculationPreviewIdentity = {
            basis: 'finished_profile',
            rootMappingDecisionId: decision.id,
            rootRevision: 1,
            catalogReleaseId: active.catalogReleaseId,
            releaseActivationId: active.activationId,
            leaves: [{
              ordinal: 0,
              componentIdentity: decision.id,
              foodId: selected.food.id,
              edibleAmountMg: root.amountMilliunits,
              unit: root.unit,
              nutrientProfileId: selected.profile.id,
              sourceItemId: selected.profile.sourceItemId,
              profileQualityGrade: selected.profile.qualityGrade,
              servingId: selected.serving?.id ?? null,
              servingAmountMilliunits:
                selected.serving?.amountMilliunits ?? null,
              servingGramsMg: selected.serving?.gramsMg ?? null,
              servingSourceRegistryId:
                selected.serving?.sourceRegistryId ?? null,
              servingQualityGrade: selected.serving?.qualityGrade ?? null,
              sourceRegistryId: selected.profile.sourceRegistryId,
              sourceReleaseId: selected.provenance.sourceReleaseId,
              sourceReleaseVersion: selected.provenance.sourceReleaseVersion,
              catalogReleaseId: selected.provenance.catalogReleaseId,
              catalogManifestSha256: selected.provenance.catalogManifestSha256,
              nutrientProfile: {
                basisAmountMg: selected.profile.basisAmountMg,
                energyMillicalories: selected.profile.energyMillicalories,
                carbohydrateMg: selected.profile.carbohydrateMg,
                proteinMg: selected.profile.proteinMg,
                fatMg: selected.profile.fatMg,
                fiberMg: selected.profile.fiberMg,
              },
            }],
          };
          await tx.insert(calculationPreviews).values({
          mealLogId, rootMappingDecisionId: decision.id, rootRevision: 1,
          catalogReleaseId: active.catalogReleaseId, releaseActivationId: active.activationId,
          discriminant: 'finished_profile',
          identity,
          contentSha256: hash(`${claim.observationId}:${decision.id}:${active.catalogReleaseId}:${active.activationId}`),
        });
          assertFinalizationReserve(context);
        }
        const nutrientProfileByLocalId = new Map(
          decisions.map((decision) => [decision.localObservationId, decision.nutrientProfileId]),
        );
        const byLocalId = new Map(inserted.map((decision) => [decision.localObservationId, decision]));
        await applyResolutionTimeouts(tx, context);
        assertFinalizationReserve(context);
        if (roots.length > 0) await tx.insert(mealItems).values(roots.map((observation) => {
          const decision = byLocalId.get(observation.localObservationId);
          return {
            mealLogId, recognizedLabel: observation.rawLabel, amountMilliunits: observation.amountMilliunits,
            unit: observation.unit, recognitionRegionIndex: observation.regionIndex,
            recognitionConfidenceBps: observation.foodConfidenceBps, portionConfidenceBps: observation.portionConfidenceBps,
            foodId: decision?.selectedFoodId ?? null, nutrientProfileId: nutrientProfileByLocalId.get(observation.localObservationId) ?? null, mappingConfidenceBps: null,
            gramsMg: null, userCorrected: false, origin: 'model_estimate' as const,
            initialEstimateAssessment: { rawLabel: observation.rawLabel, normalizedLabel: observation.normalizedLabel, foodConfidenceBps: observation.foodConfidenceBps, portionConfidenceBps: observation.portionConfidenceBps, foodCandidateMarginBps: null, questions: [], alternatives: observation.alternatives, initialMappingSource: null, initialMatchedLabel: null, initialFoodId: decision?.selectedFoodId ?? null, initialNutrientProfileId: nutrientProfileByLocalId.get(observation.localObservationId) ?? null, recognitionProvider: claim.provider, recognitionModel: claim.model, recognitionPromptVersion: claim.promptVersion, recognitionSchemaVersion: claim.schemaVersion, policyVersion: active.policyVersion },
            currentResolutionSource: null, currentResolutionSelectedAt: null, itemRevision: 1, foodRevision: 1, portionRevision: 1,
          };
        }));
        assertFinalizationReserve(context);
        const completedAt = new Date();
        await applyResolutionTimeouts(tx, context);
        assertFinalizationReserve(context);
        const [finalized] = await tx.update(resolutionAttempts)
          .set({ status: 'resolved', leaseToken: null, leaseExpiresAt: null, lastErrorCode: null, resolvedAt: completedAt, updatedAt: completedAt })
          .where(and(
            eq(resolutionAttempts.id, claim.attemptId),
            eq(resolutionAttempts.status, 'processing'),
            eq(resolutionAttempts.leaseToken, claim.leaseToken),
          ))
          .returning({ id: resolutionAttempts.id });
        assertFinalizationReserve(context);
        if (!finalized) throw new ResolutionLeaseLostError();
        await applyResolutionTimeouts(tx, context);
        assertFinalizationReserve(context);
        await tx.update(imageAssets).set({ status: 'processed', processingCompletedAt: completedAt })
          .where(and(eq(imageAssets.id, claim.imageAssetId), eq(imageAssets.status, 'processing')));
        assertFinalizationReserve(context);
        await applyResolutionTimeouts(
          tx,
          context,
          remainingResolutionMs(context) - (context?.commitReserveMs ?? 0),
        );
        assertFinalizationReserve(context);
        return true;
      });
      return completed ? { status: 'ready' } : this.currentOutcome(mealLogId, userId, context);
    } catch (error) {
      if (error instanceof ResolutionLeaseLostError) return this.currentOutcome(mealLogId, userId, context);
      if (error instanceof ResolutionDeadlineError || context?.signal.aborted || remainingResolutionMs(context) <= 0) {
        await this.releaseAfterAbort(claim, context);
        return { status: 'unavailable', code: 'EXECUTION_DEADLINE', retryable: false };
      }
      return this.fail(claim, error instanceof ResolutionUnavailableError ? error.code : 'CATALOG_UNAVAILABLE', context);
    }
  }

  private async claim(mealLogId: string, userId: string, context?: ResolutionExecutionContext): Promise<any> {
    const now = new Date(); const leaseToken = randomUUID();
    const expires = new Date(Math.min(now.getTime() + this.leaseMs, context?.wallDeadlineAt.getTime() ?? Infinity));
    return this.database.transaction(async (tx) => {
      await applyResolutionTimeouts(tx, context);
      assertActive(context);
      const [observation] = await tx.select({ id: storedObservations.id, canonicalContent: storedObservations.canonicalContent, provider: storedObservations.provider, model: storedObservations.model, promptVersion: storedObservations.promptVersion, schemaVersion: storedObservations.schemaVersion, imageAssetId: recognitionAttempts.imageAssetId }).from(storedObservations)
        .innerJoin(recognitionAttempts, eq(storedObservations.recognitionAttemptId, recognitionAttempts.id))
        .innerJoin(mealLogs, eq(storedObservations.mealLogId, mealLogs.id))
        .where(and(eq(storedObservations.mealLogId, mealLogId), eq(mealLogs.userId, userId), eq(mealLogs.status, 'draft'))).for('update').limit(1);
      assertActive(context);
      if (!observation) return { kind: 'unavailable', outcome: { status: 'unavailable', code: 'RESOLUTION_UNAVAILABLE', retryable: false } };
      await applyResolutionTimeouts(tx, context);
      const [attempt] = await tx.select({ id: resolutionAttempts.id, status: resolutionAttempts.status, attemptCount: resolutionAttempts.attemptCount, nextAttemptAt: resolutionAttempts.nextAttemptAt, leaseExpiresAt: resolutionAttempts.leaseExpiresAt, lastErrorCode: resolutionAttempts.lastErrorCode }).from(resolutionAttempts).where(eq(resolutionAttempts.storedObservationId, observation.id)).for('update').limit(1);
      assertActive(context);
      if (!attempt) return { kind: 'unavailable', outcome: { status: 'unavailable', code: 'RESOLUTION_UNAVAILABLE', retryable: false } };
      if (attempt.status === 'resolved') return { kind: 'unavailable', outcome: { status: 'ready' } };
      if (attempt.status === 'processing' && attempt.leaseExpiresAt && attempt.leaseExpiresAt > now) return { kind: 'unavailable', outcome: { status: 'active', retryAfterSeconds: Math.max(1, Math.ceil((attempt.leaseExpiresAt.getTime() - now.getTime()) / 1000)) } };
      if (attempt.status === 'failed' && (!attempt.nextAttemptAt || attempt.nextAttemptAt > now)) return { kind: 'unavailable', outcome: { status: 'unavailable', code: attempt.lastErrorCode ?? 'CATALOG_UNAVAILABLE', retryable: true } };
      if (attempt.attemptCount >= this.maxAttempts) return { kind: 'unavailable', outcome: { status: 'unavailable', code: 'RESOLUTION_MAX_ATTEMPTS_EXCEEDED', retryable: false } };
      await applyResolutionTimeouts(tx, context);
      const [updated] = await tx.update(resolutionAttempts).set({ status: 'processing', leaseToken, leaseExpiresAt: expires, attemptCount: attempt.attemptCount + 1, lastErrorCode: null, updatedAt: now }).where(and(eq(resolutionAttempts.id, attempt.id), or(eq(resolutionAttempts.status, 'pending'), and(eq(resolutionAttempts.status, 'failed'), lte(resolutionAttempts.nextAttemptAt, now)), and(eq(resolutionAttempts.status, 'processing'), lte(resolutionAttempts.leaseExpiresAt, now))))).returning({ id: resolutionAttempts.id });
      assertActive(context);
      if (!updated) return { kind: 'unavailable', outcome: { status: 'active', retryAfterSeconds: 1 } };
      return { kind: 'claimed', observationId: observation.id, attemptId: attempt.id, leaseToken, content: observation.canonicalContent, provider: observation.provider, model: observation.model, promptVersion: observation.promptVersion, schemaVersion: observation.schemaVersion, imageAssetId: observation.imageAssetId };
    });
  }

  private async loadCatalog(context?: ResolutionExecutionContext) {
    return this.database.transaction(async (tx) => {
      await applyResolutionTimeouts(tx, context);
      assertActive(context);
      const [active] = await tx.select({
        activationId: activeCatalogReleasePointers.activationId,
        catalogReleaseId: releaseActivations.catalogReleaseId,
        policyVersion: releaseActivations.policyVersion,
        policySha256: releaseActivations.policySha256,
        activationIdentitySha256: releaseActivations.signedReceiptSha256,
      }).from(activeCatalogReleasePointers)
        .innerJoin(releaseActivations, eq(activeCatalogReleasePointers.activationId, releaseActivations.id))
        .limit(1);
      assertActive(context);
      if (!active) return { active: null, release: null, documents: [] };
      await applyResolutionTimeouts(tx, context);
      const [release] = await tx.select({
        id: catalogReleases.id, status: catalogReleases.status, normalizerVersion: catalogReleases.normalizerVersion,
      }).from(catalogReleases).where(eq(catalogReleases.id, active.catalogReleaseId)).limit(1);
      assertActive(context);
      await applyResolutionTimeouts(tx, context);
      const documents = await tx.select({
        id: catalogReleaseSearchDocuments.id, catalogReleaseId: catalogReleaseSearchDocuments.catalogReleaseId,
        foodId: catalogReleaseSearchDocuments.foodId, displayTextKo: catalogReleaseSearchDocuments.displayTextKo,
        normalizedCompact: catalogReleaseSearchDocuments.normalizedCompact,
        orderedTokens: catalogReleaseSearchDocuments.orderedTokens,
        orderedTrigrams: catalogReleaseSearchDocuments.orderedTrigrams,
        normalizerVersion: catalogReleaseSearchDocuments.normalizerVersion,
        category: foods.category, preparation: foods.preparation,
      }).from(catalogReleaseSearchDocuments)
        .innerJoin(foods, eq(catalogReleaseSearchDocuments.foodId, foods.id))
        .where(eq(catalogReleaseSearchDocuments.catalogReleaseId, active.catalogReleaseId));
      assertActive(context);
      return { active, release: release ?? null, documents };
    });
  }
  private async fail(claim: any, code: string, context?: ResolutionExecutionContext): Promise<MealResolutionResult> {
    const now = new Date(); const retryable = code === 'CATALOG_UNAVAILABLE';
    const nextAttemptAt = retryable ? new Date(now.getTime() + 60_000) : null;
    await this.database.transaction(async (tx) => {
      await applyResolutionTimeouts(tx, context);
      assertActive(context);
      await tx.update(resolutionAttempts).set({
      status: 'failed',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: code,
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
      updatedAt: now,
      }).where(and(eq(resolutionAttempts.id, claim.attemptId), eq(resolutionAttempts.leaseToken, claim.leaseToken)));
    });
    return { status: 'unavailable', code, retryable };
  }

  private async releaseAfterAbort(claim: any, context?: ResolutionExecutionContext): Promise<void> {
    const now = new Date();
    const cleanup = resolutionCleanupContext(context);
    try {
      await awaitWithinCleanupBudget(this.database.transaction(async (tx) => {
        await applyResolutionCleanupTimeouts(tx, cleanup);
        await tx.update(resolutionAttempts).set({
          status: 'failed',
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: 'EXECUTION_DEADLINE',
          updatedAt: now,
        }).where(and(
          eq(resolutionAttempts.id, claim.attemptId),
          eq(resolutionAttempts.status, 'processing'),
          eq(resolutionAttempts.leaseToken, claim.leaseToken),
        ));
      }), cleanup);
    } catch {
      // The processing lease expires even when the bounded compensating write cannot run.
    } finally {
      cleanup.dispose();
    }
  }
  private async currentOutcome(mealLogId: string, userId: string, context?: ResolutionExecutionContext): Promise<MealResolutionResult> {
    assertActive(context);
    const [attempt] = await this.database.transaction(async (tx) => {
      await applyResolutionTimeouts(tx, context);
      assertActive(context);
      return tx.select({
      status: resolutionAttempts.status,
      leaseExpiresAt: resolutionAttempts.leaseExpiresAt,
      lastErrorCode: resolutionAttempts.lastErrorCode,
      nextAttemptAt: resolutionAttempts.nextAttemptAt,
      }).from(resolutionAttempts)
      .innerJoin(storedObservations, eq(resolutionAttempts.storedObservationId, storedObservations.id))
      .innerJoin(mealLogs, eq(storedObservations.mealLogId, mealLogs.id))
        .where(and(eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId))).limit(1);
    });
    assertActive(context);
    if (!attempt) return { status: 'unavailable', code: 'RESOLUTION_UNAVAILABLE', retryable: false };
    const now = new Date();
    if (attempt.status === 'resolved') return { status: 'ready' };
    if (attempt.status === 'processing' && attempt.leaseExpiresAt && attempt.leaseExpiresAt > now)
      return { status: 'active', retryAfterSeconds: Math.max(1, Math.ceil((attempt.leaseExpiresAt.getTime() - now.getTime()) / 1000)) };
    return { status: 'unavailable', code: attempt.lastErrorCode ?? 'CATALOG_UNAVAILABLE', retryable: !!attempt.nextAttemptAt && attempt.nextAttemptAt > now };
  }
}
class ResolutionUnavailableError extends Error { constructor(readonly code: string) { super(code); } }
class ResolutionLeaseLostError extends Error {}
class ResolutionDeadlineError extends Error {}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }

function remainingResolutionMs(context?: ResolutionExecutionContext) {
  return context ? Math.max(0, Math.floor(context.monotonicDeadline - performance.now())) : Number.POSITIVE_INFINITY;
}

function assertActive(context?: ResolutionExecutionContext) {
  if (context?.signal.aborted || remainingResolutionMs(context) <= 0) throw new ResolutionDeadlineError();
}

function assertFinalizationReserve(context?: ResolutionExecutionContext) {
  assertActive(context);
  if (context && remainingResolutionMs(context) < context.commitReserveMs) {
    throw new ResolutionDeadlineError();
  }
}

async function applyResolutionTimeouts(
  tx: unknown,
  context?: ResolutionExecutionContext,
  maximumMs?: number,
) {
  if (!context) return;
  const execute = (tx as { execute?: (query: unknown) => Promise<unknown> }).execute;
  if (!execute) return;
  const remaining = remainingResolutionMs(context);
  const budget = Math.min(remaining, maximumMs ?? remaining);
  if (budget <= 0) throw new ResolutionDeadlineError();
  const lock = Math.max(1, Math.min(context.dbLockCapMs, budget));
  const statement = Math.max(1, Math.min(context.dbStatementCapMs, budget));
  await execute.call(tx, sql.raw(`SET LOCAL lock_timeout = '${lock}ms'`));
  await execute.call(tx, sql.raw(`SET LOCAL statement_timeout = '${statement}ms'`));
}

function resolutionCleanupContext(context?: ResolutionExecutionContext): ResolutionCleanupContext & { dispose(): void } {
  const budget = Math.max(1, context?.commitReserveMs ?? 1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budget);
  return {
    signal: controller.signal,
    timeoutMs: budget,
    lockTimeoutMs: Math.max(1, Math.min(context?.dbLockCapMs ?? budget, budget)),
    statementTimeoutMs: Math.max(1, Math.min(context?.dbStatementCapMs ?? budget, budget)),
    dispose: () => clearTimeout(timeout),
  };
}

async function applyResolutionCleanupTimeouts(tx: unknown, cleanup: ResolutionCleanupContext): Promise<void> {
  const execute = (tx as { execute?: (query: unknown) => Promise<unknown> }).execute;
  if (!execute) return;
  await execute.call(tx, sql.raw(`SET LOCAL lock_timeout = '${cleanup.lockTimeoutMs}ms'`));
  await execute.call(tx, sql.raw(`SET LOCAL statement_timeout = '${cleanup.statementTimeoutMs}ms'`));
}

function awaitWithinCleanupBudget<T>(work: Promise<T>, cleanup: ResolutionCleanupContext): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ResolutionDeadlineError());
    cleanup.signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        cleanup.signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        cleanup.signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Shared release-scoped selector adapter for resolution and confirmation. */
export function catalogEligibilityAdapter(
  database: Database,
  context?: ResolutionExecutionContext,
): CatalogEligibilityQueryAdapter {
  return {
    async load(input: TrustedNutritionSelectorInput) {
      return database.transaction(async (tx) => {
      if (context) {
        await applyResolutionTimeouts(tx, context);
        assertActive(context);
      }
      const [catalogRelease] = await tx.select({
        id: catalogReleases.id, status: catalogReleases.status, manifestSha256: catalogReleases.manifestSha256,
      }).from(catalogReleases).where(eq(catalogReleases.id, input.catalogReleaseId)).limit(1);
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const [food] = await tx.select({
        id: foods.id, canonicalNameKo: foods.canonicalNameKo, isDeprecated: foods.isDeprecated,
      }).from(foods).where(eq(foods.id, input.foodId)).limit(1);
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const foodMembers = await tx.select({ catalogReleaseId: catalogReleaseFoods.catalogReleaseId, foodId: catalogReleaseFoods.foodId })
        .from(catalogReleaseFoods).where(and(eq(catalogReleaseFoods.catalogReleaseId, input.catalogReleaseId), eq(catalogReleaseFoods.foodId, input.foodId)));
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const profileMembers = await tx.select({ catalogReleaseId: catalogReleaseNutrientProfiles.catalogReleaseId, nutrientProfileId: catalogReleaseNutrientProfiles.nutrientProfileId })
        .from(catalogReleaseNutrientProfiles).where(eq(catalogReleaseNutrientProfiles.catalogReleaseId, input.catalogReleaseId));
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const servingMembers = await tx.select({ catalogReleaseId: catalogReleaseFoodServings.catalogReleaseId, foodServingId: catalogReleaseFoodServings.foodServingId })
        .from(catalogReleaseFoodServings).where(eq(catalogReleaseFoodServings.catalogReleaseId, input.catalogReleaseId));
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const profiles = await tx.select({
          id: nutrientProfiles.id, foodId: nutrientProfiles.foodId, sourceRegistryId: nutrientProfiles.sourceRegistryId,
          sourceReleaseId: nutrientProfiles.sourceReleaseId, sourceItemId: nutrientProfiles.sourceItemId,
          datasetVersion: nutrientProfiles.datasetVersion, basisAmountMg: nutrientProfiles.basisAmountMg,
          energyMillicalories: nutrientProfiles.energyMillicalories, carbohydrateMg: nutrientProfiles.carbohydrateMg,
          proteinMg: nutrientProfiles.proteinMg, fatMg: nutrientProfiles.fatMg, fiberMg: nutrientProfiles.fiberMg,
          qualityGrade: nutrientProfiles.qualityGrade,
        }).from(nutrientProfiles).where(eq(nutrientProfiles.foodId, input.foodId));
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const servings = await tx.select({
          id: foodServings.id, foodId: foodServings.foodId, sourceRegistryId: foodServings.sourceRegistryId,
          sourceReleaseId: foodServings.sourceReleaseId, unit: foodServings.unit,
          amountMilliunits: foodServings.amountMilliunits, gramsMg: foodServings.gramsMg, qualityGrade: foodServings.qualityGrade,
        }).from(foodServings).where(eq(foodServings.foodId, input.foodId));
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const sourceReleasesRows = await tx.select({
          id: sourceReleases.id, sourceRegistryId: sourceReleases.sourceRegistryId, version: sourceReleases.version,
          status: sourceReleases.status, kind: sourceRegistries.kind, artifactKind: sourceReleases.artifactKind,
          licenseSha256: sourceReleases.licenseSha256, artifactSha256: sourceReleases.artifactSha256,
          manifestSha256: sourceReleases.manifestSha256,
        }).from(sourceReleases).innerJoin(sourceRegistries, eq(sourceReleases.sourceRegistryId, sourceRegistries.id));
      if (context) {
        assertActive(context);
        await applyResolutionTimeouts(tx, context);
      }
      const catalogSources = await tx.select({
          catalogReleaseId: catalogReleaseSources.catalogReleaseId, sourceReleaseId: catalogReleaseSources.sourceReleaseId,
          priority: catalogReleaseSources.priority, allowedArtifactKinds: catalogReleaseSources.allowedArtifactKinds,
          eligibilityManifestSha256: catalogReleaseSources.eligibilityManifestSha256,
        }).from(catalogReleaseSources).where(eq(catalogReleaseSources.catalogReleaseId, input.catalogReleaseId));
      if (context) assertActive(context);
      return {
        catalogRelease: catalogRelease ?? null,
        food: food ?? null,
        foodMembers,
        // Null release bindings deliberately never satisfy the V3 release-aware selector.
        profiles: profiles.filter((profile) => profile.sourceReleaseId !== null).map((profile) => ({ ...profile, sourceReleaseId: profile.sourceReleaseId! })),
        profileMembers,
        servings: servings.filter((serving) => serving.sourceReleaseId !== null).map((serving) => ({ ...serving, sourceReleaseId: serving.sourceReleaseId! })),
        servingMembers,
        sourceReleases: sourceReleasesRows,
        catalogSources,
      };
      });
    },
  };
}
