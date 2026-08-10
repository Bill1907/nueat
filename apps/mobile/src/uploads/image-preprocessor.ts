import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImagePickerAsset } from 'expo-image-picker';

import {
  persistLocalUploadDraft,
  type LocalImageUploadDraft,
} from '@/uploads/image-upload-draft';
import {
  fitWithinLongEdge,
  IMAGE_MAX_BYTES,
} from '@/uploads/image-upload-policy';

const COMPRESSION_ATTEMPTS = [0.86, 0.72, 0.58] as const;

export async function prepareImageUploadDraft(
  asset: ImagePickerAsset,
  source: LocalImageUploadDraft['source'],
) {
  const dimensions = fitWithinLongEdge(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
    context.resize(dimensions);
  }
  const rendered = await context.renderAsync();
  let outputFile: File | null = null;

  try {
    for (const compress of COMPRESSION_ATTEMPTS) {
      if (outputFile?.exists) outputFile.delete();
      const result = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress,
      });
      outputFile = new File(result.uri);
      if (outputFile.size <= IMAGE_MAX_BYTES) {
        return await persistLocalUploadDraft({
          cacheUri: outputFile.uri,
          byteSize: outputFile.size,
          width: result.width,
          height: result.height,
          source,
        });
      }
    }
    throw new Error(
      '이미지를 10MB 이하로 줄이지 못했습니다. 다른 사진을 선택해 주세요.',
    );
  } finally {
    if (outputFile?.exists) outputFile.delete();
  }
}
