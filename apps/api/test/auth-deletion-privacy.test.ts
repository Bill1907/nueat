import { describe, expect, test } from 'bun:test';
import {
  assetDeletionJobs,
  imageAssets,
  mealLogs,
} from '@nueat/database';

import { recognitionEventLogFields } from '../src/services/recognition-observability';
import {
  forbiddenRecognitionPayloadFields,
  ownershipFixture,
} from './fixtures/privacy-sentinels';

describe('recognition auth deletion and privacy contracts', () => {
  test('keeps ownership predicates and retryable deletion jobs in the schema contract', () => {
    expect(ownershipFixture.ownerUserId).not.toBe(ownershipFixture.otherUserId);
    expect(imageAssets.userId.name).toBe('user_id');
    expect(mealLogs.userId.name).toBe('user_id');
    expect(mealLogs.imageAssetId.name).toBe('image_asset_id');
    expect(assetDeletionJobs.imageAssetId.name).toBe('image_asset_id');
    expect(assetDeletionJobs.attemptCount.name).toBe('attempt_count');
  });

  test('never projects private provider, storage, token, or identity fields', () => {
    const serialized = JSON.stringify(recognitionEventLogFields({
      type: 'terminal',
      executionId: ownershipFixture.mealLogId,
      code: 'PROVIDER_SERVER_ERROR',
    }));
    for (const field of forbiddenRecognitionPayloadFields)
      expect(serialized).not.toContain(field);
  });
});
