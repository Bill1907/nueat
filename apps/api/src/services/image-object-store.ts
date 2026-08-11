import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ImageObject {
  bytes: Uint8Array;
  contentType: string | undefined;
  byteSize: number;
}

export interface ImageObjectStore {
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    byteSize: number;
    expiresInSeconds: number;
  }): Promise<string>;
  createDownloadUrl(input: {
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<string>;
  readObject(input: {
    objectKey: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<ImageObject>;
  deleteObject(objectKey: string): Promise<void>;
}

export interface S3ImageObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function createS3ImageObjectStore(
  config: S3ImageObjectStoreConfig,
): ImageObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async createUploadUrl(input) {
      try {
        return await getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: input.objectKey,
            ContentType: input.contentType,
            ContentLength: input.byteSize,
          }),
          { expiresIn: input.expiresInSeconds },
        );
      } catch {
        throw new ImageObjectStoreError();
      }
    },

    async createDownloadUrl(input) {
      try {
        return await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: config.bucket, Key: input.objectKey }),
          { expiresIn: input.expiresInSeconds },
        );
      } catch {
        throw new ImageObjectStoreError();
      }
    },

    async readObject(input) {
      let head;
      try {
        head = await client.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: input.objectKey,
          }),
          input.signal ? { abortSignal: input.signal } : undefined,
        );
      } catch (error) {
        if (input.signal?.aborted) throw new ImageObjectReadAbortedError();
        if (isNotFound(error)) throw new ImageObjectNotFoundError();
        throw new ImageObjectStoreError();
      }

      const byteSize = head.ContentLength;
      if (byteSize === undefined)
        throw new Error('Image object has no content length');
      if (byteSize > input.maxBytes) throw new ImageObjectTooLargeError();

      let response;
      try {
        response = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: input.objectKey }),
          input.signal ? { abortSignal: input.signal } : undefined,
        );
      } catch (error) {
        if (input.signal?.aborted) throw new ImageObjectReadAbortedError();
        if (isNotFound(error)) throw new ImageObjectNotFoundError();
        throw new ImageObjectStoreError();
      }
      if (!response.Body) throw new ImageObjectNotFoundError();
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;
      try {
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          if (input.signal?.aborted) throw new ImageObjectReadAbortedError();
          receivedBytes += chunk.byteLength;
          if (receivedBytes > input.maxBytes) throw new ImageObjectTooLargeError();
          chunks.push(chunk);
        }
      } catch (error) {
        if (
          error instanceof ImageObjectTooLargeError ||
          error instanceof ImageObjectReadAbortedError
        )
          throw error;
        if (input.signal?.aborted) throw new ImageObjectReadAbortedError();
        throw new ImageObjectStoreError();
      }
      if (receivedBytes !== byteSize) throw new ImageObjectStoreError();
      const bytes = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return { bytes, contentType: head.ContentType, byteSize };
    },

    async deleteObject(objectKey) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }),
        );
      } catch {
        throw new ImageObjectStoreError();
      }
    },
  };
}

export class ImageObjectNotFoundError extends Error {}
export class ImageObjectTooLargeError extends Error {}
export class ImageObjectStoreError extends Error {}
export class ImageObjectReadAbortedError extends Error {}

function isNotFound(error: unknown) {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
