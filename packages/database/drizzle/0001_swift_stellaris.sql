ALTER TABLE "nutrition_profile" DROP CONSTRAINT "nutrition_profile_targets_check";--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "equation_source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "equation_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "corrigenda_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "engine_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "safety_rules_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "calculation_input_snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "activity_coefficient_bps" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "base_eer_millicalories" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "goal_adjustment" text NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD COLUMN "macro_ratio_snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nutrition_profile" ADD CONSTRAINT "nutrition_profile_targets_check" CHECK ("nutrition_profile"."calorie_target_millicalories" > 0
        and "nutrition_profile"."carbohydrate_target_mg" >= 0
        and "nutrition_profile"."protein_target_mg" >= 0
        and "nutrition_profile"."fat_target_mg" >= 0
        and "nutrition_profile"."fiber_target_mg" >= 0
        and "nutrition_profile"."activity_coefficient_bps" > 0
        and "nutrition_profile"."base_eer_millicalories" > 0);