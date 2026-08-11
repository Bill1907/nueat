import { describe, expect, test } from 'bun:test';

import {
  CURATED_MEAL_RECOMMENDATION_TEMPLATES,
  MealRecommendationError,
  rankMealRecommendations,
  type MealRecommendationNutrients,
  type RankMealRecommendationsInput,
} from './meal-recommendations';

const targets: MealRecommendationNutrients = {
  energyMillicalories: 2_000_000,
  carbohydrateMg: 250_000,
  proteinMg: 100_000,
  fatMg: 60_000,
  fiberMg: 25_000,
};

const consumed: MealRecommendationNutrients = {
  energyMillicalories: 1_000_000,
  carbohydrateMg: 120_000,
  proteinMg: 40_000,
  fatMg: 30_000,
  fiberMg: 10_000,
};

function candidate(templateId: string, overrides: Partial<RankMealRecommendationsInput['candidates'][number]> = {}) {
  return {
    templateId,
    titleKo: templateId,
    components: [
      { foodId: `${templateId}-a`, nutrientProfileId: `${templateId}-profile-a`, nameKo: '음식 A', gramsMg: 100_000 },
      { foodId: `${templateId}-b`, nutrientProfileId: `${templateId}-profile-b`, nameKo: '음식 B', gramsMg: 100_000 },
    ],
    nutrients: {
      energyMillicalories: 500_000,
      carbohydrateMg: 50_000,
      proteinMg: 30_000,
      fatMg: 10_000,
      fiberMg: 10_000,
    },
    ...overrides,
  };
}

function input(overrides: Partial<RankMealRecommendationsInput> = {}): RankMealRecommendationsInput {
  return {
    targets,
    consumed,
    candidates: [candidate('one')],
    blockedFoodIds: [],
    recentFoodIds: [],
    ...overrides,
  };
}

describe('curated meal recommendation templates', () => {
  test('contains 20 unique Korea-first templates with two or three known-source components', () => {
    const allowedSourceItemIds = new Set([
      'D301-022000000-0001', 'D306-266000000-0001', 'D315-670000000-0001', 'D106-275000000-0001',
      'D105-223000000-0001', 'D105-253000000-0001', 'D108-386000000-0001', 'D110-465000000-0001',
      'D110-462000000-0001', 'D108-382000000-0001', 'D108-357110000-0001', 'D109-417000000-0001',
      'D101-007000000-0001', 'D101-018000000-0001', 'D103-148000000-0001', 'D103-174000000-0001',
      'D110-467000000-0001', 'D110-492000000-0001', 'D111-517000000-0001', 'D113-586000000-0001',
    ]);
    expect(CURATED_MEAL_RECOMMENDATION_TEMPLATES).toHaveLength(20);
    expect(new Set(CURATED_MEAL_RECOMMENDATION_TEMPLATES.map((template) => template.id)).size).toBe(20);
    for (const template of CURATED_MEAL_RECOMMENDATION_TEMPLATES) {
      expect(template.components.length).toBeGreaterThanOrEqual(2);
      expect(template.components.length).toBeLessThanOrEqual(3);
      expect(template.components.every((component) => allowedSourceItemIds.has(component.sourceItemId) && component.gramsMg > 0)).toBe(true);
    }
  });
});

describe('rankMealRecommendations', () => {
  test('hard-blocks candidates containing an excluded food', () => {
    const blocked = candidate('blocked', { components: [{ foodId: 'allergen', nutrientProfileId: 'allergen-profile', nameKo: '알레르겐', gramsMg: 100_000 }, { foodId: 'safe', nutrientProfileId: 'safe-profile', nameKo: '안전식품', gramsMg: 100_000 }] });
    expect(rankMealRecommendations(input({ candidates: [blocked, candidate('safe')], blockedFoodIds: ['allergen'] })).map((item) => item.templateId)).toEqual(['safe']);
  });

  test('does not score unknown fiber and preserves a null projected fiber total', () => {
    const result = rankMealRecommendations(input({
      candidates: [candidate('unknown-fiber', { nutrients: { ...candidate('x').nutrients, fiberMg: null } })],
    }))[0]!;
    expect(result.projectedTotals.fiberMg).toBeNull();
    expect(result.rationaleFacts.find((fact) => fact.code === 'FIBER_GAP')).toEqual({ code: 'FIBER_GAP', remainingMg: 15_000, scoreBps: 0 });
  });

  test('penalizes energy overage and emits its warning', () => {
    const result = rankMealRecommendations(input({
      candidates: [candidate('overage', { nutrients: { ...candidate('x').nutrients, energyMillicalories: 1_100_000 } })],
    }))[0]!;
    expect(result.warnings).toEqual(['CALORIE_TARGET_OVERAGE']);
    expect(result.rationaleFacts.find((fact) => fact.code === 'ENERGY_FIT')).toEqual({ code: 'ENERGY_FIT', projectedEnergyMillicalories: 2_100_000, scoreBps: 2_250 });
  });

  test('clamps extreme energy penalties before converting to number', () => {
    const zero: MealRecommendationNutrients = {
      energyMillicalories: 0,
      carbohydrateMg: 0,
      proteinMg: 0,
      fatMg: 0,
      fiberMg: 0,
    };
    const result = rankMealRecommendations(input({
      targets: { ...zero, energyMillicalories: 1 },
      consumed: zero,
      candidates: [candidate('extreme', {
        nutrients: { ...zero, energyMillicalories: Number.MAX_SAFE_INTEGER },
      })],
    }))[0]!;
    expect(result.rationaleFacts.find((fact) => fact.code === 'ENERGY_FIT')).toEqual({
      code: 'ENERGY_FIT',
      projectedEnergyMillicalories: Number.MAX_SAFE_INTEGER,
      scoreBps: 0,
    });
  });

  test('applies a 500 basis-point penalty to a recent food', () => {
    const fresh = candidate('fresh');
    const recent = candidate('recent', { components: [{ foodId: 'recent-food', nutrientProfileId: 'recent-profile', nameKo: '최근 음식', gramsMg: 100_000 }, { foodId: 'recent-b', nutrientProfileId: 'recent-b-profile', nameKo: '최근 음식 B', gramsMg: 100_000 }] });
    const ranked = rankMealRecommendations(input({ candidates: [recent, fresh], recentFoodIds: ['recent-food'] }));
    expect(ranked.map((item) => item.templateId)).toEqual(['fresh', 'recent']);
    expect(ranked[0]!.scoreBps - ranked[1]!.scoreBps).toBe(500);
  });

  test('uses template ID as a deterministic tie-break and returns at most three', () => {
    const ranked = rankMealRecommendations(input({ candidates: [candidate('z'), candidate('a'), candidate('b'), candidate('c')] }));
    expect(ranked.map((item) => [item.rank, item.templateId])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  test('calculates projected totals without floating point arithmetic', () => {
    const result = rankMealRecommendations(input())[0]!;
    expect(result.projectedTotals).toEqual({
      energyMillicalories: 1_500_000,
      carbohydrateMg: 170_000,
      proteinMg: 70_000,
      fatMg: 40_000,
      fiberMg: 20_000,
    });
  });

  test('rejects unsafe nutrients, negative values, and duplicate template IDs', () => {
    expectRecommendationError(() => rankMealRecommendations(input({ candidates: [candidate('unsafe', { nutrients: { ...candidate('x').nutrients, proteinMg: Number.MAX_SAFE_INTEGER + 1 } })] })), 'INVALID_INPUT');
    expectRecommendationError(() => rankMealRecommendations(input({ candidates: [candidate('negative', { nutrients: { ...candidate('x').nutrients, proteinMg: -1 } })] })), 'INVALID_INPUT');
    expectRecommendationError(() => rankMealRecommendations(input({ candidates: [candidate('same'), candidate('same')] })), 'DUPLICATE_TEMPLATE_ID');
  });
});

function expectRecommendationError(callback: () => unknown, code: MealRecommendationError['code']) {
  try {
    callback();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MealRecommendationError);
    expect((error as MealRecommendationError).code).toBe(code);
  }
}
