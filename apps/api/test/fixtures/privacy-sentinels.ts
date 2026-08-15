export const ownershipFixture = {
  ownerUserId: '00000000-0000-4000-8000-000000001101',
  otherUserId: '00000000-0000-4000-8000-000000001102',
  imageAssetId: '00000000-0000-4000-8000-000000001103',
  mealLogId: '00000000-0000-4000-8000-000000001104',
} as const;

export const forbiddenRecognitionPayloadFields = [
  'imageBytes',
  'base64',
  'objectKey',
  'signedUrl',
  'email',
  'providerRequestId',
  'inputTokens',
  'outputTokens',
  'rawProviderError',
] as const;
