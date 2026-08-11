import { apiRequest, ApiError } from '@/api/client';
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

export async function getNextMealRecommendation(signal?: AbortSignal) {
  const response = await apiRequest<NextMealRecommendation>('/api/recommendations/next', {
    method: 'POST',
    signal,
  });
  if (!hasValidRecommendationCandidates(response)) {
    throw new ApiError(
      '추천 영양 정보를 확인하지 못했습니다.',
      'INVALID_RECOMMENDATION_RESPONSE',
    );
  }
  return response;
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

function hasValidRecommendationCandidates(response: NextMealRecommendation) {
  return (
    Array.isArray(response.candidates) &&
    response.candidates.every((candidate) => {
      const nutrition = candidate?.nutrition;
      return (
        nutrition !== null &&
        typeof nutrition === 'object' &&
        isNullableNumber(nutrition.energyMillicalories) &&
        isNullableNumber(nutrition.carbohydrateMg) &&
        isNullableNumber(nutrition.proteinMg) &&
        isNullableNumber(nutrition.fatMg) &&
        isNullableNumber(nutrition.fiberMg) &&
        Array.isArray(candidate.components) &&
        Array.isArray(candidate.rationaleFacts) &&
        Array.isArray(candidate.warnings)
      );
    })
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}
