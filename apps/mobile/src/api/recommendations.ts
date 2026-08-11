import { apiRequest } from '@/api/client';
import type { MealDraftResponse } from '@/api/meal-drafts';

export type RecommendationNutrition = {
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
};

export type RecommendationComponent = {
  foodId: string;
  nutrientProfileId: string;
  nameKo: string;
  gramsMg: number;
};

export type RecommendationRationaleFact =
  | { code: 'PROTEIN_GAP'; remainingMg: number | null; scoreBps: number }
  | { code: 'FIBER_GAP'; remainingMg: number | null; scoreBps: number }
  | { code: 'ENERGY_FIT'; projectedEnergyMillicalories: number | null; scoreBps: number }
  | { code: 'RECENT_FOOD_DIVERSITY'; hasRecentFood: boolean; scoreBps: number };

export type RecommendationWarning = 'CALORIE_TARGET_OVERAGE';

export type RecommendationGaps = {
  energyMillicalories: number | null;
  proteinMg: number | null;
  fiberMg: number | null;
};

export type NextMealCandidate = {
  rank: number;
  templateId: string;
  titleKo: string;
  components: RecommendationComponent[];
  nutrition: RecommendationNutrition;
  projectedTotals: RecommendationNutrition;
  rationaleFacts: RecommendationRationaleFact[];
  warnings: RecommendationWarning[];
};

export type NextMealRecommendation = {
  recommendationId: string;
  generatedAt: string;
  date: string;
  timezone: string;
  engineVersion: string;
  gaps: RecommendationGaps;
  safetyFlags: string[];
  candidates: NextMealCandidate[];
};

export function getNextMealRecommendation(signal?: AbortSignal) {
  return apiRequest<NextMealRecommendation>('/api/recommendations/next', {
    method: 'POST',
    signal,
  });
}
export function createRecommendationMealDraft(
  recommendationId: string,
  candidateRank: 1 | 2 | 3,
  signal?: AbortSignal,
) {
  return apiRequest<MealDraftResponse>(
    `/api/recommendations/${recommendationId}/meal-draft`,
    {
      method: 'POST',
      body: JSON.stringify({ candidateRank }),
      signal,
    },
  );
}
