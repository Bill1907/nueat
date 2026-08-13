import {
  MEAL_RECOGNITION_V3_PROMPT_VERSION,
  MEAL_RECOGNITION_V3_SCHEMA_VERSION,
  type MealRecognizer,
  type MealRecognizerOutput,
} from './meal-recognizer';

export const MOCK_MEAL_RECOGNITION_MODEL = 'mock-recognition-v3';

export class MockMealRecognizer implements MealRecognizer {
  async recognize(): Promise<MealRecognizerOutput> {
    return {
      provider: 'mock',
      model: MOCK_MEAL_RECOGNITION_MODEL,
      promptVersion: MEAL_RECOGNITION_V3_PROMPT_VERSION,
      schemaVersion: MEAL_RECOGNITION_V3_SCHEMA_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      result: {
        outcome: 'recognized',
        imageQualityConfidenceBps: 9_400,
        observations: [
          {
            regionIndex: 0,
            parentRegionIndex: null,
            kind: 'dish',
            rawLabel: '흰쌀밥',
            foodConfidenceBps: 9_500,
            portionConfidenceBps: 9_200,
            amountMilliunits: 1_000,
            unit: 'bowl',
            categoryHint: 'staple',
            preparationCodes: ['unknown'],
            uncertaintyCodes: [],
            questionReasonCodes: [],
            alternatives: [],
          },
          {
            regionIndex: 1,
            parentRegionIndex: null,
            kind: 'dish',
            rawLabel: '김치찌개',
            foodConfidenceBps: 9_300,
            portionConfidenceBps: 9_000,
            amountMilliunits: 1_000,
            unit: 'serving',
            categoryHint: 'soup_stew',
            preparationCodes: ['boiled'],
            uncertaintyCodes: [],
            questionReasonCodes: [],
            alternatives: [],
          },
          {
            regionIndex: 2,
            parentRegionIndex: null,
            kind: 'dish',
            rawLabel: '배추김치',
            foodConfidenceBps: 9_100,
            portionConfidenceBps: 8_800,
            amountMilliunits: 500,
            unit: 'serving',
            categoryHint: 'vegetable',
            preparationCodes: ['fermented'],
            uncertaintyCodes: [],
            questionReasonCodes: [],
            alternatives: [],
          },
        ],
      },
    };
  }
}
