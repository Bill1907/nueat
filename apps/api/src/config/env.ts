import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import { MEAL_ESTIMATE_REVIEW_POLICY_VERSION } from '@nueat/domain';

import { MEAL_ITEM_RESOLVER_VERSION } from '../services/meal-item-resolution';
import {
  MEAL_RECOGNITION_PROMPT_VERSION,
  MEAL_RECOGNITION_SCHEMA_VERSION,
} from '../services/meal-recognizer';

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
    MEAL_RECOGNITION_REVIEW_POLICY: z
      .enum(['review_only', 'quick_confirm'])
      .default('review_only'),
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
      .literal('meal-recognition-golden-report-v2')
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
  })
  .superRefine((value, context) => {
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
      value.NODE_ENV === 'production' &&
      value.MEAL_RECOGNITION_REVIEW_POLICY === 'quick_confirm'
    ) {
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
        value.MEAL_RECOGNITION_APPROVED_REPORT_VERSION !== 'meal-recognition-golden-report-v2' ||
        !receipt ||
        receipt.reportSha256 !== value.MEAL_RECOGNITION_APPROVED_REPORT_SHA256 ||
        !receiptProvenance ||
        receiptProvenance.provider !== 'openai' ||
        receiptProvenance.recognitionModel !== value.OPENAI_MODEL ||
        receiptProvenance.promptVersion !== MEAL_RECOGNITION_PROMPT_VERSION ||
        receiptProvenance.schemaVersion !== MEAL_RECOGNITION_SCHEMA_VERSION ||
        receiptProvenance.resolverVersion !== MEAL_ITEM_RESOLVER_VERSION ||
        receiptProvenance.reviewPolicyVersion !== MEAL_ESTIMATE_REVIEW_POLICY_VERSION ||
        receiptProvenance.registryVersion !== value.MEAL_RECOGNITION_CATALOG_REGISTRY_VERSION ||
        receiptProvenance.registrySha256 !== value.MEAL_RECOGNITION_CATALOG_REGISTRY_SHA256
      ) {
        context.addIssue({
          code: 'custom',
          path: ['MEAL_RECOGNITION_REVIEW_POLICY'],
          message:
            'production quick_confirm requires OpenAI mode and an authority-signed meal-recognition-golden-report-v2 receipt bound to matching report SHA-256 values, the deployed recognition stack, and catalog registry',
        });
      }
    }
  });

export type ApiEnvironment = ReturnType<typeof parseEnvironment>;

export function parseEnvironment(input: Record<string, string | undefined>) {
  const parsed = environmentSchema.parse(input);
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
    mealRecognition: {
      mode: parsed.MEAL_RECOGNITION_MODE,
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.OPENAI_MODEL,
      deadlineMs: parsed.MEAL_RECOGNITION_DEADLINE_MS,
      maxOutputTokens: parsed.MEAL_RECOGNITION_MAX_OUTPUT_TOKENS,
      maxAttempts: parsed.MEAL_RECOGNITION_MAX_ATTEMPTS,
      dailyAttemptQuota: parsed.MEAL_RECOGNITION_DAILY_ATTEMPT_QUOTA,
      reviewPolicy: {
        mode: parsed.MEAL_RECOGNITION_REVIEW_POLICY,
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
    if (!isRecord(receipt) || receipt.version !== 'meal-recognition-golden-report-v2' || receipt.mode !== 'production' || receipt.result !== 'passed' || receipt.passed !== true || !Array.isArray(receipt.failures) || receipt.failures.length !== 0 || !isRecord(receipt.counts) || !isRecord(receipt.metrics) || !isRecord(receipt.provenance) || !isRecord(receipt.approval) || !isSha256(receipt.reportSha256)) return null;
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
      !integerAtLeast(counts.consentedKoreanMealPhotos, 120) ||
      !isRecord(counts.foodGroupCases) ||
      Object.values(counts.foodGroupCases).length !== 6 ||
      Object.values(counts.foodGroupCases).some((count) => !integerAtLeast(count, 20)) ||
      !integerAtLeast(counts.noFood, 10) ||
      !integerAtLeast(counts.insufficientEvidence, 10) ||
      !integerAtLeast(counts.quickEligibleMeals, 50) ||
      !integerAtLeast(counts.quickEligibleItems, 100) ||
      counts.zeroOutcomeQuickFalsePositives !== 0 ||
      counts.nutritionOrIdErrors !== 0 ||
      counts.untrustedConversionEligible !== 0 ||
      counts.sensitiveReportLeakage !== 0 ||
      !bpsAtLeast(metrics.outcomeAccuracyBps, 9_500) ||
      !bpsAtLeast(metrics.eligibleFoodTop1Wilson95LowerBoundBps, 9_500) ||
      !bpsAtLeast(metrics.portionWithinToleranceWilson95LowerBoundBps, 9_000) ||
      !bpsAtLeast(metrics.jointItemWilson95LowerBoundBps, 9_000) ||
      !bpsAtLeast(metrics.allItemsCorrectEligibleMealWilson95LowerBoundBps, 8_500) ||
      !bpsAtLeast(metrics.eligibleCoverageBps, 1_500) ||
      !bpsAtLeast(metrics.validV2Bps, 9_900) ||
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
      typeof receipt.provenance.reviewPolicyVersion !== 'string'
    ) return null;
    return receipt;
  } catch {
    return null;
  }
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
