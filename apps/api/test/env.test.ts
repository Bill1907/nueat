import { describe, expect, test } from 'bun:test';

import { parseEnvironment } from '../src/config/env';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api-nueat.boseong.dev',
  RESEND_API_KEY: 're_test',
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
