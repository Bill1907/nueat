import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const NEON_CONTROL_PLANE_URL = 'https://console.neon.tech/api/v2';
export const NEON_GUARD_CONTRACT_VERSION = 'neon-control-plane-v2-guard-v1';
export const VERIFIED_DATABASE_TARGET_MARKER = NEON_GUARD_CONTRACT_VERSION;

const REQUEST_TIMEOUT_MS = 2_000;
const TOTAL_TIMEOUT_MS = 5_000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;

type DatabaseEnvironment = 'isolated_neon_branch' | 'production';

type GuardInput = {
  databaseUrl: string;
  apiKey: string;
  projectId: string;
  branchId: string;
  productionProjectId: string;
  productionBranchId: string;
  isolatedBranchIds: readonly string[];
  environment: DatabaseEnvironment;
  productionOverride?: {
    token: string;
    actor: string;
    changeReference: string;
  };
};

type NeonEndpoint = {
  id: string;
  host: string;
  project_id: string;
  branch_id: string;
  type: string;
  current_state: string;
  pending_state?: unknown;
  disabled?: unknown;
};

export type ProductionMigrationAudit = Readonly<{
  projectId: string;
  branchId: string;
  endpointId: string;
  actor: string;
  changeReference: string;
  contractVersion: typeof NEON_GUARD_CONTRACT_VERSION;
  overrideTokenSha256: string;
}>;

export type VerifiedDatabaseTarget = Readonly<{
  databaseUrl: string;
  projectId: string;
  branchId: string;
  endpointId: string;
  environment: DatabaseEnvironment;
  contractVersion: typeof NEON_GUARD_CONTRACT_VERSION;
  productionAudit?: ProductionMigrationAudit;
}>;

export type GuardDependencies = Readonly<{
  fetch?: typeof fetch;
}>;

export function redactDatabaseUrl(_databaseUrl: string): string {
  return '[redacted database url]';
}

function fail(): never {
  throw new Error('Database target verification failed');
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value) return fail();
  return value;
}

function id(value: string): string {
  if (!idPattern.test(value)) return fail();
  return value;
}

function parseAllowlist(value: string, productionBranchId: string): string[] {
  const entries = value.split(',');
  if (entries.length === 0 || entries.some((entry) => !idPattern.test(entry))) return fail();
  const unique = new Set(entries);
  if (unique.size !== entries.length || unique.has(productionBranchId)) return fail();
  return entries;
}

function parseEnvironment(value: string): DatabaseEnvironment {
  if (value === 'isolated_neon_branch' || value === 'production') return value;
  return fail();
}

function parseDirectNeonUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  const host = normalizedHost(url.hostname);
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    url.hash ||
    !url.username ||
    !url.password ||
    !host.endsWith('.neon.tech') ||
    host.includes('-pooler') ||
    isIP(host) ||
    host === 'localhost' ||
    url.hostname !== host
  ) return fail();
  return url;
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

export function parseGuardInput(env: Record<string, string | undefined> = process.env): GuardInput {
  const productionBranchId = id(required(env, 'NUEAT_PRODUCTION_NEON_BRANCH_ID'));
  const environment = parseEnvironment(required(env, 'NUEAT_DATABASE_ENVIRONMENT'));
  const input: GuardInput = {
    databaseUrl: required(env, 'DATABASE_URL'),
    apiKey: required(env, 'NEON_API_KEY'),
    projectId: id(required(env, 'NUEAT_NEON_PROJECT_ID')),
    branchId: id(required(env, 'NUEAT_NEON_BRANCH_ID')),
    productionProjectId: id(required(env, 'NUEAT_PRODUCTION_NEON_PROJECT_ID')),
    productionBranchId,
    isolatedBranchIds: parseAllowlist(required(env, 'NUEAT_ALLOWED_NEON_BRANCH_IDS'), productionBranchId),
    environment,
  };
  parseDirectNeonUrl(input.databaseUrl);
  if (environment === 'production') {
    input.productionOverride = {
      token: required(env, 'NUEAT_PRODUCTION_OVERRIDE_TOKEN'),
      actor: required(env, 'NUEAT_PRODUCTION_OVERRIDE_ACTOR'),
      changeReference: required(env, 'NUEAT_PRODUCTION_CHANGE_REFERENCE'),
    };
  }
  return input;
}

async function controlPlaneJson(fetcher: typeof fetch, apiKey: string, path: string): Promise<{ text: string; value: unknown }> {
  try {
    const response = await fetcher(`${NEON_CONTROL_PLANE_URL}${path}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || response.redirected) return fail();
    const text = await response.text();
    return { text, value: JSON.parse(text) };
  } catch {
    return fail();
  }
}

function branchIsReady(value: unknown, input: GuardInput): boolean {
  if (!value || typeof value !== 'object') return false;
  const branch = (value as { branch?: unknown }).branch;
  if (!branch || typeof branch !== 'object') return false;
  const record = branch as Record<string, unknown>;
  return record.id === input.branchId
    && record.project_id === input.projectId
    && record.current_state === 'ready'
    && (record.pending_state === null || record.pending_state === undefined);
}

function activeEndpoint(value: unknown, input: GuardInput): NeonEndpoint {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { endpoints?: unknown }).endpoints)) return fail();
  const endpoints = (value as { endpoints: unknown[] }).endpoints;
  const matchingEndpoints = endpoints.filter((endpoint) => {
    if (!endpoint || typeof endpoint !== 'object') return false;
    const record = endpoint as Record<string, unknown>;
    return record.project_id === input.projectId && record.branch_id === input.branchId;
  });
  if (matchingEndpoints.length !== 1) return fail();
  const endpoint = matchingEndpoints[0];
  if (!endpoint || typeof endpoint !== 'object') return fail();
  const record = endpoint as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.host !== 'string' ||
    record.project_id !== input.projectId ||
    record.branch_id !== input.branchId ||
    record.type !== 'read_write' ||
    record.current_state !== 'active' ||
    (record.pending_state !== null && record.pending_state !== undefined) ||
    record.disabled !== false
  ) return fail();
  const host = normalizedHost(record.host);
  if (!host || host !== record.host || !host.endsWith('.neon.tech') || host.includes('-pooler') || isIP(host)) return fail();
  return record as unknown as NeonEndpoint;
}

function productionAudit(input: GuardInput, endpointId: string): ProductionMigrationAudit {
  const override = input.productionOverride;
  if (!override) return fail();
  return {
    projectId: input.projectId,
    branchId: input.branchId,
    endpointId,
    actor: override.actor,
    changeReference: override.changeReference,
    contractVersion: NEON_GUARD_CONTRACT_VERSION,
    overrideTokenSha256: createHash('sha256').update(override.token).digest('hex'),
  };
}

async function withTotalTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Database target verification failed')), TOTAL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyDatabaseTarget(
  env: Record<string, string | undefined> = process.env,
  dependencies: GuardDependencies = {},
): Promise<VerifiedDatabaseTarget> {
  const input = parseGuardInput(env);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  if (!fetcher) return fail();
  return withTotalTimeout((async () => {
    const branch = await controlPlaneJson(fetcher, input.apiKey, `/projects/${input.projectId}/branches/${input.branchId}`);
    if (!branchIsReady(branch.value, input)) return fail();
    const first = await controlPlaneJson(fetcher, input.apiKey, `/projects/${input.projectId}/endpoints`);
    const second = await controlPlaneJson(fetcher, input.apiKey, `/projects/${input.projectId}/endpoints`);
    if (first.text !== second.text) return fail();
    const endpoint = activeEndpoint(first.value, input);
    if (normalizedHost(parseDirectNeonUrl(input.databaseUrl).hostname) !== normalizedHost(endpoint.host)) return fail();

    const isProductionPair = input.projectId === input.productionProjectId && input.branchId === input.productionBranchId;
    if (input.environment === 'isolated_neon_branch') {
      if (isProductionPair || !input.isolatedBranchIds.includes(input.branchId)) return fail();
      return Object.freeze({
        databaseUrl: input.databaseUrl,
        projectId: input.projectId,
        branchId: input.branchId,
        endpointId: endpoint.id,
        environment: input.environment,
        contractVersion: NEON_GUARD_CONTRACT_VERSION,
      });
    }
    if (!isProductionPair) return fail();
    return Object.freeze({
      databaseUrl: input.databaseUrl,
      projectId: input.projectId,
      branchId: input.branchId,
      endpointId: endpoint.id,
      environment: input.environment,
      contractVersion: NEON_GUARD_CONTRACT_VERSION,
      productionAudit: productionAudit(input, endpoint.id),
    });
  })());
}

const childSecretKeys = new Set([
  'DATABASE_URL',
  'NEON_API_KEY',
  'NUEAT_NEON_PROJECT_ID',
  'NUEAT_NEON_BRANCH_ID',
  'NUEAT_PRODUCTION_NEON_PROJECT_ID',
  'NUEAT_PRODUCTION_NEON_BRANCH_ID',
  'NUEAT_ALLOWED_NEON_BRANCH_IDS',
  'NUEAT_DATABASE_ENVIRONMENT',
  'NUEAT_PRODUCTION_OVERRIDE_TOKEN',
  'NUEAT_PRODUCTION_OVERRIDE_ACTOR',
  'NUEAT_PRODUCTION_CHANGE_REFERENCE',
  'NUEAT_VERIFIED_DATABASE_TARGET',
]);

export function guardedChildEnvironment(
  target: VerifiedDatabaseTarget,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !childSecretKeys.has(key)) childEnv[key] = value;
  }
  childEnv.DATABASE_URL = target.databaseUrl;
  childEnv.NUEAT_VERIFIED_DATABASE_TARGET = VERIFIED_DATABASE_TARGET_MARKER;
  return childEnv;
}
