ALTER TABLE "calculation_snapshot" ALTER COLUMN "energy_millicalories" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ALTER COLUMN "carbohydrate_mg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ALTER COLUMN "protein_mg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ALTER COLUMN "fat_mg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_snapshot" DROP CONSTRAINT "calculation_snapshot_values_check";--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ADD CONSTRAINT "calculation_snapshot_values_check" CHECK (("energy_millicalories" IS NULL OR "energy_millicalories" >= 0) AND ("carbohydrate_mg" IS NULL OR "carbohydrate_mg" >= 0) AND ("protein_mg" IS NULL OR "protein_mg" >= 0) AND ("fat_mg" IS NULL OR "fat_mg" >= 0) AND ("fiber_mg" IS NULL OR "fiber_mg" >= 0));
--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ADD COLUMN "nutrient_evidence" jsonb;--> statement-breakpoint
UPDATE "calculation_snapshot"
SET "nutrient_evidence" = jsonb_build_object(
  'energyMillicalories', jsonb_build_object('value', "energy_millicalories", 'knownValue', evidence.energy_known, 'missingItemCount', evidence.energy_missing, 'completeness', CASE WHEN evidence.energy_missing = 0 THEN 'complete' ELSE 'partial' END),
  'carbohydrateMg', jsonb_build_object('value', "carbohydrate_mg", 'knownValue', evidence.carbohydrate_known, 'missingItemCount', evidence.carbohydrate_missing, 'completeness', CASE WHEN evidence.carbohydrate_missing = 0 THEN 'complete' ELSE 'partial' END),
  'proteinMg', jsonb_build_object('value', "protein_mg", 'knownValue', evidence.protein_known, 'missingItemCount', evidence.protein_missing, 'completeness', CASE WHEN evidence.protein_missing = 0 THEN 'complete' ELSE 'partial' END),
  'fatMg', jsonb_build_object('value', "fat_mg", 'knownValue', evidence.fat_known, 'missingItemCount', evidence.fat_missing, 'completeness', CASE WHEN evidence.fat_missing = 0 THEN 'complete' ELSE 'partial' END),
  'fiberMg', jsonb_build_object('value', "fiber_mg", 'knownValue', evidence.fiber_known, 'missingItemCount', evidence.fiber_missing, 'completeness', CASE WHEN evidence.fiber_missing = 0 THEN 'complete' ELSE 'partial' END)
)
FROM LATERAL (
  SELECT
    coalesce(sum((item->'nutrients'->>'energyMillicalories')::integer) FILTER (WHERE item->'nutrients'->>'energyMillicalories' IS NOT NULL), 0)::integer AS energy_known,
    count(*) FILTER (WHERE item->'nutrients'->>'energyMillicalories' IS NULL)::integer AS energy_missing,
    coalesce(sum((item->'nutrients'->>'carbohydrateMg')::integer) FILTER (WHERE item->'nutrients'->>'carbohydrateMg' IS NOT NULL), 0)::integer AS carbohydrate_known,
    count(*) FILTER (WHERE item->'nutrients'->>'carbohydrateMg' IS NULL)::integer AS carbohydrate_missing,
    coalesce(sum((item->'nutrients'->>'proteinMg')::integer) FILTER (WHERE item->'nutrients'->>'proteinMg' IS NOT NULL), 0)::integer AS protein_known,
    count(*) FILTER (WHERE item->'nutrients'->>'proteinMg' IS NULL)::integer AS protein_missing,
    coalesce(sum((item->'nutrients'->>'fatMg')::integer) FILTER (WHERE item->'nutrients'->>'fatMg' IS NOT NULL), 0)::integer AS fat_known,
    count(*) FILTER (WHERE item->'nutrients'->>'fatMg' IS NULL)::integer AS fat_missing,
    coalesce(sum((item->'nutrients'->>'fiberMg')::integer) FILTER (WHERE item->'nutrients'->>'fiberMg' IS NOT NULL), 0)::integer AS fiber_known,
    count(*) FILTER (WHERE item->'nutrients'->>'fiberMg' IS NULL)::integer AS fiber_missing
  FROM jsonb_array_elements("calculation_snapshot"."input_snapshot"->'mealItems') AS item
) AS evidence;--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ALTER COLUMN "nutrient_evidence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_snapshot" ADD CONSTRAINT "calculation_snapshot_nutrient_evidence_check" CHECK (
  jsonb_typeof("nutrient_evidence") = 'object'
  AND "nutrient_evidence" ?& array['energyMillicalories', 'carbohydrateMg', 'proteinMg', 'fatMg', 'fiberMg']
);
