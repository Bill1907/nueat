ALTER TABLE "meal_log" DROP CONSTRAINT "meal_log_recognition_ready_check";--> statement-breakpoint
ALTER TABLE "meal_log" ALTER COLUMN "recognition_status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."recognition_status" RENAME TO "recognition_status_old";--> statement-breakpoint
CREATE TYPE "public"."recognition_status" AS ENUM('pending', 'processing', 'ready', 'failed', 'manual');--> statement-breakpoint
ALTER TABLE "meal_log" ALTER COLUMN "recognition_status" TYPE "public"."recognition_status" USING "recognition_status"::text::"public"."recognition_status";--> statement-breakpoint
ALTER TABLE "meal_log" ALTER COLUMN "recognition_status" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."recognition_status_old";--> statement-breakpoint
CREATE TYPE "public"."recognition_provider" AS ENUM('mock', 'openai');--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_provider" "recognition_provider";--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_model" text;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_prompt_version" text;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_schema_version" text;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_result" jsonb;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_provider_request_id" text;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_next_attempt_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_last_error_code" text;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "recognition_region_index" integer;--> statement-breakpoint
WITH ranked_items AS (
  SELECT "id", row_number() OVER (PARTITION BY "meal_log_id" ORDER BY "created_at", "id") - 1 AS "region_index"
  FROM (
    SELECT "meal_item"."id", "meal_item"."meal_log_id", "meal_item"."created_at",
      count(*) OVER (PARTITION BY "meal_item"."meal_log_id") AS "item_count"
    FROM "meal_item"
    INNER JOIN "meal_log" ON "meal_log"."id" = "meal_item"."meal_log_id"
    WHERE "meal_log"."recognition_status" = 'ready'
  ) AS ready_items
  WHERE "item_count" <= 20
)
UPDATE "meal_item"
SET "recognition_region_index" = ranked_items."region_index"
FROM ranked_items
WHERE "meal_item"."id" = ranked_items."id";--> statement-breakpoint
UPDATE "meal_log"
SET "recognition_status" = 'manual',
    "recognition_provider" = 'mock',
    "recognition_model" = coalesce("recognition_engine_version", 'legacy-mock'),
    "recognition_prompt_version" = 'legacy-mock-v1',
    "recognition_schema_version" = 'legacy-mock-v1'
WHERE "recognition_status" = 'ready'
  AND (
    NOT EXISTS (
      SELECT 1 FROM "meal_item" WHERE "meal_item"."meal_log_id" = "meal_log"."id"
    )
    OR 20 < (
      SELECT count(*) FROM "meal_item" WHERE "meal_item"."meal_log_id" = "meal_log"."id"
    )
  );--> statement-breakpoint
UPDATE "meal_log"
SET "recognition_provider" = 'mock',
    "recognition_model" = coalesce("recognition_engine_version", 'legacy-mock'),
    "recognition_prompt_version" = 'legacy-mock-v1',
    "recognition_schema_version" = 'legacy-mock-v1'
WHERE "recognition_engine_version" IS NOT NULL;--> statement-breakpoint
UPDATE "meal_log"
SET "recognition_provider" = 'mock',
    "recognition_model" = coalesce("recognition_model", 'legacy-mock'),
    "recognition_prompt_version" = coalesce("recognition_prompt_version", 'legacy-mock-v1'),
    "recognition_schema_version" = coalesce("recognition_schema_version", 'legacy-mock-v1'),
    "recognition_result" = (
      SELECT jsonb_build_object(
        'foods',
        jsonb_agg(
          jsonb_build_object(
            'regionIndex', "meal_item"."recognition_region_index",
            'recognizedLabel', "meal_item"."recognized_label",
            'recognitionConfidenceBps', coalesce("meal_item"."recognition_confidence_bps", 0),
            'amountMilliunits', "meal_item"."amount_milliunits",
            'unit', "meal_item"."unit"::text,
            'portionConfidenceBps', coalesce("meal_item"."portion_confidence_bps", 0)
          )
          ORDER BY "meal_item"."recognition_region_index"
        )
      )
      FROM "meal_item"
      WHERE "meal_item"."meal_log_id" = "meal_log"."id"
    ),
    "recognition_completed_at" = coalesce("recognition_completed_at", "updated_at", "created_at")
WHERE "recognition_status" = 'ready';--> statement-breakpoint
UPDATE "meal_log"
SET "recognition_next_attempt_at" = now()
WHERE "recognition_status" IN ('pending', 'failed')
  AND "recognition_next_attempt_at" IS NULL;--> statement-breakpoint
ALTER TABLE "meal_log" DROP COLUMN "recognition_engine_version";--> statement-breakpoint
CREATE INDEX "meal_log_recognition_due_idx" ON "meal_log" USING btree ("recognition_status", "recognition_next_attempt_at") WHERE "meal_log"."recognition_status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "meal_log_recognition_lease_expiry_idx" ON "meal_log" USING btree ("recognition_status", "recognition_lease_expires_at") WHERE "meal_log"."recognition_status" = 'processing';--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_processing_lease_check" CHECK (("meal_log"."recognition_status" = 'processing'
  and "meal_log"."recognition_lease_token" is not null
  and "meal_log"."recognition_lease_expires_at" is not null)
  or ("meal_log"."recognition_status" <> 'processing'
  and "meal_log"."recognition_lease_token" is null
  and "meal_log"."recognition_lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_ready_check" CHECK ("meal_log"."recognition_status" <> 'ready'
  or ("meal_log"."recognition_provider" is not null
  and "meal_log"."recognition_model" is not null
  and "meal_log"."recognition_prompt_version" is not null
  and "meal_log"."recognition_schema_version" is not null
  and "meal_log"."recognition_result" is not null
  and jsonb_typeof("meal_log"."recognition_result") = 'object'
  and "meal_log"."recognition_result" ? 'foods'
  and jsonb_typeof("meal_log"."recognition_result"->'foods') = 'array'
  and "meal_log"."recognition_completed_at" is not null));--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_attempt_usage_check" CHECK ("meal_log"."recognition_attempt_count" >= 0
  and "meal_log"."recognition_input_tokens" >= 0
  and "meal_log"."recognition_output_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_retry_schedule_check" CHECK ("meal_log"."recognition_status" not in ('pending', 'failed')
  or "meal_log"."recognition_next_attempt_at" is not null);--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_recognition_region_index_check" CHECK ("meal_item"."recognition_region_index" is null
  or "meal_item"."recognition_region_index" between 0 and 19);