import { sql } from 'drizzle-orm';
import {
  check,
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

export const deletionStatusEnum = pgEnum('deletion_status', [
  'active',
  'deletion_pending',
]);
export const onboardingStatusEnum = pgEnum('onboarding_status', [
  'pending',
  'completed',
  'limited',
]);
export const consentTypeEnum = pgEnum('consent_type', [
  'terms',
  'privacy',
  'health_data',
  'image_training',
]);
export const consentActionEnum = pgEnum('consent_action', ['granted', 'revoked']);
export const goalTypeEnum = pgEnum('goal_type', [
  'weight_loss',
  'maintenance',
  'muscle_gain',
  'balanced_diet',
]);
export const activityLevelEnum = pgEnum('activity_level', [
  'sedentary',
  'light',
  'moderate',
  'high',
  'very_high',
]);
export const calculationSexEnum = pgEnum('calculation_sex', ['female', 'male']);

export interface NutritionCalculationInputSnapshot {
  ageYears: number;
  calculationSex: 'female' | 'male';
  heightMm: number;
  weightG: number;
  activityLevel: 'sedentary' | 'light' | 'moderate' | 'high' | 'very_high';
  goalType: 'weight_loss' | 'maintenance' | 'muscle_gain' | 'balanced_diet';
}

export interface NutritionMacroRatioSnapshot {
  carbohydrate: number;
  protein: number;
  fat: number;
}

export const userProfiles = pgTable(
  'user_profile',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    locale: text('locale').default('ko-KR').notNull(),
    timezone: text('timezone').default('Asia/Seoul').notNull(),
    deletionStatus: deletionStatusEnum('deletion_status').default('active').notNull(),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    onboardingStatus: onboardingStatusEnum('onboarding_status').default('pending').notNull(),
    safetyModeReasonCodes: jsonb('safety_mode_reason_codes').$type<string[]>().default([]).notNull(),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'user_profile_onboarding_status_check',
      sql`(${table.onboardingStatus} = 'pending' and ${table.onboardingCompletedAt} is null)
        or (${table.onboardingStatus} <> 'pending' and ${table.onboardingCompletedAt} is not null)`,
    ),
  ],
);

export const consents = pgTable(
  'consent',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: consentTypeEnum('type').notNull(),
    action: consentActionEnum('action').notNull(),
    documentVersion: text('document_version').notNull(),
    documentSha256: text('document_sha256').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('consent_user_type_time_idx').on(table.userId, table.type, table.occurredAt)],
);

export const nutritionProfiles = pgTable(
  'nutrition_profile',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    goalType: goalTypeEnum('goal_type').notNull(),
    birthYear: integer('birth_year'),
    calculationSex: calculationSexEnum('calculation_sex'),
    heightMm: integer('height_mm'),
    weightG: integer('weight_g'),
    activityLevel: activityLevelEnum('activity_level').notNull(),
    calorieTargetMillicalories: integer('calorie_target_millicalories').notNull(),
    carbohydrateTargetMg: integer('carbohydrate_target_mg').notNull(),
    proteinTargetMg: integer('protein_target_mg').notNull(),
    fatTargetMg: integer('fat_target_mg').notNull(),
    fiberTargetMg: integer('fiber_target_mg').notNull(),
    equationSource: text('equation_source').notNull(),
    equationVersion: text('equation_version').notNull(),
    corrigendaVersion: text('corrigenda_version').notNull(),
    engineVersion: text('engine_version').notNull(),
    safetyRulesVersion: text('safety_rules_version').notNull(),
    calculationInputSnapshot: jsonb('calculation_input_snapshot')
      .$type<NutritionCalculationInputSnapshot>()
      .notNull(),
    activityCoefficientBps: integer('activity_coefficient_bps').notNull(),
    baseEerMillicalories: integer('base_eer_millicalories').notNull(),
    goalAdjustment: text('goal_adjustment').notNull(),
    macroRatioSnapshot: jsonb('macro_ratio_snapshot')
      .$type<NutritionMacroRatioSnapshot>()
      .notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('nutrition_profile_user_effective_idx').on(table.userId, table.effectiveFrom),
    uniqueIndex('nutrition_profile_one_active_per_user_idx')
      .on(table.userId)
      .where(sql`${table.effectiveTo} is null`),
    check(
      'nutrition_profile_effective_range_check',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'nutrition_profile_body_metrics_check',
      sql`(${table.birthYear} is null or ${table.birthYear} between 1900 and 2100)
        and (${table.heightMm} is null or ${table.heightMm} > 0)
        and (${table.weightG} is null or ${table.weightG} > 0)`,
    ),
    check(
      'nutrition_profile_targets_check',
      sql`${table.calorieTargetMillicalories} > 0
        and ${table.carbohydrateTargetMg} >= 0
        and ${table.proteinTargetMg} >= 0
        and ${table.fatTargetMg} >= 0
        and ${table.fiberTargetMg} >= 0
        and ${table.activityCoefficientBps} > 0
        and ${table.baseEerMillicalories} > 0`,
    ),
  ],
);
