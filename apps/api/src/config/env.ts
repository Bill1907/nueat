import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url().refine((value) => value.startsWith('postgresql://'), {
    message: 'DATABASE_URL must be a PostgreSQL URL',
  }),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  RESEND_API_KEY: z.string().min(1),
  AUTH_EMAIL_FROM: z.string().min(1).default('NUEAT <auth@boseong.dev>'),
  TRUSTED_ORIGINS: z.string().default('nueat://,http://localhost:8081'),
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
});

export type ApiEnvironment = ReturnType<typeof parseEnvironment>;

export function parseEnvironment(input: Record<string, string | undefined>) {
  const parsed = environmentSchema.parse(input);
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
  } as const;
}

function parseOriginList(value: string) {
  const origins = [...new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean))];
  if (origins.length === 0) {
    throw new Error('TRUSTED_ORIGINS must contain at least one origin');
  }
  return origins;
}
