import { createHash } from 'node:crypto';

import {
  foodAliases,
  foods,
  foodServings,
  nutrientProfiles,
  sourceRegistries,
  type Database,
} from '@nueat/database';
import { asc } from 'drizzle-orm';

export async function calculateCatalogRegistrySha256(database: Pick<Database, 'select'>) {
  const [registries, catalogFoods, aliases, profiles, servings] = await Promise.all([
    database.select({
      id: sourceRegistries.id,
      code: sourceRegistries.code,
      kind: sourceRegistries.kind,
      datasetVersion: sourceRegistries.datasetVersion,
      licenseReference: sourceRegistries.licenseReference,
      publishedAt: sourceRegistries.publishedAt,
    }).from(sourceRegistries).orderBy(asc(sourceRegistries.id)),
    database.select({
      id: foods.id,
      canonicalNameKo: foods.canonicalNameKo,
      category: foods.category,
      preparation: foods.preparation,
      isComposite: foods.isComposite,
      isDeprecated: foods.isDeprecated,
      replacementFoodId: foods.replacementFoodId,
    }).from(foods).orderBy(asc(foods.id)),
    database.select({
      id: foodAliases.id,
      normalizedAliasKo: foodAliases.normalizedAliasKo,
      foodId: foodAliases.foodId,
    }).from(foodAliases).orderBy(asc(foodAliases.id)),
    database.select({
      id: nutrientProfiles.id,
      foodId: nutrientProfiles.foodId,
      sourceRegistryId: nutrientProfiles.sourceRegistryId,
      sourceItemId: nutrientProfiles.sourceItemId,
      datasetVersion: nutrientProfiles.datasetVersion,
      basisAmountMg: nutrientProfiles.basisAmountMg,
      energyMillicalories: nutrientProfiles.energyMillicalories,
      carbohydrateMg: nutrientProfiles.carbohydrateMg,
      proteinMg: nutrientProfiles.proteinMg,
      fatMg: nutrientProfiles.fatMg,
      fiberMg: nutrientProfiles.fiberMg,
      qualityGrade: nutrientProfiles.qualityGrade,
    }).from(nutrientProfiles).orderBy(asc(nutrientProfiles.id)),
    database.select({
      id: foodServings.id,
      foodId: foodServings.foodId,
      unit: foodServings.unit,
      amountMilliunits: foodServings.amountMilliunits,
      gramsMg: foodServings.gramsMg,
      sourceRegistryId: foodServings.sourceRegistryId,
      qualityGrade: foodServings.qualityGrade,
    }).from(foodServings).orderBy(asc(foodServings.id)),
  ]);
  return createHash('sha256')
    .update(canonicalJson({ registries, foods: catalogFoods, aliases, profiles, servings }))
    .digest('hex');
}

export async function calculateCatalogReleaseIdentity(database: Pick<Database, 'select'>) {
  const registrySha256 = await calculateCatalogRegistrySha256(database);
  const registries = await database.select({
    code: sourceRegistries.code,
    datasetVersion: sourceRegistries.datasetVersion,
  }).from(sourceRegistries).orderBy(asc(sourceRegistries.id));
  return {
    releaseIds: registries.map((registry) => `${registry.code}@${registry.datasetVersion}`),
    registrySha256,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
