export const IMAGE_MAX_LONG_EDGE = 1_600;
export const IMAGE_MAX_BYTES = 10_000_000;
export const LOCAL_UPLOAD_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

export function fitWithinLongEdge(
  width: number,
  height: number,
  maxLongEdge = IMAGE_MAX_LONG_EDGE,
): ImageDimensions {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('이미지 크기 정보가 올바르지 않습니다.');
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge)
    return { width: Math.round(width), height: Math.round(height) };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function uploadProgress(bytesSent: number, totalBytes: number) {
  if (totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, bytesSent / totalBytes));
}

export function isUploadDraftExpired(createdAt: string, now = Date.now()) {
  const timestamp = Date.parse(createdAt);
  return (
    !Number.isFinite(timestamp) ||
    now - timestamp >= LOCAL_UPLOAD_DRAFT_MAX_AGE_MS
  );
}
