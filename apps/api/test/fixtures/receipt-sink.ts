import type {
  RecognitionExecutionEvent,
} from '../../src/services/meal-recognition-coordinator';

export const receiptEventFixtures: RecognitionExecutionEvent[] = [
  {
    type: 'phase',
    executionId: '00000000-0000-4000-8000-000000001001',
    phase: 'provider_call',
  },
  {
    type: 'terminal',
    executionId: '00000000-0000-4000-8000-000000001001',
    code: 'SUCCEEDED',
  },
  {
    type: 'reconciled',
    workflowId: '00000000-0000-4000-8000-000000001002',
  },
];

export const privacySentinels = [
  'fixture@example.invalid',
  'private/object/key',
  'https://signed.invalid/upload?secret=value',
  'data:image/jpeg;base64,private',
  'raw provider failure detail',
] as const;
