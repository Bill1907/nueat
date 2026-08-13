ALTER TABLE "meal_item" DROP CONSTRAINT "meal_item_revision_check";
--> statement-breakpoint
ALTER TABLE "meal_item"
  DROP COLUMN "food_acknowledged_revision",
  DROP COLUMN "portion_acknowledged_revision";
--> statement-breakpoint
ALTER TABLE "meal_item"
  ADD CONSTRAINT "meal_item_revision_check"
  CHECK (
    "item_revision" > 0
    AND "food_revision" > 0
    AND "portion_revision" > 0
  );
