import {
  foodAliases,
  foods,
  foodServings,
  nutrientProfiles,
  sourceRegistries,
  type Database,
} from '@nueat/database';
import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm';

const trustedSourceKinds = ['public_dataset', 'manufacturer', 'commercial_dataset'] as const;
type DatabaseExecutor = Pick<Database, 'select'>;
export const MEAL_ITEM_RESOLVER_VERSION = 'meal-item-resolution-v1';

type ResolutionItem = {
  id: string;
  foodId: string | null;
  nutrientProfileId: string | null;
  unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
};

export type CurrentMealItemResolution = {
  itemId: string;
  food: { id: string; canonicalNameKo: string } | null;
  profile: {
    id: string;
    foodId: string;
    sourceRegistryId: string;
    sourceItemId: string;
    datasetVersion: string;
    qualityGrade: 'verified' | 'estimated' | 'unverified';
    basisAmountMg: number;
    energyMillicalories: number | null;
    carbohydrateMg: number | null;
    proteinMg: number | null;
    fatMg: number | null;
    fiberMg: number | null;
  } | null;
  serving: {
    id: string;
    unit: string;
    amountMilliunits: number;
    gramsMg: number;
    sourceRegistryId: string;
    qualityGrade: 'verified' | 'estimated' | 'unverified';
  } | null;
  reason: string | null;
};

/**
 * Resolves persisted references only. It deliberately does not decide release,
 * source, profile, or serving eligibility; MealItemAuthorityProjection is the
 * release-scoped authority for those decisions.
 */
export async function resolveCurrentMealItems(
  database: DatabaseExecutor,
  items: ResolutionItem[],
): Promise<CurrentMealItemResolution[]> {
  const foodIds = [...new Set(items.flatMap((item) => item.foodId ? [item.foodId] : []))];
  const profileIds = [...new Set(items.flatMap((item) => item.nutrientProfileId ? [item.nutrientProfileId] : []))];
  const [selectedFoods, profiles, servings] = await Promise.all([
    foodIds.length === 0 ? [] : database.select({ id: foods.id, canonicalNameKo: foods.canonicalNameKo, isDeprecated: foods.isDeprecated }).from(foods).where(inArray(foods.id, foodIds)),
    profileIds.length === 0 ? [] : database.select({
      id: nutrientProfiles.id, foodId: nutrientProfiles.foodId, sourceRegistryId: nutrientProfiles.sourceRegistryId,
      sourceItemId: nutrientProfiles.sourceItemId, datasetVersion: nutrientProfiles.datasetVersion,
      qualityGrade: nutrientProfiles.qualityGrade, basisAmountMg: nutrientProfiles.basisAmountMg,
      energyMillicalories: nutrientProfiles.energyMillicalories, carbohydrateMg: nutrientProfiles.carbohydrateMg,
      proteinMg: nutrientProfiles.proteinMg, fatMg: nutrientProfiles.fatMg, fiberMg: nutrientProfiles.fiberMg,
    }).from(nutrientProfiles).where(inArray(nutrientProfiles.id, profileIds)),
    foodIds.length === 0 ? [] : database.select({
      id: foodServings.id, foodId: foodServings.foodId, sourceRegistryId: foodServings.sourceRegistryId, unit: foodServings.unit,
      amountMilliunits: foodServings.amountMilliunits, gramsMg: foodServings.gramsMg,
      qualityGrade: foodServings.qualityGrade,
    }).from(foodServings).where(inArray(foodServings.foodId, foodIds)),
  ]);
  const foodById = new Map(selectedFoods.map((food) => [food.id, food]));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return items.map((item) => {
    if (!item.foodId || !item.nutrientProfileId) return { itemId: item.id, food: null, profile: null, serving: null, reason: 'MISSING_MAPPING' };
    const food = foodById.get(item.foodId);
    if (!food) return { itemId: item.id, food: null, profile: null, serving: null, reason: 'MISSING_FOOD' };
    if (food.isDeprecated) return { itemId: item.id, food: { id: food.id, canonicalNameKo: food.canonicalNameKo }, profile: null, serving: null, reason: 'DEPRECATED_FOOD' };
    const profile = profileById.get(item.nutrientProfileId);
    if (!profile) return { itemId: item.id, food: { id: food.id, canonicalNameKo: food.canonicalNameKo }, profile: null, serving: null, reason: 'MISSING_PROFILE' };
    if (profile.foodId !== item.foodId) return { itemId: item.id, food: { id: food.id, canonicalNameKo: food.canonicalNameKo }, profile: null, serving: null, reason: 'MISMATCHED_PROFILE' };
    const publicProfile = { ...profile, qualityGrade: profile.qualityGrade as 'verified' | 'estimated' | 'unverified' };
    if (item.unit === 'g') return { itemId: item.id, food: { id: food.id, canonicalNameKo: food.canonicalNameKo }, profile: publicProfile, serving: null, reason: null };
    const unitServings = servings.filter(
      (serving) => serving.foodId === item.foodId && serving.unit === item.unit,
    );
    if (unitServings.length === 0) return { itemId: item.id, food: { id: food.id, canonicalNameKo: food.canonicalNameKo }, profile: publicProfile, serving: null, reason: 'MISSING_SERVING_CONVERSION' };
    if (unitServings.length > 1) return { itemId: item.id, food: { id: food.id, canonicalNameKo: food.canonicalNameKo }, profile: publicProfile, serving: null, reason: 'AMBIGUOUS_SERVING_CONVERSION' };
    const serving = unitServings[0]!;
    return {
      itemId: item.id,
      food: { id: food.id, canonicalNameKo: food.canonicalNameKo },
      profile: publicProfile,
      serving: {
        id: serving.id,
        unit: serving.unit,
        amountMilliunits: serving.amountMilliunits,
        gramsMg: serving.gramsMg,
        sourceRegistryId: serving.sourceRegistryId,
        qualityGrade: serving.qualityGrade as 'verified' | 'estimated' | 'unverified',
      },
      reason: null,
    };
  });
}

/** Maps recognition labels to draft candidates. These are discovery hints, never meal-item authority. */
export async function resolveRecognitionCandidates(
  database: Database,
  candidates: Array<{
    rawLabel: string;
    alternatives?: Array<{ normalizedLabel: string; confidenceBps: number }>;
  }>,
) {
  const labels = [...new Set(candidates.flatMap((candidate) => [
    normalizeFoodQuery(candidate.rawLabel),
    ...(candidate.alternatives ?? []).map((alternative) => normalizeFoodQuery(alternative.normalizedLabel)),
  ]).filter(Boolean))];
  if (labels.length === 0) return candidates.map(() => null);
  const aliases = await database.select({ normalizedAliasKo: foodAliases.normalizedAliasKo, foodId: foodAliases.foodId, canonicalNameKo: foods.canonicalNameKo, isDeprecated: foods.isDeprecated }).from(foodAliases).innerJoin(foods, eq(foodAliases.foodId, foods.id)).where(and(inArray(foodAliases.normalizedAliasKo, labels), eq(foods.isDeprecated, false))).orderBy(asc(foodAliases.normalizedAliasKo), asc(foods.id));
  const aliasesByLabel = new Map<string, (typeof aliases)[number][]>();
  for (const alias of aliases) {
    const matches = aliasesByLabel.get(alias.normalizedAliasKo) ?? [];
    matches.push(alias);
    aliasesByLabel.set(alias.normalizedAliasKo, matches);
  }
  const exact = (label: string) => {
    const matches = aliasesByLabel.get(normalizeFoodQuery(label)) ?? [];
    return matches.length === 1 ? matches[0]! : null;
  };
  const matched = candidates.map((candidate) => {
    const primary = exact(candidate.rawLabel);
    if (primary) return { alias: primary, source: 'model_primary' as const };
    const alternative = candidate.alternatives
      ?.map((value) => ({ value, alias: exact(value.normalizedLabel) }))
      .find((candidate) => candidate.alias)?.alias;
    return alternative ? { alias: alternative, source: 'model_alternative' as const } : null;
  });
  const foodIds = [...new Set(matched.flatMap((match) => match ? [match.alias.foodId] : []))];
  const profiles = foodIds.length === 0 ? [] : await database.select({ id: nutrientProfiles.id, foodId: nutrientProfiles.foodId, qualityGrade: nutrientProfiles.qualityGrade, datasetVersion: nutrientProfiles.datasetVersion }).from(nutrientProfiles).innerJoin(sourceRegistries, eq(nutrientProfiles.sourceRegistryId, sourceRegistries.id)).where(and(inArray(nutrientProfiles.foodId, foodIds), or(eq(nutrientProfiles.qualityGrade, 'verified'), eq(nutrientProfiles.qualityGrade, 'estimated')), inArray(sourceRegistries.kind, [...trustedSourceKinds]), isNotNull(nutrientProfiles.energyMillicalories), isNotNull(nutrientProfiles.carbohydrateMg), isNotNull(nutrientProfiles.proteinMg), isNotNull(nutrientProfiles.fatMg),));
  const profilesByFood = new Map<string, string>();
  for (const profile of profiles.sort(compareProfiles)) if (!profilesByFood.has(profile.foodId)) profilesByFood.set(profile.foodId, profile.id);
  return matched.map((match, index) => match && profilesByFood.has(match.alias.foodId) ? {
    foodId: match.alias.foodId,
    nutrientProfileId: profilesByFood.get(match.alias.foodId)!,
    canonicalNameKo: match.alias.canonicalNameKo,
    matchedLabel: match.source === 'model_primary'
      ? candidates[index]!.rawLabel
      : candidates[index]!.alternatives
          ?.find((alternative) => normalizeFoodQuery(alternative.normalizedLabel) === match.alias.normalizedAliasKo)
          ?.normalizedLabel ?? null,
    mappingSource: match.source,
  } : null);
}

function normalizeFoodQuery(value: string) {
  return value.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
function compareProfiles(
  left: { qualityGrade: string; datasetVersion: string; id: string },
  right: { qualityGrade: string; datasetVersion: string; id: string },
) {
  const rank = (qualityGrade: string) => qualityGrade === 'verified' ? 0 : qualityGrade === 'estimated' ? 1 : 2;
  return rank(left.qualityGrade) - rank(right.qualityGrade) ||
    right.datasetVersion.localeCompare(left.datasetVersion) ||
    left.id.localeCompare(right.id);
}
