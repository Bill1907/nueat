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
  primaryKey,
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
  'processing',
  'ready',
  'failed',
  'manual',
]);
export const assetDeletionJobStatusEnum = pgEnum('asset_deletion_job_status', [
  'pending',
  'processing',
  'failed',
  'completed',
]);
export const recognitionProviderEnum = pgEnum('recognition_provider', ['mock', 'openai']);
export const mealItemOriginEnum = pgEnum('meal_item_origin', [
  'model_estimate',
  'manual_entry',
  'user_added',
  'legacy_unknown',
]);
export const mealItemMappingSourceEnum = pgEnum('meal_item_mapping_source', [
  'model_primary',
  'model_alternative',
  'user_selected',
  'legacy_existing',
]);

export type RecognitionEvidenceReason =
  | 'blurred'
  | 'too_dark'
  | 'occluded'
  | 'not_meal_photo'
  | 'other';

export interface RecognitionQuestionV2 {
  target: 'food' | 'portion';
  question: string;
}

export interface RecognitionAlternativeV2 {
  normalizedLabel: string;
  confidenceBps: number;
}

export interface RecognitionFoodV2 {
  regionIndex: number;
  rawLabel: string;
  normalizedLabel: string;
  foodConfidenceBps: number;
  amountMilliunits: number;
  unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
  portionConfidenceBps: number;
  questions: RecognitionQuestionV2[];
  alternatives: RecognitionAlternativeV2[];
}

export interface RecognitionResultV1 {
  version?: 1;
  foods: Array<{
    regionIndex: number;
    recognizedLabel: string;
    recognitionConfidenceBps: number;
    amountMilliunits: number;
    unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
    portionConfidenceBps: number;
    candidateLabels?: string[];
    question?: string | null;
  }>;
}

export type StoredRecognitionResult = RecognitionResultV1 | RecognitionResultV2;

export function isRecognitionResultV2(
  result: StoredRecognitionResult | null | undefined,
): result is RecognitionResultV2 {
  const value: Record<string, unknown> =
    result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (!result || value.version !== 2 || !Array.isArray(value.foods)) return false;
  if (value.outcome === 'recognized') {
    return typeof value.imageQualityConfidenceBps === 'number' && value.foods.length > 0;
  }
  if (value.outcome === 'no_food') {
    return typeof value.imageQualityConfidenceBps === 'number' && value.foods.length === 0;
  }
  return value.outcome === 'insufficient_evidence' &&
    typeof value.imageQualityConfidenceBps === 'number' &&
    value.foods.length === 0 &&
    ['blurred', 'too_dark', 'occluded', 'not_meal_photo', 'other'].includes(value.evidenceReason as string);
}

export type RecognitionResultV2 =
  | {
      version: 2;
      outcome: 'recognized';
      imageQualityConfidenceBps: number;
      foods: RecognitionFoodV2[];
    }
  | {
      version: 2;
      outcome: 'no_food';
      imageQualityConfidenceBps: number;
      foods: [];
    }
  | {
      version: 2;
      outcome: 'insufficient_evidence';
      imageQualityConfidenceBps: number;
      evidenceReason: RecognitionEvidenceReason;
      foods: [];
    };

interface ManualRecognitionOverrideBase {
  decision: 'direct_entry';
  actorUserId: string;
  expectedDraftRevision: number;
  changedFields: readonly ['recognitionStatus'];
  decidedAt: string;
  decisionVersion: 'recognition-manual-override-v1';
}

export type ManualRecognitionOverride =
  | (ManualRecognitionOverrideBase & {
      fromStatus: 'ready';
      fromOutcome: 'no_food' | 'insufficient_evidence';
      fromErrorCode: null;
    })
  | (ManualRecognitionOverrideBase & {
      fromStatus: 'pending' | 'processing' | 'failed';
      fromOutcome: RecognitionResultV2['outcome'] | null;
      fromErrorCode: string | null;
    });

export interface InitialEstimateAssessment {
  rawLabel: string;
  normalizedLabel: string;
  foodConfidenceBps: number;
  portionConfidenceBps: number;
  foodCandidateMarginBps: number | null;
  questions: RecognitionQuestionV2[];
  alternatives: RecognitionAlternativeV2[];
  initialMappingSource: 'model_primary' | 'model_alternative' | null;
  initialMatchedLabel: string | null;
  initialFoodId: string | null;
  initialNutrientProfileId: string | null;
  recognitionProvider: 'mock' | 'openai';
  recognitionModel: string;
  recognitionPromptVersion: string;
  recognitionSchemaVersion: string;
  policyVersion: string;
}

export interface CalculationInputSnapshot {
  confirmationDecision: {
    originalRecognition: {
      provider: 'mock' | 'openai';
      model: string;
      promptVersion: string;
      schemaVersion: string;
      outcome: RecognitionResultV2['outcome'];
      evidenceReason?: RecognitionEvidenceReason;
      completedAt: string;
    } | null;
    manualOverride: ManualRecognitionOverride | null;
    policy: {
      version: string;
      activation: 'review_only' | 'quick_confirm';
      approvedReportSha256: string | null;
      activeReportSha256: string | null;
      approvedReportVersion: string | null;
    };
  };
  mealItems: Array<{
    mealItemId: string;
    origin: 'model_estimate' | 'manual_entry' | 'user_added' | 'legacy_unknown';
    initialEstimateAssessment: InitialEstimateAssessment | null;
    currentResolutionSource: 'model_primary' | 'model_alternative' | 'user_selected' | 'legacy_existing' | null;
    itemRevision: number;
    foodRevision: number;
    portionRevision: number;
    foodAcknowledgedRevision: number | null;
    portionAcknowledgedRevision: number | null;
    foodId: string;
    nutrientProfileId: string;
    amountMilliunits: number;
    unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
    gramsMg: number;
    sourceRegistryId: string;
    sourceItemId: string;
    datasetVersion: string;
    nutrientProfileQualityGrade: 'verified' | 'estimated' | 'unverified';
    nutrientProfile: {
      basisAmountMg: number;
      energyMillicalories: number;
      carbohydrateMg: number;
      proteinMg: number;
      fatMg: number;
      fiberMg: number | null;
    };
    serving: {
      id: string;
      unit: 'ml' | 'serving' | 'bowl' | 'piece';
      amountMilliunits: number;
      gramsMg: number;
      sourceRegistryId: string;
      qualityGrade: 'verified' | 'estimated' | 'unverified';
    } | null;
    nutrients: {
      energyMillicalories: number;
      carbohydrateMg: number;
      proteinMg: number;
      fatMg: number;
      fiberMg: number | null;
    };
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

export const recognitionDailyUsages = pgTable(
  'recognition_daily_usage',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    attemptDate: date('attempt_date').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.attemptDate] }),
    check('recognition_daily_usage_attempt_count_check', sql`${table.attemptCount} >= 0`),
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
    recognitionProvider: recognitionProviderEnum('recognition_provider'),
    recognitionModel: text('recognition_model'),
    recognitionPromptVersion: text('recognition_prompt_version'),
    recognitionSchemaVersion: text('recognition_schema_version'),
    recognitionResult: jsonb('recognition_result').$type<StoredRecognitionResult>(),
    recognitionCompletedAt: timestamp('recognition_completed_at', { withTimezone: true }),
    recognitionManualOverride: jsonb('recognition_manual_override').$type<ManualRecognitionOverride>(),
    recognitionProviderRequestId: text('recognition_provider_request_id'),
    recognitionAttemptCount: integer('recognition_attempt_count').default(0).notNull(),
    recognitionLeaseToken: uuid('recognition_lease_token'),
    recognitionLeaseExpiresAt: timestamp('recognition_lease_expires_at', { withTimezone: true }),
    recognitionNextAttemptAt: timestamp('recognition_next_attempt_at', { withTimezone: true }).defaultNow(),
    recognitionLastErrorCode: text('recognition_last_error_code'),
    recognitionInputTokens: integer('recognition_input_tokens').default(0).notNull(),
    recognitionOutputTokens: integer('recognition_output_tokens').default(0).notNull(),
    thumbnailAssetId: uuid('thumbnail_asset_id').references(() => imageAssets.id, {
      onDelete: 'set null',
    }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    draftRevision: integer('draft_revision').default(1).notNull(),
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
    index('meal_log_recognition_due_idx')
      .on(table.recognitionStatus, table.recognitionNextAttemptAt)
      .where(sql`${table.recognitionStatus} in ('pending', 'failed')`),
    index('meal_log_recognition_lease_expiry_idx')
      .on(table.recognitionStatus, table.recognitionLeaseExpiresAt)
      .where(sql`${table.recognitionStatus} = 'processing'`),
    check(
      'meal_log_recognition_processing_lease_check',
      sql`(${table.recognitionStatus} = 'processing'
        and ${table.recognitionLeaseToken} is not null
        and ${table.recognitionLeaseExpiresAt} is not null)
        or (${table.recognitionStatus} <> 'processing'
        and ${table.recognitionLeaseToken} is null
        and ${table.recognitionLeaseExpiresAt} is null)`,
    ),
    check(
      'meal_log_recognition_ready_check',
      sql`${table.recognitionStatus} <> 'ready'
        or (${table.recognitionProvider} is not null
        and ${table.recognitionModel} is not null
        and ${table.recognitionPromptVersion} is not null
        and ${table.recognitionSchemaVersion} is not null
        and ${table.recognitionResult} is not null
        and jsonb_typeof(${table.recognitionResult}) = 'object'
        and ${table.recognitionResult} ? 'foods'
        and jsonb_typeof(${table.recognitionResult}->'foods') = 'array'
        and ${table.recognitionCompletedAt} is not null)`,
    ),
    check('meal_log_draft_revision_check', sql`${table.draftRevision} > 0`),
    check(
      'meal_log_recognition_manual_override_check',
      sql`${table.recognitionManualOverride} is null
        or (${table.recognitionStatus} = 'manual'
        and ${table.recognitionManualOverride}->>'fromStatus' in ('ready', 'pending', 'processing', 'failed')
        and ${table.recognitionManualOverride}->>'decision' = 'direct_entry'
        and ${table.recognitionManualOverride}->>'decisionVersion' = 'recognition-manual-override-v1'
        and ${table.recognitionManualOverride} ? 'actorUserId'
        and jsonb_typeof(${table.recognitionManualOverride}->'expectedDraftRevision') = 'number'
        and jsonb_typeof(${table.recognitionManualOverride}->'changedFields') = 'array'
        and ${table.recognitionManualOverride} ? 'decidedAt'
        and (${table.recognitionManualOverride}->>'fromStatus' <> 'ready'
          or (${table.recognitionResult} is not null
            and ${table.recognitionResult}->>'outcome' in ('no_food', 'insufficient_evidence')
            and ${table.recognitionManualOverride}->>'fromOutcome' = ${table.recognitionResult}->>'outcome')))`,
    ),
    check(
      'meal_log_recognition_attempt_usage_check',
      sql`${table.recognitionAttemptCount} >= 0
        and ${table.recognitionInputTokens} >= 0
        and ${table.recognitionOutputTokens} >= 0`,
    ),
    check(
      'meal_log_recognition_retry_schedule_check',
      sql`${table.recognitionStatus} <> 'pending'
        or ${table.recognitionNextAttemptAt} is not null`,
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
    recognitionRegionIndex: integer('recognition_region_index'),
    gramsMg: integer('grams_mg'),
    recognitionConfidenceBps: integer('recognition_confidence_bps'),
    mappingConfidenceBps: integer('mapping_confidence_bps'),
    portionConfidenceBps: integer('portion_confidence_bps'),
    userCorrected: boolean('user_corrected').default(false).notNull(),
    origin: mealItemOriginEnum('origin').default('legacy_unknown').notNull(),
    initialEstimateAssessment: jsonb('initial_estimate_assessment').$type<InitialEstimateAssessment>(),
    currentResolutionSource: mealItemMappingSourceEnum('current_resolution_source'),
    currentResolutionSelectedAt: timestamp('current_resolution_selected_at', { withTimezone: true }),
    itemRevision: integer('item_revision').default(1).notNull(),
    foodRevision: integer('food_revision').default(1).notNull(),
    portionRevision: integer('portion_revision').default(1).notNull(),
    foodAcknowledgedRevision: integer('food_acknowledged_revision'),
    portionAcknowledgedRevision: integer('portion_acknowledged_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('meal_item_meal_log_idx').on(table.mealLogId),
    uniqueIndex('meal_item_recognition_region_unique')
      .on(table.mealLogId, table.recognitionRegionIndex)
      .where(sql`${table.recognitionRegionIndex} is not null`),
    check('meal_item_amount_check', sql`${table.amountMilliunits} > 0`),
    check('meal_item_grams_check', sql`${table.gramsMg} is null or ${table.gramsMg} > 0`),
    check(
      'meal_item_confidence_check',
      sql`(${table.recognitionConfidenceBps} is null or ${table.recognitionConfidenceBps} between 0 and 10000)
        and (${table.mappingConfidenceBps} is null or ${table.mappingConfidenceBps} between 0 and 10000)
        and (${table.portionConfidenceBps} is null or ${table.portionConfidenceBps} between 0 and 10000)`,
    ),
    check(
      'meal_item_recognition_region_index_check',
      sql`${table.recognitionRegionIndex} is null
        or ${table.recognitionRegionIndex} between 0 and 19`,
    ),
    check(
      'meal_item_revision_check',
      sql`${table.itemRevision} > 0
        and ${table.foodRevision} > 0
        and ${table.portionRevision} > 0
        and (${table.foodAcknowledgedRevision} is null
          or (${table.foodAcknowledgedRevision} > 0
            and ${table.foodAcknowledgedRevision} <= ${table.foodRevision}))
        and (${table.portionAcknowledgedRevision} is null
          or (${table.portionAcknowledgedRevision} > 0
            and ${table.portionAcknowledgedRevision} <= ${table.portionRevision}))`,
    ),
    check(
      'meal_item_initial_estimate_origin_check',
      sql`(${table.origin} = 'model_estimate'
          and ${table.initialEstimateAssessment} is not null
          and ${table.initialEstimateAssessment} ? 'initialFoodId'
          and ${table.initialEstimateAssessment} ? 'initialNutrientProfileId'
          and ${table.initialEstimateAssessment}->>'recognitionProvider' in ('mock', 'openai')
          and ${table.initialEstimateAssessment} ? 'recognitionModel'
          and ${table.initialEstimateAssessment} ? 'recognitionPromptVersion'
          and ${table.initialEstimateAssessment} ? 'recognitionSchemaVersion')
        or (${table.origin} <> 'model_estimate' and ${table.initialEstimateAssessment} is null)`,
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
