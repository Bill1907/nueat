import { sql } from 'drizzle-orm';
import {
  AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth';

export const sourceKindEnum = pgEnum('source_kind', [
  'public_dataset',
  'manufacturer',
  'commercial_dataset',
  'recipe_estimate',
  'user_entered',
]);
export const qualityGradeEnum = pgEnum('quality_grade', ['verified', 'estimated', 'unverified']);
export const servingUnitEnum = pgEnum('serving_unit', [
  'g',
  'ml',
  'serving',
  'bowl',
  'piece',
]);
export const constraintTypeEnum = pgEnum('dietary_constraint_type', [
  'allergy',
  'preference',
  'exclusion',
]);
export const constraintSeverityEnum = pgEnum('dietary_constraint_severity', [
  'avoid',
  'hard_block',
]);

export const sourceRegistries = pgTable('source_registry', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(),
  displayName: text('display_name').notNull(),
  kind: sourceKindEnum('kind').notNull(),
  datasetVersion: text('dataset_version').notNull(),
  licenseReference: text('license_reference').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
});

export const foods = pgTable(
  'food',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    canonicalNameKo: text('canonical_name_ko').notNull(),
    category: text('category').notNull(),
    preparation: text('preparation'),
    isComposite: boolean('is_composite').default(false).notNull(),
    isDeprecated: boolean('is_deprecated').default(false).notNull(),
    replacementFoodId: uuid('replacement_food_id').references((): AnyPgColumn => foods.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('food_name_category_idx').on(table.canonicalNameKo, table.category)],
);

export const foodAliases = pgTable(
  'food_alias',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'restrict' }),
    aliasKo: text('alias_ko').notNull(),
    normalizedAliasKo: text('normalized_alias_ko').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('food_alias_food_normalized_unique').on(table.foodId, table.normalizedAliasKo),
    index('food_alias_normalized_idx').on(table.normalizedAliasKo),
  ],
);

export const foodServings = pgTable(
  'food_serving',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'restrict' }),
    unit: servingUnitEnum('unit').notNull(),
    labelKo: text('label_ko').notNull(),
    amountMilliunits: integer('amount_milliunits').notNull(),
    gramsMg: integer('grams_mg').notNull(),
    sourceRegistryId: uuid('source_registry_id')
      .notNull()
      .references(() => sourceRegistries.id, { onDelete: 'restrict' }),
    qualityGrade: qualityGradeEnum('quality_grade').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('food_serving_food_idx').on(table.foodId),
    check(
      'food_serving_positive_amount_check',
      sql`${table.amountMilliunits} > 0 and ${table.gramsMg} > 0`,
    ),
  ],
);

export const nutrientProfiles = pgTable(
  'nutrient_profile',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'restrict' }),
    sourceRegistryId: uuid('source_registry_id')
      .notNull()
      .references(() => sourceRegistries.id, { onDelete: 'restrict' }),
    sourceItemId: text('source_item_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    basisAmountMg: integer('basis_amount_mg').default(100_000).notNull(),
    energyMillicalories: integer('energy_millicalories'),
    carbohydrateMg: integer('carbohydrate_mg'),
    proteinMg: integer('protein_mg'),
    fatMg: integer('fat_mg'),
    fiberMg: integer('fiber_mg'),
    qualityGrade: qualityGradeEnum('quality_grade').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('nutrient_profile_source_item_version_unique').on(
      table.sourceRegistryId,
      table.sourceItemId,
      table.datasetVersion,
    ),
    index('nutrient_profile_food_quality_idx').on(table.foodId, table.qualityGrade),
    check('nutrient_profile_basis_check', sql`${table.basisAmountMg} > 0`),
    check(
      'nutrient_profile_nonnegative_values_check',
      sql`(${table.energyMillicalories} is null or ${table.energyMillicalories} >= 0)
        and (${table.carbohydrateMg} is null or ${table.carbohydrateMg} >= 0)
        and (${table.proteinMg} is null or ${table.proteinMg} >= 0)
        and (${table.fatMg} is null or ${table.fatMg} >= 0)
        and (${table.fiberMg} is null or ${table.fiberMg} >= 0)`,
    ),
  ],
);

export const dietaryConstraints = pgTable(
  'dietary_constraint',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: constraintTypeEnum('type').notNull(),
    foodId: uuid('food_id').references(() => foods.id, { onDelete: 'restrict' }),
    labelKo: text('label_ko'),
    severity: constraintSeverityEnum('severity').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('dietary_constraint_user_type_idx').on(table.userId, table.type),
    check(
      'dietary_constraint_target_check',
      sql`${table.foodId} is not null or ${table.labelKo} is not null`,
    ),
    check(
      'dietary_constraint_allergy_hard_block_check',
      sql`${table.type} <> 'allergy' or ${table.severity} = 'hard_block'`,
    ),
  ],
);
