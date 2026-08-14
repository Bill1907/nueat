import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { verifyDatabaseTarget } from '../src/migration-target-guard';

export const recognitionReliabilityValidationRollback = Symbol(
  'recognition-reliability-validation-rollback',
);

export type ValidationTransaction = Readonly<{
  unsafe(statement: string): Promise<unknown>;
}>;
export type ValidationClient = Readonly<{
  begin(callback: (transaction: ValidationTransaction) => Promise<never>): Promise<unknown>;
  end(options: { timeout: number }): Promise<void>;
}>;
export type RecognitionReliabilityValidationDependencies = Readonly<{
  verifyTarget: typeof verifyDatabaseTarget;
  createClient: (url: string) => ValidationClient;
  readMigration: () => Promise<string>;
}>;

const migrationPath = join(import.meta.dir, '..', 'drizzle', '0024_recognition_reliability.sql');

const fixtureAssertions = `
  DO $$
  DECLARE
    attempt_guard text;
    execution_guard text;
    invocation_guard text;
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM schema_capability WHERE name = 'recognition_reliability_v2'
    ) THEN
      RAISE EXCEPTION 'recognition reliability capability marker missing';
    END IF;

    IF (SELECT count(*) FROM pg_constraint WHERE conname IN (
      'recognition_execution_ordinal_check',
      'recognition_provider_invocation_ordinal_check',
      'recognition_attempt_lease_check',
      'recognition_attempt_user_grant_binding_check'
    )) <> 4 THEN
      RAISE EXCEPTION 'recognition reliability constraints missing';
    END IF;

    SELECT pg_get_functiondef('recognition_attempt_v2_guard()'::regprocedure) INTO attempt_guard;
    SELECT pg_get_functiondef('recognition_execution_guard()'::regprocedure) INTO execution_guard;
    SELECT pg_get_functiondef('recognition_provider_invocation_guard()'::regprocedure) INTO invocation_guard;

    -- Legacy defaults and immutable meal/image binding preserve existing observations.
    IF position('legacy_v1' IN attempt_guard) = 0
      OR position('workflow binding is immutable' IN attempt_guard) = 0
      OR position('reserved recognition user grant must be consumed' IN attempt_guard) = 0 THEN
      RAISE EXCEPTION 'legacy or grant fixture missing';
    END IF;

    -- Expired initial and user executions use distinct trigger/grant paths.
    IF position('automatic_execution_count' IN execution_guard) = 0
      OR position('user_recovery' IN execution_guard) = 0
      OR position('user recovery requires its reserved grant' IN execution_guard) = 0 THEN
      RAISE EXCEPTION 'execution recovery fixture missing';
    END IF;

    -- Reserved, succeeded, cancelled and absent-call convergence is represented by the closed terminal set.
    IF position('terminal recognition provider invocation is immutable' IN invocation_guard) = 0
      OR position('automatic_invocation_reservation_count' IN invocation_guard) = 0
      OR NOT EXISTS (
        SELECT 1 FROM pg_type type
        JOIN pg_enum value ON value.enumtypid = type.oid
        WHERE type.typname = 'recognition_provider_invocation_status'
          AND value.enumlabel IN ('reserved', 'succeeded', 'cancelled_before_call', 'outcome_unknown')
        GROUP BY type.oid HAVING count(*) = 4
      ) THEN
      RAISE EXCEPTION 'provider invocation convergence fixture missing';
    END IF;

    -- Daily quota has one row per user/day, so competing upserts serialize on its primary key.
    IF NOT EXISTS (
      SELECT 1 FROM pg_index index
      JOIN pg_class relation ON relation.oid = index.indrelid
      WHERE relation.relname = 'recognition_daily_usage' AND index.indisprimary
    ) THEN
      RAISE EXCEPTION 'daily quota concurrency fixture missing';
    END IF;
  END;
  $$;
`;

const stateFixtures = `
  INSERT INTO "user" ("id", "name", "email")
  VALUES (
    'recognition-reliability-fixture-user',
    'recognition-reliability-fixture',
    concat('recognition-reliability-fixture-user', chr(64), 'invalid')
  );

  INSERT INTO "image_asset" (
    "id", "user_id", "purpose", "bucket_name", "object_key", "declared_content_type", "expires_at"
  ) VALUES (
    '00000000-0000-0000-0000-000000000101',
    'recognition-reliability-fixture-user',
    'inference',
    'recognition-reliability-fixture',
    'recognition-reliability-fixture-object',
    'image/jpeg',
    now() + interval '1 hour'
  );

  INSERT INTO "meal_log" (
    "id", "user_id", "eaten_at", "eaten_timezone", "eaten_local_date", "meal_type", "image_asset_id"
  ) VALUES (
    '00000000-0000-0000-0000-000000000102',
    'recognition-reliability-fixture-user',
    now(),
    'UTC',
    current_date,
    'snack',
    '00000000-0000-0000-0000-000000000101'
  );

  -- The first row exercises legacy defaults before its one-way V2 reservation.
  INSERT INTO "recognition_attempt" ("id", "meal_log_id", "image_asset_id")
  VALUES (
    '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000101'
  );

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM "recognition_attempt"
      WHERE id = '00000000-0000-0000-0000-000000000103'
        AND protocol_version = 'legacy_v1'
        AND next_execution_ordinal = 1
        AND user_grant_state = 'available'
        AND user_grant_execution_id IS NULL
    ) THEN
      RAISE EXCEPTION 'legacy defaults fixture failed';
    END IF;
  END;
  $$;

  UPDATE "recognition_attempt"
  SET protocol_version = 'v2_option_b',
      next_execution_ordinal = 2,
      automatic_execution_count = 1,
      user_grant_state = 'reserved',
      user_grant_execution_id = '00000000-0000-0000-0000-000000000105'
  WHERE id = '00000000-0000-0000-0000-000000000103';

  -- Expired initial and user-recovery executions have separate reservation paths.
  INSERT INTO "recognition_execution" (
    "id", "workflow_id", "execution_ordinal", "trigger", "wall_deadline_at", "lease_token"
  ) VALUES (
    '00000000-0000-0000-0000-000000000104',
    '00000000-0000-0000-0000-000000000103',
    1,
    'initial',
    now() - interval '1 minute',
    '00000000-0000-0000-0000-000000000201'
  );

  UPDATE "recognition_attempt"
  SET next_execution_ordinal = 3
  WHERE id = '00000000-0000-0000-0000-000000000103';

  INSERT INTO "recognition_execution" (
    "id", "workflow_id", "execution_ordinal", "trigger", "wall_deadline_at", "lease_token"
  ) VALUES (
    '00000000-0000-0000-0000-000000000105',
    '00000000-0000-0000-0000-000000000103',
    2,
    'user_recovery',
    now() - interval '1 minute',
    '00000000-0000-0000-0000-000000000202'
  );

  UPDATE "recognition_attempt"
  SET user_grant_state = 'consumed',
      automatic_invocation_reservation_count = 1
  WHERE id = '00000000-0000-0000-0000-000000000103';

  -- Reserved then cancelled-before-call convergence for the initial execution.
  INSERT INTO "recognition_provider_invocation" (
    "id", "workflow_id", "execution_id", "invocation_ordinal", "workflow_invocation_ordinal",
    "provider", "model", "prompt_version", "schema_version"
  ) VALUES (
    '00000000-0000-0000-0000-000000000106',
    '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000104',
    1, 1, 'mock', 'fixture', 'fixture', 'fixture'
  );

  UPDATE "recognition_provider_invocation"
  SET status = 'cancelled_before_call',
      terminal_code = 'PROVIDER_REQUEST_TIMEOUT',
      completed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000106';

  UPDATE "recognition_execution"
  SET status = 'failed',
      terminal_code = 'PROVIDER_REQUEST_TIMEOUT',
      completed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000104';

  DO $$
  BEGIN
    BEGIN
      UPDATE "recognition_execution"
      SET phase = 'reconciliation'
      WHERE id = '00000000-0000-0000-0000-000000000104';
      RAISE EXCEPTION 'terminal execution mutation fixture unexpectedly succeeded';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM = 'terminal execution mutation fixture unexpectedly succeeded' THEN
        RAISE;
      END IF;
    END;

    BEGIN
      UPDATE "recognition_provider_invocation"
      SET model = 'mutated'
      WHERE id = '00000000-0000-0000-0000-000000000106';
      RAISE EXCEPTION 'terminal invocation mutation fixture unexpectedly succeeded';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM = 'terminal invocation mutation fixture unexpectedly succeeded' THEN
        RAISE;
      END IF;
    END;
  END;
  $$;

  -- A user-grant invocation converges to succeeded without consuming automatic quota.
  INSERT INTO "recognition_provider_invocation" (
    "id", "workflow_id", "execution_id", "invocation_ordinal", "workflow_invocation_ordinal",
    "provider", "model", "prompt_version", "schema_version"
  ) VALUES (
    '00000000-0000-0000-0000-000000000107',
    '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000105',
    1, 2, 'mock', 'fixture', 'fixture', 'fixture'
  );

  UPDATE "recognition_provider_invocation"
  SET status = 'succeeded', completed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000107';

  -- An automatic lease-recovery reservation records an absent provider outcome.
  UPDATE "recognition_attempt"
  SET next_execution_ordinal = 4,
      automatic_execution_count = 2,
      automatic_invocation_reservation_count = 2
  WHERE id = '00000000-0000-0000-0000-000000000103';

  INSERT INTO "recognition_execution" (
    "id", "workflow_id", "execution_ordinal", "trigger", "wall_deadline_at", "lease_token"
  ) VALUES (
    '00000000-0000-0000-0000-000000000108',
    '00000000-0000-0000-0000-000000000103',
    3,
    'automatic_lease_recovery',
    now() - interval '1 minute',
    '00000000-0000-0000-0000-000000000203'
  );

  INSERT INTO "recognition_provider_invocation" (
    "id", "workflow_id", "execution_id", "invocation_ordinal", "workflow_invocation_ordinal",
    "provider", "model", "prompt_version", "schema_version"
  ) VALUES (
    '00000000-0000-0000-0000-000000000109',
    '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000108',
    1, 3, 'mock', 'fixture', 'fixture', 'fixture'
  );

  UPDATE "recognition_provider_invocation"
  SET status = 'outcome_unknown',
      terminal_code = 'PROCESS_OUTCOME_UNKNOWN',
      completed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000109';

  -- Existing recognition_attempt lease semantics continue to accept claim and release.
  UPDATE "recognition_attempt"
  SET status = 'processing',
      lease_token = '00000000-0000-0000-0000-000000000204',
      lease_expires_at = now() + interval '1 minute'
  WHERE id = '00000000-0000-0000-0000-000000000103';
  UPDATE "recognition_attempt"
  SET status = 'pending', lease_token = NULL, lease_expires_at = NULL
  WHERE id = '00000000-0000-0000-0000-000000000103';

  -- The primary key is the daily quota serialization point for concurrent upserts.
  INSERT INTO "recognition_daily_usage" ("user_id", "attempt_date", "attempt_count")
  VALUES ('recognition-reliability-fixture-user', current_date, 1)
  ON CONFLICT ("user_id", "attempt_date")
  DO UPDATE SET "attempt_count" = "recognition_daily_usage"."attempt_count" + 1;
`;

const defaultDependencies: RecognitionReliabilityValidationDependencies = {
  verifyTarget: verifyDatabaseTarget,
  createClient: (url) => {
    const client = postgres(url, { max: 1 });
    return {
      begin: (callback) => client.begin((transaction) => callback(transaction)),
      end: (options) => client.end(options),
    };
  },
  readMigration: () => readFile(migrationPath, 'utf8'),
};

export async function validateRecognitionReliability(
  env: Record<string, string | undefined> = process.env,
  dependencies: RecognitionReliabilityValidationDependencies = defaultDependencies,
): Promise<void> {
  const target = await dependencies.verifyTarget(env);
  if (target.environment !== 'isolated_neon_branch') {
    throw new Error('Recognition reliability validation requires an isolated database target');
  }

  const migration = await dependencies.readMigration();
  const client = dependencies.createClient(target.databaseUrl);
  try {
    await client.begin(async (transaction) => {
      await transaction.unsafe(
        'CREATE TEMP TABLE recognition_reliability_observation_count AS SELECT count(*) AS count FROM stored_observation',
      );
      await transaction.unsafe(migration);
      await transaction.unsafe(stateFixtures);
      await transaction.unsafe(fixtureAssertions);
      await transaction.unsafe(`
        DO $$
        BEGIN
          IF (SELECT count(*) FROM stored_observation)
            <> (SELECT count FROM recognition_reliability_observation_count) THEN
            RAISE EXCEPTION 'recognition migration rewrote observations';
          END IF;
        END;
        $$;
      `);
      throw recognitionReliabilityValidationRollback;
    });
  } catch (error) {
    if (error !== recognitionReliabilityValidationRollback) throw error;
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  validateRecognitionReliability().catch(() => {
    console.error('Recognition reliability validation failed');
    process.exitCode = 1;
  });
}
