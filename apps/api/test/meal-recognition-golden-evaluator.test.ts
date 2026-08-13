import { describe, expect, test } from 'bun:test';
import { evaluateGoldenSet, wilsonLowerBoundBps } from '../scripts/evaluate-meal-recognition-golden';

const sha = 'a'.repeat(64);
const groups = ['grain', 'vegetable', 'fruit', 'protein', 'dairy', 'fat'];
const manifest = {
  version: 'meal-stack-golden-manifest-v3' as const,
  profile: 'golden-v1' as const,
  groundTruthVersion: 'ground-truth-v2',
  predictionVersion: 'prediction-v2',
  adjudicationVersion: 'adjudication-v2',
  adjudicationSha256: sha,
  registryVersion: 'registry-v2',
  registrySha256: sha,
  requiredFoodGroups: groups,
  recognitionModel: 'gpt-test',
  promptVersion: 'meal-recognition-prompt-v3',
  schemaVersion: 'meal-recognition-schema-v3',
  resolverVersion: 'meal-item-resolution-v1',
  reviewPolicyVersion: 'meal-estimate-review-v1',
  provider: 'openai' as const,
  trustedConversionSourceRegistryIds: ['registry-source-1'],
  activationIdentity: {
    observationSchemaVersion: 'meal-recognition-schema-v3', promptVersion: 'meal-recognition-prompt-v3', recognitionModel: 'gpt-test', resolverVersion: 'meal-item-resolution-v1', resolverSha256: sha, reviewPolicyVersion: 'meal-estimate-review-v1', reviewPolicySha256: sha, normalizerVersion: 'normalizer-v1', normalizerSha256: sha, taxonomyVersion: 'taxonomy-v1', taxonomySha256: sha, searchWeightsSha256: sha, thresholdSha256: sha, catalogReleaseIds: ['official@2026-01'], catalogReleaseSha256: sha, mappingMode: 'hybrid_auto' as const,
  },
  rolloutMeasurements: { categoryStrataCases: 120, preparationStrataCases: 120, compositeCases: 20, abstentionCases: 20, maxLatencyMs: 2_000, correctionRateBps: 1_000, blockedViolationCount: 0, privacyViolationCount: 0, forbiddenSelectionCount: 0, untrustedSelectionCount: 0, soakDays: 7 },
};

function passingInputs() {
  const cases = [
    ...Array.from({ length: 500 }, (_, index) => ({ id: `meal-${index}`, foodGroup: groups[index % groups.length], outcome: 'recognized' as const, foods: [{ canonicalFoodId: `food-${index}`, amountGrams: 100 }], consentedKoreanMealPhoto: true })),
    ...Array.from({ length: 10 }, (_, index) => ({ id: `no-food-${index}`, foodGroup: 'grain', outcome: 'no_food' as const, foods: [], consentedKoreanMealPhoto: false })),
    ...Array.from({ length: 10 }, (_, index) => ({ id: `insufficient-${index}`, foodGroup: 'grain', outcome: 'insufficient_evidence' as const, foods: [], consentedKoreanMealPhoto: false })),
  ];
  return {
    groundTruth: { version: 'ground-truth-v2', cases },
    predictions: {
      version: 'prediction-v2',
      cases: cases.map((item) => ({
        id: item.id,
        outcome: item.outcome,
        foods: item.foods.map((food) => ({
          ...food,
          foodConfidenceBps: 9_000,
          portionConfidenceBps: 9_000,
          foodCandidateMarginBps: 1_000,
          initialMappingSource: 'model_primary' as const,
          resolutionMethod: 'lexical' as const,
          questions: [],
          unit: 'g' as const,
          conversionSourceRegistryId: null,
        })),
        imageQualityConfidenceBps: 7_000,
      })),
    },
  };
}

describe('meal recognition golden evaluator', () => {
  test('keeps legacy aggregate projections non-activating without immutable V3 evidence', () => {
    const { groundTruth, predictions } = passingInputs();
    const report = evaluateGoldenSet(manifest, groundTruth, predictions);
    expect(report.passed).toBe(false);
    expect(report.mode).toBe('production');
    expect(report.result).toBe('failed');
    expect(report.failures).toContain(
      'V3_ACTIVATION_EVIDENCE_UNAVAILABLE: predictions lack immutable V3 observation, resolver decision, and active-release selector evidence',
    );
    expect(report.counts).toMatchObject({ consentedKoreanMealPhotos: 500, quickEligibleMeals: 500, quickEligibleItems: 500, noFood: 10, insufficientEvidence: 10, zeroOutcomeQuickFalsePositives: 0 });
    expect(report.metrics.eligibleFoodTop1Wilson95LowerBoundBps).toBeGreaterThanOrEqual(9_900);
    expect(JSON.stringify(report)).not.toContain('food-0');
    expect(report.reportSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('does not allow any production floor to be lowered at its exact boundary', () => {
    const { groundTruth, predictions } = passingInputs();
    groundTruth.cases.pop();
    predictions.cases.pop();
    const report = evaluateGoldenSet(manifest, groundTruth, predictions);
    expect(report.passed).toBe(false);
    expect(report.failures).toContain('insufficient_evidence 9 < 10');

    const experiment = evaluateGoldenSet({ ...manifest, profile: 'experiment' }, groundTruth, predictions);
    expect(experiment.mode).toBe('experiment');
    expect(experiment.result).toBe('evaluated');
    expect(experiment.passed).toBe(false);
  });

  test('rejects V3 manifests without independent adjudication and registry SHA provenance', () => {
    const { groundTruth, predictions } = passingInputs();
    expect(() => evaluateGoldenSet({ ...manifest, adjudicationSha256: 'not-a-hash' }, groundTruth, predictions)).toThrow('adjudicationSha256');
    expect(wilsonLowerBoundBps(100, 100)).toBeGreaterThanOrEqual(9_500);
  });

  test('rejects duplicate food IDs and unsupported prediction fields', () => {
    const { groundTruth, predictions } = passingInputs();
    predictions.cases[0]!.foods.push({ ...predictions.cases[0]!.foods[0]! });
    expect(() => evaluateGoldenSet(manifest, groundTruth, predictions)).toThrow(
      'duplicate canonicalFoodId',
    );

    const clean = passingInputs();
    Object.assign(clean.predictions.cases[0]!.foods[0]!, { calories: 100 });
    expect(() => evaluateGoldenSet(manifest, clean.groundTruth, clean.predictions)).toThrow(
      'unsupported fields',
    );
  });

  test('counts eligible missing-item meals as incorrect and enforces outcome accuracy', () => {
    const { groundTruth, predictions } = passingInputs();
    (groundTruth.cases[0]!.foods as Array<{ canonicalFoodId: string; amountGrams: number }>).push(
      { canonicalFoodId: 'missing-food', amountGrams: 100 },
    );
    const missingItemReport = evaluateGoldenSet(manifest, groundTruth, predictions);
    expect(missingItemReport.counts.eligibleMeals).toBe(500);
    expect(
      missingItemReport.metrics.allItemsCorrectEligibleMealWilson95LowerBoundBps,
    ).toBeLessThan(wilsonLowerBoundBps(500, 500));

    const swapped = passingInputs();
    for (let index = 0; index < 10; index++) {
      swapped.predictions.cases[500 + index]!.outcome = 'insufficient_evidence';
      swapped.predictions.cases[510 + index]!.outcome = 'no_food';
    }
    swapped.predictions.cases[0]!.outcome = 'insufficient_evidence';
    swapped.predictions.cases[0]!.foods = [];
    for (let index = 1; index <= 10; index++) {
      swapped.predictions.cases[index]!.outcome = 'insufficient_evidence';
      swapped.predictions.cases[index]!.foods = [];
    }
    const outcomeReport = evaluateGoldenSet(manifest, swapped.groundTruth, swapped.predictions);
    expect(outcomeReport.metrics.outcomeAccuracyBps).toBeLessThan(9_500);
    expect(outcomeReport.failures.some((failure) => failure.startsWith('outcome accuracy'))).toBe(
      true,
    );
  });

  test('uses the exact runtime review-policy threshold edges', () => {
    const exact = passingInputs();
    expect(evaluateGoldenSet(manifest, exact.groundTruth, exact.predictions).counts.quickEligibleMeals).toBe(500);

    for (const mutate of [
      (input: ReturnType<typeof passingInputs>) => { input.predictions.cases[0]!.imageQualityConfidenceBps = 6_999; },
      (input: ReturnType<typeof passingInputs>) => { input.predictions.cases[0]!.foods[0]!.foodConfidenceBps = 6_999; },
      (input: ReturnType<typeof passingInputs>) => { input.predictions.cases[0]!.foods[0]!.portionConfidenceBps = 6_999; },
      (input: ReturnType<typeof passingInputs>) => { input.predictions.cases[0]!.foods[0]!.foodCandidateMarginBps = 999; },
      (input: ReturnType<typeof passingInputs>) => {
        (input.predictions.cases[0]!.foods[0]! as {
          initialMappingSource: 'model_primary' | 'model_alternative';
        }).initialMappingSource = 'model_alternative';
      },
    ]) {
      const below = passingInputs();
      mutate(below);
      expect(evaluateGoldenSet(manifest, below.groundTruth, below.predictions).counts.quickEligibleMeals).toBe(499);
    }

    const exactOnly = passingInputs();
    (exactOnly.predictions.cases[0]!.foods[0]! as { resolutionMethod: 'exact' | 'lexical' }).resolutionMethod = 'exact';
    expect(evaluateGoldenSet(manifest, exactOnly.groundTruth, exactOnly.predictions).counts.quickEligibleItems).toBe(499);
  });

  test('binds counter and rollout evidence instead of accepting gate booleans', () => {
    const { groundTruth, predictions } = passingInputs();
    const report = evaluateGoldenSet({
      ...manifest,
      rolloutMeasurements: { ...manifest.rolloutMeasurements, forbiddenSelectionCount: 1 },
    }, groundTruth, predictions);
    expect(report.counts.forbiddenSelectionCount).toBe(1);
    expect(report.failures).toContain('forbidden selections 1 must equal 0');
    expect(report.rolloutMeasurements.forbiddenSelectionCount).toBe(1);
  });

  test('derives conversion trust from the manifest registry and excludes zero outcomes from food-group strata', () => {
    const untrusted = passingInputs();
    const untrustedFood = untrusted.predictions.cases[0]!.foods[0]! as {
      unit: 'g' | 'serving';
      conversionSourceRegistryId: string | null;
    };
    untrustedFood.unit = 'serving';
    untrustedFood.conversionSourceRegistryId = 'unknown-registry';
    const untrustedReport = evaluateGoldenSet(
      manifest,
      untrusted.groundTruth,
      untrusted.predictions,
    );
    expect(untrustedReport.counts.untrustedConversionEligible).toBe(1);
    expect(untrustedReport.passed).toBe(false);
    const missingConversion = passingInputs();
    (missingConversion.predictions.cases[0]!.foods[0]! as {
      unit: 'g' | 'serving';
    }).unit = 'serving';
    expect(() => evaluateGoldenSet(
      manifest,
      missingConversion.groundTruth,
      missingConversion.predictions,
    )).toThrow('converted units require conversion provenance');

    const zeroOutcomeGroups = passingInputs();
    for (let index = 0; index < 390; index++) {
      zeroOutcomeGroups.groundTruth.cases[index]!.consentedKoreanMealPhoto = false;
      zeroOutcomeGroups.groundTruth.cases[500 + (index % 10)]!.consentedKoreanMealPhoto = true;
      zeroOutcomeGroups.groundTruth.cases[500 + (index % 10)]!.foodGroup = 'grain';
    }
    const groupedReport = evaluateGoldenSet(
      manifest,
      zeroOutcomeGroups.groundTruth,
      zeroOutcomeGroups.predictions,
    );
    expect(groupedReport.counts.consentedKoreanMealPhotos).toBe(110);
    expect(groupedReport.failures).toContain('consented Korean meal photos 110 < 500');
  });
});
