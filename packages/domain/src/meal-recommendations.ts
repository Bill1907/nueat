export const MEAL_RECOMMENDATION_ENGINE_VERSION = 'meal-recommendations-v1';

export interface MealRecommendationNutrients {
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
}

export interface MealRecommendationTemplateComponent {
  sourceItemId: string;
  gramsMg: number;
}

export interface MealRecommendationTemplate {
  id: string;
  titleKo: string;
  components: readonly MealRecommendationTemplateComponent[];
}

export interface ResolvedMealRecommendationComponent {
  foodId: string;
  nameKo: string;
  gramsMg: number;
}

export interface ResolvedMealRecommendationCandidate {
  templateId: string;
  titleKo: string;
  components: readonly ResolvedMealRecommendationComponent[];
  nutrients: MealRecommendationNutrients;
}

export interface RankMealRecommendationsInput {
  targets: MealRecommendationNutrients;
  consumed: MealRecommendationNutrients;
  candidates: readonly ResolvedMealRecommendationCandidate[];
  blockedFoodIds: readonly string[];
  recentFoodIds: readonly string[];
}

export type MealRecommendationRationaleFact =
  | { code: 'PROTEIN_GAP'; remainingMg: number | null; scoreBps: number }
  | { code: 'FIBER_GAP'; remainingMg: number | null; scoreBps: number }
  | { code: 'ENERGY_FIT'; projectedEnergyMillicalories: number | null; scoreBps: number }
  | { code: 'RECENT_FOOD_DIVERSITY'; hasRecentFood: boolean; scoreBps: number };

export type MealRecommendationWarningCode = 'CALORIE_TARGET_OVERAGE';

export interface RankedMealRecommendation extends ResolvedMealRecommendationCandidate {
  rank: number;
  scoreBps: number;
  projectedTotals: MealRecommendationNutrients;
  rationaleFacts: MealRecommendationRationaleFact[];
  warnings: MealRecommendationWarningCode[];
}

export type MealRecommendationErrorCode = 'INVALID_INPUT' | 'DUPLICATE_TEMPLATE_ID';

export class MealRecommendationError extends Error {
  constructor(readonly code: MealRecommendationErrorCode) {
    super(code);
    this.name = 'MealRecommendationError';
  }
}

const sourceItemIds = {
  rice: 'D301-022000000-0001',
  kimchiStew: 'D306-266000000-0001',
  kimchi: 'D315-670000000-0001',
  soybeanStew: 'D106-275000000-0001',
  seaweedSoup: 'D105-223000000-0001',
  beanSproutSoup: 'D105-253000000-0001',
  bulgogi: 'D108-386000000-0001',
  spicyPork: 'D110-465000000-0001',
  dakgalbi: 'D110-462000000-0001',
  porkBelly: 'D108-382000000-0001',
  mackerel: 'D108-357110000-0001',
  friedEgg: 'D109-417000000-0001',
  gimbap: 'D101-007000000-0001',
  bibimbap: 'D101-018000000-0001',
  ramen: 'D103-148000000-0001',
  kalguksu: 'D103-174000000-0001',
  tteokbokki: 'D110-467000000-0001',
  japchae: 'D110-492000000-0001',
  braisedTofu: 'D111-517000000-0001',
  spinach: 'D113-586000000-0001',
} as const;

const component = (sourceItemId: string, gramsMg: number): MealRecommendationTemplateComponent => ({
  sourceItemId,
  gramsMg,
});

export const CURATED_MEAL_RECOMMENDATION_TEMPLATES = [
  { id: 'rice-kimchi-stew', titleKo: '김치찌개 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.kimchiStew, 400_000), component(sourceItemIds.kimchi, 50_000)] },
  { id: 'rice-soybean-stew', titleKo: '된장찌개 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.soybeanStew, 200_000), component(sourceItemIds.spinach, 50_000)] },
  { id: 'rice-seaweed-egg', titleKo: '미역국 달걀 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.seaweedSoup, 400_000), component(sourceItemIds.friedEgg, 60_000)] },
  { id: 'rice-bean-sprout-bulgogi', titleKo: '소불고기 콩나물국 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.beanSproutSoup, 400_000), component(sourceItemIds.bulgogi, 200_000)] },
  { id: 'rice-spicy-pork', titleKo: '제육볶음 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.spicyPork, 250_000), component(sourceItemIds.kimchi, 50_000)] },
  { id: 'rice-dakgalbi', titleKo: '닭갈비 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.dakgalbi, 300_000), component(sourceItemIds.kimchi, 50_000)] },
  { id: 'rice-pork-belly', titleKo: '삼겹살구이 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.porkBelly, 200_000), component(sourceItemIds.kimchi, 50_000)] },
  { id: 'rice-mackerel', titleKo: '고등어구이 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.mackerel, 200_000), component(sourceItemIds.spinach, 50_000)] },
  { id: 'rice-tofu-egg', titleKo: '두부조림 달걀 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.braisedTofu, 100_000), component(sourceItemIds.friedEgg, 60_000)] },
  { id: 'gimbap-kimchi', titleKo: '김밥과 김치', components: [component(sourceItemIds.gimbap, 230_000), component(sourceItemIds.kimchi, 100_000)] },
  { id: 'bibimbap-seaweed-soup', titleKo: '비빔밥과 미역국', components: [component(sourceItemIds.bibimbap, 450_000), component(sourceItemIds.seaweedSoup, 400_000)] },
  { id: 'ramen-egg-kimchi', titleKo: '달걀 라면', components: [component(sourceItemIds.ramen, 550_000), component(sourceItemIds.friedEgg, 60_000), component(sourceItemIds.kimchi, 50_000)] },
  { id: 'kalguksu-kimchi', titleKo: '칼국수와 김치', components: [component(sourceItemIds.kalguksu, 700_000), component(sourceItemIds.kimchi, 100_000)] },
  { id: 'tteokbokki-egg', titleKo: '떡볶이와 달걀', components: [component(sourceItemIds.tteokbokki, 180_000), component(sourceItemIds.friedEgg, 60_000)] },
  { id: 'japchae-spinach', titleKo: '잡채와 시금치나물', components: [component(sourceItemIds.japchae, 200_000), component(sourceItemIds.spinach, 50_000)] },
  { id: 'tofu-spinach-rice', titleKo: '두부조림 시금치 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.braisedTofu, 100_000), component(sourceItemIds.spinach, 50_000)] },
  { id: 'bulgogi-spinach-rice', titleKo: '소불고기 시금치 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.bulgogi, 200_000), component(sourceItemIds.spinach, 50_000)] },
  { id: 'spicy-pork-bean-sprout-rice', titleKo: '제육볶음 콩나물국 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.spicyPork, 250_000), component(sourceItemIds.beanSproutSoup, 400_000)] },
  { id: 'dakgalbi-spinach-rice', titleKo: '닭갈비 시금치 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.dakgalbi, 300_000), component(sourceItemIds.spinach, 50_000)] },
  { id: 'mackerel-seaweed-rice', titleKo: '고등어 미역국 밥상', components: [component(sourceItemIds.rice, 210_000), component(sourceItemIds.mackerel, 200_000), component(sourceItemIds.seaweedSoup, 400_000)] },
] as const satisfies readonly MealRecommendationTemplate[];

const NUTRIENT_KEYS = [
  'energyMillicalories',
  'carbohydrateMg',
  'proteinMg',
  'fatMg',
  'fiberMg',
] as const;

export function rankMealRecommendations(input: RankMealRecommendationsInput): RankedMealRecommendation[] {
  validateInput(input);
  const blockedFoodIds = new Set(input.blockedFoodIds);
  const recentFoodIds = new Set(input.recentFoodIds);

  return input.candidates
    .filter((candidate) => !candidate.components.some((component) => blockedFoodIds.has(component.foodId)))
    .map((candidate) => rankCandidate(candidate, input.targets, input.consumed, recentFoodIds))
    .sort((left, right) => right.scoreBps - left.scoreBps || left.templateId.localeCompare(right.templateId))
    .slice(0, 3)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function rankCandidate(
  candidate: ResolvedMealRecommendationCandidate,
  targets: MealRecommendationNutrients,
  consumed: MealRecommendationNutrients,
  recentFoodIds: ReadonlySet<string>,
): RankedMealRecommendation {
  const projectedTotals = addNutrients(consumed, candidate.nutrients);
  const proteinScore = gapScore(targets.proteinMg, consumed.proteinMg, candidate.nutrients.proteinMg, 4_000);
  const fiberScore = gapScore(targets.fiberMg, consumed.fiberMg, candidate.nutrients.fiberMg, 3_000);
  const energyScore = energyFitScore(targets.energyMillicalories, projectedTotals.energyMillicalories);
  const hasRecentFood = candidate.components.some((component) => recentFoodIds.has(component.foodId));
  const diversityScore = hasRecentFood ? 0 : 500;
  const warnings: MealRecommendationWarningCode[] = [];

  if (
    targets.energyMillicalories !== null &&
    projectedTotals.energyMillicalories !== null &&
    projectedTotals.energyMillicalories > targets.energyMillicalories
  ) {
    warnings.push('CALORIE_TARGET_OVERAGE');
  }

  return {
    ...candidate,
    rank: 0,
    scoreBps: proteinScore + fiberScore + energyScore + diversityScore,
    projectedTotals,
    rationaleFacts: [
      { code: 'PROTEIN_GAP', remainingMg: remaining(targets.proteinMg, consumed.proteinMg), scoreBps: proteinScore },
      { code: 'FIBER_GAP', remainingMg: remaining(targets.fiberMg, consumed.fiberMg), scoreBps: fiberScore },
      { code: 'ENERGY_FIT', projectedEnergyMillicalories: projectedTotals.energyMillicalories, scoreBps: energyScore },
      { code: 'RECENT_FOOD_DIVERSITY', hasRecentFood, scoreBps: diversityScore },
    ],
    warnings,
  };
}

function gapScore(target: number | null, consumed: number | null, candidate: number | null, weightBps: number) {
  const gap = remaining(target, consumed);
  if (gap === null || candidate === null || gap === 0) return 0;
  return ratioBps(candidate < gap ? candidate : gap, gap, weightBps);
}

function energyFitScore(target: number | null, projected: number | null) {
  if (target === null || projected === null || target === 0) return 0;
  const difference = projected >= target ? projected - target : target - projected;
  const weightedDifference = BigInt(difference) * BigInt(projected > target ? 2 : 1);
  const penalty = (weightedDifference * 2_500n) / BigInt(target);
  return 2_500 - Number(penalty > 2_500n ? 2_500n : penalty);
}

function ratioBps(value: number, denominator: number, weightBps: number) {
  return safeBigIntToNumber((BigInt(value) * BigInt(weightBps)) / BigInt(denominator));
}

function remaining(target: number | null, consumed: number | null) {
  if (target === null || consumed === null) return null;
  return safeBigIntToNumber(BigInt(target) > BigInt(consumed) ? BigInt(target) - BigInt(consumed) : 0n);
}

function addNutrients(
  consumed: MealRecommendationNutrients,
  candidate: MealRecommendationNutrients,
): MealRecommendationNutrients {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => [key, addNullable(consumed[key], candidate[key])]),
  ) as unknown as MealRecommendationNutrients;
}

function addNullable(left: number | null, right: number | null) {
  if (left === null || right === null) return null;
  return safeBigIntToNumber(BigInt(left) + BigInt(right));
}

function validateInput(input: RankMealRecommendationsInput) {
  if (!input || typeof input !== 'object') throw new MealRecommendationError('INVALID_INPUT');
  validateNutrients(input.targets);
  validateNutrients(input.consumed);
  validateFoodIds(input.blockedFoodIds);
  validateFoodIds(input.recentFoodIds);
  if (!Array.isArray(input.candidates)) throw new MealRecommendationError('INVALID_INPUT');

  const templateIds = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate.templateId !== 'string' || candidate.templateId.length === 0 || typeof candidate.titleKo !== 'string' || candidate.titleKo.length === 0 || !Array.isArray(candidate.components)) {
      throw new MealRecommendationError('INVALID_INPUT');
    }
    if (templateIds.has(candidate.templateId)) throw new MealRecommendationError('DUPLICATE_TEMPLATE_ID');
    templateIds.add(candidate.templateId);
    if (candidate.components.length < 2 || candidate.components.length > 3) {
      throw new MealRecommendationError('INVALID_INPUT');
    }
    for (const component of candidate.components) {
      if (!component || typeof component.foodId !== 'string' || component.foodId.length === 0 || typeof component.nameKo !== 'string' || component.nameKo.length === 0 || !isPositiveSafeInteger(component.gramsMg)) {
        throw new MealRecommendationError('INVALID_INPUT');
      }
    }
    validateNutrients(candidate.nutrients);
  }
}

function validateNutrients(nutrients: MealRecommendationNutrients) {
  if (!nutrients || typeof nutrients !== 'object') throw new MealRecommendationError('INVALID_INPUT');
  for (const key of NUTRIENT_KEYS) {
    const value = nutrients[key];
    if (value !== null && !isNonnegativeSafeInteger(value)) {
      throw new MealRecommendationError('INVALID_INPUT');
    }
  }
}

function validateFoodIds(foodIds: readonly string[]) {
  if (!Array.isArray(foodIds) || foodIds.some((foodId) => typeof foodId !== 'string' || foodId.length === 0)) {
    throw new MealRecommendationError('INVALID_INPUT');
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeBigIntToNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MealRecommendationError('INVALID_INPUT');
  return Number(value);
}
