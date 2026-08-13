CREATE TABLE "recipe_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "food_id" uuid NOT NULL,
  "source_release_id" uuid NOT NULL,
  "source_recipe_id" text NOT NULL,
  "version" text NOT NULL,
  "yield_mg" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recipe_version_yield_check" CHECK ("yield_mg" > 0),
  CONSTRAINT "recipe_version_source_id_check" CHECK (length(trim("source_recipe_id")) > 0 AND length(trim("version")) > 0)
);--> statement-breakpoint
CREATE TABLE "recipe_version_component" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recipe_version_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "food_id" uuid NOT NULL,
  "edible_amount_mg" integer NOT NULL,
  CONSTRAINT "recipe_version_component_ordinal_check" CHECK ("ordinal" between 0 and 11),
  CONSTRAINT "recipe_version_component_amount_check" CHECK ("edible_amount_mg" > 0)
);--> statement-breakpoint
CREATE TABLE "meal_decomposition_revision" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "meal_log_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "root_mapping_decision_id" uuid NOT NULL,
  "root_calculation_preview_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "meal_decomposition_revision_number_check" CHECK ("revision" > 0)
);--> statement-breakpoint
CREATE TABLE "meal_decomposition_component" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "meal_decomposition_revision_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "mapping_decision_id" uuid NOT NULL,
  "calculation_preview_id" uuid NOT NULL,
  "edible_amount_mg" integer NOT NULL,
  CONSTRAINT "meal_decomposition_component_ordinal_check" CHECK ("ordinal" between 0 and 11),
  CONSTRAINT "meal_decomposition_component_amount_check" CHECK ("edible_amount_mg" > 0)
);--> statement-breakpoint
ALTER TABLE "recipe_version" ADD CONSTRAINT "recipe_version_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "food"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "recipe_version" ADD CONSTRAINT "recipe_version_source_release_id_source_release_id_fk" FOREIGN KEY ("source_release_id") REFERENCES "source_release"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "recipe_version_component" ADD CONSTRAINT "recipe_version_component_recipe_version_id_recipe_version_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_version"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "recipe_version_component" ADD CONSTRAINT "recipe_version_component_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "food"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "meal_decomposition_revision" ADD CONSTRAINT "meal_decomposition_revision_meal_log_id_meal_log_id_fk" FOREIGN KEY ("meal_log_id") REFERENCES "meal_log"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "meal_decomposition_revision" ADD CONSTRAINT "meal_decomposition_revision_root_mapping_decision_id_mapping_decision_id_fk" FOREIGN KEY ("root_mapping_decision_id") REFERENCES "mapping_decision"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "meal_decomposition_revision" ADD CONSTRAINT "meal_decomposition_revision_root_calculation_preview_id_calculation_preview_id_fk" FOREIGN KEY ("root_calculation_preview_id") REFERENCES "calculation_preview"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "meal_decomposition_component" ADD CONSTRAINT "meal_decomposition_component_revision_fk" FOREIGN KEY ("meal_decomposition_revision_id") REFERENCES "meal_decomposition_revision"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "meal_decomposition_component" ADD CONSTRAINT "meal_decomposition_component_mapping_decision_id_mapping_decision_id_fk" FOREIGN KEY ("mapping_decision_id") REFERENCES "mapping_decision"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "meal_decomposition_component" ADD CONSTRAINT "meal_decomposition_component_calculation_preview_id_calculation_preview_id_fk" FOREIGN KEY ("calculation_preview_id") REFERENCES "calculation_preview"("id") ON DELETE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_version_source_unique" ON "recipe_version" ("source_release_id", "source_recipe_id", "version");--> statement-breakpoint
CREATE INDEX "recipe_version_food_idx" ON "recipe_version" ("food_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_version_component_ordinal_unique" ON "recipe_version_component" ("recipe_version_id", "ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_version_component_food_unique" ON "recipe_version_component" ("recipe_version_id", "food_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_decomposition_revision_unique" ON "meal_decomposition_revision" ("meal_log_id", "revision");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_decomposition_component_ordinal_unique" ON "meal_decomposition_component" ("meal_decomposition_revision_id", "ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_decomposition_component_mapping_unique" ON "meal_decomposition_component" ("meal_decomposition_revision_id", "mapping_decision_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$;--> statement-breakpoint
CREATE TRIGGER recipe_version_append_only BEFORE UPDATE OR DELETE ON "recipe_version" FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION reject_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER recipe_version_component_append_only BEFORE UPDATE OR DELETE ON "recipe_version_component" FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION reject_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER meal_decomposition_revision_append_only BEFORE UPDATE OR DELETE ON "meal_decomposition_revision" FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION reject_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER meal_decomposition_component_append_only BEFORE UPDATE OR DELETE ON "meal_decomposition_component" FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION reject_append_only_mutation();
