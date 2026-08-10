import { File, UploadType } from 'expo-file-system';

import { apiRequest } from '@/api/client';
import type { LocalImageUploadDraft } from '@/uploads/image-upload-draft';
import { uploadProgress } from '@/uploads/image-upload-policy';

interface UploadIntent {
  assetId: string;
  uploadUrl: string;
  method: 'PUT';
  expectedByteSize: number;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

export interface ValidatedImageAsset {
  assetId: string;
  status: 'validated';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  width: number;
  height: number;
  expiresAt: string;
}

export async function uploadImageDraft(
  draft: LocalImageUploadDraft,
  options: {
    signal: AbortSignal;
    onProgress: (progress: number) => void;
    onStage: (stage: 'uploading' | 'validating') => void;
  },
) {
  const file = new File(draft.fileUri);
  if (!file.exists || file.size !== draft.byteSize) {
    throw new ImageUploadError(
      '저장된 업로드 사진을 찾을 수 없습니다. 다시 선택해 주세요.',
    );
  }

  const intent = await apiRequest<UploadIntent>(
    '/api/image-assets/upload-intents',
    {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({
        contentType: draft.contentType,
        byteSize: file.size,
      }),
    },
  );
  if (intent.expectedByteSize !== file.size) {
    throw new ImageUploadError('서버의 업로드 크기 계약이 일치하지 않습니다.');
  }

  options.onStage('uploading');
  const upload = file.createUploadTask(intent.uploadUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: intent.requiredHeaders,
    mimeType: draft.contentType,
    sessionType: 'foreground',
    signal: options.signal,
    onProgress: ({ bytesSent, totalBytes }) => {
      options.onProgress(uploadProgress(bytesSent, totalBytes));
    },
  });
  const uploadResult = await upload.uploadAsync();
  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new ImageUploadError(
      `이미지 업로드에 실패했습니다. (${uploadResult.status})`,
    );
  }

  options.onProgress(1);
  options.onStage('validating');
  return apiRequest<ValidatedImageAsset>(
    `/api/image-assets/${intent.assetId}/complete`,
    {
      method: 'POST',
      signal: options.signal,
    },
  );
}

export class ImageUploadError extends Error {}
