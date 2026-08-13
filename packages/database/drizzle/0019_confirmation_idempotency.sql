ALTER TABLE "calculation_snapshot"
  ADD COLUMN "confirmation_idempotency_key" text,
  ADD COLUMN "confirmation_fingerprint" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "calculation_snapshot_confirmation_idempotency_unique"
  ON "calculation_snapshot" USING btree ("meal_log_id", "confirmation_idempotency_key")
  WHERE "confirmation_idempotency_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "calculation_snapshot"
  ADD CONSTRAINT "calculation_snapshot_confirmation_idempotency_check"
  CHECK (
    ("confirmation_idempotency_key" IS NULL AND "confirmation_fingerprint" IS NULL)
    OR ("confirmation_idempotency_key" IS NOT NULL AND "confirmation_fingerprint" IS NOT NULL)
  );
