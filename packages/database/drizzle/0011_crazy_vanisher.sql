CREATE TYPE "public"."meal_item_mapping_source" AS ENUM('model_primary', 'model_alternative', 'user_selected', 'legacy_existing');--> statement-breakpoint
CREATE TYPE "public"."meal_item_origin" AS ENUM('model_estimate', 'manual_entry', 'user_added', 'legacy_unknown');--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "origin" "meal_item_origin" DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "initial_estimate_assessment" jsonb;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "current_resolution_source" "meal_item_mapping_source";--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "current_resolution_selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "item_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "food_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "portion_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "food_acknowledged_revision" integer;--> statement-breakpoint
ALTER TABLE "meal_item" ADD COLUMN "portion_acknowledged_revision" integer;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_manual_override" jsonb;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "draft_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "meal_item"
SET "current_resolution_source" = 'legacy_existing',
    "current_resolution_selected_at" = COALESCE("updated_at", "created_at")
WHERE "food_id" IS NOT NULL
  AND "nutrient_profile_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_revision_check" CHECK ("meal_item"."item_revision" > 0
        and "meal_item"."food_revision" > 0
        and "meal_item"."portion_revision" > 0
        and ("meal_item"."food_acknowledged_revision" is null
          or ("meal_item"."food_acknowledged_revision" > 0
            and "meal_item"."food_acknowledged_revision" <= "meal_item"."food_revision"))
        and ("meal_item"."portion_acknowledged_revision" is null
          or ("meal_item"."portion_acknowledged_revision" > 0
            and "meal_item"."portion_acknowledged_revision" <= "meal_item"."portion_revision")));--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_initial_estimate_origin_check" CHECK (("meal_item"."origin" = 'model_estimate' and "meal_item"."initial_estimate_assessment" is not null)
        or ("meal_item"."origin" <> 'model_estimate' and "meal_item"."initial_estimate_assessment" is null));--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_draft_revision_check" CHECK ("meal_log"."draft_revision" > 0);--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_manual_override_check" CHECK ("meal_log"."recognition_manual_override" is null
        or ("meal_log"."recognition_status" = 'manual'
        and "meal_log"."recognition_result" is not null
        and "meal_log"."recognition_result"->>'outcome' in ('no_food', 'insufficient_evidence')
        and "meal_log"."recognition_manual_override"->>'fromStatus' = 'ready'
        and "meal_log"."recognition_manual_override"->>'fromOutcome' = "meal_log"."recognition_result"->>'outcome'
        and "meal_log"."recognition_manual_override"->>'decision' = 'direct_entry'
        and "meal_log"."recognition_manual_override"->>'decisionVersion' = 'recognition-manual-override-v1'
        and "meal_log"."recognition_manual_override" ? 'decidedAt'));