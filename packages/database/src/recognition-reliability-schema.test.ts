import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  recognitionAttempts,
  recognitionExecutions,
  recognitionProviderInvocations,
  schemaCapabilities,
} from './schema/meal';

const migrationPath = join(import.meta.dir, '..', 'drizzle', '0024_recognition_reliability.sql');
const validationScriptPath = join(import.meta.dir, '..', 'scripts', 'validate-recognition-reliability.ts');

async function migrationSql() {
  return readFile(migrationPath, 'utf8');
}

describe('recognition reliability schema', () => {
  test('keeps the attempt aggregate legacy-safe and lease-compatible', async () => {
    const sql = await migrationSql();

    expect(sql).toContain('ADD COLUMN "protocol_version" "recognition_protocol_version" DEFAULT \'legacy_v1\' NOT NULL');
    expect(sql).toContain('ADD COLUMN "next_execution_ordinal" integer DEFAULT 1 NOT NULL');
    expect(sql).toContain('ADD COLUMN "user_grant_state" "recognition_user_grant_state" DEFAULT \'available\' NOT NULL');
    expect(sql).toContain('DROP CONSTRAINT "recognition_attempt_counts_check"');
    expect(sql).toContain('"attempt_count" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0');
    expect(sql).not.toContain('DROP CONSTRAINT "recognition_attempt_lease_check"');
    expect(sql).toContain('recognition workflow binding is immutable');
    expect(sql).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|UPDATE)\s+"?(?:stored_observation|recognition_attempt)"?/i);
    expect(recognitionAttempts.mealLogId.name).toBe('meal_log_id');
    expect(recognitionAttempts.imageAssetId.name).toBe('image_asset_id');
  });

  test('models initial and user-recovery grant transitions as distinct immutable paths', async () => {
    const sql = await migrationSql();

    expect(sql).toContain("'initial', 'automatic_lease_recovery', 'user_recovery'");
    expect(sql).toContain('recognition user recovery requires its reserved grant');
    expect(sql).toContain('reserved recognition user grant must be consumed');
    expect(sql).toContain('consumed recognition user grant cannot be restored');
    expect(sql).toContain('recognition user grant execution binding is immutable');
    expect(sql).toContain('recognition execution ordinal was not reserved');
    expect(sql).toContain('recognition automatic execution counter was not reserved');
    expect(recognitionExecutions.executionOrdinal.name).toBe('execution_ordinal');
    expect(recognitionAttempts.userGrantExecutionId.name).toBe('user_grant_execution_id');
  });

  test('makes execution and invocation reservations unique and terminal records immutable', async () => {
    const sql = await migrationSql();

    expect(sql).toContain('recognition_execution_workflow_ordinal_unique');
    expect(sql).toContain('recognition_provider_invocation_execution_ordinal_unique');
    expect(sql).toContain('recognition_provider_invocation_workflow_ordinal_unique');
    expect(sql).toContain('"invocation_ordinal" = 1 AND "workflow_invocation_ordinal" > 0');
    expect(sql).toContain('terminal recognition execution is immutable');
    expect(sql).toContain('terminal recognition provider invocation is immutable');
    expect(sql).toContain("'reserved', 'succeeded', 'failed_known', 'cancelled_before_call', 'outcome_unknown'");
    expect(sql).toContain("'EXECUTION_CANCELLED'");
    expect(sql).toContain('recognition automatic invocation counter was not reserved');
    expect(recognitionProviderInvocations.workflowInvocationOrdinal.name).toBe('workflow_invocation_ordinal');
  });

  test('admits a lease-free queued execution before an API worker claims it', async () => {
    const sql = await migrationSql();

    expect(sql).toContain(
      "CREATE TYPE \"recognition_execution_status\" AS ENUM ('queued', 'open', 'succeeded', 'failed', 'abandoned')",
    );
    expect(sql).toContain('"lease_token" uuid,');
    expect(sql).toContain(
      "\"status\" = 'queued' AND \"lease_token\" IS NULL",
    );
    expect(sql).toContain(
      "\"status\" = 'open' AND \"lease_token\" IS NOT NULL",
    );
    expect(sql).toContain(
      "WHERE \"status\" IN ('queued', 'open')",
    );
    expect(sql).toContain(
      "OLD.status = 'queued' AND NEW.status = 'open'",
    );
    expect(recognitionExecutions.leaseToken.notNull).toBe(false);
  });

  test('publishes the migration capability and a rollback-only isolated validation fixture', async () => {
    const [sql, validationScript] = await Promise.all([
      migrationSql(),
      readFile(validationScriptPath, 'utf8'),
    ]);

    expect(sql).toContain('INSERT INTO "schema_capability" ("name") VALUES (\'recognition_reliability_v2\')');
    expect(schemaCapabilities.name.name).toBe('name');
    expect(validationScript).toContain("target.environment !== 'isolated_neon_branch'");
    expect(validationScript).toContain('await client.begin');
    expect(validationScript).toContain('throw recognitionReliabilityValidationRollback');
    expect(validationScript).toContain('now() - interval \'1 minute\'');
    expect(validationScript).toContain('terminal execution mutation fixture unexpectedly succeeded');
    expect(validationScript).toContain('terminal invocation mutation fixture unexpectedly succeeded');
    expect(validationScript).toContain('user_grant_state = \'consumed\'');
    expect(validationScript).toContain("AND status = 'queued'");
    expect(validationScript).toContain("'recognition_daily_usage'");
    expect(validationScript).toContain("'cancelled_before_call', 'outcome_unknown'");
  });
});
