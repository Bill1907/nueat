import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './auth';
import { mealLogs } from './meal';

export const feedbackTargetTypeEnum = pgEnum('feedback_target_type', [
  'recognition',
  'food_mapping',
  'recommendation',
]);

export interface RecommendationContextSnapshot {
  requestedAt: string;
  timezone: string;
  targetId: string;
  remainingTargets: Record<string, number | null>;
  recentMealIds: string[];
  calculationSnapshots: Array<{ id: string; mealLogId: string; sequence: number }>;
  dietaryConstraintIds: string[];
  selectedNutrientProfiles: Array<{
    id: string;
    sourceRegistryId: string;
    sourceItemId: string;
    datasetVersion: string;
    foodId: string;
  }>;
}

interface RecommendationNutrientSnapshot {
  energyMillicalories: number | null;
  carbohydrateMg: number | null;
  proteinMg: number | null;
  fatMg: number | null;
  fiberMg: number | null;
}

type RecommendationRationaleSnapshot =
  | { code: 'PROTEIN_GAP'; remainingMg: number | null; scoreBps: number }
  | { code: 'FIBER_GAP'; remainingMg: number | null; scoreBps: number }
  | { code: 'ENERGY_FIT'; projectedEnergyMillicalories: number | null; scoreBps: number }
  | { code: 'RECENT_FOOD_DIVERSITY'; hasRecentFood: boolean; scoreBps: number };

export interface RecommendationCandidateSnapshot {
  rank: number;
  templateId: string;
  titleKo: string;
  scoreBps: number;
  components: Array<{ foodId: string; nutrientProfileId: string; nameKo: string; gramsMg: number }>;
  nutrition: RecommendationNutrientSnapshot;
  projectedTotals: RecommendationNutrientSnapshot;
  rationaleFacts: RecommendationRationaleSnapshot[];
  warnings: 'CALORIE_TARGET_OVERAGE'[];
}

export const recommendations = pgTable(
  'recommendation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contextSnapshot: jsonb('context_snapshot').$type<RecommendationContextSnapshot>().notNull(),
    candidateItems: jsonb('candidate_items')
      .$type<RecommendationCandidateSnapshot[]>()
      .notNull(),
    engineVersion: text('engine_version').notNull(),
    modelVersion: text('model_version'),
    promptVersion: text('prompt_version'),
    safetyFlags: jsonb('safety_flags').$type<string[]>().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('recommendation_user_created_idx').on(table.userId, table.createdAt)],
);
export const recommendationMealDrafts = pgTable(
  'recommendation_meal_draft',
  {
    recommendationId: uuid('recommendation_id')
      .primaryKey()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    mealLogId: uuid('meal_log_id')
      .notNull()
      .unique()
      .references(() => mealLogs.id, { onDelete: 'restrict' }),
    candidateRank: integer('candidate_rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'recommendation_meal_draft_candidate_rank_check',
      sql`${table.candidateRank} between 1 and 3`,
    ),
  ],
);

export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: feedbackTargetTypeEnum('target_type').notNull(),
    targetId: text('target_id').notNull(),
    rating: text('rating'),
    reasonCode: text('reason_code'),
    correction: jsonb('correction').$type<Record<string, unknown>>(),
    freeText: text('free_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('feedback_target_idx').on(table.targetType, table.targetId)],
);

export const analyticsEvents = pgTable(
  'analytics_event',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    anonymousSessionId: text('anonymous_session_id'),
    eventName: text('event_name').notNull(),
    properties: jsonb('properties').$type<Record<string, string | number | boolean | null>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('analytics_event_name_time_idx').on(table.eventName, table.occurredAt),
    index('analytics_event_user_time_idx').on(table.userId, table.occurredAt),
  ],
);
