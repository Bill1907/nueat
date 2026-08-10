import { describe, expect, test } from 'bun:test';

import {
  CONSENT_DOCUMENTS,
  hasRequiredConsents,
  toNutritionTargetInput,
  type OnboardingProfileInput,
} from './onboarding';

const profile: OnboardingProfileInput = {
  goalType: 'balanced_diet',
  birthYear: 1990,
  calculationSex: 'female',
  heightMm: 1_650,
  weightG: 58_000,
  activityLevel: 'light',
  isPregnantOrLactating: false,
  hasEatingDisorderRisk: false,
  requiresMedicalNutrition: false,
};

describe('onboarding contract', () => {
  test('derives full age from the versioned birth-year input', () => {
    expect(
      toNutritionTargetInput(profile, new Date('2026-08-10T00:00:00Z')),
    ).toEqual({
      ageYears: 36,
      calculationSex: 'female',
      heightMm: 1_650,
      weightG: 58_000,
      activityLevel: 'light',
      goalType: 'balanced_diet',
      isPregnantOrLactating: false,
      hasEatingDisorderRisk: false,
      requiresMedicalNutrition: false,
    });
  });

  test('requires all three mandatory consents but not image training', () => {
    expect(hasRequiredConsents(['terms', 'privacy', 'health_data'])).toBe(true);
    expect(hasRequiredConsents(['terms', 'privacy', 'image_training'])).toBe(
      false,
    );
  });

  test('keeps document hashes synchronized with displayed consent text', () => {
    for (const document of CONSENT_DOCUMENTS) {
      const hash = new Bun.CryptoHasher('sha256')
        .update(document.contentKo)
        .digest('hex');
      expect(hash).toBe(document.documentSha256);
    }
  });
});
