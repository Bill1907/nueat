import { describe, expect, test } from 'bun:test';

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

describe('parseEnvironment', () => {
  test('applies secure service defaults and separates browser CORS origins', () => {
    const result = parseEnvironment({
      ...validEnvironment,
      TRUSTED_ORIGINS: 'nueat://,https://nueat.boseong.dev,https://nueat.boseong.dev',
    });

    expect(result.host).toBe('0.0.0.0');
    expect(result.port).toBe(3_000);
    expect(result.authEmailFrom).toBe('NUEAT <auth@boseong.dev>');
    expect(result.trustedOrigins).toEqual(['nueat://', 'https://nueat.boseong.dev']);
    expect(result.corsOrigins).toEqual(['https://nueat.boseong.dev']);
  });

  test('allows deployment before a bucket is linked and rejects partial credentials', () => {
    const withoutBucket = parseEnvironment({
      ...validEnvironment,
      S3_ENDPOINT: undefined,
      S3_BUCKET: undefined,
      S3_ACCESS_KEY_ID: undefined,
      S3_SECRET_ACCESS_KEY: undefined,
    });

    expect(withoutBucket.imageBucket).toBeNull();
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        S3_SECRET_ACCESS_KEY: undefined,
      }),
    ).toThrow('must be set together');
  });

  test('rejects short authentication secrets', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        BETTER_AUTH_SECRET: 'short',
      }),
    ).toThrow();
  });

  test('rejects non-PostgreSQL database URLs', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        DATABASE_URL: 'https://example.com/database',
      }),
    ).toThrow('DATABASE_URL must be a PostgreSQL URL');
  });
});
