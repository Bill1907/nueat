import type {
  ActivityLevel,
  CalculationSex,
  GoalType,
  LimitedModeReason,
  NutritionTargetInput,
} from './nutrition-targets';

export type OnboardingConsentType =
  | 'terms'
  | 'privacy'
  | 'health_data'
  | 'image_training';
export type OnboardingStatus = 'pending' | 'completed' | 'limited';

export interface ConsentDocument {
  type: OnboardingConsentType;
  titleKo: string;
  contentKo: string;
  required: boolean;
  version: string;
  documentSha256: string;
}

export const CONSENT_DOCUMENTS: readonly ConsentDocument[] = [
  {
    type: 'terms',
    titleKo: '서비스 이용 및 웰니스 범위',
    contentKo:
      'NUEAT은 일반 웰니스 서비스이며 의료 진단·치료·처방을 제공하지 않습니다. 음식 인식 결과와 섭취량은 사용자가 확인·수정한 뒤 확정해야 합니다.',
    required: true,
    version: 'mvp-2026-08-10',
    documentSha256:
      '51309811857f77ece7fd561dbe2358deabed8d34548e63ff8bbe3aafc923d6a9',
  },
  {
    type: 'privacy',
    titleKo: '개인정보 처리',
    contentKo:
      '계정 식별정보와 서비스 이용정보는 인증, 기록 저장, 보안 및 기능 제공에 사용됩니다. 사용자는 계정과 데이터를 삭제할 수 있습니다.',
    required: true,
    version: 'mvp-2026-08-10',
    documentSha256:
      'b6173f3eabe7d2d931b315be7b174ad177445eaeb4ac183762e6aeb241e4a33f',
  },
  {
    type: 'health_data',
    titleKo: '건강정보 처리',
    contentKo:
      '신체정보, 영양 목표, 알레르기·제외 식품, 식사 기록은 개인화된 영양 계산과 일반 웰니스 코칭을 위해 처리됩니다.',
    required: true,
    version: 'mvp-2026-08-10',
    documentSha256:
      '284cf41df0c9ba21a4026282634816ee51d77fd871ef5744babf5951187cce78',
  },
  {
    type: 'image_training',
    titleKo: '이미지 학습 활용',
    contentKo:
      '식사 이미지를 모델 및 인식 품질 개선에 사용할 수 있습니다. 선택 동의이며 거부해도 핵심 서비스를 이용할 수 있고 언제든 철회할 수 있습니다.',
    required: false,
    version: 'mvp-2026-08-10',
    documentSha256:
      '681a2d2769f363b11da851b1d1c03faf0613616d765d46d48f28814d6dd7786c',
  },
] as const;

export const GOAL_OPTIONS: ReadonlyArray<{ value: GoalType; labelKo: string }> =
  [
    { value: 'weight_loss', labelKo: '체중 감량' },
    { value: 'maintenance', labelKo: '체중 유지' },
    { value: 'muscle_gain', labelKo: '근육 증가' },
    { value: 'balanced_diet', labelKo: '균형 식사' },
  ];

export const ACTIVITY_OPTIONS: ReadonlyArray<{
  value: ActivityLevel;
  labelKo: string;
  descriptionKo: string;
}> = [
  {
    value: 'sedentary',
    labelKo: '비활동적',
    descriptionKo: '주로 앉아서 생활해요',
  },
  {
    value: 'light',
    labelKo: '저활동적',
    descriptionKo: '가벼운 활동을 가끔 해요',
  },
  {
    value: 'moderate',
    labelKo: '활동적',
    descriptionKo: '규칙적으로 운동해요',
  },
  {
    value: 'high',
    labelKo: '매우 활동적',
    descriptionKo: '강도 높은 활동이 잦아요',
  },
  {
    value: 'very_high',
    labelKo: '전문 운동 수준',
    descriptionKo: '자동 계산 대신 확인이 필요해요',
  },
];

export const LIMITED_REASON_LABELS: Record<LimitedModeReason, string> = {
  minor: '미성년자는 자동 영양 목표를 제공하지 않아요.',
  pregnant_or_lactating: '임신·수유 중에는 전문가와 목표를 확인해 주세요.',
  eating_disorder_risk: '안전한 지원을 위해 자동 체중 코칭을 제한해요.',
  medical_nutrition_required:
    '질환 치료 목적의 영양 관리는 의료진과 진행해 주세요.',
  calculation_sex_required: '공식 계산식 선택에 필요한 정보를 확인해 주세요.',
  invalid_body_metrics: '신장 또는 체중 입력값을 확인해 주세요.',
  underweight_weight_loss:
    '현재 입력 기준으로 감량 목표를 자동 설정할 수 없어요.',
  older_adult_weight_change:
    '75세 이상 체중 변경 목표는 전문가 확인이 필요해요.',
  activity_level_requires_review:
    '전문 운동 수준의 목표는 추가 확인이 필요해요.',
};

export interface OnboardingProfileInput {
  goalType: GoalType;
  birthYear: number;
  calculationSex: CalculationSex | null;
  heightMm: number;
  weightG: number;
  activityLevel: ActivityLevel;
  isPregnantOrLactating: boolean;
  hasEatingDisorderRisk: boolean;
  requiresMedicalNutrition: boolean;
}

export interface OnboardingSubmission extends OnboardingProfileInput {
  acceptedConsentTypes: OnboardingConsentType[];
}

export function toNutritionTargetInput(
  input: OnboardingProfileInput,
  now: Date = new Date(),
): NutritionTargetInput {
  return {
    ageYears: now.getUTCFullYear() - input.birthYear,
    calculationSex: input.calculationSex,
    heightMm: input.heightMm,
    weightG: input.weightG,
    activityLevel: input.activityLevel,
    goalType: input.goalType,
    isPregnantOrLactating: input.isPregnantOrLactating,
    hasEatingDisorderRisk: input.hasEatingDisorderRisk,
    requiresMedicalNutrition: input.requiresMedicalNutrition,
  };
}

export function hasRequiredConsents(types: readonly OnboardingConsentType[]) {
  const accepted = new Set(types);
  return CONSENT_DOCUMENTS.filter((document) => document.required).every(
    (document) => accepted.has(document.type),
  );
}
