import { describe, expect, test } from 'bun:test';
import type { VerifiedDatabaseTarget } from './migration-target-guard';
import {
  recognitionReliabilityValidationRollback,
  validateRecognitionReliability,
  type RecognitionReliabilityValidationDependencies,
  type ValidationClient,
  type ValidationTransaction,
} from '../scripts/validate-recognition-reliability';

const isolatedTarget: VerifiedDatabaseTarget = {
  databaseUrl: 'postgresql://fixture:fixture@fixture.neon.tech/fixture',
  projectId: 'fixture-project',
  branchId: 'fixture-isolated-branch',
  endpointId: 'fixture-endpoint',
  environment: 'isolated_neon_branch',
  contractVersion: 'neon-control-plane-v2-guard-v1',
};

function dependencies(
  target: VerifiedDatabaseTarget,
  statements: string[],
  rollbacks: unknown[],
  closed: { value: boolean },
) {
  const transaction: Pick<ValidationTransaction, 'unsafe'> = {
    unsafe: async (statement: string) => {
      statements.push(statement);
      return [] as never;
    },
  };
  const client: Pick<ValidationClient, 'begin' | 'end'> = {
    begin: async (callback: (transaction: ValidationTransaction) => Promise<never>) => {
      try {
        await callback(transaction as ValidationTransaction);
      } catch (error) {
        rollbacks.push(error);
        throw error;
      }
      return [] as never;
    },
    end: async () => {
      closed.value = true;
    },
  };
  return {
    verifyTarget: async () => target,
    createClient: () => client as ValidationClient,
    readMigration: async () => 'CREATE TABLE recognition_reliability_fixture ();',
  } satisfies RecognitionReliabilityValidationDependencies;
}

describe('recognition reliability isolated validator', () => {
  test('imports, validates through a transaction, and rolls back its fixture transaction', async () => {
    const statements: string[] = [];
    const rollbacks: unknown[] = [];
    const closed = { value: false };

    await validateRecognitionReliability({}, dependencies(isolatedTarget, statements, rollbacks, closed));

    expect(statements).toHaveLength(5);
    expect(statements[1]).toBe('CREATE TABLE recognition_reliability_fixture ();');
    expect(statements[2]).toContain('legacy defaults fixture failed');
    expect(statements[3]).toContain('recognition reliability capability marker missing');
    expect(statements[4]).toContain('recognition migration rewrote observations');
    expect(rollbacks).toEqual([recognitionReliabilityValidationRollback]);
    expect(closed.value).toBe(true);
  });

  test('rejects production before opening a client or reading migration SQL', async () => {
    const productionTarget: VerifiedDatabaseTarget = {
      ...isolatedTarget,
      environment: 'production',
      productionAudit: {
        projectId: 'fixture-project',
        branchId: 'fixture-isolated-branch',
        endpointId: 'fixture-endpoint',
        actor: 'fixture-actor',
        changeReference: 'fixture-change',
        contractVersion: 'neon-control-plane-v2-guard-v1',
        overrideTokenSha256: 'fixture-hash',
      },
    };
    let clientOpened = false;
    let migrationRead = false;

    await expect(validateRecognitionReliability({}, {
      verifyTarget: async () => productionTarget,
      createClient: () => {
        clientOpened = true;
        throw new Error('must not open client');
      },
      readMigration: async () => {
        migrationRead = true;
        return '';
      },
    })).rejects.toThrow('requires an isolated database target');

    expect(clientOpened).toBe(false);
    expect(migrationRead).toBe(false);
  });
});
