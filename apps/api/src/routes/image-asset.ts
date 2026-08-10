import { assetDeletionJobs, imageAssets, type Database } from '@nueat/database';
import { and, eq } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Auth } from '../auth/auth';
import type { ApiEnvironment } from '../config/env';
import {
  ImageObjectNotFoundError,
  ImageObjectTooLargeError,
  type ImageObjectStore,
} from '../services/image-object-store';
import {
  ImageValidationError,
  validateMealImage,
} from '../services/image-validator';

const UPLOAD_RECORD_TTL_MS = 60 * 60 * 1_000;
const VALIDATED_INFERENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

const uploadIntentSchema = z
  .object({
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    byteSize: z.int().positive(),
  })
  .strict();

const assetIdParamsSchema = z.object({ assetId: z.uuid() });

interface ImageAssetRouteOptions {
  auth: Auth;
  database: Database;
  environment: ApiEnvironment;
  objectStore: ImageObjectStore | null;
}

export const imageAssetRoutes: FastifyPluginAsync<
  ImageAssetRouteOptions
> = async (app, options) => {
  app.post('/api/image-assets/upload-intents', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const imageBucket = options.environment.imageBucket;
    const objectStore = options.objectStore;
    if (!imageBucket || !objectStore) return serviceUnavailable(reply, request);

    const parsed = uploadIntentSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.byteSize > imageBucket.maxBytes) {
      return invalidRequest(
        reply,
        request,
        '이미지는 10MB 이하의 JPEG, PNG, WebP만 업로드할 수 있습니다.',
      );
    }

    const assetId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + UPLOAD_RECORD_TTL_MS);
    const objectKey = createObjectKey(assetId, parsed.data.contentType, now);

    await options.database.insert(imageAssets).values({
      id: assetId,
      userId,
      purpose: 'inference',
      bucketName: imageBucket.bucket,
      objectKey,
      status: 'pending_upload',
      declaredContentType: parsed.data.contentType,
      byteSize: parsed.data.byteSize,
      expiresAt,
    });

    try {
      const uploadUrl = await objectStore.createUploadUrl({
        objectKey,
        contentType: parsed.data.contentType,
        byteSize: parsed.data.byteSize,
        expiresInSeconds: imageBucket.uploadUrlTtlSeconds,
      });

      return reply.status(201).send({
        assetId,
        uploadUrl,
        method: 'PUT',
        expectedByteSize: parsed.data.byteSize,
        expiresAt: new Date(
          now.getTime() + imageBucket.uploadUrlTtlSeconds * 1_000,
        ),
        requiredHeaders: {
          'Content-Type': parsed.data.contentType,
        },
      });
    } catch (error) {
      await options.database
        .update(imageAssets)
        .set({ status: 'rejected' })
        .where(
          and(eq(imageAssets.id, assetId), eq(imageAssets.userId, userId)),
        );
      throw error;
    }
  });

  app.post('/api/image-assets/:assetId/complete', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const imageBucket = options.environment.imageBucket;
    const objectStore = options.objectStore;
    if (!imageBucket || !objectStore) return serviceUnavailable(reply, request);
    const parsedParams = assetIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply, request);

    const asset = await findOwnedAsset(
      options.database,
      parsedParams.data.assetId,
      userId,
    );
    if (!asset) return assetNotFound(reply, request);
    if (asset.status === 'validated') return validatedAssetResponse(asset);
    if (asset.status !== 'pending_upload')
      return invalidAssetState(reply, request);

    try {
      const object = await objectStore.readObject({
        objectKey: asset.objectKey,
        maxBytes: imageBucket.maxBytes,
      });
      if (
        object.byteSize !== asset.byteSize ||
        object.contentType !== asset.declaredContentType
      ) {
        throw new ImageValidationError('UPLOAD_CONTRACT_MISMATCH');
      }
      const validated = await validateMealImage(
        object.bytes,
        asset.declaredContentType,
      );
      const now = new Date();
      const expiresAt = new Date(now.getTime() + VALIDATED_INFERENCE_TTL_MS);

      const [updated] = await options.database
        .update(imageAssets)
        .set({
          status: 'validated',
          detectedContentType: validated.detectedContentType,
          byteSize: validated.byteSize,
          pixelWidth: validated.width,
          pixelHeight: validated.height,
          sha256: validated.sha256,
          uploadedAt: now,
          validatedAt: now,
          expiresAt,
        })
        .where(
          and(
            eq(imageAssets.id, asset.id),
            eq(imageAssets.userId, userId),
            eq(imageAssets.status, 'pending_upload'),
          ),
        )
        .returning({ id: imageAssets.id });
      if (!updated) return invalidAssetState(reply, request);

      return {
        assetId: asset.id,
        status: 'validated' as const,
        contentType: validated.detectedContentType,
        byteSize: validated.byteSize,
        width: validated.width,
        height: validated.height,
        expiresAt,
      };
    } catch (error) {
      if (!isExpectedUploadFailure(error)) throw error;
      await rejectAndDeleteAsset(
        options,
        objectStore,
        asset.id,
        userId,
        asset.objectKey,
        request,
      );
      return reply.status(422).send({
        error: {
          code: 'IMAGE_VALIDATION_FAILED',
          message: imageValidationMessage(error),
          requestId: request.id,
        },
      });
    }
  });

  app.get('/api/image-assets/:assetId', async (request, reply) => {
    const userId = await requireUserId(request, reply, options.auth);
    if (!userId) return;
    const parsedParams = assetIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply, request);

    const asset = await findOwnedAsset(
      options.database,
      parsedParams.data.assetId,
      userId,
    );
    if (!asset) return assetNotFound(reply, request);
    return assetResponse(asset);
  });

  app.post(
    '/api/image-assets/:assetId/download-intent',
    async (request, reply) => {
      const userId = await requireUserId(request, reply, options.auth);
      if (!userId) return;
      const imageBucket = options.environment.imageBucket;
      const objectStore = options.objectStore;
      if (!imageBucket || !objectStore)
        return serviceUnavailable(reply, request);
      const parsedParams = assetIdParamsSchema.safeParse(request.params);
      if (!parsedParams.success) return invalidRequest(reply, request);

      const asset = await findOwnedAsset(
        options.database,
        parsedParams.data.assetId,
        userId,
      );
      if (!asset) return assetNotFound(reply, request);
      if (!['validated', 'processing', 'processed'].includes(asset.status)) {
        return invalidAssetState(reply, request);
      }

      const downloadUrl = await objectStore.createDownloadUrl({
        objectKey: asset.objectKey,
        expiresInSeconds: imageBucket.downloadUrlTtlSeconds,
      });
      return {
        assetId: asset.id,
        downloadUrl,
        expiresAt: new Date(
          Date.now() + imageBucket.downloadUrlTtlSeconds * 1_000,
        ),
      };
    },
  );
};

async function findOwnedAsset(
  database: Database,
  assetId: string,
  userId: string,
) {
  const [asset] = await database
    .select({
      id: imageAssets.id,
      objectKey: imageAssets.objectKey,
      status: imageAssets.status,
      declaredContentType: imageAssets.declaredContentType,
      detectedContentType: imageAssets.detectedContentType,
      byteSize: imageAssets.byteSize,
      pixelWidth: imageAssets.pixelWidth,
      pixelHeight: imageAssets.pixelHeight,
      expiresAt: imageAssets.expiresAt,
      uploadedAt: imageAssets.uploadedAt,
      validatedAt: imageAssets.validatedAt,
    })
    .from(imageAssets)
    .where(and(eq(imageAssets.id, assetId), eq(imageAssets.userId, userId)))
    .limit(1);
  return asset;
}

async function requireUserId(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: Auth,
) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (session) return session.user.id;
  reply.status(401).send({
    error: {
      code: 'UNAUTHORIZED',
      message: '로그인이 필요합니다.',
      requestId: request.id,
    },
  });
  return null;
}

async function rejectAndDeleteAsset(
  options: ImageAssetRouteOptions,
  objectStore: ImageObjectStore,
  assetId: string,
  userId: string,
  objectKey: string,
  request: FastifyRequest,
) {
  await options.database
    .update(imageAssets)
    .set({ status: 'rejected' })
    .where(and(eq(imageAssets.id, assetId), eq(imageAssets.userId, userId)));
  try {
    await objectStore.deleteObject(objectKey);
  } catch {
    const now = new Date();
    await options.database.transaction(async (tx) => {
      await tx
        .update(imageAssets)
        .set({ status: 'deletion_pending', deletionRequestedAt: now })
        .where(
          and(eq(imageAssets.id, assetId), eq(imageAssets.userId, userId)),
        );
      await tx
        .insert(assetDeletionJobs)
        .values({
          imageAssetId: assetId,
          status: 'pending',
          nextAttemptAt: now,
        })
        .onConflictDoNothing();
    });
    request.log.warn({ assetId }, 'Rejected image object deletion was queued');
  }
}

function validatedAssetResponse(
  asset: NonNullable<Awaited<ReturnType<typeof findOwnedAsset>>>,
) {
  return {
    assetId: asset.id,
    status: 'validated' as const,
    contentType: asset.detectedContentType,
    byteSize: asset.byteSize,
    width: asset.pixelWidth,
    height: asset.pixelHeight,
    expiresAt: asset.expiresAt,
  };
}

function assetResponse(
  asset: NonNullable<Awaited<ReturnType<typeof findOwnedAsset>>>,
) {
  return {
    assetId: asset.id,
    status: asset.status,
    declaredContentType: asset.declaredContentType,
    detectedContentType: asset.detectedContentType,
    byteSize: asset.byteSize,
    width: asset.pixelWidth,
    height: asset.pixelHeight,
    expiresAt: asset.expiresAt,
    uploadedAt: asset.uploadedAt,
    validatedAt: asset.validatedAt,
  };
}

function createObjectKey(
  assetId: string,
  contentType: (typeof ALLOWED_CONTENT_TYPES)[number],
  now: Date,
) {
  const extension =
    contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `inference/${year}/${month}/${day}/${assetId}.${extension}`;
}

function isExpectedUploadFailure(error: unknown) {
  return (
    error instanceof ImageValidationError ||
    error instanceof ImageObjectNotFoundError ||
    error instanceof ImageObjectTooLargeError
  );
}

function imageValidationMessage(error: unknown) {
  if (error instanceof ImageObjectNotFoundError)
    return '업로드된 이미지를 찾을 수 없습니다.';
  if (error instanceof ImageObjectTooLargeError)
    return '이미지 크기가 허용 범위를 초과했습니다.';
  return '이미지 형식, 크기 또는 메타데이터를 확인해 주세요.';
}

function invalidRequest(
  reply: FastifyReply,
  request: FastifyRequest,
  message = '요청 형식이 올바르지 않습니다.',
) {
  return reply.status(400).send({
    error: { code: 'INVALID_REQUEST', message, requestId: request.id },
  });
}

function assetNotFound(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(404).send({
    error: {
      code: 'IMAGE_ASSET_NOT_FOUND',
      message: '이미지를 찾을 수 없습니다.',
      requestId: request.id,
    },
  });
}

function invalidAssetState(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(409).send({
    error: {
      code: 'INVALID_IMAGE_ASSET_STATE',
      message: '현재 이미지 상태에서는 요청을 처리할 수 없습니다.',
      requestId: request.id,
    },
  });
}
function serviceUnavailable(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(503).send({
    error: {
      code: 'IMAGE_STORAGE_UNAVAILABLE',
      message: '이미지 저장소가 아직 구성되지 않았습니다.',
      requestId: request.id,
    },
  });
}
