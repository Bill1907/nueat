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

function approvedReceipt(change: Record<string, unknown> = {}) {
  const unsignedReport = {
    version: 'meal-recognition-golden-report-v2', mode: 'production', result: 'passed', passed: true, failures: [],
    provenance: {
      manifestSha256: 'a'.repeat(64),
      groundTruthSha256: 'b'.repeat(64),
      predictionsSha256: 'c'.repeat(64),
      adjudicationVersion: 'adjudication-v2',
      adjudicationSha256: 'd'.repeat(64),
      registryVersion: 'registry-v2',
      registrySha256: 'e'.repeat(64),
      provider: 'openai',
      recognitionModel: 'gpt-5.6-luna',
      promptVersion: 'meal-recognition-prompt-v2',
      schemaVersion: 'meal-recognition-schema-v2',
      resolverVersion: 'meal-item-resolution-v1',
      reviewPolicyVersion: 'meal-estimate-review-v1',
    },
    inputSha256: 'f'.repeat(64),
    counts: { consentedKoreanMealPhotos: 120, foodGroupCases: { grain: 20, vegetable: 20, fruit: 20, protein: 20, dairy: 20, fat: 20 }, noFood: 10, insufficientEvidence: 10, quickEligibleMeals: 50, quickEligibleItems: 100, eligibleItems: 100, eligibleMeals: 50, zeroOutcomeQuickFalsePositives: 0, nutritionOrIdErrors: 0, untrustedConversionEligible: 0, sensitiveReportLeakage: 0 },
    metrics: { outcomeAccuracyBps: 9_500, eligibleFoodTop1Wilson95LowerBoundBps: 9_500, portionWithinToleranceWilson95LowerBoundBps: 9_000, jointItemWilson95LowerBoundBps: 9_000, allItemsCorrectEligibleMealWilson95LowerBoundBps: 8_500, eligibleCoverageBps: 1_500, validV2Bps: 9_900 },
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

function quickConfirmEnvironment(receipt: ReturnType<typeof approvedReceipt>) {
  return {
    ...validEnvironment,
    NODE_ENV: 'production',
    MEAL_RECOGNITION_MODE: 'openai',
    OPENAI_API_KEY: 'test-openai-key',
    MEAL_RECOGNITION_REVIEW_POLICY: 'quick_confirm',
    MEAL_RECOGNITION_APPROVED_REPORT_SHA256: receipt.reportSha256,
    MEAL_RECOGNITION_ACTIVE_REPORT_SHA256: receipt.reportSha256,
    MEAL_RECOGNITION_APPROVED_REPORT_VERSION: 'meal-recognition-golden-report-v2',
    MEAL_RECOGNITION_APPROVED_REPORT_JSON: JSON.stringify(receipt),
    MEAL_RECOGNITION_APPROVAL_KEY_ID: approvalKeyId,
    MEAL_RECOGNITION_APPROVAL_PUBLIC_KEY: approvalPublicKey,
    MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION: receipt.provenance.registryVersion,
    MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256: receipt.provenance.registrySha256,
  };
}

describe('parseEnvironment', () => {
  test('defaults meal recognition and its UX policy to review_only', () => {
    const result = parseEnvironment({ ...validEnvironment, OPENAI_API_KEY: '' });
    expect(result.mealRecognition).toMatchObject({ mode: 'mock', apiKey: undefined, model: 'gpt-5.6-luna', deadlineMs: 20_000, maxOutputTokens: 2_000, maxAttempts: 2, dailyAttemptQuota: 20, reviewPolicy: { mode: 'review_only', approvedReportSha256: undefined, activeReportSha256: undefined, approvedReportVersion: undefined, approvedReportReceipt: null } });
  });

  test('accepts production quick_confirm only with a canonical passing V2 approval receipt bound to both SHA values', () => {
    const receipt = approvedReceipt();
    const result = parseEnvironment(quickConfirmEnvironment(receipt));
    expect(result.mealRecognition.reviewPolicy).toMatchObject({ mode: 'quick_confirm', approvedReportSha256: receipt.reportSha256, activeReportSha256: receipt.reportSha256, approvedReportVersion: 'meal-recognition-golden-report-v2', approvedReportReceipt: receipt });
  });

  test('fails closed for tampered, unsigned, mismatched-stack, and failed receipts while review_only rolls back immediately', () => {
    const receipt = approvedReceipt();
    const invalid = (change: Record<string, unknown>) => {
      const changedReceipt = approvedReceipt(change);
      expect(() => parseEnvironment(quickConfirmEnvironment(changedReceipt))).toThrow(
        'authority-signed',
      );
    };
    invalid({ result: 'evaluated', mode: 'experiment' });
    invalid({ passed: false, result: 'failed', failures: ['gate'] });
    invalid({ counts: { ...receipt.counts, quickEligibleItems: 99 } });
    invalid({ provenance: { ...receipt.provenance, promptVersion: 'old-prompt' } });
    invalid({ provenance: { ...receipt.provenance, provider: 'mock' } });
    expect(() => parseEnvironment({
      ...quickConfirmEnvironment(receipt),
      MEAL_RECOGNITION_MODE: 'mock',
      OPENAI_API_KEY: undefined,
    })).toThrow('OpenAI mode');
    expect(() => parseEnvironment({
      ...quickConfirmEnvironment(receipt),
      MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256: '9'.repeat(64),
    })).toThrow('catalog registry');

    const forged = { ...receipt, approval: { ...receipt.approval, signatureBase64: Buffer.alloc(64).toString('base64') } };
    expect(() => parseEnvironment(quickConfirmEnvironment(forged))).toThrow(
      'authority-signed',
    );
    expect(parseEnvironment({ ...validEnvironment, NODE_ENV: 'production', MEAL_RECOGNITION_REVIEW_POLICY: 'review_only' }).mealRecognition.reviewPolicy.mode).toBe('review_only');
  });

  test('requires an OpenAI key in openai mode and rejects partial bucket credentials', () => {
    expect(() => parseEnvironment({ ...validEnvironment, MEAL_RECOGNITION_MODE: 'openai' })).toThrow('OPENAI_API_KEY is required');
    expect(() => parseEnvironment({ ...validEnvironment, S3_SECRET_ACCESS_KEY: undefined })).toThrow('must be set together');
  });
});
