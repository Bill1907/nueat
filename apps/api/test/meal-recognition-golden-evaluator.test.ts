import { describe, expect, test } from 'bun:test';
import { evaluateGoldenSet, wilsonLowerBoundBps } from '../scripts/evaluate-meal-recognition-golden';

const sha = 'a'.repeat(64);
const groups = ['grain', 'vegetable', 'fruit', 'protein', 'dairy', 'fat'];
const manifest = {
  version: 'meal-recognition-golden-manifest-v2' as const,
  profile: 'golden-v1' as const,
  groundTruthVersion: 'ground-truth-v2',
  predictionVersion: 'prediction-v2',
  adjudicationVersion: 'adjudication-v2',
  adjudicationSha256: sha,
  registryVersion: 'registry-v2',
  registrySha256: sha,
  requiredFoodGroups: groups,
  recognitionModel: 'gpt-test',
  promptVersion: 'meal-recognition-prompt-v2',
  schemaVersion: 'meal-recognition-schema-v2',
  resolverVersion: 'meal-item-resolution-v1',
  reviewPolicyVersion: 'meal-estimate-review-v1',
  provider: 'openai' as const,
  trustedConversionSourceRegistryIds: ['registry-source-1'],
};

function passingInputs() {
  const cases = [
    ...Array.from({ length: 120 }, (_, index) => ({ id: `meal-${index}`, foodGroup: groups[index % groups.length], outcome: 'recognized' as const, foods: [{ canonicalFoodId: `food-${index}`, amountGrams: 100 }], consentedKoreanMealPhoto: true })),
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
  test('passes exact V2 production gates with aggregate-only provenance', () => {
    const { groundTruth, predictions } = passingInputs();
    const report = evaluateGoldenSet(manifest, groundTruth, predictions);
    expect(report.passed).toBe(true);
    expect(report.mode).toBe('production');
    expect(report.result).toBe('passed');
    expect(report.counts).toMatchObject({ consentedKoreanMealPhotos: 120, quickEligibleMeals: 120, quickEligibleItems: 120, noFood: 10, insufficientEvidence: 10, zeroOutcomeQuickFalsePositives: 0 });
    expect(report.metrics.eligibleFoodTop1Wilson95LowerBoundBps).toBeGreaterThanOrEqual(9_500);
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
    expect(experiment.passed).toBe(true);
  });

  test('rejects V2 manifests without independent adjudication and registry SHA provenance', () => {
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
    expect(missingItemReport.counts.eligibleMeals).toBe(120);
    expect(
      missingItemReport.metrics.allItemsCorrectEligibleMealWilson95LowerBoundBps,
    ).toBeLessThan(wilsonLowerBoundBps(120, 120));

    const swapped = passingInputs();
    for (let index = 0; index < 8; index++) {
      swapped.predictions.cases[120 + index]!.outcome = 'insufficient_evidence';
    }
    const outcomeReport = evaluateGoldenSet(manifest, swapped.groundTruth, swapped.predictions);
    expect(outcomeReport.metrics.outcomeAccuracyBps).toBeLessThan(9_500);
    expect(outcomeReport.failures.some((failure) => failure.startsWith('outcome accuracy'))).toBe(
      true,
    );
  });

  test('uses the exact runtime review-policy threshold edges', () => {
    const exact = passingInputs();
    expect(evaluateGoldenSet(manifest, exact.groundTruth, exact.predictions).counts.quickEligibleMeals).toBe(120);

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
      expect(evaluateGoldenSet(manifest, below.groundTruth, below.predictions).counts.quickEligibleMeals).toBe(119);
    }
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
    for (let index = 0; index < 20; index++) {
      zeroOutcomeGroups.groundTruth.cases[index]!.consentedKoreanMealPhoto = false;
      zeroOutcomeGroups.groundTruth.cases[120 + (index % 10)]!.consentedKoreanMealPhoto = true;
      zeroOutcomeGroups.groundTruth.cases[120 + (index % 10)]!.foodGroup = 'grain';
    }
    const groupedReport = evaluateGoldenSet(
      manifest,
      zeroOutcomeGroups.groundTruth,
      zeroOutcomeGroups.predictions,
    );
    expect(groupedReport.counts.consentedKoreanMealPhotos).toBe(100);
    expect(groupedReport.failures).toContain('consented Korean meal photos 100 < 120');
  });
});
