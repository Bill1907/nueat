import { describe, expect, test } from 'bun:test';

import {
  canContinueConsents,
  toProfileInput,
} from '../src/components/onboarding/form';

describe('mobile onboarding form', () => {
  test('converts centimetres and kilograms to integer API units', () => {
    expect(
      toProfileInput({
        goalType: 'balanced_diet',
        birthYear: '1990',
        calculationSex: 'female',
        heightCm: '165.4',
        weightKg: '54.25',
        activityLevel: 'moderate',
        isPregnantOrLactating: false,
        hasEatingDisorderRisk: false,
        requiresMedicalNutrition: false,
      }),
    ).toMatchObject({ birthYear: 1990, heightMm: 1654, weightG: 54250 });
  });

  test('does not accept numeric prefixes followed by invalid text', () => {
    const profile = toProfileInput({
      goalType: 'balanced_diet',
      birthYear: '1990',
      calculationSex: 'female',
      heightCm: '165cm',
      weightKg: '54kg',
      activityLevel: 'moderate',
      isPregnantOrLactating: false,
      hasEatingDisorderRisk: false,
      requiresMedicalNutrition: false,
    });

    expect(Number.isNaN(profile.heightMm)).toBe(true);
    expect(Number.isNaN(profile.weightG)).toBe(true);
  });

  test('requires every required consent but not the optional image consent', () => {
    expect(canContinueConsents(['terms', 'privacy'])).toBe(false);
    expect(canContinueConsents(['terms', 'privacy', 'health_data'])).toBe(true);
  });
});
