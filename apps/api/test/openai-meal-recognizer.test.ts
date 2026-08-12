import { describe, expect, test } from 'bun:test';

import {
  OpenAIMealRecognizer,
  type OpenAIResponse,
  type OpenAIResponsesClient,
} from '../src/services/openai-meal-recognizer';

const recognized = {
  outcome: 'recognized',
  imageQualityConfidenceBps: 9_100,
  foods: [
    {
      regionIndex: 0,
      rawLabel: '비빔밥',
      foodConfidenceBps: 8_600,
      portionConfidenceBps: 7_200,
      amountMilliunits: 1_000,
      unit: 'bowl',
      questions: [{ target: 'portion', question: '양을 확인해 주세요.' }],
      alternatives: [{ normalizedLabel: '돌솥비빔밥', confidenceBps: 7_900 }],
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
  test('sends private bytes with a strict V2 schema that only permits recognition evidence', async () => {
    const fake = fakeClient(validResponse);
    const result = await new OpenAIMealRecognizer(fake.client).recognize({ imageBytes: new Uint8Array([0, 1, 2]), imageContentType: 'image/png' });

    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', providerRequestId: 'req_123', result: recognized });
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ model: 'gpt-5.4-mini-2026-03-17', store: false, max_output_tokens: 1_200, text: { format: { type: 'json_schema', strict: true } } });
    expect((request.text as { format: { schema: unknown } }).format.schema).toMatchObject({
      type: 'object',
      required: ['outcome', 'imageQualityConfidenceBps', 'evidenceReason', 'foods'],
    });
    expect(JSON.stringify((request.text as { format: { schema: unknown } }).format.schema)).not.toContain('"oneOf"');
    expect(JSON.stringify(request)).toContain('data:image/png;base64,AAEC');
    expect(JSON.stringify(request)).not.toContain('https://');
    expect(JSON.stringify(request)).not.toContain('nutrientProfileId');
  });

  test('accepts all three V2 outcomes, including zero-item no-food and insufficient-evidence results', async () => {
    await expect(recognizeOutput({ outcome: 'no_food', imageQualityConfidenceBps: 8_000, evidenceReason: null, foods: [] })).resolves.toMatchObject({ result: { outcome: 'no_food', foods: [] } });
    await expect(recognizeOutput({ outcome: 'insufficient_evidence', imageQualityConfidenceBps: 2_000, evidenceReason: 'blurred', foods: [] })).resolves.toMatchObject({ result: { outcome: 'insufficient_evidence', evidenceReason: 'blurred', foods: [] } });
  });

  test('rejects invalid V2 cardinality and model-supplied nutrition or official IDs', async () => {
    await expect(recognizeOutput({ outcome: 'recognized', imageQualityConfidenceBps: 9_000, foods: [] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ outcome: 'no_food', imageQualityConfidenceBps: 9_000, foods: [recognized.foods[0]] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, foods: [{ ...recognized.foods[0], calories: 200, foodId: 'official-food', nutrientProfileId: 'official-profile' }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  test('rejects duplicate regions, invalid question targets, and non-unique or unordered alternatives', async () => {
    const food = recognized.foods[0]!;
    await expect(recognizeOutput({ ...recognized, foods: [food, { ...food }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, foods: [{ ...food, questions: [{ target: 'nutrition', question: '칼로리?' }] }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, foods: [{ ...food, alternatives: [{ normalizedLabel: ' 비빔밥 ', confidenceBps: 8_500 }] }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    await expect(recognizeOutput({ ...recognized, foods: [{ ...food, alternatives: [{ normalizedLabel: 'A', confidenceBps: 8_700 }, { normalizedLabel: 'B', confidenceBps: 8_700 }] }] })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
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
