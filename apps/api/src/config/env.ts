import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import { MEAL_REVIEW_POLICY_VERSION } from '@nueat/domain';

import { MEAL_ITEM_RESOLVER_VERSION } from '../services/meal-item-resolution';
import {
  MEAL_RECOGNITION_V3_PROMPT_VERSION,
  MEAL_RECOGNITION_V3_SCHEMA_VERSION,
} from '../services/meal-recognizer';
import { MEAL_CONFIRMATION_CUTOVER_MODES } from '../services/meal-confirmation-cutover';
import {
  CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
  CATALOG_AUTO_SELECTION_POLICY_VERSION,
} from '../services/catalog-auto-selection-policy';

const environmentBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string()
      .url()
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a PostgreSQL URL',
      }),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),
    RESEND_API_KEY: z.string().min(1),
    AUTH_EMAIL_FROM: z.string().min(1).default('NUEAT <auth@boseong.dev>'),
    TRUSTED_ORIGINS: z.string().default('nueat://,http://localhost:8081'),
    HEALTH_DB_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(10_000)
      .default(2_000),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).default('auto'),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_URL_STYLE: z.enum(['virtual', 'path']).default('virtual'),
    IMAGE_UPLOAD_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(900)
      .default(300),
    IMAGE_DOWNLOAD_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(300)
      .default(120),
    IMAGE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(10_000_000)
      .default(10_000_000),
    VECTOR_SHADOW_MODE: z.enum(['off', 'shadow']).default('off'),
    MEAL_RECOGNITION_MODE: z.enum(['mock', 'openai']).default('mock'),
    OPENAI_API_KEY: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || undefined),
    OPENAI_MODEL: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/, 'OPENAI_MODEL must be a valid OpenAI model ID')
      .default('gpt-5.4-mini-2026-03-17'),
    MEAL_RECOGNITION_DEADLINE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(20_000),
    RECOGNITION_RELIABILITY_PROTOCOL_MODE: z
      .enum(['disabled', 'legacy_observe', 'v2_one_call', 'v2_auto_retry'])
      .default('disabled'),
    RECOGNITION_RELIABILITY_KILL_SWITCH: environmentBoolean.default(false),
    RECOGNITION_RELIABILITY_SCHEMA_CAPABILITY: environmentBoolean.default(false),

    RECOGNITION_RELIABILITY_V2_ONE_CALL_ADMISSION_EVIDENCE: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/, 'RECOGNITION_RELIABILITY_V2_ONE_CALL_ADMISSION_EVIDENCE must be a lowercase SHA-256 hex digest')
      .optional(),
    RECOGNITION_RECOVERY_ENABLED: environmentBoolean.default(false),
    RECOGNITION_RELIABILITY_COHORT_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
    MEAL_RECOGNITION_FINALIZATION_RESERVE_MS: z.coerce.number().int().min(1).default(2_000),
    MEAL_RECOGNITION_RESPONSE_RESERVE_MS: z.coerce.number().int().min(1).default(2_000),
    MEAL_RECOGNITION_PROVIDER_CALL_MAX_MS: z.coerce.number().int().min(1).default(15_000),
    MEAL_RECOGNITION_PROVIDER_CALL_MIN_MS: z.coerce.number().int().min(1).default(1_000),
    MEAL_RECOGNITION_DB_LOCK_CAP_MS: z.coerce.number().int().min(1).default(1_000),
    MEAL_RECOGNITION_DB_STATEMENT_CAP_MS: z.coerce.number().int().min(1).default(1_500),
    MEAL_RECOGNITION_LEASE_MARGIN_MS: z.coerce.number().int().min(1).default(1_000),
    MEAL_RECOGNITION_INGRESS_HARD_TIMEOUT_MS: z.coerce.number().int().min(1).optional(),
    MEAL_RECOGNITION_APPLICATION_HARD_TIMEOUT_MS: z.coerce.number().int().min(1).optional(),
    MEAL_RECOGNITION_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(256)
      .max(4_000)
      .default(2_000),
    MEAL_RECOGNITION_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3)
      .default(2),
    MEAL_RECOGNITION_DAILY_ATTEMPT_QUOTA: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20),
    MEAL_RECOGNITION_MAPPING_MODE: z
      .enum(['exact_review', 'hybrid_review', 'vector_shadow', 'hybrid_auto'])
      .default('exact_review'),
    MEAL_RECOGNITION_EMERGENCY_OVERRIDE: z
      .enum(['none', 'disabled', 'exact_review', 'hybrid_review', 'vector_shadow'])
      .default('none'),
    MEAL_RECOGNITION_ACTIVATION_IDENTITY_JSON: z.string().trim().optional(),
    MEAL_RECOGNITION_APPROVED_REPORT_SHA256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/, 'MEAL_RECOGNITION_APPROVED_REPORT_SHA256 must be a lowercase SHA-256 hex digest')
      .optional(),
    MEAL_RECOGNITION_ACTIVE_REPORT_SHA256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/, 'MEAL_RECOGNITION_ACTIVE_REPORT_SHA256 must be a lowercase SHA-256 hex digest')
      .optional(),
    MEAL_RECOGNITION_APPROVED_REPORT_VERSION: z
      .literal('meal-stack-golden-report-v3')
      .optional(),
    MEAL_RECOGNITION_APPROVED_REPORT_JSON: z.string().trim().optional(),
    MEAL_RECOGNITION_APPROVAL_KEY_ID: z.string().trim().min(1).optional(),
    MEAL_RECOGNITION_APPROVAL_PUBLIC_KEY: z.string().trim().min(1).optional(),
    MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION: z.string().trim().min(1).optional(),
    MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    MEAL_CONFIRMATION_CUTOVER_MODE: z
      .enum(MEAL_CONFIRMATION_CUTOVER_MODES)
      .default('normal'),
    MEAL_CONFIRMATION_MAINTENANCE_RETRY_AFTER_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_600)
      .default(60),
  })
  .superRefine((value, context) => {
    const protocolMode = value.RECOGNITION_RELIABILITY_KILL_SWITCH
      ? 'disabled'
      : value.RECOGNITION_RELIABILITY_PROTOCOL_MODE;
    const deadline = value.MEAL_RECOGNITION_DEADLINE_MS;
    if (
      value.MEAL_RECOGNITION_PROVIDER_CALL_MIN_MS + value.MEAL_RECOGNITION_FINALIZATION_RESERVE_MS >
        deadline ||
      value.MEAL_RECOGNITION_PROVIDER_CALL_MAX_MS >
        deadline - value.MEAL_RECOGNITION_FINALIZATION_RESERVE_MS ||
      value.MEAL_RECOGNITION_DB_LOCK_CAP_MS >= value.MEAL_RECOGNITION_FINALIZATION_RESERVE_MS ||
      value.MEAL_RECOGNITION_DB_STATEMENT_CAP_MS >= value.MEAL_RECOGNITION_FINALIZATION_RESERVE_MS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MEAL_RECOGNITION_DEADLINE_MS'],
        message: 'recognition deadline reserves must leave a useful provider window and finalization DB timeouts below the finalization reserve',
      });
    }
    if (
      value.MEAL_RECOGNITION_INGRESS_HARD_TIMEOUT_MS !== undefined &&
      deadline + value.MEAL_RECOGNITION_RESPONSE_RESERVE_MS >
        value.MEAL_RECOGNITION_INGRESS_HARD_TIMEOUT_MS
    ) {
      context.addIssue({ code: 'custom', path: ['MEAL_RECOGNITION_INGRESS_HARD_TIMEOUT_MS'], message: 'recognition deadline plus response reserve exceeds ingress hard timeout' });
    }
    if (
      value.MEAL_RECOGNITION_APPLICATION_HARD_TIMEOUT_MS !== undefined &&
      deadline > value.MEAL_RECOGNITION_APPLICATION_HARD_TIMEOUT_MS
    ) {
      context.addIssue({ code: 'custom', path: ['MEAL_RECOGNITION_APPLICATION_HARD_TIMEOUT_MS'], message: 'recognition deadline exceeds application hard timeout' });
    }
    if (protocolMode !== 'disabled' && !value.RECOGNITION_RELIABILITY_SCHEMA_CAPABILITY) {
      context.addIssue({ code: 'custom', path: ['RECOGNITION_RELIABILITY_SCHEMA_CAPABILITY'], message: 'recognition reliability protocol requires schema capability' });
    }
    if (protocolMode === 'v2_auto_retry') {
      context.addIssue({ code: 'custom', path: ['RECOGNITION_RELIABILITY_PROTOCOL_MODE'], message: 'v2_auto_retry is not admitted for coordinator replay' });
    }
    if (
      protocolMode === 'v2_one_call' &&
      !value.RECOGNITION_RELIABILITY_V2_ONE_CALL_ADMISSION_EVIDENCE
    ) {
      context.addIssue({ code: 'custom', path: ['RECOGNITION_RELIABILITY_V2_ONE_CALL_ADMISSION_EVIDENCE'], message: 'v2_one_call requires admission evidence' });
    }
    if (
      protocolMode === 'v2_one_call' &&
      (value.MEAL_RECOGNITION_INGRESS_HARD_TIMEOUT_MS === undefined ||
        value.MEAL_RECOGNITION_APPLICATION_HARD_TIMEOUT_MS === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MEAL_RECOGNITION_INGRESS_HARD_TIMEOUT_MS'],
        message: 'v2_one_call requires measured ingress and application hard timeouts',
      });
    }
    if (value.RECOGNITION_RECOVERY_ENABLED && (
      protocolMode !== 'v2_one_call' ||
      !value.RECOGNITION_RELIABILITY_V2_ONE_CALL_ADMISSION_EVIDENCE ||
      !value.RECOGNITION_RELIABILITY_SCHEMA_CAPABILITY ||
      value.RECOGNITION_RELIABILITY_COHORT_PERCENT <= 0
    )) {
      context.addIssue({ code: 'custom', path: ['RECOGNITION_RECOVERY_ENABLED'], message: 'recovery requires admitted v2_one_call, schema capability, and a non-zero cohort' });
    }
    const effectiveMappingMode = value.MEAL_RECOGNITION_EMERGENCY_OVERRIDE === 'none'
      ? value.MEAL_RECOGNITION_MAPPING_MODE
      : value.MEAL_RECOGNITION_EMERGENCY_OVERRIDE === 'disabled'
        ? 'exact_review'
        : value.MEAL_RECOGNITION_EMERGENCY_OVERRIDE;
    const bucketValues = [
      value.S3_ENDPOINT,
      value.S3_BUCKET,
      value.S3_ACCESS_KEY_ID,
      value.S3_SECRET_ACCESS_KEY,
    ];
    const configuredValues = bucketValues.filter(Boolean).length;
    if (configuredValues !== 0 && configuredValues !== bucketValues.length) {
      context.addIssue({
        code: 'custom',
        message:
          'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY must be set together',
      });
    }
    if (value.MEAL_RECOGNITION_MODE === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when MEAL_RECOGNITION_MODE is openai',
      });
    }
    if (
      value.VECTOR_SHADOW_MODE === 'shadow' ||
      effectiveMappingMode === 'vector_shadow'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['VECTOR_SHADOW_MODE'],
        message:
          'VECTOR_SHADOW_UNAVAILABLE: the required pinned local ONNX encoder artifact is not deployed',
      });
    }
    if (effectiveMappingMode === 'hybrid_auto') {
      const receipt = parseApprovedGoldenReport(
        value.MEAL_RECOGNITION_APPROVED_REPORT_JSON,
        value.MEAL_RECOGNITION_APPROVAL_KEY_ID,
        value.MEAL_RECOGNITION_APPROVAL_PUBLIC_KEY,
      );
      const receiptProvenance =
        receipt && isRecord(receipt.provenance) ? receipt.provenance : null;
      if (
        value.MEAL_RECOGNITION_MODE !== 'openai' ||
        !value.MEAL_RECOGNITION_APPROVED_REPORT_SHA256 ||
        !value.MEAL_RECOGNITION_ACTIVE_REPORT_SHA256 ||
        value.MEAL_RECOGNITION_APPROVED_REPORT_SHA256 !== value.MEAL_RECOGNITION_ACTIVE_REPORT_SHA256 ||
        value.MEAL_RECOGNITION_APPROVED_REPORT_VERSION !== 'meal-stack-golden-report-v3' ||
        !receipt ||
        receipt.reportSha256 !== value.MEAL_RECOGNITION_APPROVED_REPORT_SHA256 ||
        !receiptProvenance ||
        receiptProvenance.provider !== 'openai' ||
        receiptProvenance.recognitionModel !== value.OPENAI_MODEL ||
        receiptProvenance.promptVersion !== MEAL_RECOGNITION_V3_PROMPT_VERSION ||
        receiptProvenance.schemaVersion !== MEAL_RECOGNITION_V3_SCHEMA_VERSION ||
        receiptProvenance.resolverVersion !== MEAL_ITEM_RESOLVER_VERSION ||
        receiptProvenance.reviewPolicyVersion !== MEAL_REVIEW_POLICY_VERSION ||
        receiptProvenance.registryVersion !== value.MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION ||
        receiptProvenance.registrySha256 !== value.MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256 ||
        !activationIdentityMatches(receiptProvenance.activationIdentity, value.MEAL_RECOGNITION_ACTIVATION_IDENTITY_JSON, effectiveMappingMode) ||
        (effectiveMappingMode === 'hybrid_auto' && !hasHybridAutoEvidence(receipt))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['MEAL_RECOGNITION_MAPPING_MODE'],
          message:
            'automatic mapping requires OpenAI mode and an authority-signed receipt bound to the exact deployed stack with hybrid-auto evidence',
        });
      }
    }
  });

export type ApiEnvironment = ReturnType<typeof parseEnvironment>;

export function parseEnvironment(input: Record<string, string | undefined>) {
  const parsed = environmentSchema.parse(input);
  const mappingMode = parsed.MEAL_RECOGNITION_EMERGENCY_OVERRIDE === 'none'
    ? parsed.MEAL_RECOGNITION_MAPPING_MODE
    : parsed.MEAL_RECOGNITION_EMERGENCY_OVERRIDE === 'disabled'
      ? 'exact_review'
      : parsed.MEAL_RECOGNITION_EMERGENCY_OVERRIDE;
  const imageBucket =
    parsed.S3_ENDPOINT &&
    parsed.S3_BUCKET &&
    parsed.S3_ACCESS_KEY_ID &&
    parsed.S3_SECRET_ACCESS_KEY
      ? {
          endpoint: parsed.S3_ENDPOINT,
          region: parsed.S3_REGION,
          bucket: parsed.S3_BUCKET,
          accessKeyId: parsed.S3_ACCESS_KEY_ID,
          secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
          forcePathStyle: parsed.S3_URL_STYLE === 'path',
          uploadUrlTtlSeconds: parsed.IMAGE_UPLOAD_URL_TTL_SECONDS,
          downloadUrlTtlSeconds: parsed.IMAGE_DOWNLOAD_URL_TTL_SECONDS,
          maxBytes: parsed.IMAGE_MAX_BYTES,
        }
      : null;
  const trustedOrigins = parseOriginList(parsed.TRUSTED_ORIGINS);
  const corsOrigins = trustedOrigins.filter(
    (origin) => origin.startsWith('http://') || origin.startsWith('https://'),
  );

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    betterAuthSecret: parsed.BETTER_AUTH_SECRET,
    betterAuthUrl: parsed.BETTER_AUTH_URL,
    resendApiKey: parsed.RESEND_API_KEY,
    authEmailFrom: parsed.AUTH_EMAIL_FROM,
    trustedOrigins,
    corsOrigins,
    healthDbTimeoutMs: parsed.HEALTH_DB_TIMEOUT_MS,
    imageBucket,
    vectorShadow: {
      mode: parsed.VECTOR_SHADOW_MODE,
    },
    mealRecognition: {
      mode: parsed.MEAL_RECOGNITION_MODE,
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.OPENAI_MODEL,
      deadlineMs: parsed.MEAL_RECOGNITION_DEADLINE_MS,
      reliability: {
        protocolMode: parsed.RECOGNITION_RELIABILITY_KILL_SWITCH
          ? 'disabled'
          : parsed.RECOGNITION_RELIABILITY_PROTOCOL_MODE,
        cohortPercent: parsed.RECOGNITION_RELIABILITY_COHORT_PERCENT,
        v2OneCallAdmitted: !!parsed.RECOGNITION_RELIABILITY_V2_ONE_CALL_ADMISSION_EVIDENCE,
        recoveryEnabled: parsed.RECOGNITION_RECOVERY_ENABLED,
        finalizationReserveMs: parsed.MEAL_RECOGNITION_FINALIZATION_RESERVE_MS,
        responseReserveMs: parsed.MEAL_RECOGNITION_RESPONSE_RESERVE_MS,
        providerCallMaxMs: parsed.MEAL_RECOGNITION_PROVIDER_CALL_MAX_MS,
        providerCallMinMs: parsed.MEAL_RECOGNITION_PROVIDER_CALL_MIN_MS,
        dbLockCapMs: parsed.MEAL_RECOGNITION_DB_LOCK_CAP_MS,
        dbStatementCapMs: parsed.MEAL_RECOGNITION_DB_STATEMENT_CAP_MS,
        leaseMarginMs: parsed.MEAL_RECOGNITION_LEASE_MARGIN_MS,
      },
      maxOutputTokens: parsed.MEAL_RECOGNITION_MAX_OUTPUT_TOKENS,
      maxAttempts: parsed.MEAL_RECOGNITION_MAX_ATTEMPTS,
      dailyAttemptQuota: parsed.MEAL_RECOGNITION_DAILY_ATTEMPT_QUOTA,
      reviewPolicy: {
        mode:
          mappingMode === 'hybrid_auto'
            ? 'auto_selection'
            : 'review_only',
        mappingMode,
        approvedReportSha256: parsed.MEAL_RECOGNITION_APPROVED_REPORT_SHA256,
        activeReportSha256: parsed.MEAL_RECOGNITION_ACTIVE_REPORT_SHA256,
        approvedReportVersion: parsed.MEAL_RECOGNITION_APPROVED_REPORT_VERSION,
        catalogRegistryVersion: parsed.MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION,
        catalogRegistrySha256: parsed.MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256,
        approvedReportReceipt: parseApprovedGoldenReport(
          parsed.MEAL_RECOGNITION_APPROVED_REPORT_JSON,
          parsed.MEAL_RECOGNITION_APPROVAL_KEY_ID,
          parsed.MEAL_RECOGNITION_APPROVAL_PUBLIC_KEY,
        ),
      },
    },
    mealConfirmationCutover: {
      mode: parsed.MEAL_CONFIRMATION_CUTOVER_MODE,
      retryAfterSeconds: parsed.MEAL_CONFIRMATION_MAINTENANCE_RETRY_AFTER_SECONDS,
    },
  } as const;
}
function parseApprovedGoldenReport(
  value: string | undefined,
  expectedKeyId: string | undefined,
  publicKeyBase64: string | undefined,
) {
  if (!value || !expectedKeyId || !publicKeyBase64) return null;
  try {
    const receipt: unknown = JSON.parse(value);
    if (!isRecord(receipt) || receipt.version !== 'meal-stack-golden-report-v3' || receipt.mode !== 'production' || receipt.result !== 'passed' || receipt.passed !== true || !Array.isArray(receipt.failures) || receipt.failures.length !== 0 || !isRecord(receipt.counts) || !isRecord(receipt.metrics) || !isRecord(receipt.provenance) || !isRecord(receipt.approval) || !isSha256(receipt.reportSha256)) return null;
    const { reportSha256, approval, ...unsignedReport } = receipt;
    if (canonicalSha256(unsignedReport) !== reportSha256) return null;
    if (
      approval.keyId !== expectedKeyId ||
      typeof approval.signatureBase64 !== 'string' ||
      !verifyReportApproval(reportSha256, approval.signatureBase64, publicKeyBase64)
    ) return null;
    const counts = receipt.counts;
    const metrics = receipt.metrics;
    if (
      !integerAtLeast(counts.consentedKoreanMealPhotos, 500) ||
      !isRecord(counts.foodGroupCases) ||
      Object.values(counts.foodGroupCases).length !== 6 ||
      Object.values(counts.foodGroupCases).some((count) => !integerAtLeast(count, 50)) ||
      !integerAtLeast(counts.noFood, 10) ||
      !integerAtLeast(counts.insufficientEvidence, 10) ||
      !integerAtLeast(counts.quickEligibleMeals, 381) ||
      !integerAtLeast(counts.quickEligibleItems, 381) ||
      !integerAtLeast(counts.eligibleItems, 381) ||
      counts.zeroOutcomeQuickFalsePositives !== 0 ||
      counts.nutritionOrIdErrors !== 0 ||
      counts.forbiddenSelectionCount !== 0 ||
      counts.untrustedConversionEligible !== 0 ||
      counts.untrustedSelectionCount !== 0 ||
      counts.sensitiveReportLeakage !== 0 ||
      !bpsAtLeast(metrics.outcomeAccuracyBps, 9_500) ||
      !bpsAtLeast(metrics.eligibleFoodTop1Wilson95LowerBoundBps, 9_900) ||
      !bpsAtLeast(metrics.portionWithinToleranceWilson95LowerBoundBps, 9_000) ||
      !bpsAtLeast(metrics.jointItemWilson95LowerBoundBps, 9_000) ||
      !bpsAtLeast(metrics.allItemsCorrectEligibleMealWilson95LowerBoundBps, 8_500) ||
      !bpsAtLeast(metrics.eligibleCoverageBps, 1_500) ||
      !bpsAtLeast(metrics.validV3Bps, 9_900) ||
      !isSha256(receipt.provenance.manifestSha256) ||
      !isSha256(receipt.provenance.groundTruthSha256) ||
      !isSha256(receipt.provenance.predictionsSha256) ||
      !isSha256(receipt.inputSha256) ||
      typeof receipt.provenance.adjudicationVersion !== 'string' ||
      !isSha256(receipt.provenance.adjudicationSha256) ||
      typeof receipt.provenance.registryVersion !== 'string' ||
      !isSha256(receipt.provenance.registrySha256) ||
      receipt.provenance.provider !== 'openai' ||
      typeof receipt.provenance.recognitionModel !== 'string' ||
      typeof receipt.provenance.promptVersion !== 'string' ||
      typeof receipt.provenance.schemaVersion !== 'string' ||
      typeof receipt.provenance.resolverVersion !== 'string' ||
      typeof receipt.provenance.reviewPolicyVersion !== 'string' ||
      !isRecord(receipt.provenance.activationIdentity) ||
      !hasMeasuredRolloutEvidence(receipt.rolloutMeasurements)
    ) return null;
    return receipt;
  } catch {
    return null;
  }
}

function activationIdentityMatches(
  receiptIdentity: unknown,
  configuredIdentityJson: string | undefined,
  mappingMode: string,
) {
  if (!configuredIdentityJson || !isRecord(receiptIdentity)) return false;
  try {
    const configured: unknown = JSON.parse(configuredIdentityJson);
    return isRecord(configured) &&
      canonicalJson(configured) === canonicalJson(receiptIdentity) &&
      configured.mappingMode === mappingMode;
  } catch {
    return false;
  }
}

function hasHybridAutoEvidence(receipt: Record<string, unknown>) {
  const counts = receipt.counts;
  const metrics = receipt.metrics;
  return isRecord(counts) &&
    isRecord(metrics) &&
    hasExactAutoSelectionPolicy(receipt) &&
    hasMeasuredRolloutEvidence(receipt.rolloutMeasurements) &&
    integerAtLeast(counts.eligibleItems, 381) &&
    counts.eligibleItems === counts.quickEligibleItems &&
    counts.nutritionOrIdErrors === 0 &&
    counts.forbiddenSelectionCount === 0 &&
    counts.untrustedConversionEligible === 0 &&
    counts.untrustedSelectionCount === 0 &&
    counts.zeroOutcomeQuickFalsePositives === 0 &&
    bpsAtLeast(metrics.eligibleFoodTop1Wilson95LowerBoundBps, 9_900);
}

function hasExactAutoSelectionPolicy(receipt: Record<string, unknown>) {
  if (!isRecord(receipt.autoSelectionPolicy) || !isRecord(receipt.provenance)) {
    return false;
  }
  const policy = receipt.autoSelectionPolicy;
  const evidence = receipt.provenance.autoSelectionEvidence;
  if (!isRecord(evidence) || !isRecord(evidence.selectedSubset)) return false;
  const selectedSubset = evidence.selectedSubset;
  return policy.version === CATALOG_AUTO_SELECTION_POLICY_VERSION &&
    policy.comparatorVersion === CATALOG_AUTO_SELECTION_COMPARATOR_VERSION &&
    isBps(policy.minimumWinnerScoreBps) &&
    isBps(policy.minimumMarginBps) &&
    isSha256(policy.identitySha256) &&
    evidence.policyVersion === policy.version &&
    evidence.comparatorVersion === policy.comparatorVersion &&
    evidence.policySha256 === policy.identitySha256 &&
    evidence.minimumWinnerScoreBps === policy.minimumWinnerScoreBps &&
    evidence.minimumMarginBps === policy.minimumMarginBps &&
    integerAtLeast(selectedSubset.selectedMeals, 1) &&
    integerAtLeast(selectedSubset.selectedItems, 1) &&
    integerAtLeast(selectedSubset.foodMatches, 0) &&
    (selectedSubset.foodMatches as number) <= (selectedSubset.selectedItems as number) &&
    integerAtLeast(selectedSubset.fullyCorrectMeals, 0) &&
    (selectedSubset.fullyCorrectMeals as number) <= (selectedSubset.selectedMeals as number);
}

function hasMeasuredRolloutEvidence(value: unknown) {
  return isRecord(value) &&
    integerAtLeast(value.categoryStrataCases, 120) &&
    integerAtLeast(value.preparationStrataCases, 120) &&
    integerAtLeast(value.compositeCases, 20) &&
    integerAtLeast(value.abstentionCases, 20) &&
    Number.isInteger(value.maxLatencyMs) &&
    (value.maxLatencyMs as number) >= 0 &&
    (value.maxLatencyMs as number) <= 2_000 &&
    bpsAtLeast(value.correctionRateBps, 0) &&
    (value.correctionRateBps as number) <= 1_000 &&
    value.blockedViolationCount === 0 &&
    value.privacyViolationCount === 0 &&
    value.forbiddenSelectionCount === 0 &&
    value.untrustedSelectionCount === 0 &&
    integerAtLeast(value.soakDays, 7);
}

function verifyReportApproval(
  reportSha256: string,
  signatureBase64: string,
  publicKeyBase64: string,
) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(
      null,
      Buffer.from(reportSha256, 'utf8'),
      publicKey,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function integerAtLeast(value: unknown, minimum: number) {
  return Number.isInteger(value) && (value as number) >= minimum;
}

function bpsAtLeast(value: unknown, minimum: number) {
  return integerAtLeast(value, minimum) && (value as number) <= 10_000;
}

function isBps(value: unknown) {
  return bpsAtLeast(value, 0);
}

function canonicalSha256(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseOriginList(value: string) {
  const origins = [
    ...new Set(
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];
  if (origins.length === 0) {
    throw new Error('TRUSTED_ORIGINS must contain at least one origin');
  }
  return origins;
}
