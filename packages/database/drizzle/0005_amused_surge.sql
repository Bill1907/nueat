CREATE TYPE "public"."recognition_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_status" "recognition_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_engine_version" text;--> statement-breakpoint
ALTER TABLE "meal_log" ADD COLUMN "recognition_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_log_image_asset_unique" ON "meal_log" USING btree ("image_asset_id") WHERE "meal_log"."image_asset_id" is not null;--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_recognition_ready_check" CHECK ("meal_log"."recognition_status" <> 'ready'
        or ("meal_log"."recognition_engine_version" is not null and "meal_log"."recognition_completed_at" is not null));