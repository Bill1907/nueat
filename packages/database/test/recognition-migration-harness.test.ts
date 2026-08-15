import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  recognitionMigrationHarnessRollback,
  runRecognitionMigrationHarness,
} from './recognition-migration-harness';

describe('recognition migration harness', () => {
  test('applies a real 0023 fixture before 0024 under bounded rollback-only SQL', async () => {
    const statements: string[] = [];
    const migration = await readFile(
      join(import.meta.dir, '..', 'drizzle', '0024_recognition_reliability.sql'),
      'utf8',
    );

    await expect(runRecognitionMigrationHarness({
      async unsafe(sql) {
        statements.push(sql);
      },
    }, migration)).rejects.toBe(recognitionMigrationHarnessRollback);

    expect(statements[0]).toContain("lock_timeout = '5s'");
    expect(statements[1]).toContain("statement_timeout = '30s'");
    expect(statements[2]).toContain('INSERT INTO "meal_log"');
    expect(statements[3]).toBe(migration);
    expect(statements[4]).toContain("recognition_reliability_v2");
    expect(statements[4]).toContain('0023 meal fixture changed');
  });
});
