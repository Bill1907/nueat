export const NUTRITION_STANDARD = {
  nameKo: '2025 한국인 영양소 섭취기준',
  publisherKo: '보건복지부·한국영양학회',
  equationSource: 'KDRI',
  equationVersion: '2025',
  corrigendaVersion: '2026-03-16',
  engineVersion: 'nutrition-targets-v1',
  safetyRulesVersion: 'nutrition-safety-v1',
  sourceUrl:
    'https://www.mohw.go.kr/board.es?mid=a10411010100&bid=0019&act=view&list_no=1488446',
} as const;

export type CalculationSex = 'female' | 'male';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'high' | 'very_high';
export type GoalType = 'weight_loss' | 'maintenance' | 'muscle_gain' | 'balanced_diet';

export type LimitedModeReason =
  | 'minor'
  | 'pregnant_or_lactating'
  | 'eating_disorder_risk'
  | 'medical_nutrition_required'
  | 'calculation_sex_required'
  | 'invalid_body_metrics'
  | 'underweight_weight_loss'
  | 'older_adult_weight_change'
  | 'activity_level_requires_review';

export interface NutritionTargetInput {
  ageYears: number;
  calculationSex: CalculationSex | null;
  heightMm: number;
  weightG: number;
  activityLevel: ActivityLevel;
  goalType: GoalType;
  isPregnantOrLactating: boolean;
  hasEatingDisorderRisk: boolean;
  requiresMedicalNutrition: boolean;
}

export interface NutritionTargets {
  calorieTargetMillicalories: number;
  carbohydrateTargetMg: number;
  proteinTargetMg: number;
  fatTargetMg: number;
  fiberTargetMg: number;
}

export interface NutritionTargetProvenance {
  standard: typeof NUTRITION_STANDARD;
  activityCoefficient: number;
  baseEerKcal: number;
  goalAdjustment: 'none' | 'deficit_15_percent_max_500' | 'surplus_8_percent_max_300';
  macroEnergyPercent: {
    carbohydrate: number;
    protein: number;
    fat: number;
  };
}

export type NutritionTargetResult =
  | {
      status: 'limited';
      reasons: LimitedModeReason[];
      standard: typeof NUTRITION_STANDARD;
    }
  | {
      status: 'calculated';
      targets: NutritionTargets;
      provenance: NutritionTargetProvenance;
    };

const ACTIVITY_COEFFICIENTS = {
  female: {
    sedentary: 1,
    light: 1.12,
    moderate: 1.27,
    high: 1.45,
  },
  male: {
    sedentary: 1,
    light: 1.11,
    moderate: 1.25,
    high: 1.48,
  },
} as const;

const MACRO_RATIOS: Record<GoalType, NutritionTargetProvenance['macroEnergyPercent']> = {
  balanced_diet: { carbohydrate: 55, protein: 20, fat: 25 },
  maintenance: { carbohydrate: 55, protein: 20, fat: 25 },
  muscle_gain: { carbohydrate: 55, protein: 20, fat: 25 },
  weight_loss: { carbohydrate: 50, protein: 20, fat: 30 },
};

export function calculateNutritionTargets(input: NutritionTargetInput): NutritionTargetResult {
  const reasons = getLimitedModeReasons(input);
  if (reasons.length > 0 || input.calculationSex === null) {
    return {
      status: 'limited',
      reasons,
      standard: NUTRITION_STANDARD,
    };
  }

  const coefficient = getActivityCoefficient(input.calculationSex, input.activityLevel);
  const heightM = input.heightMm / 1_000;
  const weightKg = input.weightG / 1_000;
  const baseEerKcal = calculateEer(
    input.calculationSex,
    input.ageYears,
    heightM,
    weightKg,
    coefficient,
  );
  const adjustedEnergy = adjustEnergyForGoal(
    baseEerKcal,
    input.goalType,
    input.calculationSex,
  );
  const calorieTargetKcal = roundToNearest(adjustedEnergy.kcal, 10);
  const macroRatio = MACRO_RATIOS[input.goalType];

  return {
    status: 'calculated',
    targets: {
      calorieTargetMillicalories: calorieTargetKcal * 1_000,
      carbohydrateTargetMg: gramsToMg(
        (calorieTargetKcal * (macroRatio.carbohydrate / 100)) / 4,
      ),
      proteinTargetMg: gramsToMg((calorieTargetKcal * (macroRatio.protein / 100)) / 4),
      fatTargetMg: gramsToMg((calorieTargetKcal * (macroRatio.fat / 100)) / 9),
      fiberTargetMg: getFiberTargetG(input.calculationSex, input.ageYears) * 1_000,
    },
    provenance: {
      standard: NUTRITION_STANDARD,
      activityCoefficient: coefficient,
      baseEerKcal: roundToNearest(baseEerKcal, 1),
      goalAdjustment: adjustedEnergy.adjustment,
      macroEnergyPercent: macroRatio,
    },
  };
}

function getLimitedModeReasons(input: NutritionTargetInput): LimitedModeReason[] {
  const reasons: LimitedModeReason[] = [];

  if (!Number.isInteger(input.ageYears) || input.ageYears < 19) reasons.push('minor');
  if (input.isPregnantOrLactating) reasons.push('pregnant_or_lactating');
  if (input.hasEatingDisorderRisk) reasons.push('eating_disorder_risk');
  if (input.requiresMedicalNutrition) reasons.push('medical_nutrition_required');
  if (input.calculationSex === null) reasons.push('calculation_sex_required');
  if (!hasValidBodyMetrics(input)) reasons.push('invalid_body_metrics');
  if (input.activityLevel === 'very_high') reasons.push('activity_level_requires_review');

  if (input.calculationSex !== null && hasValidBodyMetrics(input)) {
    const heightM = input.heightMm / 1_000;
    const weightKg = input.weightG / 1_000;
    const bmi = weightKg / heightM ** 2;
    if (input.goalType === 'weight_loss' && bmi < 18.5) {
      reasons.push('underweight_weight_loss');
    }
  }

  if (
    input.ageYears >= 75 &&
    (input.goalType === 'weight_loss' || input.goalType === 'muscle_gain')
  ) {
    reasons.push('older_adult_weight_change');
  }

  return reasons;
}

function hasValidBodyMetrics(input: NutritionTargetInput) {
  return (
    Number.isInteger(input.heightMm) &&
    input.heightMm >= 1_200 &&
    input.heightMm <= 2_200 &&
    Number.isInteger(input.weightG) &&
    input.weightG >= 35_000 &&
    input.weightG <= 250_000
  );
}

function calculateEer(
  sex: CalculationSex,
  ageYears: number,
  heightM: number,
  weightKg: number,
  activityCoefficient: number,
) {
  if (sex === 'male') {
    return (
      662 -
      9.53 * ageYears +
      activityCoefficient * (15.91 * weightKg + 539.6 * heightM)
    );
  }

  return (
    354 -
    6.91 * ageYears +
    activityCoefficient * (9.36 * weightKg + 726 * heightM)
  );
}

function getActivityCoefficient(sex: CalculationSex, activityLevel: ActivityLevel) {
  if (activityLevel === 'very_high') {
    throw new Error('very_high activity requires manual review');
  }

  return ACTIVITY_COEFFICIENTS[sex][activityLevel];
}
function adjustEnergyForGoal(
  baseEerKcal: number,
  goalType: GoalType,
  sex: CalculationSex,
): {
  kcal: number;
  adjustment: NutritionTargetProvenance['goalAdjustment'];
} {
  if (goalType === 'weight_loss') {
    const minimumKcal = sex === 'male' ? 1_500 : 1_200;
    return {
      kcal: Math.max(baseEerKcal * 0.85, baseEerKcal - 500, minimumKcal),
      adjustment: 'deficit_15_percent_max_500',
    };
  }

  if (goalType === 'muscle_gain') {
    return {
      kcal: Math.min(baseEerKcal * 1.08, baseEerKcal + 300),
      adjustment: 'surplus_8_percent_max_300',
    };
  }

  return { kcal: baseEerKcal, adjustment: 'none' };
}

function getFiberTargetG(sex: CalculationSex, ageYears: number) {
  if (sex === 'male') return 30;
  return ageYears < 50 ? 20 : 25;
}

function gramsToMg(grams: number) {
  return Math.round(grams * 1_000);
}

function roundToNearest(value: number, increment: number) {
  return Math.round(value / increment) * increment;
}
