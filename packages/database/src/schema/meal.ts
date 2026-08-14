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

import type {
  CalculationInputSnapshotV2,
  LegacyCalculationInputSnapshot,
} from '../calculation-snapshot';
import { users } from './auth';
import {
  catalogReleases,
  foods,
  nutrientProfiles,
  releaseActivations,
  servingUnitEnum,
} from './food';

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
export const recognitionProviderEnum = pgEnum('recognition_provider', [
  'mock',
  'openai',
  'manual',
]);
export const recognitionProtocolVersionEnum = pgEnum('recognition_protocol_version', [
  'legacy_v1',
  'v2_option_b',
]);
export const recognitionUserGrantStateEnum = pgEnum('recognition_user_grant_state', [
  'available',
  'reserved',
  'consumed',
]);
export const recognitionExecutionTriggerEnum = pgEnum('recognition_execution_trigger', [
  'initial',
  'automatic_lease_recovery',
  'user_recovery',
]);
export const recognitionExecutionPhaseEnum = pgEnum('recognition_execution_phase', [
  'claim',
  'asset_read',
  'asset_verify',
  'invocation_reserve',
  'provider_call',
  'provider_output',
  'observation_persist',
  'resolution_handoff',
  'response_delivery',
  'reconciliation',
]);
export const recognitionExecutionStatusEnum = pgEnum('recognition_execution_status', [
  'open',
  'succeeded',
  'failed',
  'abandoned',
]);
export const recognitionProviderInvocationStatusEnum = pgEnum(
  'recognition_provider_invocation_status',
  ['reserved', 'succeeded', 'failed_known', 'cancelled_before_call', 'outcome_unknown'],
);
export const recognitionFailureCodeEnum = pgEnum('recognition_failure_code', [
  'DRAFT_INELIGIBLE',
  'EXECUTION_LIMIT_REACHED',
  'USER_RECOVERY_UNAVAILABLE',
  'DAILY_QUOTA_RESERVED',
  'DB_LOCK_TIMEOUT',
  'DB_STATEMENT_TIMEOUT',
  'DB_UNAVAILABLE',
  'LEASE_LOST',
  'ASSET_NOT_FOUND',
  'ASSET_EXPIRED',
  'ASSET_TOO_LARGE',
  'ASSET_UNAVAILABLE',
  'ASSET_READ_TIMEOUT',
  'ASSET_MISMATCH',
  'ASSET_TYPE_INVALID',
  'PROVIDER_CALL_DEADLINE',
  'PROVIDER_REQUEST_TIMEOUT',
  'PROVIDER_CONFLICT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_CONNECTION_FAILED',
  'PROVIDER_SERVER_ERROR',
  'PROVIDER_REQUEST_INVALID',
  'PROVIDER_AUTH_INVALID',
  'PROVIDER_REJECTED',
  'PROVIDER_UNKNOWN',
  'PROVIDER_INCOMPLETE',
  'INVALID_PROVIDER_RESPONSE',
  'EXECUTION_DEADLINE',
  'EXECUTION_CANCELLED',
  'PERSISTENCE_UNAVAILABLE',
  'DRAFT_STATE_LOST',
  'COORDINATOR_INTERNAL',
  'PROCESS_OUTCOME_UNKNOWN',
]);
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
export const resolutionStatusEnum = pgEnum('resolution_status', [
  'pending',
  'processing',
  'resolved',
  'failed',
]);
export const mappingDecisionStatusEnum = pgEnum('mapping_decision_status', [
  'review_required',
  'selected',
  'unresolved',
]);
export const mappingDecisionMethodEnum = pgEnum('mapping_decision_method', [
  'exact',
  'lexical',
  'user_selected',
  'manual',
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

export interface RecognitionObservationV3 {
  localObservationId: `o${number}`;
  regionIndex: number;
  parentRegionIndex: number | null;
  kind: 'dish' | 'drink' | 'component';
  rawLabel: string;
  normalizedLabel: string;
  foodConfidenceBps: number;
  portionConfidenceBps: number;
  amountMilliunits: number;
  unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
  categoryHint: 'staple' | 'soup_stew' | 'meat' | 'seafood' | 'vegetable' | 'noodle_dumpling' | 'snack_dessert' | 'beverage' | 'mixed' | 'unknown';
  preparationCodes: Array<'raw' | 'boiled' | 'steamed' | 'grilled' | 'fried' | 'baked' | 'braised' | 'fermented' | 'mixed' | 'unknown'>;
  uncertaintyCodes: Array<'identity_uncertain' | 'portion_uncertain' | 'occluded' | 'overlapping' | 'mixed_dish' | 'preparation_uncertain'>;
  questionReasonCodes: Array<'confirm_identity' | 'confirm_portion' | 'confirm_component'>;
  alternatives: Array<{ label: string; normalizedLabel: string; confidenceBps: number }>;
}
export type RecognitionResultV3 =
  | { version: 3; outcome: 'recognized'; imageQualityConfidenceBps: number; observations: RecognitionObservationV3[] }
  | { version: 3; outcome: 'no_food'; imageQualityConfidenceBps: number; observations: [] }
  | { version: 3; outcome: 'insufficient_evidence'; imageQualityConfidenceBps: number; evidenceReason: RecognitionEvidenceReason; observations: [] };
export type StoredRecognitionResult = RecognitionResultV1 | RecognitionResultV2 | RecognitionResultV3;

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

export function isRecognitionResultV3(
  result: StoredRecognitionResult | null | undefined,
): result is RecognitionResultV3 {
  const value: Record<string, unknown> =
    result && typeof result === 'object'
      ? result as Record<string, unknown>
      : {};
  if (!result || value.version !== 3 || !Array.isArray(value.observations))
    return false;
  if (value.outcome === 'recognized') {
    return (
      typeof value.imageQualityConfidenceBps === 'number' &&
      value.observations.length > 0
    );
  }
  if (value.outcome === 'no_food') {
    return (
      typeof value.imageQualityConfidenceBps === 'number' &&
      value.observations.length === 0
    );
  }
  return (
    value.outcome === 'insufficient_evidence' &&
    typeof value.imageQualityConfidenceBps === 'number' &&
    value.observations.length === 0 &&
    ['blurred', 'too_dark', 'occluded', 'not_meal_photo', 'other'].includes(
      value.evidenceReason as string,
    )
  );
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

export type StoredCalculationInputSnapshot =
  | LegacyCalculationInputSnapshot
  | CalculationInputSnapshotV2;

export type NutrientSnapshotEvidence = Record<
  'energyMillicalories' | 'carbohydrateMg' | 'proteinMg' | 'fatMg' | 'fiberMg',
  {
    value: number | null;
    knownValue: number;
    missingItemCount: number;
    completeness: 'complete' | 'partial';
  }
>;

export type CalculationPreviewLeafProvenance = {
  ordinal: number;
  componentIdentity: string;
  foodId: string;
  edibleAmountMg: number;
  unit: 'g' | 'ml' | 'serving' | 'bowl' | 'piece';
  nutrientProfileId: string;
  sourceItemId: string;
  profileQualityGrade: 'verified' | 'estimated' | 'unverified';
  servingId: string | null;
  servingAmountMilliunits: number | null;
  servingGramsMg: number | null;
  servingSourceRegistryId: string | null;
  servingQualityGrade: 'verified' | 'estimated' | 'unverified' | null;
  sourceRegistryId: string;
  sourceReleaseId: string;
  sourceReleaseVersion: string;
  catalogReleaseId: string;
  catalogManifestSha256: string;
  nutrientProfile: {
    basisAmountMg: number;
    energyMillicalories: number | null;
    carbohydrateMg: number | null;
    proteinMg: number | null;
    fatMg: number | null;
    fiberMg: number | null;
  };
};

export type CalculationPreviewIdentity =
  | {
      basis: 'finished_profile';
      rootMappingDecisionId: string;
      rootRevision: number;
      catalogReleaseId: string;
      releaseActivationId: string;
      leaves: [CalculationPreviewLeafProvenance];
    }
  | {
      basis: 'source_recipe';
      rootMappingDecisionId: string;
      rootRevision: number;
      catalogReleaseId: string;
      releaseActivationId: string;
      recipeVersionId: string;
      leaves: CalculationPreviewLeafProvenance[];
    }
  | {
      basis: 'meal_decomposition';
      rootMappingDecisionId: string;
      rootRevision: number;
      catalogReleaseId: string;
      releaseActivationId: string;
      decompositionRevisionId: string;
      leaves: CalculationPreviewLeafProvenance[];
    };

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

export const schemaCapabilities = pgTable('schema_capability', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
});

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
        and (
          (${table.recognitionResult}->>'version' = '2'
            and ${table.recognitionResult} ? 'foods'
            and jsonb_typeof(${table.recognitionResult}->'foods') = 'array')
          or (${table.recognitionResult}->>'version' = '3'
            and ${table.recognitionResult} ? 'observations'
            and jsonb_typeof(${table.recognitionResult}->'observations') = 'array')
        )
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

export const recognitionAttempts = pgTable(
  'recognition_attempt',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mealLogId: uuid('meal_log_id').notNull().unique().references(() => mealLogs.id, { onDelete: 'cascade' }),
    imageAssetId: uuid('image_asset_id').notNull().references(() => imageAssets.id, { onDelete: 'restrict' }),
    status: recognitionStatusEnum('status').default('pending').notNull(),
    provider: recognitionProviderEnum('provider'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    schemaVersion: text('schema_version'),
    providerRequestId: text('provider_request_id'),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    protocolVersion: recognitionProtocolVersionEnum('protocol_version')
      .default('legacy_v1')
      .notNull(),
    nextExecutionOrdinal: integer('next_execution_ordinal').default(1).notNull(),
    automaticExecutionCount: integer('automatic_execution_count').default(0).notNull(),
    automaticInvocationReservationCount: integer('automatic_invocation_reservation_count')
      .default(0)
      .notNull(),
    userGrantState: recognitionUserGrantStateEnum('user_grant_state').default('available').notNull(),
    userGrantExecutionId: uuid('user_grant_execution_id'),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastErrorCode: text('last_error_code'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('recognition_attempt_due_idx').on(table.status, table.nextAttemptAt),
    index('recognition_attempt_protocol_status_idx').on(table.protocolVersion, table.status),
    check('recognition_attempt_counts_check', sql`${table.attemptCount} >= 0 and ${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.automaticExecutionCount} >= 0 and ${table.automaticInvocationReservationCount} >= 0 and ${table.nextExecutionOrdinal} > 0`),
    check(
      'recognition_attempt_option_b_reservation_ceiling_check',
      sql`${table.protocolVersion} <> 'v2_option_b'
        or ${table.automaticInvocationReservationCount} <= ${table.automaticExecutionCount}`,
    ),
    check(
      'recognition_attempt_user_grant_binding_check',
      sql`(${table.userGrantState} = 'available' and ${table.userGrantExecutionId} is null)
        or (${table.userGrantState} in ('reserved', 'consumed') and ${table.userGrantExecutionId} is not null)`,
    ),
    check('recognition_attempt_lease_check', sql`(${table.status} = 'processing' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} <> 'processing' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`),
  ],
);

export const recognitionExecutions = pgTable(
  'recognition_execution',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => recognitionAttempts.id, { onDelete: 'cascade' }),
    executionOrdinal: integer('execution_ordinal').notNull(),
    trigger: recognitionExecutionTriggerEnum('trigger').notNull(),
    wallDeadlineAt: timestamp('wall_deadline_at', { withTimezone: true }).notNull(),
    leaseToken: uuid('lease_token').notNull(),
    phase: recognitionExecutionPhaseEnum('phase').default('claim').notNull(),
    status: recognitionExecutionStatusEnum('status').default('open').notNull(),
    terminalCode: recognitionFailureCodeEnum('terminal_code'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('recognition_execution_workflow_ordinal_unique').on(
      table.workflowId,
      table.executionOrdinal,
    ),
    index('recognition_execution_open_deadline_idx')
      .on(table.wallDeadlineAt)
      .where(sql`${table.status} = 'open'`),
    check('recognition_execution_ordinal_check', sql`${table.executionOrdinal} > 0`),
    check(
      'recognition_execution_terminal_check',
      sql`(${table.status} = 'open' and ${table.completedAt} is null and ${table.terminalCode} is null)
        or (${table.status} = 'succeeded' and ${table.completedAt} is not null and ${table.terminalCode} is null)
        or (${table.status} in ('failed', 'abandoned') and ${table.completedAt} is not null and ${table.terminalCode} is not null)`,
    ),
  ],
);

export const recognitionProviderInvocations = pgTable(
  'recognition_provider_invocation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => recognitionAttempts.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => recognitionExecutions.id, { onDelete: 'cascade' }),
    invocationOrdinal: integer('invocation_ordinal').notNull(),
    workflowInvocationOrdinal: integer('workflow_invocation_ordinal').notNull(),
    status: recognitionProviderInvocationStatusEnum('status').default('reserved').notNull(),
    provider: recognitionProviderEnum('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    terminalCode: recognitionFailureCodeEnum('terminal_code'),
    providerAcknowledgedAt: timestamp('provider_acknowledged_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('recognition_provider_invocation_execution_ordinal_unique').on(
      table.executionId,
      table.invocationOrdinal,
    ),
    uniqueIndex('recognition_provider_invocation_workflow_ordinal_unique').on(
      table.workflowId,
      table.workflowInvocationOrdinal,
    ),
    index('recognition_provider_invocation_reserved_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'reserved'`),
    check(
      'recognition_provider_invocation_ordinal_check',
      sql`${table.invocationOrdinal} = 1 and ${table.workflowInvocationOrdinal} > 0`,
    ),
    check(
      'recognition_provider_invocation_terminal_check',
      sql`(${table.status} = 'reserved' and ${table.completedAt} is null and ${table.terminalCode} is null)
        or (${table.status} = 'succeeded' and ${table.completedAt} is not null and ${table.terminalCode} is null)
        or (${table.status} in ('failed_known', 'cancelled_before_call', 'outcome_unknown')
          and ${table.completedAt} is not null and ${table.terminalCode} is not null)`,
    ),
  ],
);

export const storedObservations = pgTable(
  'stored_observation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mealLogId: uuid('meal_log_id').notNull().unique().references(() => mealLogs.id, { onDelete: 'cascade' }),
    recognitionAttemptId: uuid('recognition_attempt_id').notNull().unique().references(() => recognitionAttempts.id, { onDelete: 'restrict' }),
    provider: recognitionProviderEnum('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    providerRequestId: text('provider_request_id'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    canonicalContent: jsonb('canonical_content').notNull(),
    contentSha256: text('content_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('stored_observation_content_unique').on(table.mealLogId, table.contentSha256),
    check('stored_observation_tokens_check', sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0`),
    check('stored_observation_content_check', sql`jsonb_typeof(${table.canonicalContent}) = 'object' and ${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const resolutionAttempts = pgTable(
  'resolution_attempt',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storedObservationId: uuid('stored_observation_id').notNull().unique().references(() => storedObservations.id, { onDelete: 'cascade' }),
    status: resolutionStatusEnum('status').default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastErrorCode: text('last_error_code'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('resolution_attempt_due_idx').on(table.status, table.nextAttemptAt),
    check('resolution_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check('resolution_attempt_lease_check', sql`(${table.status} = 'processing' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} <> 'processing' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`),
    check('resolution_attempt_resolved_check', sql`${table.status} <> 'resolved' or ${table.resolvedAt} is not null`),
  ],
);

export const mappingDecisions = pgTable(
  'mapping_decision',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storedObservationId: uuid('stored_observation_id').notNull().references(() => storedObservations.id, { onDelete: 'restrict' }),
    localObservationId: text('local_observation_id').notNull(),
    catalogReleaseId: uuid('catalog_release_id').notNull().references(() => catalogReleases.id, { onDelete: 'restrict' }),
    releaseActivationId: uuid('release_activation_id').notNull().references(() => releaseActivations.id, { onDelete: 'restrict' }),
    resolverVersion: text('resolver_version').notNull(),
    resolverSha256: text('resolver_sha256').notNull(),
    policyVersion: text('policy_version').notNull(),
    policySha256: text('policy_sha256').notNull(),
    candidates: jsonb('candidates').notNull(),
    selectedFoodId: uuid('selected_food_id').references(() => foods.id, { onDelete: 'restrict' }),
    status: mappingDecisionStatusEnum('status').notNull(),
    method: mappingDecisionMethodEnum('method').notNull(),
    reasonCode: text('reason_code').notNull(),
    evidence: jsonb('evidence').notNull(),
    predecessorId: uuid('predecessor_id').references((): AnyPgColumn => mappingDecisions.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('mapping_decision_observation_idx').on(table.storedObservationId, table.localObservationId, table.createdAt),
    check('mapping_decision_content_check', sql`jsonb_typeof(${table.candidates}) = 'array' and jsonb_array_length(${table.candidates}) <= 8 and jsonb_typeof(${table.evidence}) = 'object'`),
    check('mapping_decision_hash_check', sql`${table.resolverSha256} ~ '^[0-9a-f]{64}$' and ${table.policySha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const calculationPreviews = pgTable(
  'calculation_preview',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mealLogId: uuid('meal_log_id').notNull().references(() => mealLogs.id, { onDelete: 'cascade' }),
    rootMappingDecisionId: uuid('root_mapping_decision_id').notNull().references(() => mappingDecisions.id, { onDelete: 'restrict' }),
    rootRevision: integer('root_revision').notNull(),
    catalogReleaseId: uuid('catalog_release_id').notNull().references(() => catalogReleases.id, { onDelete: 'restrict' }),
    releaseActivationId: uuid('release_activation_id').notNull().references(() => releaseActivations.id, { onDelete: 'restrict' }),
    discriminant: text('discriminant').notNull(),
    identity: jsonb('identity').$type<CalculationPreviewIdentity>().notNull(),
    contentSha256: text('content_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calculation_preview_identity_unique').on(table.mealLogId, table.rootMappingDecisionId, table.rootRevision, table.contentSha256),
    index('calculation_preview_meal_root_idx').on(table.mealLogId, table.rootRevision),
    check(
      'calculation_preview_identity_check',
      sql`${table.rootRevision} > 0
        and length(trim(${table.discriminant})) > 0
        and jsonb_typeof(${table.identity}) = 'object'
        and ${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const mealDecompositionRevisions = pgTable(
  'meal_decomposition_revision',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mealLogId: uuid('meal_log_id').notNull().references(() => mealLogs.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    rootMappingDecisionId: uuid('root_mapping_decision_id').notNull().references(() => mappingDecisions.id, { onDelete: 'restrict' }),
    rootCalculationPreviewId: uuid('root_calculation_preview_id').notNull().references(() => calculationPreviews.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('meal_decomposition_revision_unique').on(table.mealLogId, table.revision),
    check('meal_decomposition_revision_number_check', sql`${table.revision} > 0`),
  ],
);

export const mealDecompositionComponents = pgTable(
  'meal_decomposition_component',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mealDecompositionRevisionId: uuid('meal_decomposition_revision_id').notNull().references(() => mealDecompositionRevisions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    mappingDecisionId: uuid('mapping_decision_id').notNull().references(() => mappingDecisions.id, { onDelete: 'restrict' }),
    calculationPreviewId: uuid('calculation_preview_id').notNull().references(() => calculationPreviews.id, { onDelete: 'restrict' }),
    edibleAmountMg: integer('edible_amount_mg').notNull(),
  },
  (table) => [
    uniqueIndex('meal_decomposition_component_ordinal_unique').on(table.mealDecompositionRevisionId, table.ordinal),
    uniqueIndex('meal_decomposition_component_mapping_unique').on(table.mealDecompositionRevisionId, table.mappingDecisionId),
    check('meal_decomposition_component_ordinal_check', sql`${table.ordinal} between 0 and 11`),
    check('meal_decomposition_component_amount_check', sql`${table.edibleAmountMg} > 0`),
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
    reviewedItemRevision: integer('reviewed_item_revision'),
    reviewedAuthorityFingerprintVersion: text('reviewed_authority_fingerprint_version'),
    reviewedAuthorityFingerprint: text('reviewed_authority_fingerprint'),
    reviewIdempotencyKey: text('review_idempotency_key'),
    reviewRequestFingerprint: text('review_request_fingerprint'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
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
        and ${table.portionRevision} > 0`,
    ),
    check(
      'meal_item_review_checkpoint_check',
      sql`(${table.reviewedItemRevision} is null
          and ${table.reviewedAuthorityFingerprintVersion} is null
          and ${table.reviewedAuthorityFingerprint} is null
          and ${table.reviewIdempotencyKey} is null
          and ${table.reviewRequestFingerprint} is null
          and ${table.reviewedAt} is null)
        or (${table.reviewedItemRevision} is not null
          and ${table.reviewedAuthorityFingerprintVersion} is not null
          and ${table.reviewedAuthorityFingerprint} is not null
          and ${table.reviewIdempotencyKey} is not null
          and ${table.reviewRequestFingerprint} is not null
          and ${table.reviewedAt} is not null
          and ${table.reviewedItemRevision} = ${table.itemRevision}
          and ${table.reviewedItemRevision} > 0
          and length(trim(${table.reviewedAuthorityFingerprintVersion})) > 0
          and ${table.reviewedAuthorityFingerprint} ~ '^[0-9a-f]{64}$'
          and length(trim(${table.reviewIdempotencyKey})) > 0
          and ${table.reviewRequestFingerprint} ~ '^[0-9a-f]{64}$')`,
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
    inputSnapshot: jsonb('input_snapshot').$type<StoredCalculationInputSnapshot>().notNull(),
    energyMillicalories: integer('energy_millicalories'),
    carbohydrateMg: integer('carbohydrate_mg'),
    proteinMg: integer('protein_mg'),
    fatMg: integer('fat_mg'),
    fiberMg: integer('fiber_mg'),
    nutrientEvidence: jsonb('nutrient_evidence').$type<NutrientSnapshotEvidence>(),
    confirmationIdempotencyKey: text('confirmation_idempotency_key'),
    confirmationFingerprint: text('confirmation_fingerprint'),
    calculationVersion: text('calculation_version').notNull(),
    calculatedAt: timestamp('calculated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calculation_snapshot_meal_sequence_unique').on(table.mealLogId, table.sequence),
    uniqueIndex('calculation_snapshot_confirmation_idempotency_unique')
      .on(table.mealLogId, table.confirmationIdempotencyKey)
      .where(sql`${table.confirmationIdempotencyKey} is not null`),
    index('calculation_snapshot_meal_calculated_idx').on(table.mealLogId, table.calculatedAt),
    check('calculation_snapshot_sequence_check', sql`${table.sequence} > 0`),
    check(
      'calculation_snapshot_confirmation_idempotency_check',
      sql`(${table.confirmationIdempotencyKey} is null and ${table.confirmationFingerprint} is null)
        or (${table.confirmationIdempotencyKey} is not null and ${table.confirmationFingerprint} is not null)`,
    ),
    check(
      'calculation_snapshot_values_check',
      sql`(${table.energyMillicalories} is null or ${table.energyMillicalories} >= 0)
        and (${table.carbohydrateMg} is null or ${table.carbohydrateMg} >= 0)
        and (${table.proteinMg} is null or ${table.proteinMg} >= 0)
        and (${table.fatMg} is null or ${table.fatMg} >= 0)
        and (${table.fiberMg} is null or ${table.fiberMg} >= 0)`,
    ),
  ],
);
