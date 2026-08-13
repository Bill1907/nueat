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
import { and, eq, lte, or } from 'drizzle-orm';

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

  async resolve(mealLogId: string, userId: string): Promise<MealResolutionResult> {
    const claim = await this.claim(mealLogId, userId);
    if (claim.kind !== 'claimed') return claim.outcome;
    try {
      const [active] = await this.database.select({
        activationId: activeCatalogReleasePointers.activationId,
        catalogReleaseId: releaseActivations.catalogReleaseId,
        policyVersion: releaseActivations.policyVersion,
        policySha256: releaseActivations.policySha256,
        activationIdentitySha256: releaseActivations.signedReceiptSha256,
      }).from(activeCatalogReleasePointers)
        .innerJoin(releaseActivations, eq(activeCatalogReleasePointers.activationId, releaseActivations.id))
        .limit(1);
      if (!active) throw new ResolutionUnavailableError('CATALOG_UNAVAILABLE');
      const [release] = await this.database.select({
        id: catalogReleases.id, status: catalogReleases.status, normalizerVersion: catalogReleases.normalizerVersion,
      }).from(catalogReleases).where(eq(catalogReleases.id, active.catalogReleaseId)).limit(1);
      const documents = await this.database.select({
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
      const content = claim.content as { outcome: string; observations: Array<any> };
      const roots = content.outcome === 'recognized'
        ? content.observations
          .filter((observation) => observation.parentRegionIndex === null)
          .sort((left, right) => left.localObservationId.localeCompare(right.localObservationId))
        : [];
      const eligibility = catalogEligibilityAdapter(this.database);
      const decisions: Array<{ localObservationId: string; selectedFoodId: string | null; nutrientProfileId: string | null; selection: TrustedNutritionSelection | null; status: 'selected' | 'review_required' | 'unresolved'; method: 'exact' | 'lexical'; reasonCode: string; candidates: unknown[]; evidence: unknown }> = [];
      for (const observation of roots) {
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
          const selection = await selectTrustedNutrition(eligibility, {
            catalogReleaseId: active.catalogReleaseId, foodId: candidate.foodId, unit: observation.unit,
          });
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
        const [lease] = await tx.select({ id: resolutionAttempts.id }).from(resolutionAttempts).where(and(
          eq(resolutionAttempts.id, claim.attemptId),
          eq(resolutionAttempts.status, 'processing'),
          eq(resolutionAttempts.leaseToken, claim.leaseToken),
        )).for('update').limit(1);
        if (!lease) return false;
        const inserted = decisions.length === 0 ? [] : await tx.insert(mappingDecisions).values(decisions.map((decision) => ({
          storedObservationId: claim.observationId, localObservationId: decision.localObservationId,
          catalogReleaseId: active.catalogReleaseId, releaseActivationId: active.activationId,
          resolverVersion: CATALOG_LEXICAL_RESOLVER_VERSION,
          resolverSha256: hash(CATALOG_LEXICAL_RESOLVER_VERSION), policyVersion: active.policyVersion,
          policySha256: active.policySha256, candidates: decision.candidates, selectedFoodId: decision.selectedFoodId,
          status: decision.status, method: decision.method, reasonCode: decision.reasonCode,
          evidence: decision.evidence,
        }))).returning({ id: mappingDecisions.id, localObservationId: mappingDecisions.localObservationId, selectedFoodId: mappingDecisions.selectedFoodId, status: mappingDecisions.status });
        // A preview exists only for an eligibility-backed candidate, before UI projection.
        for (const decision of inserted.filter((decision) => decision.selectedFoodId !== null)) {
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
        }
        const nutrientProfileByLocalId = new Map(
          decisions.map((decision) => [decision.localObservationId, decision.nutrientProfileId]),
        );
        const byLocalId = new Map(inserted.map((decision) => [decision.localObservationId, decision]));
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
        const completedAt = new Date();
        const [finalized] = await tx.update(resolutionAttempts)
          .set({ status: 'resolved', leaseToken: null, leaseExpiresAt: null, lastErrorCode: null, resolvedAt: completedAt, updatedAt: completedAt })
          .where(and(
            eq(resolutionAttempts.id, claim.attemptId),
            eq(resolutionAttempts.status, 'processing'),
            eq(resolutionAttempts.leaseToken, claim.leaseToken),
          ))
          .returning({ id: resolutionAttempts.id });
        if (!finalized) throw new ResolutionLeaseLostError();
        await tx.update(imageAssets).set({ status: 'processed', processingCompletedAt: completedAt })
          .where(and(eq(imageAssets.id, claim.imageAssetId), eq(imageAssets.status, 'processing')));
        return true;
      });
      return completed ? { status: 'ready' } : this.currentOutcome(mealLogId, userId);
    } catch (error) {
      if (error instanceof ResolutionLeaseLostError) return this.currentOutcome(mealLogId, userId);
      return this.fail(claim, error instanceof ResolutionUnavailableError ? error.code : 'CATALOG_UNAVAILABLE');
    }
  }

  private async claim(mealLogId: string, userId: string): Promise<any> {
    const now = new Date(); const leaseToken = randomUUID(); const expires = new Date(now.getTime() + this.leaseMs);
    return this.database.transaction(async (tx) => {
      const [observation] = await tx.select({ id: storedObservations.id, canonicalContent: storedObservations.canonicalContent, provider: storedObservations.provider, model: storedObservations.model, promptVersion: storedObservations.promptVersion, schemaVersion: storedObservations.schemaVersion, imageAssetId: recognitionAttempts.imageAssetId }).from(storedObservations)
        .innerJoin(recognitionAttempts, eq(storedObservations.recognitionAttemptId, recognitionAttempts.id))
        .innerJoin(mealLogs, eq(storedObservations.mealLogId, mealLogs.id))
        .where(and(eq(storedObservations.mealLogId, mealLogId), eq(mealLogs.userId, userId), eq(mealLogs.status, 'draft'))).for('update').limit(1);
      if (!observation) return { kind: 'unavailable', outcome: { status: 'unavailable', code: 'RESOLUTION_UNAVAILABLE', retryable: false } };
      const [attempt] = await tx.select({ id: resolutionAttempts.id, status: resolutionAttempts.status, attemptCount: resolutionAttempts.attemptCount, nextAttemptAt: resolutionAttempts.nextAttemptAt, leaseExpiresAt: resolutionAttempts.leaseExpiresAt, lastErrorCode: resolutionAttempts.lastErrorCode }).from(resolutionAttempts).where(eq(resolutionAttempts.storedObservationId, observation.id)).for('update').limit(1);
      if (!attempt) return { kind: 'unavailable', outcome: { status: 'unavailable', code: 'RESOLUTION_UNAVAILABLE', retryable: false } };
      if (attempt.status === 'resolved') return { kind: 'unavailable', outcome: { status: 'ready' } };
      if (attempt.status === 'processing' && attempt.leaseExpiresAt && attempt.leaseExpiresAt > now) return { kind: 'unavailable', outcome: { status: 'active', retryAfterSeconds: Math.max(1, Math.ceil((attempt.leaseExpiresAt.getTime() - now.getTime()) / 1000)) } };
      if (attempt.status === 'failed' && (!attempt.nextAttemptAt || attempt.nextAttemptAt > now)) return { kind: 'unavailable', outcome: { status: 'unavailable', code: attempt.lastErrorCode ?? 'CATALOG_UNAVAILABLE', retryable: true } };
      if (attempt.attemptCount >= this.maxAttempts) return { kind: 'unavailable', outcome: { status: 'unavailable', code: 'RESOLUTION_MAX_ATTEMPTS_EXCEEDED', retryable: false } };
      const [updated] = await tx.update(resolutionAttempts).set({ status: 'processing', leaseToken, leaseExpiresAt: expires, attemptCount: attempt.attemptCount + 1, lastErrorCode: null, updatedAt: now }).where(and(eq(resolutionAttempts.id, attempt.id), or(eq(resolutionAttempts.status, 'pending'), and(eq(resolutionAttempts.status, 'failed'), lte(resolutionAttempts.nextAttemptAt, now)), and(eq(resolutionAttempts.status, 'processing'), lte(resolutionAttempts.leaseExpiresAt, now))))).returning({ id: resolutionAttempts.id });
      if (!updated) return { kind: 'unavailable', outcome: { status: 'active', retryAfterSeconds: 1 } };
      return { kind: 'claimed', observationId: observation.id, attemptId: attempt.id, leaseToken, content: observation.canonicalContent, provider: observation.provider, model: observation.model, promptVersion: observation.promptVersion, schemaVersion: observation.schemaVersion, imageAssetId: observation.imageAssetId };
    });
  }
  private async fail(claim: any, code: string): Promise<MealResolutionResult> {
    const now = new Date(); const retryable = code === 'CATALOG_UNAVAILABLE';
    const nextAttemptAt = retryable ? new Date(now.getTime() + 60_000) : null;
    await this.database.update(resolutionAttempts).set({
      status: 'failed',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: code,
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
      updatedAt: now,
    }).where(and(eq(resolutionAttempts.id, claim.attemptId), eq(resolutionAttempts.leaseToken, claim.leaseToken)));
    return { status: 'unavailable', code, retryable };
  }
  private async currentOutcome(mealLogId: string, userId: string): Promise<MealResolutionResult> {
    const [attempt] = await this.database.select({
      status: resolutionAttempts.status,
      leaseExpiresAt: resolutionAttempts.leaseExpiresAt,
      lastErrorCode: resolutionAttempts.lastErrorCode,
      nextAttemptAt: resolutionAttempts.nextAttemptAt,
    }).from(resolutionAttempts)
      .innerJoin(storedObservations, eq(resolutionAttempts.storedObservationId, storedObservations.id))
      .innerJoin(mealLogs, eq(storedObservations.mealLogId, mealLogs.id))
      .where(and(eq(mealLogs.id, mealLogId), eq(mealLogs.userId, userId))).limit(1);
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
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }

/** Shared release-scoped selector adapter for resolution and confirmation. */
export function catalogEligibilityAdapter(database: Database): CatalogEligibilityQueryAdapter {
  return {
    async load(input: TrustedNutritionSelectorInput) {
      const [catalogRelease] = await database.select({
        id: catalogReleases.id, status: catalogReleases.status, manifestSha256: catalogReleases.manifestSha256,
      }).from(catalogReleases).where(eq(catalogReleases.id, input.catalogReleaseId)).limit(1);
      const [food] = await database.select({
        id: foods.id, canonicalNameKo: foods.canonicalNameKo, isDeprecated: foods.isDeprecated,
      }).from(foods).where(eq(foods.id, input.foodId)).limit(1);
      const [foodMembers, profileMembers, servingMembers, profiles, servings, sourceReleasesRows, catalogSources] = await Promise.all([
        database.select({ catalogReleaseId: catalogReleaseFoods.catalogReleaseId, foodId: catalogReleaseFoods.foodId })
          .from(catalogReleaseFoods).where(and(eq(catalogReleaseFoods.catalogReleaseId, input.catalogReleaseId), eq(catalogReleaseFoods.foodId, input.foodId))),
        database.select({ catalogReleaseId: catalogReleaseNutrientProfiles.catalogReleaseId, nutrientProfileId: catalogReleaseNutrientProfiles.nutrientProfileId })
          .from(catalogReleaseNutrientProfiles).where(eq(catalogReleaseNutrientProfiles.catalogReleaseId, input.catalogReleaseId)),
        database.select({ catalogReleaseId: catalogReleaseFoodServings.catalogReleaseId, foodServingId: catalogReleaseFoodServings.foodServingId })
          .from(catalogReleaseFoodServings).where(eq(catalogReleaseFoodServings.catalogReleaseId, input.catalogReleaseId)),
        database.select({
          id: nutrientProfiles.id, foodId: nutrientProfiles.foodId, sourceRegistryId: nutrientProfiles.sourceRegistryId,
          sourceReleaseId: nutrientProfiles.sourceReleaseId, sourceItemId: nutrientProfiles.sourceItemId,
          datasetVersion: nutrientProfiles.datasetVersion, basisAmountMg: nutrientProfiles.basisAmountMg,
          energyMillicalories: nutrientProfiles.energyMillicalories, carbohydrateMg: nutrientProfiles.carbohydrateMg,
          proteinMg: nutrientProfiles.proteinMg, fatMg: nutrientProfiles.fatMg, fiberMg: nutrientProfiles.fiberMg,
          qualityGrade: nutrientProfiles.qualityGrade,
        }).from(nutrientProfiles).where(eq(nutrientProfiles.foodId, input.foodId)),
        database.select({
          id: foodServings.id, foodId: foodServings.foodId, sourceRegistryId: foodServings.sourceRegistryId,
          sourceReleaseId: foodServings.sourceReleaseId, unit: foodServings.unit,
          amountMilliunits: foodServings.amountMilliunits, gramsMg: foodServings.gramsMg, qualityGrade: foodServings.qualityGrade,
        }).from(foodServings).where(eq(foodServings.foodId, input.foodId)),
        database.select({
          id: sourceReleases.id, sourceRegistryId: sourceReleases.sourceRegistryId, version: sourceReleases.version,
          status: sourceReleases.status, kind: sourceRegistries.kind, artifactKind: sourceReleases.artifactKind,
          licenseSha256: sourceReleases.licenseSha256, artifactSha256: sourceReleases.artifactSha256,
          manifestSha256: sourceReleases.manifestSha256,
        }).from(sourceReleases).innerJoin(sourceRegistries, eq(sourceReleases.sourceRegistryId, sourceRegistries.id)),
        database.select({
          catalogReleaseId: catalogReleaseSources.catalogReleaseId, sourceReleaseId: catalogReleaseSources.sourceReleaseId,
          priority: catalogReleaseSources.priority, allowedArtifactKinds: catalogReleaseSources.allowedArtifactKinds,
          eligibilityManifestSha256: catalogReleaseSources.eligibilityManifestSha256,
        }).from(catalogReleaseSources).where(eq(catalogReleaseSources.catalogReleaseId, input.catalogReleaseId)),
      ]);
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
    },
  };
}
