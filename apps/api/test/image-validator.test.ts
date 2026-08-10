import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import {
  ImageValidationError,
  validateMealImage,
} from '../src/services/image-validator';

describe('meal image validation', () => {
  test('accepts a decodable metadata-free image and returns trace data', async () => {
    const bytes = await sharp({
      create: { width: 100, height: 80, channels: 3, background: '#16794A' },
    })
      .jpeg()
      .toBuffer();

    const result = await validateMealImage(bytes, 'image/jpeg');

    expect(result).toMatchObject({
      detectedContentType: 'image/jpeg',
      byteSize: bytes.byteLength,
      width: 100,
      height: 80,
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('accepts normalized orientation and dimension EXIF without private fields', async () => {
    const bytes = await sharp({
      create: { width: 100, height: 80, channels: 3, background: '#16794A' },
    })
      .jpeg()
      .withMetadata({ orientation: 1 })
      .toBuffer();

    await expect(validateMealImage(bytes, 'image/jpeg')).resolves.toMatchObject(
      {
        width: 100,
        height: 80,
      },
    );
  });

  test('rejects retained descriptive EXIF fields', async () => {
    const bytes = await sharp({
      create: { width: 100, height: 80, channels: 3, background: '#16794A' },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'private metadata' } } })
      .toBuffer();

    await expect(validateMealImage(bytes, 'image/jpeg')).rejects.toMatchObject({
      code: 'IMAGE_METADATA_PRESENT',
    });
  });

  test('rejects declared content types that differ from decoded bytes', async () => {
    const bytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    await expect(validateMealImage(bytes, 'image/jpeg')).rejects.toMatchObject({
      code: 'CONTENT_TYPE_MISMATCH',
    });
  });

  test('rejects images whose long edge exceeds the upload contract', async () => {
    const bytes = await sharp({
      create: { width: 1_601, height: 10, channels: 3, background: '#ffffff' },
    })
      .webp()
      .toBuffer();

    await expect(validateMealImage(bytes, 'image/webp')).rejects.toMatchObject({
      code: 'IMAGE_DIMENSIONS_TOO_LARGE',
    });
  });

  test('rejects undecodable payloads', async () => {
    await expect(
      validateMealImage(new TextEncoder().encode('not an image'), 'image/jpeg'),
    ).rejects.toBeInstanceOf(ImageValidationError);
  });
});
