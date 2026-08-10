import {
  hasRequiredConsents,
  type OnboardingConsentType,
  type OnboardingProfileInput,
} from '@nueat/domain';

export type OnboardingFormState = Omit<
  OnboardingProfileInput,
  'birthYear' | 'heightMm' | 'weightG'
> & {
  birthYear: string;
  heightCm: string;
  weightKg: string;
};

export function toProfileInput(
  form: OnboardingFormState,
): OnboardingProfileInput {
  return {
    goalType: form.goalType,
    birthYear: Number.parseInt(form.birthYear, 10),
    calculationSex: form.calculationSex,
    heightMm: Math.round(Number(form.heightCm) * 10),
    weightG: Math.round(Number(form.weightKg) * 1000),
    activityLevel: form.activityLevel,
    isPregnantOrLactating: form.isPregnantOrLactating,
    hasEatingDisorderRisk: form.hasEatingDisorderRisk,
    requiresMedicalNutrition: form.requiresMedicalNutrition,
  };
}

export function canContinueConsents(
  consents: readonly OnboardingConsentType[],
) {
  return hasRequiredConsents(consents);
}
