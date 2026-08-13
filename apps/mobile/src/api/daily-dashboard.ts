import { apiRequest } from '@/api/client';

export type DailyNutritionTarget = {
  profileId: string;
  goalType: string;
  energyMillicalories: number;
  carbohydrateMg: number;
  proteinMg: number;
  fatMg: number;
  fiberMg: number;
};

export type DailyNutrientTotal = {
  value: number | null;
  knownValue: number;
  missingItemCount: number;
  completeness: 'complete' | 'partial';
};

export type DailyNutritionTotals = Record<
  'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
  DailyNutrientTotal
>;

export type DailyMeal = {
  id: string;
  eatenAt: string;
  mealType: string;
  itemLabels: string[];
  totals: DailyNutritionTotals;
  qualityGrade: 'verified' | 'estimated';
  calculationVersion: string;
  calculatedAt: string;
};

export type DailyDashboard = {
  date: string;
  timezone: string;
  targetStatus: 'active' | 'pending' | 'limited' | 'none';
  targetReasons: string[];
  target: DailyNutritionTarget | null;
  totals: DailyNutritionTotals;
  meals: DailyMeal[];
};

export function getDailyDashboard(date?: string, signal?: AbortSignal) {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return apiRequest<DailyDashboard>(`/api/dashboard/daily${query}`, { signal });
}
