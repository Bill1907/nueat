import { z } from 'zod';

export const MEAL_RECOGNITION_PROMPT_VERSION = 'meal-recognition-prompt-v2';
export const MEAL_RECOGNITION_SCHEMA_VERSION = 'meal-recognition-schema-v2';
export const MEAL_RECOGNITION_V3_PROMPT_VERSION = 'meal-recognition-prompt-v3';
export const MEAL_RECOGNITION_V3_SCHEMA_VERSION = 'meal-recognition-schema-v3';

const recognitionLabelSchema = z.string().trim().min(1).max(120);
const confidenceBpsSchema = z.int().min(0).max(10_000);

export const RecognitionQuestionV2 = z
  .object({
    target: z.enum(['food', 'portion']),
    question: z.string().trim().min(1).max(240),
  })
  .strict();

export const RecognitionAlternativeV2 = z
  .object({
    normalizedLabel: recognitionLabelSchema,
    confidenceBps: confidenceBpsSchema,
  })
  .strict();

export const RecognitionFoodV2 = z
  .object({
    regionIndex: z.int().min(0).max(19),
    rawLabel: recognitionLabelSchema,
    foodConfidenceBps: confidenceBpsSchema,
    portionConfidenceBps: confidenceBpsSchema,
    amountMilliunits: z.int().positive(),
    unit: z.enum(['g', 'ml', 'serving', 'bowl', 'piece']),
    questions: z.array(RecognitionQuestionV2).max(2),
    alternatives: z.array(RecognitionAlternativeV2).max(5),
  })
  .strict()
  .superRefine((food, context) => {
    const normalizedLabels = new Set([normalizeRecognitionLabel(food.rawLabel)]);
    let previousConfidenceBps = food.foodConfidenceBps;
    for (const [index, alternative] of food.alternatives.entries()) {
      const normalizedLabel = normalizeRecognitionLabel(alternative.normalizedLabel);
      if (normalizedLabels.has(normalizedLabel)) {
        context.addIssue({
          code: 'custom',
          path: ['alternatives', index, 'normalizedLabel'],
          message: 'alternative labels must be unique and differ from rawLabel',
        });
      }
      normalizedLabels.add(normalizedLabel);
      if (alternative.confidenceBps >= food.foodConfidenceBps) {
        context.addIssue({
          code: 'custom',
          path: ['alternatives', index, 'confidenceBps'],
          message: 'alternative confidence must be lower than recognition confidence',
        });
      }
      if (alternative.confidenceBps >= previousConfidenceBps) {
        context.addIssue({
          code: 'custom',
          path: ['alternatives', index, 'confidenceBps'],
          message: 'alternative confidences must be strictly descending',
        });
      }
      previousConfidenceBps = alternative.confidenceBps;
    }
  });

const recognizedResultSchema = z
  .object({
    outcome: z.literal('recognized'),
    imageQualityConfidenceBps: confidenceBpsSchema,
    foods: z.array(RecognitionFoodV2).min(1).max(20),
  })
  .strict()
  .superRefine(validateUniqueRegionIndexes);

const noFoodResultSchema = z
  .object({
    outcome: z.literal('no_food'),
    imageQualityConfidenceBps: confidenceBpsSchema,
    foods: z.array(z.never()).length(0),
  })
  .strict();

const insufficientEvidenceResultSchema = z
  .object({
    outcome: z.literal('insufficient_evidence'),
    imageQualityConfidenceBps: confidenceBpsSchema,
    evidenceReason: z.enum(['blurred', 'too_dark', 'occluded', 'not_meal_photo', 'other']),
    foods: z.array(z.never()).length(0),
  })
  .strict();

export const RecognitionResultV2 = z.discriminatedUnion('outcome', [
  recognizedResultSchema,
  noFoodResultSchema,
  insufficientEvidenceResultSchema,
]);

export type RecognitionQuestionV2 = z.infer<typeof RecognitionQuestionV2>;
export type RecognitionAlternativeV2 = z.infer<typeof RecognitionAlternativeV2>;
export type RecognitionFoodV2 = z.infer<typeof RecognitionFoodV2>;
export type RecognitionResultV2 = z.infer<typeof RecognitionResultV2>;

function validateUniqueRegionIndexes(
  result: { foods: Array<{ regionIndex: number }> },
  context: z.RefinementCtx,
) {
  const seenRegionIndexes = new Set<number>();
  for (const [index, food] of result.foods.entries()) {
    if (seenRegionIndexes.has(food.regionIndex)) {
      context.addIssue({
        code: 'custom',
        path: ['foods', index, 'regionIndex'],
        message: 'regionIndex values must be unique',
      });
    }
    seenRegionIndexes.add(food.regionIndex);
  }
}

export function normalizeRecognitionLabel(label: string): string {
  return label.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}

export type StoredRecognitionFoodV2 = RecognitionFoodV2 & {
  normalizedLabel: string;
};
export type StoredRecognitionResultV2 =
  | {
      version: 2;
      outcome: 'recognized';
      imageQualityConfidenceBps: number;
      foods: StoredRecognitionFoodV2[];
    }
  | { version: 2; outcome: 'no_food'; imageQualityConfidenceBps: number; foods: [] }
  | {
      version: 2;
      outcome: 'insufficient_evidence';
      imageQualityConfidenceBps: number;
      evidenceReason: 'blurred' | 'too_dark' | 'occluded' | 'not_meal_photo' | 'other';
      foods: [];
    };

export function toStoredRecognitionResultV2(
  result: RecognitionResultV2,
): StoredRecognitionResultV2 {
  if (result.outcome === 'no_food') {
    return {
      version: 2,
      outcome: 'no_food',
      imageQualityConfidenceBps: result.imageQualityConfidenceBps,
      foods: [],
    };
  }
  if (result.outcome === 'insufficient_evidence') {
    return {
      version: 2,
      outcome: 'insufficient_evidence',
      imageQualityConfidenceBps: result.imageQualityConfidenceBps,
      evidenceReason: result.evidenceReason,
      foods: [],
    };
  }
  return {
    ...result,
    version: 2,
    foods: result.foods.map((food) => ({
      ...food,
      normalizedLabel: normalizeRecognitionLabel(food.rawLabel),
    })),
  };
}

const v3LabelSchema = z.string().trim().min(1).max(120);
const v3UncertaintyCode = z.enum([
  'identity_uncertain',
  'portion_uncertain',
  'occluded',
  'overlapping',
  'mixed_dish',
  'preparation_uncertain',
]);
const v3QuestionReasonCode = z.enum([
  'confirm_identity',
  'confirm_portion',
  'confirm_component',
]);

export const RecognitionAlternativeV3 = z.object({
  label: v3LabelSchema,
  confidenceBps: confidenceBpsSchema,
}).strict();

export const RecognitionObservationV3 = z.object({
  regionIndex: z.int().min(0).max(19),
  parentRegionIndex: z.int().min(0).max(19).nullable(),
  kind: z.enum(['dish', 'drink', 'component']),
  rawLabel: v3LabelSchema,
  foodConfidenceBps: confidenceBpsSchema,
  portionConfidenceBps: confidenceBpsSchema,
  amountMilliunits: z.int().positive(),
  unit: z.enum(['g', 'ml', 'serving', 'bowl', 'piece']),
  categoryHint: z.enum([
    'staple', 'soup_stew', 'meat', 'seafood', 'vegetable', 'noodle_dumpling',
    'snack_dessert', 'beverage', 'mixed', 'unknown',
  ]),
  preparationCodes: z.array(z.enum([
    'raw', 'boiled', 'steamed', 'grilled', 'fried', 'baked', 'braised',
    'fermented', 'mixed', 'unknown',
  ])).min(1).max(3),
  uncertaintyCodes: z.array(v3UncertaintyCode).max(4),
  questionReasonCodes: z.array(v3QuestionReasonCode).max(2),
  alternatives: z.array(RecognitionAlternativeV3).max(5),
}).strict().superRefine((observation, context) => {
  const labels = new Set([normalizeRecognitionLabel(observation.rawLabel)]);
  let previousConfidence = observation.foodConfidenceBps;
  for (const [index, alternative] of observation.alternatives.entries()) {
    const label = normalizeRecognitionLabel(alternative.label);
    if (labels.has(label)) context.addIssue({ code: 'custom', path: ['alternatives', index, 'label'], message: 'alternative labels must be unique and differ from rawLabel' });
    labels.add(label);
    if (alternative.confidenceBps >= previousConfidence) context.addIssue({ code: 'custom', path: ['alternatives', index, 'confidenceBps'], message: 'alternative confidences must be strictly descending and below recognition confidence' });
    previousConfidence = alternative.confidenceBps;
  }
});

const recognizedResultV3Schema = z.object({
  outcome: z.literal('recognized'),
  imageQualityConfidenceBps: confidenceBpsSchema,
  observations: z.array(RecognitionObservationV3).min(1).max(20),
}).strict().superRefine(validateObservationGraphV3);
const noFoodResultV3Schema = z.object({
  outcome: z.literal('no_food'),
  imageQualityConfidenceBps: confidenceBpsSchema,
  observations: z.array(z.never()).length(0),
}).strict();
const insufficientEvidenceResultV3Schema = z.object({
  outcome: z.literal('insufficient_evidence'),
  imageQualityConfidenceBps: confidenceBpsSchema,
  evidenceReason: z.enum(['blurred', 'too_dark', 'occluded', 'not_meal_photo', 'other']),
  observations: z.array(z.never()).length(0),
}).strict();

export const RecognitionResultV3 = z.discriminatedUnion('outcome', [
  recognizedResultV3Schema, noFoodResultV3Schema, insufficientEvidenceResultV3Schema,
]);
export type RecognitionObservationV3 = z.infer<typeof RecognitionObservationV3>;
export type RecognitionResultV3 = z.infer<typeof RecognitionResultV3>;
export type StoredRecognitionObservationV3 = RecognitionObservationV3 & {
  localObservationId: `o${number}`;
  normalizedLabel: string;
  alternatives: Array<z.infer<typeof RecognitionAlternativeV3> & { normalizedLabel: string }>;
};
export type StoredRecognitionResultV3 =
  | { version: 3; outcome: 'recognized'; imageQualityConfidenceBps: number; observations: StoredRecognitionObservationV3[] }
  | { version: 3; outcome: 'no_food'; imageQualityConfidenceBps: number; observations: [] }
  | { version: 3; outcome: 'insufficient_evidence'; imageQualityConfidenceBps: number; evidenceReason: 'blurred' | 'too_dark' | 'occluded' | 'not_meal_photo' | 'other'; observations: [] };

export function parseRecognitionResultV3(value: unknown): RecognitionResultV3 {
  if (!hasOnlyV3ObservationContent(value)) throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
  const parsed = RecognitionResultV3.safeParse(value);
  if (!parsed.success) throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
  return parsed.data;
}

export function toStoredRecognitionResultV3(result: RecognitionResultV3): StoredRecognitionResultV3 {
  if (result.outcome !== 'recognized') return { ...result, version: 3, observations: [] };
  return {
    version: 3,
    outcome: 'recognized',
    imageQualityConfidenceBps: result.imageQualityConfidenceBps,
    observations: [...result.observations]
      .sort((left, right) => left.regionIndex - right.regionIndex)
      .map((observation, index) => ({
        ...observation,
        localObservationId: `o${index}` as `o${number}`,
        normalizedLabel: normalizeRecognitionLabel(observation.rawLabel),
        alternatives: observation.alternatives.map((alternative) => ({
          ...alternative,
          normalizedLabel: normalizeRecognitionLabel(alternative.label),
        })),
      })),
  };
}

function validateObservationGraphV3(
  result: { observations: RecognitionObservationV3[] }, context: z.RefinementCtx,
) {
  const byRegion = new Map<number, RecognitionObservationV3>();
  const childCounts = new Map<number, number>();
  let roots = 0;
  for (const [index, observation] of result.observations.entries()) {
    if (byRegion.has(observation.regionIndex)) context.addIssue({ code: 'custom', path: ['observations', index, 'regionIndex'], message: 'regionIndex values must be unique' });
    byRegion.set(observation.regionIndex, observation);
    if (observation.parentRegionIndex === null) {
      roots += 1;
      if (observation.kind === 'component') context.addIssue({ code: 'custom', path: ['observations', index, 'kind'], message: 'roots must be dish or drink' });
      continue;
    }
    const parent = byRegion.get(observation.parentRegionIndex);
    if (!parent || observation.parentRegionIndex >= observation.regionIndex || parent.parentRegionIndex !== null || parent.kind === 'component' || observation.kind !== 'component') {
      context.addIssue({ code: 'custom', path: ['observations', index, 'parentRegionIndex'], message: 'parent must be an earlier root and children must be components' });
    }
    const children = (childCounts.get(observation.parentRegionIndex) ?? 0) + 1;
    childCounts.set(observation.parentRegionIndex, children);
    if (children > 12) context.addIssue({ code: 'custom', path: ['observations', index, 'parentRegionIndex'], message: 'a root may have at most 12 children' });
  }
  if (roots > 10) context.addIssue({ code: 'custom', path: ['observations'], message: 'at most 10 roots are allowed' });
}

const normalizedV3Keys = new Set([
  'outcome', 'imagequalityconfidencebps', 'observations', 'evidencereason',
  'regionindex', 'parentregionindex', 'kind', 'rawlabel', 'foodconfidencebps',
  'portionconfidencebps', 'amountmilliunits', 'unit', 'categoryhint',
  'preparationcodes', 'uncertaintycodes', 'questionreasoncodes', 'alternatives',
  'label', 'confidencebps',
]);
const forbiddenV3Key = /(?:^|(?:food|canonical|profile|source|serving|recipe|catalog|official|dataset|license))(?:id|code|release)?$|^(?:id|uuid|nutrient|nutrients|calorie|calories|energy|protein|carbohydrate|fat|fiber|kcal)$/;
const forbiddenV3Text = /(?:https?:\/\/|(?:k[-\s]?fcdb|data\.go)[\w-]*\d|\bD\d{3}-\d{6,}-\d{4}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|(?:official|catalog|source|license)\s*(?:id|code|claim|assertion)|(?:단백질|탄수화물|지방|식이섬유|칼로리|protein|carbohydrate|fat|fiber|calories?)\s*[:：]?\s*\d+\s*(?:g|mg|kcal|cal))/iu;

function hasOnlyV3ObservationContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasOnlyV3ObservationContent);
  if (typeof value === 'string') return !forbiddenV3Text.test(value);
  if (typeof value !== 'object' || value === null) return true;
  return Object.entries(value).every(([key, child]) => {
    const normalized = key.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s_-]/g, '');
    return normalizedV3Keys.has(normalized) && !forbiddenV3Key.test(normalized) && hasOnlyV3ObservationContent(child);
  });
}

export interface MealRecognizerInput {
  imageBytes: Uint8Array;
  imageContentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface MealRecognizerOutput {
  provider: 'mock' | 'openai';
  model: string;
  promptVersion:
    | typeof MEAL_RECOGNITION_PROMPT_VERSION
    | typeof MEAL_RECOGNITION_V3_PROMPT_VERSION;
  schemaVersion:
    | typeof MEAL_RECOGNITION_SCHEMA_VERSION
    | typeof MEAL_RECOGNITION_V3_SCHEMA_VERSION;
  providerRequestId?: string;
  inputTokens: number;
  outputTokens: number;
  result: RecognitionResultV2 | RecognitionResultV3;
}

export interface MealRecognizer {
  recognize(input: MealRecognizerInput): Promise<MealRecognizerOutput>;
}

export const MealRecognitionFailureCode = z.enum([
  'CONFIGURATION_INVALID',
  'DEADLINE_EXCEEDED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REJECTED',
  'INVALID_PROVIDER_RESPONSE',
]);

export type MealRecognitionFailureCode = z.infer<
  typeof MealRecognitionFailureCode
>;

export class MealRecognitionFailure extends Error {
  constructor(readonly code: MealRecognitionFailureCode) {
    super(code);
    this.name = 'MealRecognitionFailure';
  }
}
