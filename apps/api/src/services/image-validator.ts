import { createHash } from 'node:crypto';

import sharp from 'sharp';
import exifReader from 'exif-reader';

const MAX_LONG_EDGE_PX = 1_600;
const MAX_INPUT_PIXELS = 40_000_000;

const CONTENT_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;
const ALLOWED_IMAGE_EXIF_FIELDS = new Set([
  'Orientation',
  'XResolution',
  'YResolution',
  'ResolutionUnit',
  'YCbCrPositioning',
  'ExifTag',
]);
const ALLOWED_PHOTO_EXIF_FIELDS = new Set([
  'ExifVersion',
  'ComponentsConfiguration',
  'FlashpixVersion',
  'ColorSpace',
  'PixelXDimension',
  'PixelYDimension',
]);

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
  if (metadata.exif && containsSensitiveExif(metadata.exif)) {
    throw new ImageValidationError('IMAGE_METADATA_PRESENT');
  }

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
function containsSensitiveExif(buffer: Buffer) {
  try {
    const parsed = exifReader(buffer);
    if (parsed.GPSInfo || parsed.Iop || parsed.Thumbnail) return true;
    return (
      hasUnexpectedFields(parsed.Image, ALLOWED_IMAGE_EXIF_FIELDS) ||
      hasUnexpectedFields(parsed.Photo, ALLOWED_PHOTO_EXIF_FIELDS)
    );
  } catch {
    return true;
  }
}

function hasUnexpectedFields(
  fields: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
) {
  return fields
    ? Object.keys(fields).some((field) => !allowed.has(field))
    : false;
}
