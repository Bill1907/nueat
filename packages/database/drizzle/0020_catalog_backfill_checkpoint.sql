CREATE TABLE "catalog_backfill_checkpoint" (
	"job_name" text NOT NULL,
	"catalog_release_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"last_id" uuid,
	"row_count" integer DEFAULT 0 NOT NULL,
	"rolling_sha256" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_backfill_checkpoint_unique" UNIQUE("job_name","catalog_release_id","phase"),
	CONSTRAINT "catalog_backfill_checkpoint_job_check" CHECK (length(trim("catalog_backfill_checkpoint"."job_name")) > 0),
	CONSTRAINT "catalog_backfill_checkpoint_phase_check" CHECK (length(trim("catalog_backfill_checkpoint"."phase")) > 0),
	CONSTRAINT "catalog_backfill_checkpoint_count_check" CHECK ("catalog_backfill_checkpoint"."row_count" >= 0),
	CONSTRAINT "catalog_backfill_checkpoint_hash_check" CHECK ("catalog_backfill_checkpoint"."rolling_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_backfill_checkpoint_status_check" CHECK (("catalog_backfill_checkpoint"."status" = 'running' and "catalog_backfill_checkpoint"."completed_at" is null) or ("catalog_backfill_checkpoint"."status" = 'complete' and "catalog_backfill_checkpoint"."completed_at" is not null))
);--> statement-breakpoint
ALTER TABLE "catalog_backfill_checkpoint" ADD CONSTRAINT "catalog_backfill_checkpoint_catalog_release_id_catalog_release_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_backfill_checkpoint_release_idx" ON "catalog_backfill_checkpoint" USING btree ("catalog_release_id","phase");
