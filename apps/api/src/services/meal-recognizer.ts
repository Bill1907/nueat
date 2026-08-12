import { z } from 'zod';

export const MEAL_RECOGNITION_PROMPT_VERSION = 'meal-recognition-prompt-v2';
export const MEAL_RECOGNITION_SCHEMA_VERSION = 'meal-recognition-schema-v2';

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

export interface MealRecognizerInput {
  imageBytes: Uint8Array;
  imageContentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface MealRecognizerOutput {
  provider: 'mock' | 'openai';
  model: string;
  promptVersion: typeof MEAL_RECOGNITION_PROMPT_VERSION;
  schemaVersion: typeof MEAL_RECOGNITION_SCHEMA_VERSION;
  providerRequestId?: string;
  inputTokens: number;
  outputTokens: number;
  result: RecognitionResultV2;
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
