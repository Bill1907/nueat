import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { canonicalSha256 } from '../scripts/evaluate-meal-recognition-golden';
import { parseEnvironment } from '../src/config/env';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api-nueat.boseong.dev',
  RESEND_API_KEY: 're_test',
  S3_ENDPOINT: 'https://storage.railway.app',
  S3_BUCKET: 'nueat-test',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
};

const approvalKeyId = 'meal-recognition-release-key-v1';
const approvalKeys = generateKeyPairSync('ed25519');
const approvalPublicKey = approvalKeys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
const activationIdentity = {
  observationSchemaVersion: 'meal-recognition-schema-v3', promptVersion: 'meal-recognition-prompt-v3', recognitionModel: 'gpt-5.4-mini-2026-03-17', resolverVersion: 'meal-item-resolution-v1', resolverSha256: '1'.repeat(64), reviewPolicyVersion: 'meal-review-policy-v1', reviewPolicySha256: '2'.repeat(64), normalizerVersion: 'normalizer-v1', normalizerSha256: '3'.repeat(64), taxonomyVersion: 'taxonomy-v1', taxonomySha256: '4'.repeat(64), searchWeightsSha256: '5'.repeat(64), thresholdSha256: '6'.repeat(64), catalogReleaseIds: ['official@2026-01'], catalogReleaseSha256: 'e'.repeat(64), mappingMode: 'hybrid_auto',
};
const autoSelectionPolicy = {
  version: 'catalog-auto-selection-policy-v1',
  comparatorVersion: 'catalog-auto-selection-comparator-v1',
  minimumWinnerScoreBps: 9_000,
  minimumMarginBps: 1_000,
  identitySha256: '9'.repeat(64),
};

function approvedReceipt(change: Record<string, unknown> = {}) {
  const unsignedReport = {
    version: 'meal-stack-golden-report-v3', mode: 'production', result: 'passed', passed: true, failures: [],
    provenance: {
      manifestSha256: 'a'.repeat(64),
      groundTruthSha256: 'b'.repeat(64),
      predictionsSha256: 'c'.repeat(64),
      adjudicationVersion: 'adjudication-v2',
      adjudicationSha256: 'd'.repeat(64),
      registryVersion: 'registry-v2',
      registrySha256: 'e'.repeat(64),
      provider: 'openai',
      recognitionModel: 'gpt-5.4-mini-2026-03-17',
      promptVersion: 'meal-recognition-prompt-v3',
      schemaVersion: 'meal-recognition-schema-v3',
      resolverVersion: 'meal-item-resolution-v1',
      reviewPolicyVersion: 'meal-review-policy-v1',
      activationIdentity,
      autoSelectionEvidence: {
        policyVersion: autoSelectionPolicy.version,
        comparatorVersion: autoSelectionPolicy.comparatorVersion,
        policySha256: autoSelectionPolicy.identitySha256,
        minimumWinnerScoreBps: autoSelectionPolicy.minimumWinnerScoreBps,
        minimumMarginBps: autoSelectionPolicy.minimumMarginBps,
        population: { version: 'selected-v1', sha256: '8'.repeat(64) },
        stackSha256: '7'.repeat(64),
        selectedSubset: {
          selectedMeals: 381,
          selectedItems: 381,
          foodMatches: 381,
          fullyCorrectMeals: 381,
        },
      },
    },
    inputSha256: 'f'.repeat(64),
    counts: { consentedKoreanMealPhotos: 500, foodGroupCases: { grain: 50, vegetable: 50, fruit: 50, protein: 50, dairy: 50, fat: 50 }, noFood: 10, insufficientEvidence: 10, quickEligibleMeals: 381, quickEligibleItems: 381, eligibleItems: 381, eligibleMeals: 381, zeroOutcomeQuickFalsePositives: 0, nutritionOrIdErrors: 0, forbiddenSelectionCount: 0, untrustedConversionEligible: 0, untrustedSelectionCount: 0, sensitiveReportLeakage: 0 },
    metrics: { outcomeAccuracyBps: 9_500, eligibleFoodTop1Wilson95LowerBoundBps: 9_900, portionWithinToleranceWilson95LowerBoundBps: 9_000, jointItemWilson95LowerBoundBps: 9_000, allItemsCorrectEligibleMealWilson95LowerBoundBps: 8_500, eligibleCoverageBps: 1_500, validV3Bps: 9_900 },
    rolloutMeasurements: { categoryStrataCases: 120, preparationStrataCases: 120, compositeCases: 20, abstentionCases: 20, maxLatencyMs: 2_000, correctionRateBps: 1_000, blockedViolationCount: 0, privacyViolationCount: 0, forbiddenSelectionCount: 0, untrustedSelectionCount: 0, soakDays: 7 },
    rolloutGates: { categoryStrata: true, preparationStrata: true, compositeStrata: true, abstentionCoverage: true, latency: true, correction: true, block: true, privacy: true, soak: true },
    autoSelectionPolicy,
    ...change,
  };
  const reportSha256 = canonicalSha256(unsignedReport);
  return {
    ...unsignedReport,
    reportSha256,
    approval: {
      keyId: approvalKeyId,
      signatureBase64: sign(
        null,
        Buffer.from(reportSha256, 'utf8'),
        approvalKeys.privateKey,
      ).toString('base64'),
    },
  };
}

function hybridAutoEnvironment(receipt: ReturnType<typeof approvedReceipt>) {
  return {
    ...validEnvironment,
    NODE_ENV: 'production',
    MEAL_RECOGNITION_MODE: 'openai',
    OPENAI_API_KEY: 'test-openai-key',
    MEAL_RECOGNITION_APPROVED_REPORT_SHA256: receipt.reportSha256,
    MEAL_RECOGNITION_ACTIVE_REPORT_SHA256: receipt.reportSha256,
    MEAL_RECOGNITION_APPROVED_REPORT_VERSION: 'meal-stack-golden-report-v3',
    MEAL_RECOGNITION_APPROVED_REPORT_JSON: JSON.stringify(receipt),
    MEAL_RECOGNITION_APPROVAL_KEY_ID: approvalKeyId,
    MEAL_RECOGNITION_APPROVAL_PUBLIC_KEY: approvalPublicKey,
    MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION: receipt.provenance.registryVersion,
    MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256: receipt.provenance.registrySha256,
    MEAL_RECOGNITION_MAPPING_MODE: 'hybrid_auto',
    MEAL_RECOGNITION_ACTIVATION_IDENTITY_JSON: JSON.stringify(activationIdentity),
  };
}

describe('parseEnvironment', () => {
  test('defaults meal recognition, cutover mode, and maintenance retry metadata', () => {
    const result = parseEnvironment({ ...validEnvironment, OPENAI_API_KEY: '' });
    expect(result.mealRecognition).toMatchObject({ mode: 'mock', apiKey: undefined, model: 'gpt-5.4-mini-2026-03-17', deadlineMs: 20_000, maxOutputTokens: 2_000, maxAttempts: 2, dailyAttemptQuota: 20, reviewPolicy: { mode: 'review_only', approvedReportSha256: undefined, activeReportSha256: undefined, approvedReportVersion: undefined, approvedReportReceipt: null } });
    expect(result.mealConfirmationCutover).toEqual({
      mode: 'normal',
      retryAfterSeconds: 60,
    });
  });

  test('passes a configured model ID through in review-only mode', () => {
    const result = parseEnvironment({
      ...validEnvironment,
      MEAL_RECOGNITION_MODE: 'openai',
      OPENAI_API_KEY: 'test-openai-key',
      OPENAI_MODEL: 'gpt-5.4-mini',
    });
    expect(result.mealRecognition.model).toBe('gpt-5.4-mini');
  });

  test('accepts production hybrid_auto only with a canonical passing V3 approval receipt bound to both SHA values', () => {
    const receipt = approvedReceipt();
    const result = parseEnvironment(hybridAutoEnvironment(receipt));
    expect(result.mealRecognition.reviewPolicy).toMatchObject({ mode: 'auto_selection', approvedReportSha256: receipt.reportSha256, activeReportSha256: receipt.reportSha256, approvedReportVersion: 'meal-stack-golden-report-v3', approvedReportReceipt: receipt });
  });

  test('fails closed for tampered, unsigned, mismatched-stack, and failed receipts while review_only rolls back immediately', () => {
    const receipt = approvedReceipt();
    const invalid = (change: Record<string, unknown>) => {
      const changedReceipt = approvedReceipt(change);
      expect(() => parseEnvironment(hybridAutoEnvironment(changedReceipt))).toThrow(
        'authority-signed',
      );
    };
    invalid({ result: 'evaluated', mode: 'experiment' });
    invalid({ passed: false, result: 'failed', failures: ['gate'] });
    invalid({ counts: { ...receipt.counts, quickEligibleItems: 99 } });
    invalid({ version: 'meal-recognition-golden-report-v2' });
    invalid({ provenance: { ...receipt.provenance, promptVersion: 'old-prompt' } });
    invalid({ provenance: { ...receipt.provenance, provider: 'mock' } });
    expect(() => parseEnvironment({
      ...hybridAutoEnvironment(receipt),
      MEAL_RECOGNITION_MODE: 'mock',
      OPENAI_API_KEY: undefined,
    })).toThrow('OpenAI mode');
    expect(() => parseEnvironment({
      ...hybridAutoEnvironment(receipt),
      MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256: '9'.repeat(64),
    })).toThrow('exact deployed stack');

    const forged = { ...receipt, approval: { ...receipt.approval, signatureBase64: Buffer.alloc(64).toString('base64') } };
    expect(() => parseEnvironment(hybridAutoEnvironment(forged))).toThrow(
      'authority-signed',
    );
    expect(parseEnvironment({ ...validEnvironment, NODE_ENV: 'production' }).mealRecognition.reviewPolicy.mode).toBe('review_only');
  });

  test('fails closed when the signed auto-selection policy carrier does not match selected-subset evidence', () => {
    const receipt = approvedReceipt();
    const invalid = (change: Record<string, unknown>) =>
      expect(() => parseEnvironment(hybridAutoEnvironment(approvedReceipt(change)))).toThrow(
        'hybrid-auto evidence',
      );

    invalid({ autoSelectionPolicy: { ...autoSelectionPolicy, comparatorVersion: 'other' } });
    invalid({ autoSelectionPolicy: { ...autoSelectionPolicy, minimumWinnerScoreBps: 8_999 } });
    invalid({ autoSelectionPolicy: { ...autoSelectionPolicy, minimumMarginBps: 999 } });
    invalid({ autoSelectionPolicy: { ...autoSelectionPolicy, identitySha256: '0'.repeat(64) } });
    invalid({
      provenance: {
        ...receipt.provenance,
        autoSelectionEvidence: {
          ...(receipt.provenance.autoSelectionEvidence as Record<string, unknown>),
          selectedSubset: { selectedMeals: 0, selectedItems: 0, foodMatches: 0, fullyCorrectMeals: 0 },
        },
      },
    });
  });

  test('requires an OpenAI key in openai mode and rejects partial bucket credentials', () => {
    expect(() => parseEnvironment({ ...validEnvironment, MEAL_RECOGNITION_MODE: 'openai' })).toThrow('OPENAI_API_KEY is required');
    expect(() => parseEnvironment({ ...validEnvironment, S3_SECRET_ACCESS_KEY: undefined })).toThrow('must be set together');
  });

  test('fails closed when unavailable vector shadow is configured', () => {
    expect(() => parseEnvironment({ ...validEnvironment, VECTOR_SHADOW_MODE: 'shadow' })).toThrow(
      'VECTOR_SHADOW_UNAVAILABLE',
    );
    expect(() => parseEnvironment({ ...validEnvironment, MEAL_RECOGNITION_MAPPING_MODE: 'vector_shadow' })).toThrow(
      'VECTOR_SHADOW_UNAVAILABLE',
    );
  });

  test('accepts each cutover mode and validates maintenance retry seconds', () => {
    expect(
      parseEnvironment({
        ...validEnvironment,
        MEAL_CONFIRMATION_CUTOVER_MODE: 'maintenance_bridge',
        MEAL_CONFIRMATION_MAINTENANCE_RETRY_AFTER_SECONDS: '120',
      }).mealConfirmationCutover,
    ).toEqual({ mode: 'maintenance_bridge', retryAfterSeconds: 120 });
    expect(
      parseEnvironment({
        ...validEnvironment,
        MEAL_CONFIRMATION_CUTOVER_MODE: 'safe_review_maintenance',
      }).mealConfirmationCutover.mode,
    ).toBe('safe_review_maintenance');
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        MEAL_CONFIRMATION_CUTOVER_MODE: 'unknown',
      }),
    ).toThrow();
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        MEAL_CONFIRMATION_MAINTENANCE_RETRY_AFTER_SECONDS: '0',
      }),
    ).toThrow();
  });
});
