CREATE TYPE "recognition_protocol_version" AS ENUM ('legacy_v1', 'v2_option_b');
--> statement-breakpoint
CREATE TYPE "recognition_user_grant_state" AS ENUM ('available', 'reserved', 'consumed');
--> statement-breakpoint
CREATE TYPE "recognition_execution_trigger" AS ENUM ('initial', 'automatic_lease_recovery', 'user_recovery');
--> statement-breakpoint
CREATE TYPE "recognition_execution_phase" AS ENUM ('claim', 'asset_read', 'asset_verify', 'invocation_reserve', 'provider_call', 'provider_output', 'observation_persist', 'resolution_handoff', 'response_delivery', 'reconciliation');
--> statement-breakpoint
CREATE TYPE "recognition_execution_status" AS ENUM ('open', 'succeeded', 'failed', 'abandoned');
--> statement-breakpoint
CREATE TYPE "recognition_provider_invocation_status" AS ENUM ('reserved', 'succeeded', 'failed_known', 'cancelled_before_call', 'outcome_unknown');
--> statement-breakpoint
CREATE TYPE "recognition_failure_code" AS ENUM ('DRAFT_INELIGIBLE', 'EXECUTION_LIMIT_REACHED', 'USER_RECOVERY_UNAVAILABLE', 'DAILY_QUOTA_RESERVED', 'DB_LOCK_TIMEOUT', 'DB_STATEMENT_TIMEOUT', 'DB_UNAVAILABLE', 'LEASE_LOST', 'ASSET_NOT_FOUND', 'ASSET_EXPIRED', 'ASSET_TOO_LARGE', 'ASSET_UNAVAILABLE', 'ASSET_READ_TIMEOUT', 'ASSET_MISMATCH', 'ASSET_TYPE_INVALID', 'PROVIDER_CALL_DEADLINE', 'PROVIDER_REQUEST_TIMEOUT', 'PROVIDER_CONFLICT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_CONNECTION_FAILED', 'PROVIDER_SERVER_ERROR', 'PROVIDER_REQUEST_INVALID', 'PROVIDER_AUTH_INVALID', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'PROVIDER_INCOMPLETE', 'INVALID_PROVIDER_RESPONSE', 'EXECUTION_DEADLINE', 'EXECUTION_CANCELLED', 'PERSISTENCE_UNAVAILABLE', 'DRAFT_STATE_LOST', 'COORDINATOR_INTERNAL', 'PROCESS_OUTCOME_UNKNOWN');
--> statement-breakpoint
ALTER TABLE "recognition_attempt"
  ADD COLUMN "protocol_version" "recognition_protocol_version" DEFAULT 'legacy_v1' NOT NULL,
  ADD COLUMN "next_execution_ordinal" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "automatic_execution_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "automatic_invocation_reservation_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "user_grant_state" "recognition_user_grant_state" DEFAULT 'available' NOT NULL,
  ADD COLUMN "user_grant_execution_id" uuid;
--> statement-breakpoint
ALTER TABLE "recognition_attempt"
  DROP CONSTRAINT "recognition_attempt_counts_check",
  ADD CONSTRAINT "recognition_attempt_option_b_reservation_ceiling_check"
  CHECK ("protocol_version" <> 'v2_option_b' OR "automatic_invocation_reservation_count" <= "automatic_execution_count"),
  ADD CONSTRAINT "recognition_attempt_user_grant_binding_check"
  CHECK (("user_grant_state" = 'available' AND "user_grant_execution_id" IS NULL)
    OR ("user_grant_state" IN ('reserved', 'consumed') AND "user_grant_execution_id" IS NOT NULL)),
  ADD CONSTRAINT "recognition_attempt_counts_check"
  CHECK ("attempt_count" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0
    AND "automatic_execution_count" >= 0 AND "automatic_invocation_reservation_count" >= 0
    AND "next_execution_ordinal" > 0);
--> statement-breakpoint
CREATE INDEX "recognition_attempt_protocol_status_idx" ON "recognition_attempt" USING btree ("protocol_version", "status");
--> statement-breakpoint
CREATE TABLE "recognition_execution" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "recognition_attempt"("id") ON DELETE cascade,
  "execution_ordinal" integer NOT NULL,
  "trigger" "recognition_execution_trigger" NOT NULL,
  "wall_deadline_at" timestamp with time zone NOT NULL,
  "lease_token" uuid NOT NULL,
  "phase" "recognition_execution_phase" DEFAULT 'claim' NOT NULL,
  "status" "recognition_execution_status" DEFAULT 'open' NOT NULL,
  "terminal_code" "recognition_failure_code",
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recognition_execution_ordinal_check" CHECK ("execution_ordinal" > 0),
  CONSTRAINT "recognition_execution_terminal_check" CHECK (
    ("status" = 'open' AND "completed_at" IS NULL AND "terminal_code" IS NULL)
    OR ("status" = 'succeeded' AND "completed_at" IS NOT NULL AND "terminal_code" IS NULL)
    OR ("status" IN ('failed', 'abandoned') AND "completed_at" IS NOT NULL AND "terminal_code" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recognition_execution_workflow_ordinal_unique" ON "recognition_execution" USING btree ("workflow_id", "execution_ordinal");
--> statement-breakpoint
CREATE INDEX "recognition_execution_open_deadline_idx" ON "recognition_execution" USING btree ("wall_deadline_at") WHERE "status" = 'open';
--> statement-breakpoint
CREATE TABLE "recognition_provider_invocation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "recognition_attempt"("id") ON DELETE cascade,
  "execution_id" uuid NOT NULL REFERENCES "recognition_execution"("id") ON DELETE cascade,
  "invocation_ordinal" integer NOT NULL,
  "workflow_invocation_ordinal" integer NOT NULL,
  "status" "recognition_provider_invocation_status" DEFAULT 'reserved' NOT NULL,
  "provider" "recognition_provider" NOT NULL,
  "model" text NOT NULL,
  "prompt_version" text NOT NULL,
  "schema_version" text NOT NULL,
  "terminal_code" "recognition_failure_code",
  "provider_acknowledged_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recognition_provider_invocation_ordinal_check" CHECK ("invocation_ordinal" = 1 AND "workflow_invocation_ordinal" > 0),
  CONSTRAINT "recognition_provider_invocation_terminal_check" CHECK (
    ("status" = 'reserved' AND "completed_at" IS NULL AND "terminal_code" IS NULL)
    OR ("status" = 'succeeded' AND "completed_at" IS NOT NULL AND "terminal_code" IS NULL)
    OR ("status" IN ('failed_known', 'cancelled_before_call', 'outcome_unknown') AND "completed_at" IS NOT NULL AND "terminal_code" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recognition_provider_invocation_execution_ordinal_unique" ON "recognition_provider_invocation" USING btree ("execution_id", "invocation_ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "recognition_provider_invocation_workflow_ordinal_unique" ON "recognition_provider_invocation" USING btree ("workflow_id", "workflow_invocation_ordinal");
--> statement-breakpoint
CREATE INDEX "recognition_provider_invocation_reserved_idx" ON "recognition_provider_invocation" USING btree ("created_at") WHERE "status" = 'reserved';
--> statement-breakpoint
CREATE TABLE "schema_capability" (
  "name" text PRIMARY KEY NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "schema_capability" ("name") VALUES ('recognition_reliability_v2');
--> statement-breakpoint
CREATE FUNCTION recognition_attempt_v2_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.meal_log_id IS DISTINCT FROM OLD.meal_log_id OR NEW.image_asset_id IS DISTINCT FROM OLD.image_asset_id THEN
    RAISE EXCEPTION 'recognition workflow binding is immutable';
  END IF;
  IF NEW.next_execution_ordinal < OLD.next_execution_ordinal
    OR NEW.automatic_execution_count < OLD.automatic_execution_count
    OR NEW.automatic_invocation_reservation_count < OLD.automatic_invocation_reservation_count THEN
    RAISE EXCEPTION 'recognition workflow counters cannot decrease';
  END IF;
  IF OLD.protocol_version = 'v2_option_b' AND NEW.protocol_version <> 'v2_option_b' THEN
    RAISE EXCEPTION 'recognition workflow protocol cannot downgrade';
  END IF;
  IF OLD.user_grant_state = 'consumed' AND NEW.user_grant_state <> 'consumed' THEN
    RAISE EXCEPTION 'consumed recognition user grant cannot be restored';
  END IF;
  IF OLD.user_grant_state = 'reserved' AND NEW.user_grant_state <> 'consumed' THEN
    RAISE EXCEPTION 'reserved recognition user grant must be consumed';
  END IF;
  IF OLD.user_grant_state IN ('reserved', 'consumed')
    AND NEW.user_grant_execution_id IS DISTINCT FROM OLD.user_grant_execution_id THEN
    RAISE EXCEPTION 'recognition user grant execution binding is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER recognition_attempt_v2_guard_trigger
  BEFORE UPDATE ON "recognition_attempt"
  FOR EACH ROW EXECUTE FUNCTION recognition_attempt_v2_guard();
--> statement-breakpoint
CREATE FUNCTION recognition_execution_guard() RETURNS trigger AS $$
DECLARE workflow "recognition_attempt"%ROWTYPE;
DECLARE automatic_execution_total integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'terminal recognition execution is immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
      OR NEW.execution_ordinal IS DISTINCT FROM OLD.execution_ordinal
      OR NEW.trigger IS DISTINCT FROM OLD.trigger
      OR NEW.wall_deadline_at IS DISTINCT FROM OLD.wall_deadline_at
      OR NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'recognition execution binding is immutable';
    END IF;
    IF NEW.status = 'open' THEN
      RETURN NEW;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO workflow FROM "recognition_attempt" WHERE id = NEW.workflow_id FOR KEY SHARE;
  IF NOT FOUND OR workflow.protocol_version <> 'v2_option_b' THEN
    RAISE EXCEPTION 'recognition execution requires a v2 workflow';
  END IF;
  IF NEW.execution_ordinal <> workflow.next_execution_ordinal - 1 THEN
    RAISE EXCEPTION 'recognition execution ordinal was not reserved';
  END IF;
  IF NEW.trigger <> 'user_recovery' THEN
    SELECT count(*) INTO automatic_execution_total
      FROM "recognition_execution"
      WHERE workflow_id = NEW.workflow_id AND trigger <> 'user_recovery';
    IF workflow.automatic_execution_count <> automatic_execution_total + 1 THEN
      RAISE EXCEPTION 'recognition automatic execution counter was not reserved';
    END IF;
  END IF;
  IF NEW.trigger = 'user_recovery'
    AND (workflow.user_grant_state <> 'reserved' OR workflow.user_grant_execution_id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'recognition user recovery requires its reserved grant';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER recognition_execution_guard_trigger
  BEFORE INSERT OR UPDATE ON "recognition_execution"
  FOR EACH ROW EXECUTE FUNCTION recognition_execution_guard();
--> statement-breakpoint
CREATE FUNCTION recognition_provider_invocation_guard() RETURNS trigger AS $$
DECLARE execution "recognition_execution"%ROWTYPE;
DECLARE workflow "recognition_attempt"%ROWTYPE;
DECLARE automatic_invocation_total integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'reserved' THEN
      RAISE EXCEPTION 'terminal recognition provider invocation is immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
      OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
      OR NEW.invocation_ordinal IS DISTINCT FROM OLD.invocation_ordinal
      OR NEW.workflow_invocation_ordinal IS DISTINCT FROM OLD.workflow_invocation_ordinal
      OR NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.model IS DISTINCT FROM OLD.model
      OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
      OR NEW.schema_version IS DISTINCT FROM OLD.schema_version THEN
      RAISE EXCEPTION 'recognition provider invocation reservation is immutable';
    END IF;
    IF NEW.status = 'reserved' THEN
      RETURN NEW;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO execution FROM "recognition_execution" WHERE id = NEW.execution_id FOR KEY SHARE;
  IF NOT FOUND OR execution.workflow_id IS DISTINCT FROM NEW.workflow_id OR execution.status <> 'open' THEN
    RAISE EXCEPTION 'recognition invocation must belong to an open execution workflow';
  END IF;
  IF execution.trigger <> 'user_recovery' THEN
    SELECT * INTO workflow FROM "recognition_attempt" WHERE id = NEW.workflow_id FOR KEY SHARE;
    SELECT count(*) INTO automatic_invocation_total
      FROM "recognition_provider_invocation" invocation
      JOIN "recognition_execution" invocation_execution ON invocation_execution.id = invocation.execution_id
      WHERE invocation.workflow_id = NEW.workflow_id
        AND invocation_execution.trigger <> 'user_recovery';
    IF workflow.automatic_invocation_reservation_count <> automatic_invocation_total + 1 THEN
      RAISE EXCEPTION 'recognition automatic invocation counter was not reserved';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER recognition_provider_invocation_guard_trigger
  BEFORE INSERT OR UPDATE ON "recognition_provider_invocation"
  FOR EACH ROW EXECUTE FUNCTION recognition_provider_invocation_guard();
