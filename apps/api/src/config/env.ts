import { z } from 'zod';

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
  } as const;
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
