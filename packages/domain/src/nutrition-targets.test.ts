import { describe, expect, test } from 'bun:test';

import { calculateNutritionTargets, NUTRITION_STANDARD } from './nutrition-targets';

const baseInput = {
  ageYears: 30,
  calculationSex: 'male' as const,
  heightMm: 1_750,
  weightG: 70_000,
  activityLevel: 'light' as const,
  goalType: 'maintenance' as const,
  isPregnantOrLactating: false,
  hasEatingDisorderRisk: false,
  requiresMedicalNutrition: false,
};

describe('calculateNutritionTargets', () => {
  test('calculates the published male KDRI EER example deterministically', () => {
    const result = calculateNutritionTargets(baseInput);

    expect(result.status).toBe('calculated');
    if (result.status !== 'calculated') return;

    expect(result.provenance.baseEerKcal).toBe(2_660);
    expect(result.provenance.activityCoefficient).toBe(1.11);
    expect(result.targets.calorieTargetMillicalories).toBe(2_660_000);
    expect(result.targets.fiberTargetMg).toBe(30_000);
    expect(result.provenance.standard).toEqual(NUTRITION_STANDARD);
  });

  test('uses the female KDRI equation and age-based fiber target', () => {
    const result = calculateNutritionTargets({
      ...baseInput,
      ageYears: 55,
      calculationSex: 'female',
      activityLevel: 'sedentary',
    });

    expect(result.status).toBe('calculated');
    if (result.status !== 'calculated') return;

    expect(result.provenance.baseEerKcal).toBe(1_900);
    expect(result.targets.fiberTargetMg).toBe(25_000);
  });

  test('applies a 15 percent weight-loss deficit and the minimum energy floor', () => {
    const result = calculateNutritionTargets({
      ...baseInput,
      calculationSex: 'female',
      heightMm: 1_500,
      weightG: 48_000,
      activityLevel: 'sedentary',
      goalType: 'weight_loss',
    });

    expect(result.status).toBe('calculated');
    if (result.status !== 'calculated') return;

    expect(result.targets.calorieTargetMillicalories).toBeGreaterThanOrEqual(1_200_000);
    expect(result.provenance.goalAdjustment).toBe('deficit_15_percent_max_500');
    expect(result.provenance.macroEnergyPercent).toEqual({
      carbohydrate: 50,
      protein: 20,
      fat: 30,
    });
  });

  test('caps muscle-gain surplus at 300 kcal', () => {
    const result = calculateNutritionTargets({
      ...baseInput,
      activityLevel: 'high',
      goalType: 'muscle_gain',
    });

    expect(result.status).toBe('calculated');
    if (result.status !== 'calculated') return;

    const targetKcal = result.targets.calorieTargetMillicalories / 1_000;
    expect(targetKcal - result.provenance.baseEerKcal).toBeLessThanOrEqual(300);
    expect(result.provenance.goalAdjustment).toBe('surplus_8_percent_max_300');
  });

  test('blocks automatic targets for high-risk inputs', () => {
    const result = calculateNutritionTargets({
      ...baseInput,
      calculationSex: null,
      isPregnantOrLactating: true,
      hasEatingDisorderRisk: true,
      requiresMedicalNutrition: true,
    });

    expect(result).toEqual({
      status: 'limited',
      reasons: [
        'pregnant_or_lactating',
        'eating_disorder_risk',
        'medical_nutrition_required',
        'calculation_sex_required',
      ],
      standard: NUTRITION_STANDARD,
    });
  });

  test('blocks weight loss below BMI 18.5 and weight changes from age 75', () => {
    const underweight = calculateNutritionTargets({
      ...baseInput,
      weightG: 50_000,
      goalType: 'weight_loss',
    });
    const olderAdult = calculateNutritionTargets({
      ...baseInput,
      ageYears: 75,
      goalType: 'muscle_gain',
    });

    expect(underweight.status).toBe('limited');
    if (underweight.status === 'limited') {
      expect(underweight.reasons).toContain('underweight_weight_loss');
    }
    expect(olderAdult.status).toBe('limited');
    if (olderAdult.status === 'limited') {
      expect(olderAdult.reasons).toContain('older_adult_weight_change');
    }
  });

  test('requires manual review for unsupported very-high activity', () => {
    const result = calculateNutritionTargets({
      ...baseInput,
      activityLevel: 'very_high',
    });

    expect(result.status).toBe('limited');
    if (result.status === 'limited') {
      expect(result.reasons).toContain('activity_level_requires_review');
    }
  });
});
