import { describe, expect, test } from 'bun:test';

import {
  OpenAIMealRecognizer,
  type OpenAIResponse,
  type OpenAIResponsesClient,
} from '../src/services/openai-meal-recognizer';

const validResponse: OpenAIResponse = {
  model: 'gpt-5.6-luna',
  _request_id: 'req_123',
  usage: { input_tokens: 123, output_tokens: 45 },
  output_text: JSON.stringify({
    foods: [
      {
        regionIndex: 0,
        recognizedLabel: '비빔밥',
        recognitionConfidenceBps: 8600,
        portionConfidenceBps: 6200,
        amountMilliunits: 1,
        unit: 'bowl',
      },
    ],
  }),
};

function fakeClient(response: OpenAIResponse): {
  client: OpenAIResponsesClient;
  requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    client: {
      responses: {
        async create(request) {
          requests.push(request);
          return response;
        },
      },
    },
  };
}

describe('OpenAIMealRecognizer', () => {
  test('sends private bytes in an in-memory data URL with strict non-persistent output', async () => {
    const fake = fakeClient(validResponse);
    const recognizer = new OpenAIMealRecognizer(fake.client);

    const result = await recognizer.recognize({
      imageBytes: new Uint8Array([0, 1, 2]),
      imageContentType: 'image/png',
    });

    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      providerRequestId: 'req_123',
      inputTokens: 123,
      outputTokens: 45,
    });
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      max_output_tokens: 1_200,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(JSON.stringify(request)).toContain('data:image/png;base64,AAEC');
    expect(JSON.stringify(request)).not.toContain('https://');
  });

  test('rejects extra nutrition fields even when the provider returns valid JSON', async () => {
    const fake = fakeClient({
      ...validResponse,
      output_text: JSON.stringify({
        foods: [
          {
            regionIndex: 0,
            recognizedLabel: 'rice',
            recognitionConfidenceBps: 8000,
            portionConfidenceBps: 7000,
            amountMilliunits: 120,
            unit: 'g',
            calories: 200,
          },
        ],
      }),
    });

    await expect(
      new OpenAIMealRecognizer(fake.client).recognize({
        imageBytes: new Uint8Array([1]),
        imageContentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  test('sanitizes refusal, incomplete, and provider errors into stable failures', async () => {
    const refusal = fakeClient({
      output: [{ type: 'message', content: [{ type: 'refusal' }] }],
    });
    await expect(
      new OpenAIMealRecognizer(refusal.client).recognize({
        imageBytes: new Uint8Array([1]),
        imageContentType: 'image/webp',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });

    const incomplete = fakeClient({ status: 'incomplete' });
    await expect(
      new OpenAIMealRecognizer(incomplete.client).recognize({
        imageBytes: new Uint8Array([1]),
        imageContentType: 'image/webp',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });

    const unavailable: OpenAIResponsesClient = {
      responses: {
        async create() {
          throw { status: 503, message: 'private provider detail' };
        },
      },
    };
    await expect(
      new OpenAIMealRecognizer(unavailable).recognize({
        imageBytes: new Uint8Array([1]),
        imageContentType: 'image/webp',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
