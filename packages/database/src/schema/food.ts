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
export const releaseStatusEnum = pgEnum('release_status', ['draft', 'published', 'revoked']);

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
    sourceReleaseId: uuid('source_release_id').references(() => sourceReleases.id, {
      onDelete: 'restrict',
    }),
    qualityGrade: qualityGradeEnum('quality_grade').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('food_serving_food_idx').on(table.foodId),
    index('food_serving_source_release_idx').on(table.sourceReleaseId),
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
    sourceReleaseId: uuid('source_release_id').references(() => sourceReleases.id, {
      onDelete: 'restrict',
    }),
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
    index('nutrient_profile_source_release_idx').on(table.sourceReleaseId),
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

export const sourceIdentities = pgTable(
  'source_identity',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    publisher: text('publisher').notNull(),
    dataset: text('dataset').notNull(),
    kind: sourceKindEnum('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('source_identity_publisher_dataset_unique').on(table.publisher, table.dataset),
  ],
);

export const sourceReleases = pgTable(
  'source_release',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceIdentityId: uuid('source_identity_id')
      .notNull()
      .references(() => sourceIdentities.id, { onDelete: 'restrict' }),
    sourceRegistryId: uuid('source_registry_id')
      .notNull()
      .references(() => sourceRegistries.id, { onDelete: 'restrict' }),
    version: text('version').notNull(),
    status: releaseStatusEnum('status').default('draft').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
    licenseReference: text('license_reference').notNull(),
    licenseSha256: text('license_sha256').notNull(),
    artifactSha256: text('artifact_sha256').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    artifactKind: text('artifact_kind').notNull(),
  },
  (table) => [
    uniqueIndex('source_release_identity_version_unique').on(table.sourceIdentityId, table.version),
    check('source_release_version_check', sql`length(trim(${table.version})) > 0`),
    check(
      'source_release_hashes_check',
      sql`${table.licenseSha256} ~ '^[0-9a-f]{64}$'
        and ${table.artifactSha256} ~ '^[0-9a-f]{64}$'
        and ${table.manifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'source_release_publication_check',
      sql`(${table.status} = 'draft' and ${table.publishedAt} is null)
        or (${table.status} in ('published', 'revoked') and ${table.publishedAt} is not null)`,
    ),
  ],
);

export const recipeVersions = pgTable(
  'recipe_version',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    foodId: uuid('food_id').notNull().references(() => foods.id, { onDelete: 'restrict' }),
    sourceReleaseId: uuid('source_release_id').notNull().references(() => sourceReleases.id, { onDelete: 'restrict' }),
    sourceRecipeId: text('source_recipe_id').notNull(),
    version: text('version').notNull(),
    yieldMg: integer('yield_mg').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('recipe_version_source_unique').on(table.sourceReleaseId, table.sourceRecipeId, table.version),
    index('recipe_version_food_idx').on(table.foodId),
    check('recipe_version_yield_check', sql`${table.yieldMg} > 0`),
    check('recipe_version_source_id_check', sql`length(trim(${table.sourceRecipeId})) > 0 and length(trim(${table.version})) > 0`),
  ],
);

export const recipeVersionComponents = pgTable(
  'recipe_version_component',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recipeVersionId: uuid('recipe_version_id').notNull().references(() => recipeVersions.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    foodId: uuid('food_id').notNull().references(() => foods.id, { onDelete: 'restrict' }),
    edibleAmountMg: integer('edible_amount_mg').notNull(),
  },
  (table) => [
    uniqueIndex('recipe_version_component_ordinal_unique').on(table.recipeVersionId, table.ordinal),
    uniqueIndex('recipe_version_component_food_unique').on(table.recipeVersionId, table.foodId),
    check('recipe_version_component_ordinal_check', sql`${table.ordinal} between 0 and 11`),
    check('recipe_version_component_amount_check', sql`${table.edibleAmountMg} > 0`),
  ],
);

export const catalogReleases = pgTable(
  'catalog_release',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    version: text('version').notNull().unique(),
    status: releaseStatusEnum('status').default('draft').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    normalizerVersion: text('normalizer_version').notNull(),
    normalizerSha256: text('normalizer_sha256').notNull(),
    taxonomySha256: text('taxonomy_sha256').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    foodMemberCount: integer('food_member_count').notNull(),
    foodAliasMemberCount: integer('food_alias_member_count').notNull(),
    searchDocumentCount: integer('search_document_count').notNull(),
    nutrientProfileMemberCount: integer('nutrient_profile_member_count').notNull(),
    foodServingMemberCount: integer('food_serving_member_count').notNull(),
    sourceReleaseMemberCount: integer('source_release_member_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('catalog_release_version_check', sql`length(trim(${table.version})) > 0`),
    check(
      'catalog_release_hashes_check',
      sql`${table.normalizerSha256} ~ '^[0-9a-f]{64}$'
        and ${table.taxonomySha256} ~ '^[0-9a-f]{64}$'
        and ${table.manifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'catalog_release_counts_check',
      sql`${table.foodMemberCount} >= 0 and ${table.foodAliasMemberCount} >= 0
        and ${table.searchDocumentCount} >= 0
        and ${table.nutrientProfileMemberCount} >= 0 and ${table.foodServingMemberCount} >= 0
        and ${table.sourceReleaseMemberCount} >= 0`,
    ),
    check(
      'catalog_release_publication_check',
      sql`(${table.status} = 'draft' and ${table.publishedAt} is null)
        or (${table.status} in ('published', 'revoked') and ${table.publishedAt} is not null)`,
    ),
  ],
);

export const catalogBackfillCheckpoints = pgTable(
  'catalog_backfill_checkpoint',
  {
    jobName: text('job_name').notNull(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    phase: text('phase').notNull(),
    lastId: uuid('last_id'),
    rowCount: integer('row_count').default(0).notNull(),
    rollingSha256: text('rolling_sha256').notNull(),
    status: text('status').default('running').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('catalog_backfill_checkpoint_unique').on(
      table.jobName,
      table.catalogReleaseId,
      table.phase,
    ),
    index('catalog_backfill_checkpoint_release_idx').on(
      table.catalogReleaseId,
      table.phase,
    ),
    check('catalog_backfill_checkpoint_job_check', sql`length(trim(${table.jobName})) > 0`),
    check('catalog_backfill_checkpoint_phase_check', sql`length(trim(${table.phase})) > 0`),
    check('catalog_backfill_checkpoint_count_check', sql`${table.rowCount} >= 0`),
    check('catalog_backfill_checkpoint_hash_check', sql`${table.rollingSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'catalog_backfill_checkpoint_status_check',
      sql`(${table.status} = 'running' and ${table.completedAt} is null)
        or (${table.status} = 'complete' and ${table.completedAt} is not null)`,
    ),
  ],
);

export const catalogReleaseSources = pgTable(
  'catalog_release_source',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    sourceReleaseId: uuid('source_release_id')
      .notNull()
      .references(() => sourceReleases.id, { onDelete: 'restrict' }),
    priority: integer('priority').notNull(),
    allowedArtifactKinds: text('allowed_artifact_kinds').array().notNull(),
    eligibilityManifestSha256: text('eligibility_manifest_sha256').notNull(),
  },
  (table) => [
    uniqueIndex('catalog_release_source_release_unique').on(
      table.catalogReleaseId,
      table.sourceReleaseId,
    ),
    uniqueIndex('catalog_release_source_priority_unique').on(table.catalogReleaseId, table.priority),
    check('catalog_release_source_priority_check', sql`${table.priority} >= 100 and ${table.priority} <= 499`),
    check('catalog_release_source_artifact_kinds_check', sql`cardinality(${table.allowedArtifactKinds}) > 0`),
    check(
      'catalog_release_source_eligibility_hash_check',
      sql`${table.eligibilityManifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const catalogReleaseFoods = pgTable(
  'catalog_release_food',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('catalog_release_food_unique').on(table.catalogReleaseId, table.foodId),
    index('catalog_release_food_release_idx').on(table.catalogReleaseId),
  ],
);

export const catalogReleaseFoodAliases = pgTable(
  'catalog_release_food_alias',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    foodAliasId: uuid('food_alias_id')
      .notNull()
      .references(() => foodAliases.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('catalog_release_food_alias_unique').on(table.catalogReleaseId, table.foodAliasId),
  ],
);

export const catalogReleaseNutrientProfiles = pgTable(
  'catalog_release_nutrient_profile',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    nutrientProfileId: uuid('nutrient_profile_id')
      .notNull()
      .references(() => nutrientProfiles.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('catalog_release_nutrient_profile_unique').on(
      table.catalogReleaseId,
      table.nutrientProfileId,
    ),
  ],
);

export const catalogReleaseFoodServings = pgTable(
  'catalog_release_food_serving',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    foodServingId: uuid('food_serving_id')
      .notNull()
      .references(() => foodServings.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('catalog_release_food_serving_unique').on(
      table.catalogReleaseId,
      table.foodServingId,
    ),
  ],
);

export const catalogReleaseSearchDocuments = pgTable(
  'catalog_release_search_document',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'restrict' }),
    sourceAliasId: uuid('source_alias_id').references(() => foodAliases.id, { onDelete: 'restrict' }),
    displayTextKo: text('display_text_ko').notNull(),
    normalizedSpaced: text('normalized_spaced').notNull(),
    normalizedCompact: text('normalized_compact').notNull(),
    orderedTokens: text('ordered_tokens').array().notNull(),
    orderedTrigrams: text('ordered_trigrams').array().notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    contentSha256: text('content_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('catalog_release_search_document_content_unique').on(
      table.catalogReleaseId,
      table.foodId,
      table.contentSha256,
    ),
    index('catalog_release_search_document_release_idx').on(table.catalogReleaseId, table.id),
    index('catalog_release_search_document_compact_idx').on(
      table.catalogReleaseId,
      table.normalizedCompact,
    ),
    check('catalog_release_search_document_compact_check', sql`length(${table.normalizedCompact}) > 0`),
    check(
      'catalog_release_search_document_hash_check',
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const releaseActivations = pgTable(
  'release_activation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    catalogReleaseId: uuid('catalog_release_id')
      .notNull()
      .references(() => catalogReleases.id, { onDelete: 'restrict' }),
    policyVersion: text('policy_version').notNull(),
    policySha256: text('policy_sha256').notNull(),
    eligibilityManifestSha256: text('eligibility_manifest_sha256').notNull(),
    signedReceiptVersion: text('signed_receipt_version').notNull(),
    signedReceiptSha256: text('signed_receipt_sha256').notNull(),
    actorId: text('actor_id').notNull(),
    reason: text('reason').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('release_activation_catalog_release_idx').on(table.catalogReleaseId, table.effectiveAt),
    check(
      'release_activation_hashes_check',
      sql`${table.policySha256} ~ '^[0-9a-f]{64}$'
        and ${table.eligibilityManifestSha256} ~ '^[0-9a-f]{64}$'
        and ${table.signedReceiptSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'release_activation_text_check',
      sql`length(trim(${table.policyVersion})) > 0
        and length(trim(${table.signedReceiptVersion})) > 0
        and length(trim(${table.actorId})) > 0
        and length(trim(${table.reason})) > 0`,
    ),
  ],
);

export const activeCatalogReleasePointers = pgTable(
  'active_catalog_release_pointer',
  {
    singletonId: integer('singleton_id').primaryKey().default(1),
    activationId: uuid('activation_id')
      .notNull()
      .references(() => releaseActivations.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check('active_catalog_release_pointer_singleton_check', sql`${table.singletonId} = 1`)],
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
