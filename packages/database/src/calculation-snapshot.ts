export const CALCULATION_INPUT_SNAPSHOT_V2 = 'meal-calculation-snapshot-v2';

export type SnapshotNutrients = Record<
  'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
  number | null
>;

export interface LegacyCalculationSnapshotItem {
  mealItemId: string;
  origin: 'model_estimate' | 'manual_entry' | 'user_added' | 'legacy_unknown';
  currentResolutionSource: 'model_primary' | 'model_alternative' | 'user_selected' | 'legacy_existing' | null;
  foodId: string;
  nutrientProfileId: string | null;
  amountMilliunits: number;
  unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
  gramsMg: number;
  sourceRegistryId: string | null;
  sourceItemId: string | null;
  datasetVersion: string | null;
  nutrientProfileQualityGrade: 'verified' | 'estimated' | 'unverified' | null;
  nutrients: SnapshotNutrients;
  initialEstimateAssessment: unknown | null;
  itemRevision: number;
  foodRevision: number;
  portionRevision: number;
  foodAcknowledgedRevision: number | null;
  portionAcknowledgedRevision: number | null;
  nutrientProfile: unknown | null;
  serving: unknown | null;
  calculationBasis?: unknown;
  calculationLeaves?: unknown;
  calculationPreview?: unknown;
}

/** The immutable payload written by the pre-review-checkpoint confirmation flow. */
export interface LegacyCalculationInputSnapshot {
  confirmationDecision: Record<string, unknown>;
  mealItems: LegacyCalculationSnapshotItem[];
}

export interface CalculationSnapshotConfirmationDecision {
  reviewProtocol: 'meal-confirmation-safe-review-v1';
  originalRecognition: CalculationSnapshotOriginalRecognition | null;
  manualOverride: CalculationSnapshotManualOverride | null;
}

export interface CalculationSnapshotOriginalRecognition {
  provider: 'mock' | 'openai' | 'manual';
  model: string;
  promptVersion: string;
  schemaVersion: string;
  outcome: 'recognized' | 'no_food' | 'insufficient_evidence';
  evidenceReason?: 'blurred' | 'too_dark' | 'occluded' | 'not_meal_photo' | 'other';
  completedAt: string;
}

export interface CalculationSnapshotManualOverride {
  fromStatus: 'ready' | 'pending' | 'processing' | 'failed';
  fromOutcome: 'recognized' | 'no_food' | 'insufficient_evidence' | null;
  decision: 'direct_entry';
  decisionVersion: 'recognition-manual-override-v1';
  decidedAt: string;
}

export interface CalculationReviewCheckpoint {
  reviewedItemRevision: number;
  reviewedAuthorityFingerprintVersion: string;
  reviewedAuthorityFingerprint: string;
  reviewIdempotencyKey: string;
  reviewRequestFingerprint: string;
  reviewedAt: string;
}

export interface CalculationSnapshotAuthorityTuple {
  fingerprintVersion: string;
  fingerprint: string;
}

export interface CalculationSnapshotProvenance {
  calculationVersion: string;
  sourceRegistryId: string | null;
  sourceItemId: string | null;
  datasetVersion: string | null;
  nutrientProfileId: string | null;
}

export type CalculationSnapshotItemV2 = Omit<
  LegacyCalculationSnapshotItem,
  | 'foodAcknowledgedRevision'
  | 'portionAcknowledgedRevision'
  | 'foodId'
  | 'gramsMg'
> & {
  foodId: string | null;
  gramsMg: number | null;
  checkpoint: CalculationReviewCheckpoint;
  authority: CalculationSnapshotAuthorityTuple;
  provenance: CalculationSnapshotProvenance;
};

export type CalculationInputSnapshotV2 = Omit<
  LegacyCalculationInputSnapshot,
  'confirmationDecision' | 'mealItems'
> & {
  version: typeof CALCULATION_INPUT_SNAPSHOT_V2;
  confirmationDecision: CalculationSnapshotConfirmationDecision;
  mealItems: CalculationSnapshotItemV2[];
};

export type ParsedCalculationInputSnapshot =
  | { kind: 'legacy'; snapshot: LegacyCalculationInputSnapshot }
  | { kind: 'v2'; snapshot: CalculationInputSnapshotV2 };

export interface CalculationSnapshotProjection {
  version: 'legacy' | typeof CALCULATION_INPUT_SNAPSHOT_V2;
  reviewEvidence: 'legacy_unknown' | 'explicit_v2';
  mealItems: Array<{
    mealItemId: string;
    foodId: string | null;
    nutrientProfileId: string | null;
    nutrients: SnapshotNutrients;
    provenance: CalculationSnapshotProvenance;
    checkpoint: CalculationReviewCheckpoint | null;
    authority: CalculationSnapshotAuthorityTuple | null;
  }>;
}

/**
 * Parses a persisted JSONB value without reserializing or upgrading it. A versionless
 * payload is accepted only when it is exactly the historical shape; an explicit version
 * must be the current V2 discriminator.
 */
export function parseCalculationInputSnapshot(value: unknown): ParsedCalculationInputSnapshot | null {
  if (!isRecord(value)) return null;
  if (!Object.hasOwn(value, 'version')) {
    const legacy = parseLegacy(value);
    return legacy ? { kind: 'legacy', snapshot: legacy } : null;
  }
  if (value.version !== CALCULATION_INPUT_SNAPSHOT_V2) return null;
  const v2 = parseV2(value);
  return v2 ? { kind: 'v2', snapshot: v2 } : null;
}

export function projectCalculationInputSnapshot(parsed: ParsedCalculationInputSnapshot): CalculationSnapshotProjection {
  if (parsed.kind === 'v2') {
    return {
      version: CALCULATION_INPUT_SNAPSHOT_V2,
      reviewEvidence: 'explicit_v2',
      mealItems: parsed.snapshot.mealItems.map((item) => ({
        mealItemId: item.mealItemId,
        foodId: item.foodId,
        nutrientProfileId: item.nutrientProfileId,
        nutrients: item.nutrients,
        provenance: item.provenance,
        checkpoint: item.checkpoint,
        authority: item.authority,
      })),
    };
  }
  return {
    version: 'legacy',
    reviewEvidence: 'legacy_unknown',
    mealItems: parsed.snapshot.mealItems.map((item) => ({
      mealItemId: item.mealItemId,
      foodId: item.foodId,
      nutrientProfileId: item.nutrientProfileId,
      nutrients: item.nutrients,
      provenance: {
        calculationVersion: 'legacy_unknown',
        sourceRegistryId: item.sourceRegistryId,
        sourceItemId: item.sourceItemId,
        datasetVersion: item.datasetVersion,
        nutrientProfileId: item.nutrientProfileId,
      },
      checkpoint: null,
      authority: null,
    })),
  };
}

function parseLegacy(value: Record<string, unknown>): LegacyCalculationInputSnapshot | null {
  return isLegacySnapshot(value) ? value : null;
}

function parseV2(value: Record<string, unknown>): CalculationInputSnapshotV2 | null {
  return isV2Snapshot(value) ? value : null;
}

function parseLegacyItem(value: unknown): LegacyCalculationSnapshotItem | null {
  if (!isRecord(value)) return null;
  const requiredKeys = [
    'amountMilliunits', 'currentResolutionSource', 'datasetVersion', 'foodId', 'gramsMg', 'mealItemId',
    'nutrientProfileId', 'nutrientProfileQualityGrade', 'nutrients', 'origin', 'sourceItemId',
    'sourceRegistryId', 'unit', 'initialEstimateAssessment', 'itemRevision', 'foodRevision',
    'portionRevision', 'foodAcknowledgedRevision', 'portionAcknowledgedRevision', 'nutrientProfile', 'serving',
  ];
  const previewKeys = ['calculationBasis', 'calculationLeaves', 'calculationPreview'];
  const hasPreview = previewKeys.every((key) => Object.hasOwn(value, key));
  if (!hasExactKeys(value, hasPreview ? [...requiredKeys, ...previewKeys] : requiredKeys)) return null;
  if (!isString(value.mealItemId) || !isEnum(value.origin, ['model_estimate', 'manual_entry', 'user_added', 'legacy_unknown'])) return null;
  if (!isNullableEnum(value.currentResolutionSource, ['model_primary', 'model_alternative', 'user_selected', 'legacy_existing'])) return null;
  if (!isString(value.foodId) || !isNullableString(value.nutrientProfileId)) return null;
  if (!isSafeInteger(value.amountMilliunits) || !isEnum(value.unit, ['g', 'ml', 'serving', 'bowl', 'piece']) || !isSafeInteger(value.gramsMg)) return null;
  if (!isNullableString(value.sourceRegistryId) || !isNullableString(value.sourceItemId) || !isNullableString(value.datasetVersion)) return null;
  if (!isNullableEnum(value.nutrientProfileQualityGrade, ['verified', 'estimated', 'unverified'])) return null;
  if (!isNullableJson(value.initialEstimateAssessment) || !isSafeInteger(value.itemRevision) || !isSafeInteger(value.foodRevision) || !isSafeInteger(value.portionRevision) || !isNullableSafeInteger(value.foodAcknowledgedRevision) || !isNullableSafeInteger(value.portionAcknowledgedRevision) || !isNullableJson(value.nutrientProfile) || !isNullableJson(value.serving)) return null;
  if (hasPreview && (!isJson(value.calculationBasis) || !isJson(value.calculationLeaves) || !isJson(value.calculationPreview))) return null;
  const nutrients = parseNutrients(value.nutrients);
  return nutrients ? {
    mealItemId: value.mealItemId, origin: value.origin, currentResolutionSource: value.currentResolutionSource,
    foodId: value.foodId, nutrientProfileId: value.nutrientProfileId, amountMilliunits: value.amountMilliunits,
    unit: value.unit, gramsMg: value.gramsMg, sourceRegistryId: value.sourceRegistryId,
    sourceItemId: value.sourceItemId, datasetVersion: value.datasetVersion,
    nutrientProfileQualityGrade: value.nutrientProfileQualityGrade, nutrients,
    initialEstimateAssessment: value.initialEstimateAssessment, itemRevision: value.itemRevision,
    foodRevision: value.foodRevision, portionRevision: value.portionRevision,
    foodAcknowledgedRevision: value.foodAcknowledgedRevision, portionAcknowledgedRevision: value.portionAcknowledgedRevision,
    nutrientProfile: value.nutrientProfile, serving: value.serving,
    ...(hasPreview ? { calculationBasis: value.calculationBasis, calculationLeaves: value.calculationLeaves, calculationPreview: value.calculationPreview } : {}),
  } : null;
}

function parseV2Item(value: unknown): CalculationInputSnapshotV2['mealItems'][number] | null {
  if (!isRecord(value)) return null;
  const { authority, checkpoint, provenance, ...legacyValue } = value;
  const foodId = legacyValue.foodId;
  const gramsMg = legacyValue.gramsMg;
  if (!isNullableString(foodId) || !isNullableSafeInteger(gramsMg)) return null;
  const legacy = parseLegacyItem({
    ...legacyValue,
    foodId: foodId ?? 'manual-unmapped',
    gramsMg: gramsMg ?? 1,
    foodAcknowledgedRevision: null,
    portionAcknowledgedRevision: null,
  });
  const parsedCheckpoint = parseCheckpoint(checkpoint);
  const parsedAuthority = parseAuthority(authority);
  const parsedProvenance = parseProvenance(provenance);
  if (!legacy || !parsedCheckpoint || !parsedAuthority || !parsedProvenance) return null;
  const {
    foodAcknowledgedRevision: _foodAcknowledgedRevision,
    portionAcknowledgedRevision: _portionAcknowledgedRevision,
    ...current
  } = legacy;
  return {
    ...current,
    foodId,
    gramsMg,
    checkpoint: parsedCheckpoint,
    authority: parsedAuthority,
    provenance: parsedProvenance,
  };
}

function parseNutrients(value: unknown): SnapshotNutrients | null {
  if (!isRecord(value) || !hasExactKeys(value, ['carbohydrateMg', 'energyMillicalories', 'fatMg', 'fiberMg', 'proteinMg'])) return null;
  return isNullableSafeInteger(value.energyMillicalories) && isNullableSafeInteger(value.carbohydrateMg) &&
    isNullableSafeInteger(value.proteinMg) && isNullableSafeInteger(value.fatMg) && isNullableSafeInteger(value.fiberMg)
    ? {
        energyMillicalories: value.energyMillicalories,
        carbohydrateMg: value.carbohydrateMg,
        proteinMg: value.proteinMg,
        fatMg: value.fatMg,
        fiberMg: value.fiberMg,
      } : null;
}

function parseLegacyConfirmationDecision(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ['manualOverride', 'originalRecognition', 'policy'])) return false;
  if (parseOriginalRecognition(value.originalRecognition) === false || parseManualOverride(value.manualOverride) === false) return false;
  const policy = value.policy;
  return isRecord(policy) && hasExactKeys(policy, ['activation', 'activeReportSha256', 'approvedReportSha256', 'approvedReportVersion', 'version']) &&
    isString(policy.version) && isEnum(policy.activation, ['review_only', 'quick_confirm']) &&
    isNullableString(policy.approvedReportSha256) && isNullableString(policy.activeReportSha256) && isNullableString(policy.approvedReportVersion);
}

function parseConfirmationDecision(value: unknown): CalculationSnapshotConfirmationDecision | null {
  if (!isRecord(value) || !hasExactKeys(value, ['manualOverride', 'originalRecognition', 'reviewProtocol'])) return null;
  if (value.reviewProtocol !== 'meal-confirmation-safe-review-v1') return null;
  const originalRecognition = parseOriginalRecognition(value.originalRecognition);
  const manualOverride = parseManualOverride(value.manualOverride);
  return originalRecognition !== false && manualOverride !== false
    ? { reviewProtocol: value.reviewProtocol, originalRecognition, manualOverride }
    : null;
}

function parseOriginalRecognition(value: unknown): CalculationSnapshotOriginalRecognition | null | false {
  if (value === null) return null;
  if (!isRecord(value)) return false;
  const base = ['completedAt', 'model', 'outcome', 'promptVersion', 'provider', 'schemaVersion'];
  if (!isEnum(value.outcome, ['recognized', 'no_food', 'insufficient_evidence'])) return false;
  if (!hasExactKeys(
    value,
    value.outcome === 'insufficient_evidence' ? [...base, 'evidenceReason'] : base,
  )) return false;
  return isEnum(value.provider, ['mock', 'openai', 'manual']) && isString(value.model) && isString(value.promptVersion) &&
    isString(value.schemaVersion) && isString(value.completedAt) &&
    (value.outcome !== 'insufficient_evidence' || isEnum(value.evidenceReason, ['blurred', 'too_dark', 'occluded', 'not_meal_photo', 'other']))
    ? value as unknown as CalculationSnapshotOriginalRecognition
    : false;
}

function parseManualOverride(value: unknown): CalculationSnapshotManualOverride | null | false {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ['decidedAt', 'decision', 'decisionVersion', 'fromOutcome', 'fromStatus'])) return false;
  if (!isEnum(value.fromStatus, ['ready', 'pending', 'processing', 'failed']) ||
    !isNullableEnum(value.fromOutcome, ['recognized', 'no_food', 'insufficient_evidence']) ||
    !isEnum(value.decision, ['direct_entry']) ||
    !isEnum(value.decisionVersion, ['recognition-manual-override-v1']) ||
    !isString(value.decidedAt)) return false;
  if (value.fromStatus === 'ready' && !isEnum(value.fromOutcome, ['no_food', 'insufficient_evidence'])) return false;
  return value as unknown as CalculationSnapshotManualOverride;
}

function parseCheckpoint(value: unknown): CalculationReviewCheckpoint | null {
  if (!isRecord(value) || !hasExactKeys(value, ['reviewIdempotencyKey', 'reviewRequestFingerprint', 'reviewedAt', 'reviewedAuthorityFingerprint', 'reviewedAuthorityFingerprintVersion', 'reviewedItemRevision'])) return null;
  if (!isSafeInteger(value.reviewedItemRevision) || value.reviewedItemRevision <= 0 || !isString(value.reviewedAuthorityFingerprintVersion) || !isSha256(value.reviewedAuthorityFingerprint) || !isString(value.reviewIdempotencyKey) || !isSha256(value.reviewRequestFingerprint) || !isString(value.reviewedAt)) return null;
  return {
    reviewedItemRevision: value.reviewedItemRevision,
    reviewedAuthorityFingerprintVersion: value.reviewedAuthorityFingerprintVersion,
    reviewedAuthorityFingerprint: value.reviewedAuthorityFingerprint,
    reviewIdempotencyKey: value.reviewIdempotencyKey,
    reviewRequestFingerprint: value.reviewRequestFingerprint,
    reviewedAt: value.reviewedAt,
  };
}

function parseAuthority(value: unknown): CalculationSnapshotAuthorityTuple | null {
  if (!isRecord(value) || !hasExactKeys(value, ['fingerprint', 'fingerprintVersion']) || !isString(value.fingerprintVersion) || !isSha256(value.fingerprint)) return null;
  return {
    fingerprintVersion: value.fingerprintVersion,
    fingerprint: value.fingerprint,
  };
}

function parseProvenance(value: unknown): CalculationSnapshotProvenance | null {
  if (!isRecord(value) || !hasExactKeys(value, ['calculationVersion', 'datasetVersion', 'nutrientProfileId', 'sourceItemId', 'sourceRegistryId'])) return null;
  if (!isString(value.calculationVersion) || !isNullableString(value.sourceRegistryId) || !isNullableString(value.sourceItemId) || !isNullableString(value.datasetVersion) || !isNullableString(value.nutrientProfileId)) return null;
  return {
    calculationVersion: value.calculationVersion,
    sourceRegistryId: value.sourceRegistryId,
    sourceItemId: value.sourceItemId,
    datasetVersion: value.datasetVersion,
    nutrientProfileId: value.nutrientProfileId,
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isLegacySnapshot(value: Record<string, unknown>): value is Record<string, unknown> & LegacyCalculationInputSnapshot {
  return hasExactKeys(value, ['confirmationDecision', 'mealItems']) &&
    parseLegacyConfirmationDecision(value.confirmationDecision) &&
    Array.isArray(value.mealItems) &&
    value.mealItems.every(isLegacyItem);
}
function isLegacyItem(value: unknown): value is LegacyCalculationSnapshotItem {
  return parseLegacyItem(value) !== null;
}
function isV2Snapshot(value: Record<string, unknown>): value is Record<string, unknown> & CalculationInputSnapshotV2 {
  return hasExactKeys(value, ['confirmationDecision', 'mealItems', 'version']) &&
    value.version === CALCULATION_INPUT_SNAPSHOT_V2 &&
    parseConfirmationDecision(value.confirmationDecision) !== null &&
    Array.isArray(value.mealItems) &&
    value.mealItems.every(isV2Item);
}
function isV2Item(value: unknown): value is CalculationInputSnapshotV2['mealItems'][number] {
  return parseV2Item(value) !== null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function isString(value: unknown): value is string { return typeof value === 'string'; }
function isNullableString(value: unknown): value is string | null { return value === null || isString(value); }
function isSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function isNullableSafeInteger(value: unknown): value is number | null { return value === null || isSafeInteger(value); }
function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
function isNullableJson(value: unknown): boolean { return value === null || isJson(value); }
function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.includes(value as T); }
function isNullableEnum<T extends string>(value: unknown, values: readonly T[]): value is T | null { return value === null || isEnum(value, values); }
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
