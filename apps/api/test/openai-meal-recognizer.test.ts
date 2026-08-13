import { describe, expect, test } from 'bun:test';

import {
  OpenAIMealRecognizer,
  type OpenAIResponse,
  type OpenAIResponsesClient,
} from '../src/services/openai-meal-recognizer';
import { toStoredRecognitionResultV3, type RecognitionResultV3 } from '../src/services/meal-recognizer';

const recognized: RecognitionResultV3 = {
  outcome: 'recognized',
  imageQualityConfidenceBps: 9_100,
  observations: [
    {
      regionIndex: 0,
      parentRegionIndex: null,
      kind: 'dish',
      rawLabel: '비빔밥',
      foodConfidenceBps: 8_600,
      portionConfidenceBps: 7_200,
      amountMilliunits: 1_000,
      unit: 'bowl',
      categoryHint: 'mixed',
      preparationCodes: ['mixed'],
      uncertaintyCodes: ['portion_uncertain'],
      questionReasonCodes: ['confirm_portion'],
      alternatives: [{ label: '돌솥비빔밥', confidenceBps: 7_900 }],
    },
  ],
};

const validResponse: OpenAIResponse = {
  model: 'gpt-5.4-mini-2026-03-17',
  _request_id: 'req_123',
  usage: { input_tokens: 123, output_tokens: 45 },
  output_text: JSON.stringify(recognized),
};

function fakeClient(response: OpenAIResponse): { client: OpenAIResponsesClient; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    client: { responses: { async create(request) { requests.push(request); return response; } } },
  };
}

async function recognizeOutput(output: unknown) {
  const fake = fakeClient({ ...validResponse, output_text: JSON.stringify(output) });
  return new OpenAIMealRecognizer(fake.client).recognize({ imageBytes: new Uint8Array([1]), imageContentType: 'image/jpeg' });
}

describe('OpenAIMealRecognizer', () => {
  test('sends private bytes with a strict V3 schema that only permits recognition evidence', async () => {
    const fake = fakeClient(validResponse);
    const result = await new OpenAIMealRecognizer(fake.client).recognize({ imageBytes: new Uint8Array([0, 1, 2]), imageContentType: 'image/png' });

    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', providerRequestId: 'req_123', result: recognized });
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ model: 'gpt-5.4-mini-2026-03-17', store: false, max_output_tokens: 1_200, text: { format: { type: 'json_schema', strict: true } } });
    expect((request.text as { format: { schema: unknown } }).format.schema).toMatchObject({
      type: 'object',
      required: [
        'outcome',
        'imageQualityConfidenceBps',
        'evidenceReason',
        'observations',
      ],
      properties: {
        evidenceReason: {
          type: ['string', 'null'],
          enum: ['blurred', 'too_dark', 'occluded', 'not_meal_photo', 'other', null],
        },
      },
    });
    expect(JSON.stringify((request.text as { format: { schema: unknown } }).format.schema)).not.toContain('"oneOf"');
    expect(JSON.stringify(request)).toContain('data:image/png;base64,AAEC');
    expect(JSON.stringify(request)).not.toContain('https://');
    expect(JSON.stringify(request)).not.toContain('nutrientProfileId');
  });

  test('accepts all three V3 outcomes, including zero-item no-food and insufficient-evidence results', async () => {
    await expect(recognizeOutput({ outcome: 'no_food', imageQualityConfidenceBps: 8_000, evidenceReason: null, observations: [] })).resolves.toMatchObject({ result: { outcome: 'no_food', observations: [] } });
    await expect(recognizeOutput({ outcome: 'insufficient_evidence', imageQualityConfidenceBps: 2_000, evidenceReason: 'blurred', observations: [] })).resolves.toMatchObject({ result: { outcome: 'insufficient_evidence', evidenceReason: 'blurred', observations: [] } });
  });

  test('assigns stable local observation IDs from persisted ordering, not sparse region values', () => {
    const stored = toStoredRecognitionResultV3({
      ...recognized,
      observations: [
        { ...recognized.observations[0]!, regionIndex: 12 },
        { ...recognized.observations[0]!, regionIndex: 3, rawLabel: '김밥' },
      ],
    });
    expect(stored).toMatchObject({
      observations: [
        { regionIndex: 3, localObservationId: 'o0' },
        { regionIndex: 12, localObservationId: 'o1' },
      ],
    });
  });

  test('rejects invalid V3 cardinality and model-supplied nutrition or official IDs', async () => {
    await expect(recognizeOutput({ outcome: 'recognized', imageQualityConfidenceBps: 9_000, observations: [] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ outcome: 'no_food', imageQualityConfidenceBps: 9_000, observations: [recognized.observations[0]] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, observations: [{ ...recognized.observations[0], calories: 200, foodId: 'official-food', nutrientProfileId: 'official-profile' }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, observations: [{ ...recognized.observations[0], rawLabel: '비빔밥 K-FCDB-12345' }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  test('rejects duplicate regions, forbidden fields, and non-unique or unordered alternatives', async () => {
    const food = recognized.observations[0]!;
    await expect(recognizeOutput({ ...recognized, observations: [food, { ...food }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, observations: [{ ...food, questions: [{ target: 'nutrition', question: '칼로리?' }] }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, observations: [{ ...food, alternatives: [{ label: ' 비빔밥 ', confidenceBps: 8_500 }] }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, observations: [{ ...food, alternatives: [{ label: 'A', confidenceBps: 8_700 }, { label: 'B', confidenceBps: 8_700 }] }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  test('sanitizes refusal, incomplete, and provider errors into stable failures', async () => {
    const refusal = fakeClient({ output: [{ type: 'message', content: [{ type: 'refusal' }] }] });
    await expect(new OpenAIMealRecognizer(refusal.client).recognize({ imageBytes: new Uint8Array([1]), imageContentType: 'image/webp' })).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    const incomplete = fakeClient({ status: 'incomplete' });
    await expect(new OpenAIMealRecognizer(incomplete.client).recognize({ imageBytes: new Uint8Array([1]), imageContentType: 'image/webp' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    const unavailable: OpenAIResponsesClient = { responses: { async create() { throw { status: 503, message: 'private provider detail' }; } } };
    await expect(new OpenAIMealRecognizer(unavailable).recognize({ imageBytes: new Uint8Array([1]), imageContentType: 'image/webp' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
