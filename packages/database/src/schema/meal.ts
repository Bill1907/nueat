import { sql } from 'drizzle-orm';
import {
  AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth';
import { foods, nutrientProfiles, servingUnitEnum } from './food';

export const mealStatusEnum = pgEnum('meal_status', ['draft', 'confirmed', 'deleted']);
export const mealTypeEnum = pgEnum('meal_type', ['breakfast', 'lunch', 'dinner', 'snack']);
export const imageAssetPurposeEnum = pgEnum('image_asset_purpose', ['inference', 'thumbnail']);
export const imageAssetStatusEnum = pgEnum('image_asset_status', [
  'pending_upload',
  'uploaded',
  'validating',
  'validated',
  'processing',
  'processed',
  'rejected',
  'deletion_pending',
  'deleted',
]);
export const recognitionStatusEnum = pgEnum('recognition_status', [
  'pending',
  'ready',
  'failed',
]);
export const assetDeletionJobStatusEnum = pgEnum('asset_deletion_job_status', [
  'pending',
  'processing',
  'failed',
  'completed',
]);

export interface CalculationInputSnapshot {
  mealItems: Array<{
    mealItemId: string;
    foodId: string;
    nutrientProfileId: string;
    gramsMg: number;
    sourceRegistryId: string;
    sourceItemId: string;
    datasetVersion: string;
  }>;
}

export const imageAssets = pgTable(
  'image_asset',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: imageAssetPurposeEnum('purpose').notNull(),
    parentAssetId: uuid('parent_asset_id').references((): AnyPgColumn => imageAssets.id, {
      onDelete: 'set null',
    }),
    bucketName: text('bucket_name').notNull(),
    objectKey: text('object_key').notNull().unique(),
    status: imageAssetStatusEnum('status').default('pending_upload').notNull(),
    declaredContentType: text('declared_content_type').notNull(),
    detectedContentType: text('detected_content_type'),
    byteSize: integer('byte_size'),
    pixelWidth: integer('pixel_width'),
    pixelHeight: integer('pixel_height'),
    sha256: text('sha256'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    processingCompletedAt: timestamp('processing_completed_at', { withTimezone: true }),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('image_asset_user_created_idx').on(table.userId, table.createdAt),
    index('image_asset_expiry_status_idx').on(table.expiresAt, table.status),
    index('image_asset_parent_idx').on(table.parentAssetId),
    check(
      'image_asset_dimensions_check',
      sql`(${table.pixelWidth} is null and ${table.pixelHeight} is null)
        or (${table.pixelWidth} > 0 and ${table.pixelHeight} > 0)`,
    ),
    check('image_asset_byte_size_check', sql`${table.byteSize} is null or ${table.byteSize} > 0`),
    check(
      'image_asset_inference_expiry_check',
      sql`${table.purpose} <> 'inference' or ${table.expiresAt} is not null`,
    ),
    check(
      'image_asset_status_timestamps_check',
      sql`(${table.status} <> 'processed' or ${table.processingCompletedAt} is not null)
        and (${table.status} <> 'deletion_pending' or ${table.deletionRequestedAt} is not null)
        and (${table.status} <> 'deleted' or ${table.deletedAt} is not null)`,
    ),
  ],
);

export const assetDeletionJobs = pgTable(
  'asset_deletion_job',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    imageAssetId: uuid('image_asset_id')
      .notNull()
      .unique()
      .references(() => imageAssets.id, { onDelete: 'restrict' }),
    status: assetDeletionJobStatusEnum('status').default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('asset_deletion_job_due_idx').on(table.status, table.nextAttemptAt),
    check('asset_deletion_job_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check(
      'asset_deletion_job_completed_timestamp_check',
      sql`${table.status} <> 'completed' or ${table.completedAt} is not null`,
    ),
  ],
);

export const mealLogs = pgTable(
  'meal_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eatenAt: timestamp('eaten_at', { withTimezone: true }).notNull(),
    eatenTimezone: text('eaten_timezone').notNull(),
    eatenLocalDate: date('eaten_local_date').notNull(),
    mealType: mealTypeEnum('meal_type').notNull(),
    status: mealStatusEnum('status').default('draft').notNull(),
    imageAssetId: uuid('image_asset_id').references(() => imageAssets.id, { onDelete: 'set null' }),
    recognitionStatus: recognitionStatusEnum('recognition_status').default('pending').notNull(),
    recognitionEngineVersion: text('recognition_engine_version'),
    recognitionCompletedAt: timestamp('recognition_completed_at', { withTimezone: true }),
    thumbnailAssetId: uuid('thumbnail_asset_id').references(() => imageAssets.id, {
      onDelete: 'set null',
    }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('meal_log_user_local_date_status_idx').on(
      table.userId,
      table.eatenLocalDate,
      table.status,
    ),
    uniqueIndex('meal_log_image_asset_unique')
      .on(table.imageAssetId)
      .where(sql`${table.imageAssetId} is not null`),
    check(
      'meal_log_recognition_ready_check',
      sql`${table.recognitionStatus} <> 'ready'
        or (${table.recognitionEngineVersion} is not null and ${table.recognitionCompletedAt} is not null)`,
    ),
    check(
      'meal_log_status_timestamps_check',
      sql`(${table.status} <> 'confirmed' or ${table.confirmedAt} is not null)
        and (${table.status} <> 'deleted' or (${table.deletedAt} is not null and ${table.purgeAfter} is not null))`,
    ),
  ],
);

export const mealItems = pgTable(
  'meal_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mealLogId: uuid('meal_log_id')
      .notNull()
      .references(() => mealLogs.id, { onDelete: 'cascade' }),
    recognizedLabel: text('recognized_label').notNull(),
    foodId: uuid('food_id').references(() => foods.id, { onDelete: 'restrict' }),
    nutrientProfileId: uuid('nutrient_profile_id').references(() => nutrientProfiles.id, {
      onDelete: 'restrict',
    }),
    amountMilliunits: integer('amount_milliunits').notNull(),
    unit: servingUnitEnum('unit').notNull(),
    gramsMg: integer('grams_mg'),
    recognitionConfidenceBps: integer('recognition_confidence_bps'),
    mappingConfidenceBps: integer('mapping_confidence_bps'),
    portionConfidenceBps: integer('portion_confidence_bps'),
    userCorrected: boolean('user_corrected').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('meal_item_meal_log_idx').on(table.mealLogId),
    check('meal_item_amount_check', sql`${table.amountMilliunits} > 0`),
    check('meal_item_grams_check', sql`${table.gramsMg} is null or ${table.gramsMg} > 0`),
    check(
      'meal_item_confidence_check',
      sql`(${table.recognitionConfidenceBps} is null or ${table.recognitionConfidenceBps} between 0 and 10000)
        and (${table.mappingConfidenceBps} is null or ${table.mappingConfidenceBps} between 0 and 10000)
        and (${table.portionConfidenceBps} is null or ${table.portionConfidenceBps} between 0 and 10000)`,
    ),
  ],
);

export const calculationSnapshots = pgTable(
  'calculation_snapshot',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mealLogId: uuid('meal_log_id')
      .notNull()
      .references(() => mealLogs.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    inputSnapshot: jsonb('input_snapshot').$type<CalculationInputSnapshot>().notNull(),
    energyMillicalories: integer('energy_millicalories').notNull(),
    carbohydrateMg: integer('carbohydrate_mg').notNull(),
    proteinMg: integer('protein_mg').notNull(),
    fatMg: integer('fat_mg').notNull(),
    fiberMg: integer('fiber_mg'),
    calculationVersion: text('calculation_version').notNull(),
    calculatedAt: timestamp('calculated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calculation_snapshot_meal_sequence_unique').on(table.mealLogId, table.sequence),
    index('calculation_snapshot_meal_calculated_idx').on(table.mealLogId, table.calculatedAt),
    check('calculation_snapshot_sequence_check', sql`${table.sequence} > 0`),
    check(
      'calculation_snapshot_values_check',
      sql`${table.energyMillicalories} >= 0
        and ${table.carbohydrateMg} >= 0
        and ${table.proteinMg} >= 0
        and ${table.fatMg} >= 0
        and (${table.fiberMg} is null or ${table.fiberMg} >= 0)`,
    ),
  ],
);
