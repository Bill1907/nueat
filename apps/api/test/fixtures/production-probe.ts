export const productionProbeFixture = {
  status: 'ready',
  service: 'nueat-api',
  dependencies: { database: 'up' },
  mealConfirmation: {
    identity: 'meal-confirmation-cutover-v1',
    mode: 'normal',
    protocol: 'meal-confirmation-safe-review-v1',
    barrier: 'required',
    recognitionWorker: 'idle',
    recognitionReliability: {
      mode: 'v2_one_call',
      cohortPercent: 5,
      recoveryEnabled: false,
      schemaCapabilityRequired: true,
      sdkMaxRetries: 0,
    },
  },
} as const;
