import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from '@nueat/database';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import type { Auth } from '../src/auth/auth';
import { parseEnvironment } from '../src/config/env';
import type { ImageObjectStore } from '../src/services/image-object-store';
import { buildServer } from '../src/server';

const environment = parseEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api-nueat.boseong.dev',
  RESEND_API_KEY: 're_test',
  TRUSTED_ORIGINS: 'nueat://,https://nueat.boseong.dev',
  S3_ENDPOINT: 'https://storage.railway.app',
  S3_BUCKET: 'nueat-test',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
});

const environmentWithoutBucket = parseEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:password@example.com/nueat?sslmode=require',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://api-nueat.boseong.dev',
  RESEND_API_KEY: 're_test',
  TRUSTED_ORIGINS: 'nueat://,https://nueat.boseong.dev',
});

const openServers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe('image asset routes', () => {
  test('rejects unauthenticated upload intents', async () => {
    const { server } = await createTestServer({ authenticated: false });

    const response = await server.inject({
      method: 'POST',
      url: '/api/image-assets/upload-intents',
      payload: { contentType: 'image/jpeg', byteSize: 1000 },
    });

    expect(response.statusCode).toBe(401);
  });

  test('returns a stable unavailable response until Railway Bucket variables are linked', async () => {
    const { server, state } = await createTestServer({
      authenticated: true,
      bucketConfigured: false,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/image-assets/upload-intents',
      payload: { contentType: 'image/jpeg', byteSize: 1000 },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe(
      'IMAGE_STORAGE_UNAVAILABLE',
    );
    expect(state.asset).toBeUndefined();
  });

  test('creates an opaque five-minute upload contract without exposing the object key', async () => {
    const { server, state, storeCalls } = await createTestServer({
      authenticated: true,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/image-assets/upload-intents',
      payload: { contentType: 'image/jpeg', byteSize: 1000 },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({
      method: 'PUT',
      uploadUrl: 'https://signed.example/upload',
      requiredHeaders: { 'Content-Type': 'image/jpeg' },
      expectedByteSize: 1000,
    });
    expect(body.objectKey).toBeUndefined();
    expect(body.bucketName).toBeUndefined();
    expect(state.asset?.objectKey).toMatch(
      /^inference\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9-]+\.jpg$/,
    );
    expect(state.asset?.objectKey).not.toContain('user-id');
    expect(storeCalls.uploads).toHaveLength(1);
  });

  test('rejects unsupported and oversized upload declarations before persistence', async () => {
    const { server, state } = await createTestServer({ authenticated: true });

    const unsupported = await server.inject({
      method: 'POST',
      url: '/api/image-assets/upload-intents',
      payload: { contentType: 'image/gif', byteSize: 1000 },
    });
    const oversized = await server.inject({
      method: 'POST',
      url: '/api/image-assets/upload-intents',
      payload: { contentType: 'image/jpeg', byteSize: 10_000_001 },
    });

    expect(unsupported.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(state.asset).toBeUndefined();
  });

  test('validates uploaded bytes and persists only server-derived image facts', async () => {
    const bytes = await createJpeg();
    const asset = pendingAsset(bytes.byteLength);
    const { server, state } = await createTestServer({
      authenticated: true,
      asset,
      object: { bytes, contentType: 'image/jpeg', byteSize: bytes.byteLength },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/image-assets/${asset.id}/complete`,
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      assetId: asset.id,
      status: 'validated',
      contentType: 'image/jpeg',
      width: 120,
      height: 80,
    });
    expect(state.asset).toMatchObject({
      status: 'validated',
      detectedContentType: 'image/jpeg',
      pixelWidth: 120,
      pixelHeight: 80,
    });
    expect(state.asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('deletes rejected objects and never validates a contract mismatch', async () => {
    const bytes = await createJpeg();
    const asset = pendingAsset(bytes.byteLength + 1);
    const { server, state, storeCalls } = await createTestServer({
      authenticated: true,
      asset,
      object: { bytes, contentType: 'image/jpeg', byteSize: bytes.byteLength },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/image-assets/${asset.id}/complete`,
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).error.code).toBe(
      'IMAGE_VALIDATION_FAILED',
    );
    expect(state.asset?.status).toBe('rejected');
    expect(storeCalls.deletions).toEqual([asset.objectKey]);
  });

  test('issues short-lived downloads only for validated owner assets', async () => {
    const asset = {
      ...pendingAsset(1000),
      status: 'validated',
      detectedContentType: 'image/jpeg',
      pixelWidth: 120,
      pixelHeight: 80,
    };
    const { server, storeCalls } = await createTestServer({
      authenticated: true,
      asset,
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/image-assets/${asset.id}/download-intent`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      assetId: asset.id,
      downloadUrl: 'https://signed.example/download',
    });
    expect(storeCalls.downloads).toEqual([asset.objectKey]);
  });

  test('blocks download signing before server validation', async () => {
    const asset = pendingAsset(1000);
    const { server, storeCalls } = await createTestServer({
      authenticated: true,
      asset,
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/image-assets/${asset.id}/download-intent`,
    });

    expect(response.statusCode).toBe(409);
    expect(storeCalls.downloads).toHaveLength(0);
  });

  test('does not reveal assets that are outside the authenticated owner query', async () => {
    const { server } = await createTestServer({ authenticated: true });

    const response = await server.inject({
      method: 'GET',
      url: '/api/image-assets/00000000-0000-4000-8000-000000000001',
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('IMAGE_ASSET_NOT_FOUND');
  });
});

interface AssetState {
  id: string;
  userId: string;
  objectKey: string;
  status: string;
  declaredContentType: string;
  detectedContentType: string | null;
  byteSize: number;
  pixelWidth: number | null;
  pixelHeight: number | null;
  sha256: string | null;
  expiresAt: Date;
  uploadedAt: Date | null;
  validatedAt: Date | null;
}

async function createTestServer({
  authenticated,
  asset,
  object,
  bucketConfigured = true,
}: {
  authenticated: boolean;
  asset?: AssetState;
  object?: { bytes: Uint8Array; contentType: string; byteSize: number };
  bucketConfigured?: boolean;
}) {
  const state: { asset: AssetState | undefined } = { asset };
  const storeCalls = {
    uploads: [] as string[],
    downloads: [] as string[],
    deletions: [] as string[],
  };
  const objectStore: ImageObjectStore = {
    async createUploadUrl(input) {
      storeCalls.uploads.push(input.objectKey);
      return 'https://signed.example/upload';
    },
    async createDownloadUrl(input) {
      storeCalls.downloads.push(input.objectKey);
      return 'https://signed.example/download';
    },
    async readObject() {
      if (!object) throw new Error('Test object was not configured');
      return object;
    },
    async deleteObject(objectKey) {
      storeCalls.deletions.push(objectKey);
    },
  };
  const auth = {
    api: {
      getSession: async () =>
        authenticated
          ? { user: { id: 'user-id', email: 'user@example.com' }, session: {} }
          : null,
    },
  } as unknown as Auth;
  const database = createDatabaseMock(state);
  const server = await buildServer({
    environment: bucketConfigured ? environment : environmentWithoutBucket,
    database,
    auth,
    imageObjectStore: objectStore,
  });
  openServers.push(server);
  return { server, state, storeCalls };
}

function createDatabaseMock(state: { asset: AssetState | undefined }) {
  return {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        state.asset = {
          id: values.id as string,
          userId: values.userId as string,
          objectKey: values.objectKey as string,
          status: values.status as string,
          declaredContentType: values.declaredContentType as string,
          detectedContentType: null,
          byteSize: values.byteSize as number,
          pixelWidth: null,
          pixelHeight: null,
          sha256: null,
          expiresAt: values.expiresAt as Date,
          uploadedAt: null,
          validatedAt: null,
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (state.asset ? [state.asset] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<AssetState>) => ({
        where: () => updateQuery(state, values),
      }),
    }),
  } as unknown as Database;
}

function updateQuery(
  state: { asset: AssetState | undefined },
  values: Partial<AssetState>,
) {
  const apply = () => {
    if (state.asset) Object.assign(state.asset, values);
  };
  return {
    returning: async () => {
      apply();
      return state.asset ? [{ id: state.asset.id }] : [];
    },
    then<TResult1 = undefined, TResult2 = never>(
      onfulfilled?:
        | ((value: undefined) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ) {
      apply();
      return Promise.resolve(undefined).then(onfulfilled, onrejected);
    },
  };
}

function pendingAsset(byteSize: number): AssetState {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    userId: 'user-id',
    objectKey: 'inference/2026/08/10/asset.jpg',
    status: 'pending_upload',
    declaredContentType: 'image/jpeg',
    detectedContentType: null,
    byteSize,
    pixelWidth: null,
    pixelHeight: null,
    sha256: null,
    expiresAt: new Date(Date.now() + 60_000),
    uploadedAt: null,
    validatedAt: null,
  };
}

async function createJpeg() {
  return sharp({
    create: { width: 120, height: 80, channels: 3, background: '#16794A' },
  })
    .jpeg()
    .toBuffer();
}
