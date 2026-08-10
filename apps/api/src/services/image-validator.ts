import { createHash } from 'node:crypto';

import sharp from 'sharp';

const MAX_LONG_EDGE_PX = 1_600;
const MAX_INPUT_PIXELS = 40_000_000;

const CONTENT_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export interface ValidatedImage {
  detectedContentType: (typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES];
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

export async function validateMealImage(
  bytes: Uint8Array,
  declaredContentType: string,
): Promise<ValidatedImage> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    metadata = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new ImageValidationError('UNDECODABLE_IMAGE');
  }

  const detectedContentType =
    metadata.format &&
    CONTENT_TYPES[metadata.format as keyof typeof CONTENT_TYPES];
  if (!detectedContentType)
    throw new ImageValidationError('UNSUPPORTED_IMAGE_FORMAT');
  if (detectedContentType !== declaredContentType) {
    throw new ImageValidationError('CONTENT_TYPE_MISMATCH');
  }
  if (!metadata.width || !metadata.height)
    throw new ImageValidationError('MISSING_DIMENSIONS');
  if (Math.max(metadata.width, metadata.height) > MAX_LONG_EDGE_PX) {
    throw new ImageValidationError('IMAGE_DIMENSIONS_TOO_LARGE');
  }
  if (metadata.exif) throw new ImageValidationError('IMAGE_METADATA_PRESENT');

  return {
    detectedContentType,
    byteSize: bytes.byteLength,
    width: metadata.width,
    height: metadata.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export class ImageValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
