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
        outcome: 'recognized',
        imageQualityConfidenceBps: 9_400,
        foods: [
          {
            regionIndex: 0,
            rawLabel: '흰쌀밥',
            foodConfidenceBps: 9_500,
            portionConfidenceBps: 9_200,
            amountMilliunits: 1_000,
            unit: 'bowl',
            questions: [],
            alternatives: [],
          },
          {
            regionIndex: 1,
            rawLabel: '김치찌개',
            foodConfidenceBps: 9_300,
            portionConfidenceBps: 9_000,
            amountMilliunits: 1_000,
            unit: 'serving',
            questions: [],
            alternatives: [],
          },
          {
            regionIndex: 2,
            rawLabel: '배추김치',
            foodConfidenceBps: 9_100,
            portionConfidenceBps: 8_800,
            amountMilliunits: 500,
            unit: 'serving',
            questions: [],
            alternatives: [],
          },
        ],
      },
    };
  }
}
