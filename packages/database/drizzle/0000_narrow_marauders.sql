CREATE TYPE "public"."feedback_target_type" AS ENUM('recognition', 'food_mapping', 'recommendation');--> statement-breakpoint
CREATE TYPE "public"."dietary_constraint_severity" AS ENUM('avoid', 'hard_block');--> statement-breakpoint
CREATE TYPE "public"."dietary_constraint_type" AS ENUM('allergy', 'preference', 'exclusion');--> statement-breakpoint
CREATE TYPE "public"."quality_grade" AS ENUM('verified', 'estimated', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."serving_unit" AS ENUM('g', 'ml', 'serving', 'bowl', 'piece');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('public_dataset', 'manufacturer', 'commercial_dataset', 'recipe_estimate', 'user_entered');--> statement-breakpoint
CREATE TYPE "public"."asset_deletion_job_status" AS ENUM('pending', 'processing', 'failed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."image_asset_purpose" AS ENUM('inference', 'thumbnail');--> statement-breakpoint
CREATE TYPE "public"."image_asset_status" AS ENUM('pending_upload', 'uploaded', 'validating', 'validated', 'processing', 'processed', 'rejected', 'deletion_pending', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."meal_status" AS ENUM('draft', 'confirmed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."meal_type" AS ENUM('breakfast', 'lunch', 'dinner', 'snack');--> statement-breakpoint
CREATE TYPE "public"."activity_level" AS ENUM('sedentary', 'light', 'moderate', 'high', 'very_high');--> statement-breakpoint
CREATE TYPE "public"."calculation_sex" AS ENUM('female', 'male');--> statement-breakpoint
CREATE TYPE "public"."consent_action" AS ENUM('granted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('terms', 'privacy', 'health_data', 'image_training');--> statement-breakpoint
CREATE TYPE "public"."deletion_status" AS ENUM('active', 'deletion_pending');--> statement-breakpoint
CREATE TYPE "public"."goal_type" AS ENUM('weight_loss', 'maintenance', 'muscle_gain', 'balanced_diet');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"anonymous_session_id" text,
	"event_name" text NOT NULL,
	"properties" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"target_type" "feedback_target_type" NOT NULL,
	"target_id" text NOT NULL,
	"rating" text,
	"reason_code" text,
	"correction" jsonb,
	"free_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"context_snapshot" jsonb NOT NULL,
	"candidate_items" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"model_version" text,
	"prompt_version" text,
	"safety_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dietary_constraint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" "dietary_constraint_type" NOT NULL,
	"food_id" uuid,
	"label_ko" text,
	"severity" "dietary_constraint_severity" NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dietary_constraint_target_check" CHECK ("dietary_constraint"."food_id" is not null or "dietary_constraint"."label_ko" is not null),
	CONSTRAINT "dietary_constraint_allergy_hard_block_check" CHECK ("dietary_constraint"."type" <> 'allergy' or "dietary_constraint"."severity" = 'hard_block')
);
--> statement-breakpoint
CREATE TABLE "food_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"alias_ko" text NOT NULL,
	"normalized_alias_ko" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_serving" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"unit" "serving_unit" NOT NULL,
	"label_ko" text NOT NULL,
	"amount_milliunits" integer NOT NULL,
	"grams_mg" integer NOT NULL,
	"source_registry_id" uuid NOT NULL,
	"quality_grade" "quality_grade" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_serving_positive_amount_check" CHECK ("food_serving"."amount_milliunits" > 0 and "food_serving"."grams_mg" > 0)
);
--> statement-breakpoint
CREATE TABLE "food" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name_ko" text NOT NULL,
	"category" text NOT NULL,
	"preparation" text,
	"is_composite" boolean DEFAULT false NOT NULL,
	"is_deprecated" boolean DEFAULT false NOT NULL,
	"replacement_food_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nutrient_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"source_registry_id" uuid NOT NULL,
	"source_item_id" text NOT NULL,
	"dataset_version" text NOT NULL,
	"basis_amount_mg" integer DEFAULT 100000 NOT NULL,
	"energy_millicalories" integer,
	"carbohydrate_mg" integer,
	"protein_mg" integer,
	"fat_mg" integer,
	"fiber_mg" integer,
	"quality_grade" "quality_grade" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nutrient_profile_basis_check" CHECK ("nutrient_profile"."basis_amount_mg" > 0),
	CONSTRAINT "nutrient_profile_nonnegative_values_check" CHECK (("nutrient_profile"."energy_millicalories" is null or "nutrient_profile"."energy_millicalories" >= 0)
        and ("nutrient_profile"."carbohydrate_mg" is null or "nutrient_profile"."carbohydrate_mg" >= 0)
        and ("nutrient_profile"."protein_mg" is null or "nutrient_profile"."protein_mg" >= 0)
        and ("nutrient_profile"."fat_mg" is null or "nutrient_profile"."fat_mg" >= 0)
        and ("nutrient_profile"."fiber_mg" is null or "nutrient_profile"."fiber_mg" >= 0))
);
--> statement-breakpoint
CREATE TABLE "source_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"dataset_version" text NOT NULL,
	"license_reference" text NOT NULL,
	"published_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_registry_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "asset_deletion_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_asset_id" uuid NOT NULL,
	"status" "asset_deletion_job_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_deletion_job_image_asset_id_unique" UNIQUE("image_asset_id"),
	CONSTRAINT "asset_deletion_job_attempt_count_check" CHECK ("asset_deletion_job"."attempt_count" >= 0),
	CONSTRAINT "asset_deletion_job_completed_timestamp_check" CHECK ("asset_deletion_job"."status" <> 'completed' or "asset_deletion_job"."completed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "calculation_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_log_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"energy_millicalories" integer NOT NULL,
	"carbohydrate_mg" integer NOT NULL,
	"protein_mg" integer NOT NULL,
	"fat_mg" integer NOT NULL,
	"fiber_mg" integer,
	"calculation_version" text NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calculation_snapshot_sequence_check" CHECK ("calculation_snapshot"."sequence" > 0),
	CONSTRAINT "calculation_snapshot_values_check" CHECK ("calculation_snapshot"."energy_millicalories" >= 0
        and "calculation_snapshot"."carbohydrate_mg" >= 0
        and "calculation_snapshot"."protein_mg" >= 0
        and "calculation_snapshot"."fat_mg" >= 0
        and ("calculation_snapshot"."fiber_mg" is null or "calculation_snapshot"."fiber_mg" >= 0))
);
--> statement-breakpoint
CREATE TABLE "image_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"purpose" "image_asset_purpose" NOT NULL,
	"parent_asset_id" uuid,
	"bucket_name" text NOT NULL,
	"object_key" text NOT NULL,
	"status" "image_asset_status" DEFAULT 'pending_upload' NOT NULL,
	"declared_content_type" text NOT NULL,
	"detected_content_type" text,
	"byte_size" integer,
	"sha256" text,
	"expires_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"validated_at" timestamp with time zone,
	"processing_completed_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_asset_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "image_asset_byte_size_check" CHECK ("image_asset"."byte_size" is null or "image_asset"."byte_size" > 0),
	CONSTRAINT "image_asset_inference_expiry_check" CHECK ("image_asset"."purpose" <> 'inference' or "image_asset"."expires_at" is not null),
	CONSTRAINT "image_asset_status_timestamps_check" CHECK (("image_asset"."status" <> 'processed' or "image_asset"."processing_completed_at" is not null)
        and ("image_asset"."status" <> 'deletion_pending' or "image_asset"."deletion_requested_at" is not null)
        and ("image_asset"."status" <> 'deleted' or "image_asset"."deleted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "meal_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_log_id" uuid NOT NULL,
	"recognized_label" text NOT NULL,
	"food_id" uuid,
	"nutrient_profile_id" uuid,
	"amount_milliunits" integer NOT NULL,
	"unit" "serving_unit" NOT NULL,
	"grams_mg" integer,
	"recognition_confidence_bps" integer,
	"mapping_confidence_bps" integer,
	"portion_confidence_bps" integer,
	"user_corrected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_item_amount_check" CHECK ("meal_item"."amount_milliunits" > 0),
	CONSTRAINT "meal_item_grams_check" CHECK ("meal_item"."grams_mg" is null or "meal_item"."grams_mg" > 0),
	CONSTRAINT "meal_item_confidence_check" CHECK (("meal_item"."recognition_confidence_bps" is null or "meal_item"."recognition_confidence_bps" between 0 and 10000)
        and ("meal_item"."mapping_confidence_bps" is null or "meal_item"."mapping_confidence_bps" between 0 and 10000)
        and ("meal_item"."portion_confidence_bps" is null or "meal_item"."portion_confidence_bps" between 0 and 10000))
);
--> statement-breakpoint
CREATE TABLE "meal_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"eaten_at" timestamp with time zone NOT NULL,
	"eaten_timezone" text NOT NULL,
	"eaten_local_date" date NOT NULL,
	"meal_type" "meal_type" NOT NULL,
	"status" "meal_status" DEFAULT 'draft' NOT NULL,
	"image_asset_id" uuid,
	"thumbnail_asset_id" uuid,
	"confirmed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_log_status_timestamps_check" CHECK (("meal_log"."status" <> 'confirmed' or "meal_log"."confirmed_at" is not null)
        and ("meal_log"."status" <> 'deleted' or ("meal_log"."deleted_at" is not null and "meal_log"."purge_after" is not null)))
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" "consent_type" NOT NULL,
	"action" "consent_action" NOT NULL,
	"document_version" text NOT NULL,
	"document_sha256" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nutrition_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"goal_type" "goal_type" NOT NULL,
	"birth_year" integer,
	"calculation_sex" "calculation_sex",
	"height_mm" integer,
	"weight_g" integer,
	"activity_level" "activity_level" NOT NULL,
	"calorie_target_millicalories" integer NOT NULL,
	"carbohydrate_target_mg" integer NOT NULL,
	"protein_target_mg" integer NOT NULL,
	"fat_target_mg" integer NOT NULL,
	"fiber_target_mg" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nutrition_profile_effective_range_check" CHECK ("nutrition_profile"."effective_to" is null or "nutrition_profile"."effective_to" > "nutrition_profile"."effective_from"),
	CONSTRAINT "nutrition_profile_body_metrics_check" CHECK (("nutrition_profile"."birth_year" is null or "nutrition_profile"."birth_year" between 1900 and 2100)
        and ("nutrition_profile"."height_mm" is null or "nutrition_profile"."height_mm" > 0)
        and ("nutrition_profile"."weight_g" is null or "nutrition_profile"."weight_g" > 0)),
	CONSTRAINT "nutrition_profile_targets_check" CHECK ("nutrition_profile"."calorie_target_millicalories" > 0
        and "nutrition_profile"."carbohydrate_target_mg" >= 0
        and "nutrition_profile"."protein_target_mg" >= 0
        and "nutrition_profile"."fat_target_mg" >= 0
        and "nutrition_profile"."fiber_target_mg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"locale" text DEFAULT 'ko-KR' NOT NULL,
	"timezone" text DEFAULT 'Asia/Seoul' NOT NULL,
	"deletion_status" "deletion_status" DEFAULT 'active' NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_event" ADD CONSTRAINT "analytics_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dietary_constraint" ADD CONSTRAINT "dietary_constraint_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dietary_constraint" ADD CONSTRAINT "dietary_constraint_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_alias" ADD CONSTRAINT "food_alias_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_serving" ADD CONSTRAINT "food_serving_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_serving" ADD CONSTRAINT "food_serving_source_registry_id_source_registry_id_fk" FOREIGN KEY ("source_registry_id") REFERENCES "public"."source_registry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food" ADD CONSTRAINT "food_replacement_food_id_food_id_fk" FOREIGN KEY ("replacement_food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrient_profile" ADD CONSTRAINT "nutrient_profile_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrient_profile" ADD CONSTRAINT "nutrient_profile_source_registry_id_source_registry_id_fk" FOREIGN KEY ("source_registry_id") REFERENCES "public"."source_registry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_deletion_job" ADD CONSTRAINT "asset_deletion_job_image_asset_id_image_asset_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."image_asset"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ADD CONSTRAINT "calculation_snapshot_meal_log_id_meal_log_id_fk" FOREIGN KEY ("meal_log_id") REFERENCES "public"."meal_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_asset" ADD CONSTRAINT "image_asset_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_asset" ADD CONSTRAINT "image_asset_parent_asset_id_image_asset_id_fk" FOREIGN KEY ("parent_asset_id") REFERENCES "public"."image_asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_meal_log_id_meal_log_id_fk" FOREIGN KEY ("meal_log_id") REFERENCES "public"."meal_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_nutrient_profile_id_nutrient_profile_id_fk" FOREIGN KEY ("nutrient_profile_id") REFERENCES "public"."nutrient_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_image_asset_id_image_asset_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."image_asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_thumbnail_asset_id_image_asset_id_fk" FOREIGN KEY ("thumbnail_asset_id") REFERENCES "public"."image_asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD CONSTRAINT "nutrition_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "analytics_event_name_time_idx" ON "analytics_event" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_event_user_time_idx" ON "analytics_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "feedback_target_idx" ON "feedback" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "recommendation_user_created_idx" ON "recommendation" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "dietary_constraint_user_type_idx" ON "dietary_constraint" USING btree ("user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "food_alias_food_normalized_unique" ON "food_alias" USING btree ("food_id","normalized_alias_ko");--> statement-breakpoint
CREATE INDEX "food_alias_normalized_idx" ON "food_alias" USING btree ("normalized_alias_ko");--> statement-breakpoint
CREATE INDEX "food_serving_food_idx" ON "food_serving" USING btree ("food_id");--> statement-breakpoint
CREATE INDEX "food_name_category_idx" ON "food" USING btree ("canonical_name_ko","category");--> statement-breakpoint
CREATE UNIQUE INDEX "nutrient_profile_source_item_version_unique" ON "nutrient_profile" USING btree ("source_registry_id","source_item_id","dataset_version");--> statement-breakpoint
CREATE INDEX "nutrient_profile_food_quality_idx" ON "nutrient_profile" USING btree ("food_id","quality_grade");--> statement-breakpoint
CREATE INDEX "asset_deletion_job_due_idx" ON "asset_deletion_job" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calculation_snapshot_meal_sequence_unique" ON "calculation_snapshot" USING btree ("meal_log_id","sequence");--> statement-breakpoint
CREATE INDEX "calculation_snapshot_meal_calculated_idx" ON "calculation_snapshot" USING btree ("meal_log_id","calculated_at");--> statement-breakpoint
CREATE INDEX "image_asset_user_created_idx" ON "image_asset" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "image_asset_expiry_status_idx" ON "image_asset" USING btree ("expires_at","status");--> statement-breakpoint
CREATE INDEX "image_asset_parent_idx" ON "image_asset" USING btree ("parent_asset_id");--> statement-breakpoint
CREATE INDEX "meal_item_meal_log_idx" ON "meal_item" USING btree ("meal_log_id");--> statement-breakpoint
CREATE INDEX "meal_log_user_local_date_status_idx" ON "meal_log" USING btree ("user_id","eaten_local_date","status");--> statement-breakpoint
CREATE INDEX "consent_user_type_time_idx" ON "consent" USING btree ("user_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "nutrition_profile_user_effective_idx" ON "nutrition_profile" USING btree ("user_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "nutrition_profile_one_active_per_user_idx" ON "nutrition_profile" USING btree ("user_id") WHERE "nutrition_profile"."effective_to" is null;