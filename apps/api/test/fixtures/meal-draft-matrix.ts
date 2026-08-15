const baseMealLog = {
  id: '00000000-0000-4000-8000-000000000801',
  status: 'draft',
  recognitionStatus: 'ready',
  draftRevision: 3,
} as const;

const observationItem = {
  id: '00000000-0000-4000-8000-000000000802',
  recognizedLabel: '비빔밥',
  amountMilliunits: 1_000,
  unit: 'bowl',
  foodId: null,
  nutrientProfileId: null,
  itemRevision: 1,
} as const;

export const mealDraftResponseMatrix = [
  {
    name: 'current_api_known_recovery_with_observation',
    response: {
      mealLog: {
        ...baseMealLog,
        recognitionRecovery: {
          mode: 'none',
          reason: 'recognition_complete',
          retryAt: null,
        },
      },
      items: [observationItem],
    },
    observationCount: 1,
  },
  {
    name: 'old_api_recovery_absent_with_observation',
    response: { mealLog: baseMealLog, items: [observationItem] },
    observationCount: 1,
  },
  {
    name: 'legacy_api_without_observation',
    response: {
      mealLog: {
        ...baseMealLog,
        recognitionStatus: 'pending',
      },
      items: [],
    },
    observationCount: 0,
  },
] as const;

export const forbiddenMealDraftResponseKeys = [
  'recognitionProviderRequestId',
  'recognitionInputTokens',
  'recognitionOutputTokens',
  'recognitionLeaseToken',
  'recognitionLastErrorCode',
  'objectKey',
  'signedUrl',
  'email',
] as const;
