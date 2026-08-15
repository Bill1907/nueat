import { describe, expect, test } from 'bun:test';

import {
  formsFromMealDraftItems,
  mergeObservationRefreshForms,
} from '../src/meals/meal-observation-merge';
import { mealDraftObservation } from './fixtures/meal-draft-current-previous';

describe('meal confirmation observation precedence', () => {
  test('preserves local label, amount, and unit edits over a late observation', () => {
    const previous = [mealDraftObservation()];
    const current = formsFromMealDraftItems(previous);
    current['observation-item'] = {
      recognizedLabel: '직접 확인한 음식',
      amount: '1.5',
      unit: 'serving',
    };
    const late = [mealDraftObservation({
      recognizedLabel: '돌솥비빔밥',
      amountMilliunits: 2_000,
      unit: 'bowl',
    })];

    expect(mergeObservationRefreshForms(current, previous, late)).toEqual({
      'observation-item': {
        recognizedLabel: '직접 확인한 음식',
        amount: '1.5',
        unit: 'serving',
      },
    });
  });

  test('accepts unedited server changes and appends a new observation', () => {
    const previous = [mealDraftObservation()];
    const current = formsFromMealDraftItems(previous);
    const next = [
      mealDraftObservation({ amountMilliunits: 1_500 }),
      mealDraftObservation({ id: 'late-item', recognizedLabel: '김치' }),
    ];

    expect(mergeObservationRefreshForms(current, previous, next)).toEqual({
      'observation-item': {
        recognizedLabel: '비빔밥',
        amount: '1.5',
        unit: 'bowl',
      },
      'late-item': {
        recognizedLabel: '김치',
        amount: '1',
        unit: 'bowl',
      },
    });
  });
});
