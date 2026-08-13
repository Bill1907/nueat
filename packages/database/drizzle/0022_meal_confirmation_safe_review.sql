ALTER TABLE "meal_item"
  ADD COLUMN "reviewed_item_revision" integer,
  ADD COLUMN "reviewed_authority_fingerprint_version" text,
  ADD COLUMN "reviewed_authority_fingerprint" text,
  ADD COLUMN "review_idempotency_key" text,
  ADD COLUMN "review_request_fingerprint" text,
  ADD COLUMN "reviewed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "meal_item" AS "item"
SET
  "food_acknowledged_revision" = NULL,
  "portion_acknowledged_revision" = NULL
FROM "meal_log" AS "meal"
WHERE "item"."meal_log_id" = "meal"."id"
  AND "meal"."status" = 'draft';
--> statement-breakpoint
ALTER TABLE "meal_item"
  ADD CONSTRAINT "meal_item_review_checkpoint_check"
  CHECK (
    (
      "reviewed_item_revision" IS NULL
      AND "reviewed_authority_fingerprint_version" IS NULL
      AND "reviewed_authority_fingerprint" IS NULL
      AND "review_idempotency_key" IS NULL
      AND "review_request_fingerprint" IS NULL
      AND "reviewed_at" IS NULL
    )
    OR (
      "reviewed_item_revision" IS NOT NULL
      AND "reviewed_authority_fingerprint_version" IS NOT NULL
      AND "reviewed_authority_fingerprint" IS NOT NULL
      AND "review_idempotency_key" IS NOT NULL
      AND "review_request_fingerprint" IS NOT NULL
      AND "reviewed_at" IS NOT NULL
      AND "reviewed_item_revision" = "item_revision"
      AND "reviewed_item_revision" > 0
      AND length(trim("reviewed_authority_fingerprint_version")) > 0
      AND "reviewed_authority_fingerprint" ~ '^[0-9a-f]{64}$'
      AND length(trim("review_idempotency_key")) > 0
      AND "review_request_fingerprint" ~ '^[0-9a-f]{64}$'
    )
  );
--> statement-breakpoint
CREATE FUNCTION "meal_log_confirmed_review_checkpoint_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'confirmed'
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'confirmed')
    AND (
      NOT EXISTS (
        SELECT 1
        FROM "meal_item"
        WHERE "meal_log_id" = NEW."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "meal_item"
        WHERE "meal_log_id" = NEW."id"
          AND (
            "reviewed_item_revision" IS NULL
            OR "reviewed_authority_fingerprint_version" IS NULL
            OR "reviewed_authority_fingerprint" IS NULL
            OR "review_idempotency_key" IS NULL
            OR "review_request_fingerprint" IS NULL
            OR "reviewed_at" IS NULL
          )
      )
    )
  THEN
    RAISE EXCEPTION 'Confirmed meal logs require non-empty review checkpoints for every item.';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "meal_log_confirmed_review_checkpoint_guard"
BEFORE INSERT OR UPDATE OF "status" ON "meal_log"
FOR EACH ROW
EXECUTE FUNCTION "meal_log_confirmed_review_checkpoint_guard"();
