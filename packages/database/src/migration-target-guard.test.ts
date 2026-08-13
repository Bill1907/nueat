import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  guardedChildEnvironment,
  verifyDatabaseTarget,
  type VerifiedDatabaseTarget,
} from './migration-target-guard';
import { runMigration } from '../scripts/migrate';

const directUrl = 'postgresql://user:secret@ep-test-123.aws.neon.tech/nueat?sslmode=require';
const baseEnv = (): Record<string, string> => ({
  DATABASE_URL: directUrl,
  NEON_API_KEY: 'metadata-key',
  NUEAT_NEON_PROJECT_ID: 'project-isolated',
  NUEAT_NEON_BRANCH_ID: 'branch-isolated',
  NUEAT_PRODUCTION_NEON_PROJECT_ID: 'project-production',
  NUEAT_PRODUCTION_NEON_BRANCH_ID: 'branch-production',
  NUEAT_ALLOWED_NEON_BRANCH_IDS: 'branch-isolated',
  NUEAT_DATABASE_ENVIRONMENT: 'isolated_neon_branch',
});

const branch = {
  branch: {
    id: 'branch-isolated',
    project_id: 'project-isolated',
    current_state: 'ready',
    pending_state: null,
  },
};
const endpointRecord = {
  id: 'endpoint-123',
  host: 'ep-test-123.aws.neon.tech',
  project_id: 'project-isolated',
  branch_id: 'branch-isolated',
  type: 'read_write',
  current_state: 'active',
  pending_state: null,
  disabled: false,
};
const endpoint = {
  endpoints: [endpointRecord],
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function neonFetch(
  options: { branch?: unknown; firstEndpoint?: unknown; secondEndpoint?: unknown; failAt?: number } = {},
): typeof fetch {
  let request = 0;
  return (async () => {
    request += 1;
    if (options.failAt === request) throw new Error('network failure');
    if (request === 1) return jsonResponse(options.branch ?? branch);
    if (request === 2) return jsonResponse(options.firstEndpoint ?? endpoint);
    return jsonResponse(options.secondEndpoint ?? endpoint);
  }) as unknown as typeof fetch;
}

describe('Neon migration target guard', () => {
  test('verifies a matching isolated branch without exposing its URL', async () => {
    const target = await verifyDatabaseTarget(baseEnv(), { fetch: neonFetch() });
    expect(target).toMatchObject({
      projectId: 'project-isolated',
      branchId: 'branch-isolated',
      endpointId: 'endpoint-123',
      environment: 'isolated_neon_branch',
    });
  });

  test('rejects a production pair mislabeled as isolated', async () => {
    const env = baseEnv();
    env.NUEAT_NEON_PROJECT_ID = 'project-production';
    env.NUEAT_NEON_BRANCH_ID = 'branch-production';
    env.DATABASE_URL = directUrl;
    await expect(verifyDatabaseTarget(env, {
      fetch: neonFetch({
        branch: { branch: { ...branch.branch, id: 'branch-production', project_id: 'project-production' } },
        firstEndpoint: { endpoints: [{ ...endpointRecord, branch_id: 'branch-production', project_id: 'project-production' }] },
        secondEndpoint: { endpoints: [{ ...endpointRecord, branch_id: 'branch-production', project_id: 'project-production' }] },
      }),
    })).rejects.toThrow('Database target verification failed');
  });

  test('rejects an isolated pair mislabeled as production', async () => {
    const env = baseEnv();
    env.NUEAT_DATABASE_ENVIRONMENT = 'production';
    env.NUEAT_PRODUCTION_OVERRIDE_TOKEN = 'one-job-token';
    env.NUEAT_PRODUCTION_OVERRIDE_ACTOR = 'operator';
    env.NUEAT_PRODUCTION_CHANGE_REFERENCE = 'change-123';
    await expect(verifyDatabaseTarget(env, { fetch: neonFetch() })).rejects.toThrow('Database target verification failed');
  });

  test('requires and redacts a production override', async () => {
    const env = baseEnv();
    env.NUEAT_NEON_PROJECT_ID = 'project-production';
    env.NUEAT_NEON_BRANCH_ID = 'branch-production';
    env.NUEAT_DATABASE_ENVIRONMENT = 'production';
    const productionBranch = { branch: { ...branch.branch, id: 'branch-production', project_id: 'project-production' } };
    const productionEndpoint = { endpoints: [{ ...endpointRecord, branch_id: 'branch-production', project_id: 'project-production' }] };
    const dependencies = { fetch: neonFetch({ branch: productionBranch, firstEndpoint: productionEndpoint, secondEndpoint: productionEndpoint }) };
    await expect(verifyDatabaseTarget(env, dependencies)).rejects.toThrow('Database target verification failed');
    env.NUEAT_PRODUCTION_OVERRIDE_TOKEN = 'one-job-token';
    env.NUEAT_PRODUCTION_OVERRIDE_ACTOR = 'operator';
    env.NUEAT_PRODUCTION_CHANGE_REFERENCE = 'change-123';
    const target = await verifyDatabaseTarget(env, dependencies);
    expect(target.productionAudit).toMatchObject({ actor: 'operator', changeReference: 'change-123' });
    expect(JSON.stringify(target.productionAudit)).not.toContain('one-job-token');
  });

  test('rejects host mismatch, endpoint rotation, and control-plane failure', async () => {
    const mismatch = { endpoints: [{ ...endpointRecord, host: 'ep-other.aws.neon.tech' }] };
    await expect(verifyDatabaseTarget(baseEnv(), { fetch: neonFetch({ firstEndpoint: mismatch, secondEndpoint: mismatch }) })).rejects.toThrow();
    await expect(verifyDatabaseTarget(baseEnv(), {
      fetch: neonFetch({ secondEndpoint: { endpoints: [{ ...endpointRecord, id: 'rotated-endpoint' }] } }),
    })).rejects.toThrow();
    await expect(verifyDatabaseTarget(baseEnv(), { fetch: neonFetch({ failAt: 2 }) })).rejects.toThrow();
  });

  test('propagates only the verified exact URL to the Drizzle child', async () => {
    const target: VerifiedDatabaseTarget = {
      databaseUrl: directUrl,
      projectId: 'project-isolated',
      branchId: 'branch-isolated',
      endpointId: 'endpoint-123',
      environment: 'isolated_neon_branch',
      contractVersion: 'neon-control-plane-v2-guard-v1',
    };
    const childEnv = guardedChildEnvironment(target, {
      ...baseEnv(),
      DATABASE_URL: 'postgresql://stale:secret@ep-stale.aws.neon.tech/nueat',
    });
    expect(childEnv.DATABASE_URL).toBe(directUrl);
    expect(childEnv.NEON_API_KEY).toBeUndefined();
    expect(childEnv.NUEAT_NEON_PROJECT_ID).toBeUndefined();

    let spawned = false;
    const fakeSpawn = ((_command: string, _args: string[], options: { env?: Record<string, string> }) => {
      spawned = true;
      expect(options.env?.DATABASE_URL).toBe(directUrl);
      const child = new EventEmitter() as EventEmitter & { once: EventEmitter['once'] };
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    await runMigration('bridge', baseEnv(), fakeSpawn, async () => target);
    expect(spawned).toBe(true);
  });

  test('does not spawn when target verification fails', async () => {
    let spawned = false;
    const fakeSpawn = (() => {
      spawned = true;
      return new EventEmitter();
    }) as unknown as typeof import('node:child_process').spawn;
    await expect(runMigration('bridge', baseEnv(), fakeSpawn, async () => {
      throw new Error('Database target verification failed');
    })).rejects.toThrow();
    expect(spawned).toBe(false);
  });
});
