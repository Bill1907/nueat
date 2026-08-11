import {
  MEAL_RECOGNITION_PROMPT_VERSION,
  MEAL_RECOGNITION_SCHEMA_VERSION,
  type MealRecognizer,
  type MealRecognizerOutput,
} from './meal-recognizer';

export const MOCK_MEAL_RECOGNITION_MODEL = 'mock-recognition-v2';

export class MockMealRecognizer implements MealRecognizer {
  async recognize(): Promise<MealRecognizerOutput> {
    return {
      provider: 'mock',
      model: MOCK_MEAL_RECOGNITION_MODEL,
      promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
      schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      result: {
        foods: [
          {
            regionIndex: 0,
            recognizedLabel: '흰쌀밥',
            recognitionConfidenceBps: 9_500,
            portionConfidenceBps: 9_200,
            amountMilliunits: 1_000,
            unit: 'bowl',
          },
          {
            regionIndex: 1,
            recognizedLabel: '김치찌개',
            recognitionConfidenceBps: 9_300,
            portionConfidenceBps: 9_000,
            amountMilliunits: 1_000,
            unit: 'serving',
          },
          {
            regionIndex: 2,
            recognizedLabel: '배추김치',
            recognitionConfidenceBps: 9_100,
            portionConfidenceBps: 8_800,
            amountMilliunits: 500,
            unit: 'serving',
          },
        ],
      },
    };
  }
}
