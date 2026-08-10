import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './auth';

export const feedbackTargetTypeEnum = pgEnum('feedback_target_type', [
  'recognition',
  'food_mapping',
  'recommendation',
]);

export interface RecommendationContextSnapshot {
  requestedAt: string;
  timezone: string;
  remainingTargets: Record<string, number | null>;
  recentMealIds: string[];
  dietaryConstraintIds: string[];
}

export interface RecommendationCandidateSnapshot {
  rank: number;
  foodIds: string[];
  amountsMg: number[];
  projectedTotals: Record<string, number | null>;
  rationaleFacts: string[];
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
