ALTER TABLE "meal_item" DROP CONSTRAINT "meal_item_initial_estimate_origin_check";--> statement-breakpoint
UPDATE "meal_item" AS item
SET "initial_estimate_assessment" = item."initial_estimate_assessment" || jsonb_build_object(
  'initialFoodId', CASE
    WHEN item."current_resolution_source" IN ('model_primary', 'model_alternative')
      THEN item."food_id"
    ELSE NULL
  END,
  'initialNutrientProfileId', CASE
    WHEN item."current_resolution_source" IN ('model_primary', 'model_alternative')
      THEN item."nutrient_profile_id"
    ELSE NULL
  END,
  'recognitionProvider', CASE
    WHEN meal."recognition_provider" IN ('mock', 'openai') THEN meal."recognition_provider"
    ELSE 'mock'
  END,
  'recognitionModel', COALESCE(meal."recognition_model", 'legacy-unknown'),
  'recognitionPromptVersion', COALESCE(meal."recognition_prompt_version", 'legacy-unknown'),
  'recognitionSchemaVersion', COALESCE(meal."recognition_schema_version", 'legacy-unknown')
)
FROM "meal_log" AS meal
WHERE item."meal_log_id" = meal."id"
  AND item."origin" = 'model_estimate';--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_initial_estimate_origin_check" CHECK (("meal_item"."origin" = 'model_estimate'
          and "meal_item"."initial_estimate_assessment" is not null
          and "meal_item"."initial_estimate_assessment" ? 'initialFoodId'
          and "meal_item"."initial_estimate_assessment" ? 'initialNutrientProfileId'
          and "meal_item"."initial_estimate_assessment"->>'recognitionProvider' in ('mock', 'openai')
          and "meal_item"."initial_estimate_assessment" ? 'recognitionModel'
          and "meal_item"."initial_estimate_assessment" ? 'recognitionPromptVersion'
          and "meal_item"."initial_estimate_assessment" ? 'recognitionSchemaVersion')
        or ("meal_item"."origin" <> 'model_estimate' and "meal_item"."initial_estimate_assessment" is null));