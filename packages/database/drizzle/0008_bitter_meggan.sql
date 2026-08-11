ALTER TABLE "meal_log" ALTER COLUMN "recognition_attempt_count" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "meal_log" ALTER COLUMN "recognition_input_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "meal_log" ALTER COLUMN "recognition_output_tokens" SET DEFAULT 0;--> statement-breakpoint
UPDATE "meal_item"
SET "recognition_region_index" = null
WHERE "meal_log_id" IN (
  SELECT "id"
  FROM "meal_log"
  WHERE "recognition_provider" = 'mock'
    AND "recognition_prompt_version" = 'legacy-mock-v1'
);--> statement-breakpoint
UPDATE "meal_log"
SET "recognition_status" = 'manual',
    "recognition_provider" = null,
    "recognition_model" = null,
    "recognition_prompt_version" = null,
    "recognition_schema_version" = null,
    "recognition_result" = null,
    "recognition_completed_at" = null,
    "recognition_provider_request_id" = null,
    "recognition_attempt_count" = 0,
    "recognition_lease_token" = null,
    "recognition_lease_expires_at" = null,
    "recognition_next_attempt_at" = null,
    "recognition_last_error_code" = null,
    "recognition_input_tokens" = 0,
    "recognition_output_tokens" = 0
WHERE "recognition_provider" = 'mock'
  AND "recognition_prompt_version" = 'legacy-mock-v1';--> statement-breakpoint
WITH duplicate_regions AS (
  SELECT "meal_log_id", "recognition_region_index"
  FROM "meal_item"
  WHERE "recognition_region_index" IS NOT NULL
  GROUP BY "meal_log_id", "recognition_region_index"
  HAVING count(*) > 1
)
UPDATE "meal_item"
SET "recognition_region_index" = null
FROM duplicate_regions
WHERE "meal_item"."meal_log_id" = duplicate_regions."meal_log_id"
  AND "meal_item"."recognition_region_index" =
      duplicate_regions."recognition_region_index";--> statement-breakpoint
CREATE UNIQUE INDEX "meal_item_recognition_region_unique" ON "meal_item" USING btree ("meal_log_id","recognition_region_index") WHERE "meal_item"."recognition_region_index" is not null;