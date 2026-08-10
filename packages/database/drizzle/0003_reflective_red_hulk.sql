CREATE TYPE "public"."onboarding_status" AS ENUM('pending', 'completed', 'limited');--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "onboarding_status" "onboarding_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "safety_mode_reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_onboarding_status_check" CHECK (("user_profile"."onboarding_status" = 'pending' and "user_profile"."onboarding_completed_at" is null)
      or ("user_profile"."onboarding_status" <> 'pending' and "user_profile"."onboarding_completed_at" is not null));