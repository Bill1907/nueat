import { recognition0023FixtureSql } from './fixtures/recognition-0023';

export const recognitionMigrationHarnessRollback = Symbol(
  'recognition-migration-harness-rollback',
);

export interface RecognitionMigrationHarnessTransaction {
  unsafe(sql: string): Promise<unknown>;
}

/**
 * Runs the real 0023 fixture and 0024 SQL in one rollback-only transaction.
 * The caller owns BEGIN/ROLLBACK so no production state can survive this helper.
 */
export async function runRecognitionMigrationHarness(
  transaction: RecognitionMigrationHarnessTransaction,
  migrationSql: string,
) {
  await transaction.unsafe("SET LOCAL lock_timeout = '5s'");
  await transaction.unsafe("SET LOCAL statement_timeout = '30s'");
  await transaction.unsafe(recognition0023FixtureSql);
  await transaction.unsafe(migrationSql);
  await transaction.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "schema_capability"
    WHERE "name" = 'recognition_reliability_v2'
  ) THEN
    RAISE EXCEPTION 'recognition capability fixture missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "meal_log"
    WHERE "id" = '00000000-0000-4000-8000-000000002303'
      AND "status" = 'draft'
      AND "recognition_status" = 'manual'
  ) THEN
    RAISE EXCEPTION '0023 meal fixture changed during additive migration';
  END IF;
END;
$$;
`);
  throw recognitionMigrationHarnessRollback;
}
