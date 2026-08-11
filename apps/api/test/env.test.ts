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
  test('defaults meal recognition to mock mode without an OpenAI key', () => {
    const result = parseEnvironment({
      ...validEnvironment,
      OPENAI_API_KEY: '',
    });

    expect(result.mealRecognition).toEqual({
      mode: 'mock',
      apiKey: undefined,
      model: 'gpt-5.6-luna',
      deadlineMs: 20_000,
      maxOutputTokens: 2_000,
      maxAttempts: 2,
      dailyAttemptQuota: 20,
    });
  });

  test('requires an OpenAI key in openai mode and enforces hard limits', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        MEAL_RECOGNITION_MODE: 'openai',
      }),
    ).toThrow('OPENAI_API_KEY is required');

    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        MEAL_RECOGNITION_DEADLINE_MS: '999',
      }),
    ).toThrow();

    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        MEAL_RECOGNITION_MAX_OUTPUT_TOKENS: '4001',
      }),
    ).toThrow();

    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        MEAL_RECOGNITION_MAX_ATTEMPTS: '4',
      }),
    ).toThrow();

    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        MEAL_RECOGNITION_DAILY_ATTEMPT_QUOTA: '101',
      }),
    ).toThrow();
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        OPENAI_MODEL: 'gpt-5.6',
      }),
    ).toThrow();
  });

  test('parses bounded OpenAI recognition settings', () => {
    const result = parseEnvironment({
      ...validEnvironment,
      MEAL_RECOGNITION_MODE: 'openai',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'gpt-5.6-luna',
      MEAL_RECOGNITION_DEADLINE_MS: '30000',
      MEAL_RECOGNITION_MAX_OUTPUT_TOKENS: '2000',
      MEAL_RECOGNITION_MAX_ATTEMPTS: '3',
      MEAL_RECOGNITION_DAILY_ATTEMPT_QUOTA: '50',
    });

    expect(result.mealRecognition).toEqual({
      mode: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5.6-luna',
      deadlineMs: 30_000,
      maxOutputTokens: 2_000,
      maxAttempts: 3,
      dailyAttemptQuota: 50,
    });
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
