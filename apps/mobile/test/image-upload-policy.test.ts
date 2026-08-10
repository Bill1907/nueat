import { describe, expect, test } from 'bun:test';

import {
  fitWithinLongEdge,
  isUploadDraftExpired,
  LOCAL_UPLOAD_DRAFT_MAX_AGE_MS,
  uploadProgress,
} from '../src/uploads/image-upload-policy';

describe('mobile image upload policy', () => {
  test('preserves small images and scales the long edge to 1600px', () => {
    expect(fitWithinLongEdge(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithinLongEdge(4032, 3024)).toEqual({
      width: 1600,
      height: 1200,
    });
    expect(fitWithinLongEdge(3024, 4032)).toEqual({
      width: 1200,
      height: 1600,
    });
  });

  test('rejects invalid source dimensions', () => {
    expect(() => fitWithinLongEdge(0, 100)).toThrow('이미지 크기');
    expect(() => fitWithinLongEdge(Number.NaN, 100)).toThrow('이미지 크기');
  });

  test('clamps upload progress to a safe display range', () => {
    expect(uploadProgress(50, 100)).toBe(0.5);
    expect(uploadProgress(-1, 100)).toBe(0);
    expect(uploadProgress(200, 100)).toBe(1);
    expect(uploadProgress(10, 0)).toBe(0);
  });

  test('expires local drafts after 24 hours and rejects invalid timestamps', () => {
    const now = Date.parse('2026-08-10T12:00:00.000Z');
    expect(isUploadDraftExpired('2026-08-09T12:00:00.001Z', now)).toBe(false);
    expect(
      isUploadDraftExpired(
        new Date(now - LOCAL_UPLOAD_DRAFT_MAX_AGE_MS).toISOString(),
        now,
      ),
    ).toBe(true);
    expect(isUploadDraftExpired('invalid', now)).toBe(true);
  });
});
