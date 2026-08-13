import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { MEAL_REVIEW_POLICY_THRESHOLDS } from '@nueat/domain';

type Outcome = 'recognized' | 'no_food' | 'insufficient_evidence';
type Food = { canonicalFoodId: string; amountGrams: number; foodConfidenceBps?: number; portionConfidenceBps?: number; foodCandidateMarginBps?: number | null; initialMappingSource?: 'model_primary' | 'model_alternative'; resolutionMethod?: 'exact' | 'lexical'; questions?: Array<{ target: 'food' | 'portion' }>; unit?: 'g' | 'ml' | 'serving' | 'bowl' | 'piece'; conversionSourceRegistryId?: string | null };

export type GoldenManifest = {
  version: 'meal-stack-golden-manifest-v3';
  profile: 'golden-v1' | 'experiment';
  groundTruthVersion: string;
  predictionVersion: string;
  adjudicationVersion: string;
  adjudicationSha256: string;
  registryVersion: string;
  registrySha256: string;
  requiredFoodGroups: string[];
  recognitionModel: string;
  promptVersion: string;
  schemaVersion: string;
  resolverVersion: string;
  reviewPolicyVersion: string;
  provider: 'openai';
  trustedConversionSourceRegistryIds: string[];
  activationIdentity: ActivationIdentity;
  rolloutMeasurements: { categoryStrataCases: number; preparationStrataCases: number; compositeCases: number; abstentionCases: number; maxLatencyMs: number; correctionRateBps: number; blockedViolationCount: number; privacyViolationCount: number; forbiddenSelectionCount: number; untrustedSelectionCount: number; soakDays: number };
};

export type ActivationIdentity = {
  observationSchemaVersion: string;
  promptVersion: string;
  recognitionModel: string;
  resolverVersion: string;
  resolverSha256: string;
  reviewPolicyVersion: string;
  reviewPolicySha256: string;
  normalizerVersion: string;
  normalizerSha256: string;
  taxonomyVersion: string;
  taxonomySha256: string;
  searchWeightsSha256: string;
  thresholdSha256: string;
  catalogReleaseIds: string[];
  catalogReleaseSha256: string;
  localEncoderManifestSha256?: string;
  mappingMode: 'exact_review' | 'hybrid_review' | 'vector_shadow' | 'hybrid_auto';
};

export type AutoSelectionGoldenEvidence = {
  comparatorVersion: string;
  policyVersion: string;
  policySha256: string;
  minimumWinnerScoreBps: number;
  minimumMarginBps: number;
  population: { version: string; sha256: string };
  stackSha256: string;
  selectedSubset: {
    selectedMeals: number;
    selectedItems: number;
    foodMatches: number;
    fullyCorrectMeals: number;
  };
};

export type GoldenReport = {
  version: 'meal-stack-golden-report-v3';
  mode: 'production' | 'experiment';
  result: 'passed' | 'failed' | 'evaluated';
  provenance: { manifestSha256: string; groundTruthSha256: string; predictionsSha256: string; adjudicationVersion: string; adjudicationSha256: string; registryVersion: string; registrySha256: string; provider: 'openai'; recognitionModel: string; promptVersion: string; schemaVersion: string; resolverVersion: string; reviewPolicyVersion: string; activationIdentity: ActivationIdentity; autoSelectionEvidence: AutoSelectionGoldenEvidence | null };
  autoSelectionPolicy: { version: string; comparatorVersion: string; minimumWinnerScoreBps: number; minimumMarginBps: number; identitySha256: string } | null;
  inputSha256: string;
  reportSha256: string;
  passed: boolean;
  failures: string[];
  counts: { consentedKoreanMealPhotos: number; foodGroupCases: Record<string, number>; noFood: number; insufficientEvidence: number; quickEligibleMeals: number; quickEligibleItems: number; eligibleItems: number; eligibleMeals: number; zeroOutcomeQuickFalsePositives: number; nutritionOrIdErrors: number; forbiddenSelectionCount: number; untrustedConversionEligible: number; untrustedSelectionCount: number; sensitiveReportLeakage: number };
  metrics: { outcomeAccuracyBps: number; eligibleFoodTop1Wilson95LowerBoundBps: number; portionWithinToleranceWilson95LowerBoundBps: number; jointItemWilson95LowerBoundBps: number; allItemsCorrectEligibleMealWilson95LowerBoundBps: number; eligibleCoverageBps: number; validV3Bps: number };
  rolloutMeasurements: GoldenManifest['rolloutMeasurements'];
  rolloutGates: { categoryStrata: boolean; preparationStrata: boolean; compositeStrata: boolean; abstentionCoverage: boolean; latency: boolean; correction: boolean; block: boolean; privacy: boolean; soak: boolean };
};

export const GOLDEN_V1_PRODUCTION_FLOORS = {
  consentedKoreanMealPhotos: 500,
  foodGroupCases: 50,
  noFood: 10,
  insufficientEvidence: 10,
  quickEligibleMeals: 381,
  quickEligibleItems: 381,
  eligibleFoodTop1Wilson95LowerBoundBps: 9_900,
  portionWithinToleranceWilson95LowerBoundBps: 9_000,
  jointItemWilson95LowerBoundBps: 9_000,
  allItemsCorrectEligibleMealWilson95LowerBoundBps: 8_500,
  eligibleCoverageBps: 1_500,
  validV3Bps: 9_900,
  outcomeAccuracyBps: 9_500,
} as const;

function fail(message: string): never { throw new Error(`Invalid meal-recognition golden input: ${message}`); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function integer(value: unknown, name: string, minimum = 0): number { if (!Number.isInteger(value) || (value as number) < minimum) fail(`${name} must be an integer >= ${minimum}`); return value as number; }
function bps(value: unknown, name: string): number { const result = integer(value, name); if (result > 10_000) fail(`${name} must be <= 10000`); return result; }
function sha(value: unknown, name: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${name} must be a lowercase SHA-256 hex digest`); return value; }
function autoSelectionEvidence(value: unknown): AutoSelectionGoldenEvidence | null {
  if (value === undefined) return null;
  if (!isRecord(value) || typeof value.comparatorVersion !== 'string' || value.comparatorVersion.length === 0 ||
    typeof value.policyVersion !== 'string' || value.policyVersion.length === 0 ||
    !isRecord(value.population) || typeof value.population.version !== 'string' || value.population.version.length === 0 ||
    !isRecord(value.selectedSubset)) fail('manifest.autoSelectionEvidence is invalid');
  const selectedSubset = value.selectedSubset;
  const result = {
    comparatorVersion: value.comparatorVersion,
    policyVersion: value.policyVersion,
    policySha256: sha(value.policySha256, 'manifest.autoSelectionEvidence.policySha256'),
    population: {
      version: value.population.version,
      sha256: sha(value.population.sha256, 'manifest.autoSelectionEvidence.population.sha256'),
    },
    stackSha256: sha(value.stackSha256, 'manifest.autoSelectionEvidence.stackSha256'),
    selectedSubset: {
      selectedMeals: integer(selectedSubset.selectedMeals, 'manifest.autoSelectionEvidence.selectedSubset.selectedMeals'),
      selectedItems: integer(selectedSubset.selectedItems, 'manifest.autoSelectionEvidence.selectedSubset.selectedItems'),
      foodMatches: integer(selectedSubset.foodMatches, 'manifest.autoSelectionEvidence.selectedSubset.foodMatches'),
      fullyCorrectMeals: integer(selectedSubset.fullyCorrectMeals, 'manifest.autoSelectionEvidence.selectedSubset.fullyCorrectMeals'),
    },
    minimumWinnerScoreBps: bps(value.minimumWinnerScoreBps, 'manifest.autoSelectionEvidence.minimumWinnerScoreBps'),
    minimumMarginBps: bps(value.minimumMarginBps, 'manifest.autoSelectionEvidence.minimumMarginBps'),
  };
  if (result.selectedSubset.foodMatches > result.selectedSubset.selectedItems ||
    result.selectedSubset.fullyCorrectMeals > result.selectedSubset.selectedMeals) {
    fail('manifest.autoSelectionEvidence.selectedSubset is inconsistent');
  }
  return result;
}
function outcome(value: unknown, name: string): Outcome { if (value !== 'recognized' && value !== 'no_food' && value !== 'insufficient_evidence') fail(`${name} is invalid`); return value; }
function food(value: unknown, name: string, prediction: boolean): Food {
  if (!isRecord(value) || typeof value.canonicalFoodId !== 'string' || value.canonicalFoodId.length === 0) fail(`${name}.canonicalFoodId is required`);
  const allowedKeys = prediction
    ? new Set(['canonicalFoodId', 'amountGrams', 'foodConfidenceBps', 'portionConfidenceBps', 'foodCandidateMarginBps', 'initialMappingSource', 'resolutionMethod', 'questions', 'unit', 'conversionSourceRegistryId'])
    : new Set(['canonicalFoodId', 'amountGrams']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) fail(`${name} contains unsupported fields`);
  const result: Food = { canonicalFoodId: value.canonicalFoodId, amountGrams: integer(value.amountGrams, `${name}.amountGrams`, 1) };
  if (prediction) {
    result.foodConfidenceBps = bps(value.foodConfidenceBps, `${name}.foodConfidenceBps`);
    result.portionConfidenceBps = bps(value.portionConfidenceBps, `${name}.portionConfidenceBps`);
    if (!Array.isArray(value.questions)) fail(`${name}.questions must be an array`);
    if (value.foodCandidateMarginBps !== null) result.foodCandidateMarginBps = bps(value.foodCandidateMarginBps, `${name}.foodCandidateMarginBps`);
    else result.foodCandidateMarginBps = null;
    if (value.initialMappingSource !== 'model_primary' && value.initialMappingSource !== 'model_alternative') fail(`${name}.initialMappingSource is invalid`);
    result.initialMappingSource = value.initialMappingSource;
    if (value.resolutionMethod !== 'exact' && value.resolutionMethod !== 'lexical') fail(`${name}.resolutionMethod is invalid`);
    result.resolutionMethod = value.resolutionMethod;
    result.questions = value.questions.map((question, index) => {
      if (!isRecord(question) || Object.keys(question).some((key) => key !== 'target') || (question.target !== 'food' && question.target !== 'portion')) fail(`${name}.questions[${index}] is invalid`);
      return { target: question.target };
    });
    if (!['g', 'ml', 'serving', 'bowl', 'piece'].includes(value.unit as string)) fail(`${name}.unit is invalid`);
    result.unit = value.unit as NonNullable<Food['unit']>;
    if (value.conversionSourceRegistryId !== null && (typeof value.conversionSourceRegistryId !== 'string' || value.conversionSourceRegistryId.length === 0)) fail(`${name}.conversionSourceRegistryId is invalid`);
    if (result.unit === 'g' && value.conversionSourceRegistryId !== null) fail(`${name} native grams must not declare conversion provenance`);
    if (result.unit !== 'g' && value.conversionSourceRegistryId === null) fail(`${name} converted units require conversion provenance`);
    result.conversionSourceRegistryId = value.conversionSourceRegistryId;
  }
  return result;
}
function rejectDuplicateFoods(foods: Food[], name: string) {
  if (new Set(foods.map((item) => item.canonicalFoodId)).size !== foods.length) fail(`${name} contains duplicate canonicalFoodId values`);
}
function activationIdentity(value: unknown): ActivationIdentity {
  if (!isRecord(value)) fail('manifest.activationIdentity is required');
  const stringFields = ['observationSchemaVersion', 'promptVersion', 'recognitionModel', 'resolverVersion', 'reviewPolicyVersion', 'normalizerVersion', 'taxonomyVersion'] as const;
  const hashFields = ['resolverSha256', 'reviewPolicySha256', 'normalizerSha256', 'taxonomySha256', 'searchWeightsSha256', 'thresholdSha256', 'catalogReleaseSha256'] as const;
  if (stringFields.some((field) => typeof value[field] !== 'string' || (value[field] as string).length === 0) || hashFields.some((field) => typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field] as string))) fail('manifest.activationIdentity is invalid');
  if (!Array.isArray(value.catalogReleaseIds) || value.catalogReleaseIds.length === 0 || value.catalogReleaseIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(value.catalogReleaseIds).size !== value.catalogReleaseIds.length) fail('manifest.activationIdentity.catalogReleaseIds is invalid');
  if (value.localEncoderManifestSha256 !== undefined && (typeof value.localEncoderManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.localEncoderManifestSha256))) fail('manifest.activationIdentity.localEncoderManifestSha256 is invalid');
  if (!['exact_review', 'hybrid_review', 'vector_shadow', 'hybrid_auto'].includes(value.mappingMode as string)) fail('manifest.activationIdentity.mappingMode is invalid');
  return {
    observationSchemaVersion: value.observationSchemaVersion as string, promptVersion: value.promptVersion as string, recognitionModel: value.recognitionModel as string, resolverVersion: value.resolverVersion as string, resolverSha256: value.resolverSha256 as string, reviewPolicyVersion: value.reviewPolicyVersion as string, reviewPolicySha256: value.reviewPolicySha256 as string, normalizerVersion: value.normalizerVersion as string, normalizerSha256: value.normalizerSha256 as string, taxonomyVersion: value.taxonomyVersion as string, taxonomySha256: value.taxonomySha256 as string, searchWeightsSha256: value.searchWeightsSha256 as string, thresholdSha256: value.thresholdSha256 as string, catalogReleaseIds: value.catalogReleaseIds as string[], catalogReleaseSha256: value.catalogReleaseSha256 as string, ...(value.localEncoderManifestSha256 ? { localEncoderManifestSha256: value.localEncoderManifestSha256 as string } : {}), mappingMode: value.mappingMode as ActivationIdentity['mappingMode'],
  };
}

export function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
export function canonicalSha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function wilsonLowerBoundBps(successes: number, trials: number): number { if (trials === 0) return 0; const z = 1.959963984540054; const p = successes / trials; const denominator = 1 + (z * z) / trials; const centre = p + (z * z) / (2 * trials); const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials); return Math.floor(Math.max(0, (centre - margin) / denominator) * 10_000); }

export function parseManifest(value: unknown): GoldenManifest {
  if (!isRecord(value) || value.version !== 'meal-stack-golden-manifest-v3') fail('manifest.version must be meal-stack-golden-manifest-v3');
  if (value.profile !== 'golden-v1' && value.profile !== 'experiment') fail('manifest.profile must be golden-v1 or experiment');
  const stackFields = ['groundTruthVersion', 'predictionVersion', 'adjudicationVersion', 'registryVersion', 'recognitionModel', 'promptVersion', 'schemaVersion', 'resolverVersion', 'reviewPolicyVersion'] as const;
  if (stackFields.some((field) => typeof value[field] !== 'string' || (value[field] as string).length === 0) || value.provider !== 'openai') fail('manifest versions and recognition stack identities are required');
  const requiredFoodGroups = value.requiredFoodGroups;
  const trustedConversionSourceRegistryIds = value.trustedConversionSourceRegistryIds;
  if (!Array.isArray(requiredFoodGroups) || requiredFoodGroups.some((group) => typeof group !== 'string' || group.length === 0) || new Set(requiredFoodGroups).size !== requiredFoodGroups.length) fail('manifest.requiredFoodGroups must be unique non-empty strings');
  if (!Array.isArray(trustedConversionSourceRegistryIds) || trustedConversionSourceRegistryIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(trustedConversionSourceRegistryIds).size !== trustedConversionSourceRegistryIds.length) fail('manifest.trustedConversionSourceRegistryIds must be unique non-empty strings');
  if (value.profile === 'golden-v1' && requiredFoodGroups.length !== 6) fail('golden-v1 requires exactly six approved food groups');
  const identity = activationIdentity(value.activationIdentity);
  const rolloutMeasurements = value.rolloutMeasurements;
  const measurementNames = ['categoryStrataCases', 'preparationStrataCases', 'compositeCases', 'abstentionCases', 'maxLatencyMs', 'correctionRateBps', 'blockedViolationCount', 'privacyViolationCount', 'forbiddenSelectionCount', 'untrustedSelectionCount', 'soakDays'] as const;
  if (!isRecord(rolloutMeasurements) || measurementNames.some((name) => !Number.isInteger(rolloutMeasurements[name]) || (rolloutMeasurements[name] as number) < 0)) fail('manifest.rolloutMeasurements must contain non-negative measured inputs');
  if (identity.promptVersion !== value.promptVersion || identity.recognitionModel !== value.recognitionModel || identity.resolverVersion !== value.resolverVersion || identity.reviewPolicyVersion !== value.reviewPolicyVersion || identity.observationSchemaVersion !== value.schemaVersion) fail('manifest.activationIdentity must match recognition stack');
  return { version: value.version, profile: value.profile, groundTruthVersion: value.groundTruthVersion as string, predictionVersion: value.predictionVersion as string, adjudicationVersion: value.adjudicationVersion as string, adjudicationSha256: sha(value.adjudicationSha256, 'manifest.adjudicationSha256'), registryVersion: value.registryVersion as string, registrySha256: sha(value.registrySha256, 'manifest.registrySha256'), requiredFoodGroups, recognitionModel: value.recognitionModel as string, promptVersion: value.promptVersion as string, schemaVersion: value.schemaVersion as string, resolverVersion: value.resolverVersion as string, reviewPolicyVersion: value.reviewPolicyVersion as string, provider: value.provider, trustedConversionSourceRegistryIds, activationIdentity: identity, rolloutMeasurements: rolloutMeasurements as GoldenManifest['rolloutMeasurements'] };
}

type GroundTruthCase = { id: string; foodGroup: string; outcome: Outcome; foods: Food[]; consentedKoreanMealPhoto: boolean };
type PredictionCase = { id: string; outcome: Outcome; foods: Food[]; imageQualityConfidenceBps: number };
function parseGroundTruth(value: unknown): { version: string; cases: GroundTruthCase[] } {
  if (!isRecord(value) || typeof value.version !== 'string' || !Array.isArray(value.cases)) fail('ground truth version and cases are required');
  const ids = new Set<string>();
  return { version: value.version, cases: value.cases.map((item, index) => { const name = `groundTruth.cases[${index}]`; if (!isRecord(item) || typeof item.id !== 'string' || typeof item.foodGroup !== 'string' || typeof item.consentedKoreanMealPhoto !== 'boolean' || !Array.isArray(item.foods) || ids.has(item.id)) fail(`${name} is invalid`); ids.add(item.id); const foods = item.foods.map((entry, foodIndex) => food(entry, `${name}.foods[${foodIndex}]`, false)); rejectDuplicateFoods(foods, `${name}.foods`); const result = { id: item.id, foodGroup: item.foodGroup, outcome: outcome(item.outcome, `${name}.outcome`), foods, consentedKoreanMealPhoto: item.consentedKoreanMealPhoto }; if ((result.outcome === 'recognized') !== (result.foods.length > 0)) fail(`${name} foods must be present only for recognized outcomes`); return result; }) };
}
function parsePredictions(value: unknown): { version: string; cases: PredictionCase[] } {
  if (!isRecord(value) || typeof value.version !== 'string' || !Array.isArray(value.cases)) fail('predictions version and cases are required');
  const ids = new Set<string>();
  return { version: value.version, cases: value.cases.map((item, index) => { const name = `predictions.cases[${index}]`; if (!isRecord(item) || Object.keys(item).some((key) => !['id', 'outcome', 'foods', 'imageQualityConfidenceBps'].includes(key)) || typeof item.id !== 'string' || !Array.isArray(item.foods) || ids.has(item.id)) fail(`${name} is invalid`); ids.add(item.id); const foods = item.foods.map((entry, foodIndex) => food(entry, `${name}.foods[${foodIndex}]`, true)); rejectDuplicateFoods(foods, `${name}.foods`); const result = { id: item.id, outcome: outcome(item.outcome, `${name}.outcome`), foods, imageQualityConfidenceBps: bps(item.imageQualityConfidenceBps, `${name}.imageQualityConfidenceBps`) }; if ((result.outcome === 'recognized') !== (result.foods.length > 0)) fail(`${name} foods must be present only for recognized outcomes`); return result; }) };
}

export function evaluateGoldenSet(manifestInput: unknown, groundTruthInput: unknown, predictionsInput: unknown): GoldenReport {
  const selectionEvidence = autoSelectionEvidence(isRecord(manifestInput) ? manifestInput.autoSelectionEvidence : undefined);
  const manifest = parseManifest(manifestInput); const groundTruth = parseGroundTruth(groundTruthInput); const predictions = parsePredictions(predictionsInput);
  if (groundTruth.version !== manifest.groundTruthVersion || predictions.version !== manifest.predictionVersion || predictions.cases.length !== groundTruth.cases.length) fail('input versions or cases do not match manifest');
  const byId = new Map(predictions.cases.map((item) => [item.id, item])); for (const item of groundTruth.cases) if (!byId.has(item.id)) fail('prediction cases must exactly match ground truth case ids');
  // These legacy projection inputs do not contain immutable V3 observations,
  // resolver decisions, or release-bound selector evidence. They are useful
  // diagnostics, but cannot authorize an automatic mapping activation.
  const v3ActivationEvidenceAvailable = false;
  const foodGroupCases: Record<string, number> = Object.fromEntries(manifest.requiredFoodGroups.map((group) => [group, 0])); let consentedKoreanMealPhotos = 0; let noFood = 0; let insufficientEvidence = 0; let quickEligibleMeals = 0; let quickEligibleItems = 0; let eligibleItems = 0; let eligibleMeals = 0; let top1 = 0; let portion = 0; let joint = 0; let allItemsCorrectMeals = 0; let correctOutcomes = 0; let zeroOutcomeQuickFalsePositives = 0; let validV3 = 0; let untrustedConversionEligible = 0;
  for (const expected of groundTruth.cases) {
    const actual = byId.get(expected.id)!; if (expected.consentedKoreanMealPhoto && expected.outcome === 'recognized') { consentedKoreanMealPhotos++; foodGroupCases[expected.foodGroup] = (foodGroupCases[expected.foodGroup] ?? 0) + 1; } if (expected.outcome === 'no_food') noFood++; if (expected.outcome === 'insufficient_evidence') insufficientEvidence++; if (actual.outcome === expected.outcome) correctOutcomes++; if (v3ActivationEvidenceAvailable) validV3++;
    if (expected.outcome !== 'recognized') { if (actual.outcome === 'recognized' && actual.foods.every((food) => isQuickEligible(food, actual.imageQualityConfidenceBps, manifest.trustedConversionSourceRegistryIds))) zeroOutcomeQuickFalsePositives++; continue; }
    const expectedById = new Map(expected.foods.map((food) => [food.canonicalFoodId, food]));
    const mealEligible = actual.outcome === 'recognized' && actual.foods.every((food) => isQuickEligible(food, actual.imageQualityConfidenceBps, manifest.trustedConversionSourceRegistryIds));
    let mealAllCorrect = actual.outcome === 'recognized' && actual.foods.length === expected.foods.length;
    for (const actualFood of actual.foods) {
      const expectedFood = expectedById.get(actualFood.canonicalFoodId);
      const policyEligible = isPolicyEligible(actualFood, actual.imageQualityConfidenceBps);
      const trustedConversion =
        actualFood.unit === 'g' ||
        manifest.trustedConversionSourceRegistryIds.includes(
          actualFood.conversionSourceRegistryId!,
        );
      if (policyEligible && !trustedConversion) untrustedConversionEligible++;
      const eligible = policyEligible && trustedConversion;
      if (eligible) { eligibleItems++; quickEligibleItems++; }
      if (!expectedFood) { mealAllCorrect = false; continue; }
      expectedById.delete(actualFood.canonicalFoodId);
      const portionCorrect = Math.abs(actualFood.amountGrams - expectedFood.amountGrams) <= Math.max(25, expectedFood.amountGrams * 0.2);
      if (!portionCorrect) mealAllCorrect = false;
      if (eligible) { top1++; portion += portionCorrect ? 1 : 0; joint += portionCorrect ? 1 : 0; }
    }
    if (expectedById.size > 0) mealAllCorrect = false;
    if (mealEligible) { eligibleMeals++; quickEligibleMeals++; if (mealAllCorrect) allItemsCorrectMeals++; }
  }
  const metrics = { outcomeAccuracyBps: groundTruth.cases.length === 0 ? 0 : Math.floor(correctOutcomes * 10_000 / groundTruth.cases.length), eligibleFoodTop1Wilson95LowerBoundBps: wilsonLowerBoundBps(top1, eligibleItems), portionWithinToleranceWilson95LowerBoundBps: wilsonLowerBoundBps(portion, eligibleItems), jointItemWilson95LowerBoundBps: wilsonLowerBoundBps(joint, eligibleItems), allItemsCorrectEligibleMealWilson95LowerBoundBps: wilsonLowerBoundBps(allItemsCorrectMeals, eligibleMeals), eligibleCoverageBps: groundTruth.cases.length === 0 ? 0 : Math.floor(eligibleMeals * 10_000 / groundTruth.cases.length), validV3Bps: groundTruth.cases.length === 0 ? 0 : Math.floor(validV3 * 10_000 / groundTruth.cases.length) };
  const measured = manifest.rolloutMeasurements;
  const counts = { consentedKoreanMealPhotos, foodGroupCases, noFood, insufficientEvidence, quickEligibleMeals, quickEligibleItems, eligibleItems, eligibleMeals, zeroOutcomeQuickFalsePositives, nutritionOrIdErrors: measured.forbiddenSelectionCount, forbiddenSelectionCount: measured.forbiddenSelectionCount, untrustedConversionEligible, untrustedSelectionCount: measured.untrustedSelectionCount + untrustedConversionEligible, sensitiveReportLeakage: measured.privacyViolationCount };
  const rolloutGates = { categoryStrata: measured.categoryStrataCases >= 120, preparationStrata: measured.preparationStrataCases >= 120, compositeStrata: measured.compositeCases >= 20, abstentionCoverage: measured.abstentionCases >= 20, latency: measured.maxLatencyMs <= 2_000, correction: measured.correctionRateBps <= 1_000, block: measured.blockedViolationCount === 0, privacy: measured.privacyViolationCount === 0, soak: measured.soakDays >= 7 };
  const failures = manifest.profile === 'golden-v1' ? [
    [v3ActivationEvidenceAvailable, 'V3_ACTIVATION_EVIDENCE_UNAVAILABLE: predictions lack immutable V3 observation, resolver decision, and active-release selector evidence'],
    [counts.consentedKoreanMealPhotos >= GOLDEN_V1_PRODUCTION_FLOORS.consentedKoreanMealPhotos, `consented Korean meal photos ${counts.consentedKoreanMealPhotos} < 500`],
    ...manifest.requiredFoodGroups.map((group) => [(counts.foodGroupCases[group] ?? 0) >= GOLDEN_V1_PRODUCTION_FLOORS.foodGroupCases, `food group ${group} ${counts.foodGroupCases[group] ?? 0} < 50`] as const),
    [counts.noFood >= GOLDEN_V1_PRODUCTION_FLOORS.noFood, `no_food ${counts.noFood} < 10`], [counts.insufficientEvidence >= GOLDEN_V1_PRODUCTION_FLOORS.insufficientEvidence, `insufficient_evidence ${counts.insufficientEvidence} < 10`], [counts.quickEligibleMeals >= 381, `quick eligible non-exact meals ${counts.quickEligibleMeals} < 381`], [counts.quickEligibleItems >= 381, `quick eligible non-exact items ${counts.quickEligibleItems} < 381`], [counts.eligibleItems >= 381, `eligible non-exact items ${counts.eligibleItems} < 381`], [top1 === eligibleItems, `eligible food matches ${top1} must equal eligible items ${eligibleItems}`], [counts.forbiddenSelectionCount === 0, `forbidden selections ${counts.forbiddenSelectionCount} must equal 0`], [counts.untrustedSelectionCount === 0, `untrusted selections ${counts.untrustedSelectionCount} must equal 0`], [metrics.outcomeAccuracyBps >= GOLDEN_V1_PRODUCTION_FLOORS.outcomeAccuracyBps, `outcome accuracy ${metrics.outcomeAccuracyBps} < 9500`], [metrics.eligibleFoodTop1Wilson95LowerBoundBps >= 9_900, `eligible food top-1 Wilson95 lower bound ${metrics.eligibleFoodTop1Wilson95LowerBoundBps} < 9900`], [metrics.portionWithinToleranceWilson95LowerBoundBps >= 9_000, `portion Wilson95 lower bound ${metrics.portionWithinToleranceWilson95LowerBoundBps} < 9000`], [metrics.jointItemWilson95LowerBoundBps >= 9_000, `joint item Wilson95 lower bound ${metrics.jointItemWilson95LowerBoundBps} < 9000`], [metrics.allItemsCorrectEligibleMealWilson95LowerBoundBps >= 8_500, `all-items-correct eligible meal Wilson95 lower bound ${metrics.allItemsCorrectEligibleMealWilson95LowerBoundBps} < 8500`], [metrics.eligibleCoverageBps >= 1_500, `eligible coverage ${metrics.eligibleCoverageBps} < 1500`], [counts.zeroOutcomeQuickFalsePositives === 0, `zero-outcome quick false positives ${counts.zeroOutcomeQuickFalsePositives} > 0`], [metrics.validV3Bps >= 9_900, `valid V3 ${metrics.validV3Bps} < 9900`], [counts.nutritionOrIdErrors === 0, `nutrition/ID errors ${counts.nutritionOrIdErrors} > 0`], [counts.untrustedConversionEligible === 0, `untrusted conversion eligible ${counts.untrustedConversionEligible} > 0`], [counts.sensitiveReportLeakage === 0, `sensitive report leakage ${counts.sensitiveReportLeakage} > 0`],
    ...Object.entries(rolloutGates).map(([name, passed]) => [passed, `rollout gate ${name} failed`] as const),
  ].filter(([passed]) => !passed).map(([, message]) => message as string) : [];
  const provenance = { manifestSha256: canonicalSha256(manifest), groundTruthSha256: canonicalSha256(groundTruth), predictionsSha256: canonicalSha256(predictions), adjudicationVersion: manifest.adjudicationVersion, adjudicationSha256: manifest.adjudicationSha256, registryVersion: manifest.registryVersion, registrySha256: manifest.registrySha256, provider: manifest.provider, recognitionModel: manifest.recognitionModel, promptVersion: manifest.promptVersion, schemaVersion: manifest.schemaVersion, resolverVersion: manifest.resolverVersion, reviewPolicyVersion: manifest.reviewPolicyVersion, activationIdentity: manifest.activationIdentity, autoSelectionEvidence: selectionEvidence };
  const autoSelectionPolicy = selectionEvidence === null ? null : {
    version: selectionEvidence.policyVersion,
    comparatorVersion: selectionEvidence.comparatorVersion,
    minimumWinnerScoreBps: selectionEvidence.minimumWinnerScoreBps,
    minimumMarginBps: selectionEvidence.minimumMarginBps,
    identitySha256: selectionEvidence.policySha256,
  };
  const inputSha256 = canonicalSha256({ manifest, groundTruth, predictions, selectionEvidence }); const passed = v3ActivationEvidenceAvailable && failures.length === 0; const unsignedReport = { version: 'meal-stack-golden-report-v3' as const, mode: manifest.profile === 'golden-v1' ? 'production' as const : 'experiment' as const, result: v3ActivationEvidenceAvailable && passed ? 'passed' as const : manifest.profile === 'golden-v1' ? 'failed' as const : 'evaluated' as const, provenance, autoSelectionPolicy, inputSha256, passed, failures, counts, metrics, rolloutMeasurements: measured, rolloutGates }; return { ...unsignedReport, reportSha256: canonicalSha256(unsignedReport) };
}

function isQuickEligible(
  food: Food,
  imageQualityConfidenceBps: number,
  trustedConversionSourceRegistryIds: string[],
) {
  return (
    isPolicyEligible(food, imageQualityConfidenceBps) &&
    (food.unit === 'g' ||
      trustedConversionSourceRegistryIds.includes(food.conversionSourceRegistryId!))
  );
}

function isPolicyEligible(food: Food, imageQualityConfidenceBps: number) {
  return (
    imageQualityConfidenceBps >=
      MEAL_REVIEW_POLICY_THRESHOLDS.minImageQualityConfidenceBps &&
    food.foodConfidenceBps! >= MEAL_REVIEW_POLICY_THRESHOLDS.minFoodConfidenceBps &&
    food.portionConfidenceBps! >=
      MEAL_REVIEW_POLICY_THRESHOLDS.minPortionConfidenceBps &&
    (food.foodCandidateMarginBps === null ||
      food.foodCandidateMarginBps! >=
        MEAL_REVIEW_POLICY_THRESHOLDS.minFoodCandidateMarginBps) &&
    food.initialMappingSource === 'model_primary' &&
    food.resolutionMethod === 'lexical' &&
    food.questions!.length === 0
  );
}

export async function evaluateGoldenFiles(manifestPath: string, groundTruthPath: string, predictionsPath: string, reportPath?: string): Promise<GoldenReport> { const [manifest, groundTruth, predictions] = await Promise.all([manifestPath, groundTruthPath, predictionsPath].map(async (path) => JSON.parse(await readFile(path, 'utf8')))); const report = evaluateGoldenSet(manifest, groundTruth, predictions); if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); return report; }
if (import.meta.main) { const [manifestPath, groundTruthPath, predictionsPath, reportPath] = Bun.argv.slice(2); if (!manifestPath || !groundTruthPath || !predictionsPath || !reportPath) throw new Error('Usage: bun scripts/evaluate-meal-recognition-golden.ts <manifest.json> <ground-truth.json> <predictions.json> <report.json>'); const report = await evaluateGoldenFiles(manifestPath, groundTruthPath, predictionsPath, reportPath); process.exitCode = report.passed ? 0 : 1; }
