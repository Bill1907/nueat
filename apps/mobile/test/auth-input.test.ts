import { describe, expect, test } from 'bun:test';

import { isCompleteOtp, isValidEmail, normalizeEmail, normalizeOtp } from '../src/auth/input';
import { normalizeApiUrl } from '../src/config/environment';

describe('mobile authentication inputs', () => {
  test('normalizes and validates email addresses', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
  });

  test('keeps only six OTP digits', () => {
    expect(normalizeOtp('12a 34-567')).toBe('123456');
    expect(isCompleteOtp('123456')).toBe(true);
    expect(isCompleteOtp('12345')).toBe(false);
  });

  test('requires HTTPS outside local development', () => {
    expect(normalizeApiUrl('https://api-nueat.boseong.dev/')).toBe(
      'https://api-nueat.boseong.dev',
    );
    expect(normalizeApiUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(() => normalizeApiUrl('http://api-nueat.boseong.dev')).toThrow();
  });
});
