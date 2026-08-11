import { z } from 'zod';

export const MEAL_RECOGNITION_PROMPT_VERSION = 'meal-recognition-prompt-v1';
export const MEAL_RECOGNITION_SCHEMA_VERSION = 'meal-recognition-schema-v1';

const recognitionLabelSchema = z.string().trim().min(1).max(120);

export const RecognitionFoodV1 = z
  .object({
    regionIndex: z.int().min(0).max(19),
    recognizedLabel: recognitionLabelSchema,
    recognitionConfidenceBps: z.int().min(0).max(10_000),
    portionConfidenceBps: z.int().min(0).max(10_000),
    amountMilliunits: z.int().positive(),
    unit: z.enum(['g', 'ml', 'serving', 'bowl', 'piece']),
    question: z.string().trim().min(1).max(240).nullable().optional(),
    candidateLabels: z.array(recognitionLabelSchema).max(5).optional(),
  })
  .strict();

export const RecognitionResultV1 = z
  .object({
    foods: z.array(RecognitionFoodV1).min(1).max(20),
  })
  .strict()
  .superRefine((result, context) => {
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
  });

export type RecognitionFoodV1 = z.infer<typeof RecognitionFoodV1>;
export type RecognitionResultV1 = z.infer<typeof RecognitionResultV1>;

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
  result: RecognitionResultV1;
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
