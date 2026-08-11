import {
  MEAL_RECOGNITION_PROMPT_VERSION,
  MEAL_RECOGNITION_SCHEMA_VERSION,
  MealRecognitionFailure,
  type MealRecognizer,
  type MealRecognizerInput,
  type MealRecognizerOutput,
  RecognitionResultV1,
} from './meal-recognizer';

export const OPENAI_MEAL_RECOGNITION_MODEL = 'gpt-5.6-luna';
export const OPENAI_MEAL_RECOGNITION_MAX_OUTPUT_TOKENS = 1_200;
export const OPENAI_MEAL_RECOGNITION_DEADLINE_MS = 15_000;

export const OPENAI_MEAL_RECOGNITION_SYSTEM_PROMPT = `당신은 식사 사진 인식기입니다. 사진에서 보이는 음식과 음료만 식별하고 각 항목의 대략적인 양을 추정하세요.
반드시 제공된 JSON 스키마만 따르세요. 보이지 않거나 확실하지 않은 내용은 단정하지 말고, 필요한 경우 question과 candidateLabels로 불확실성을 표현하세요.
에너지, 칼로리, 영양소, 건강 진단, 정식 Food ID, NutrientProfile ID를 출력하거나 추론하지 마세요. 사진으로 뒷받침되지 않는 확실성을 주장하지 마세요.`;

export const OPENAI_MEAL_RECOGNITION_USER_PROMPT = `이 식사 사진을 분석하세요. 서로 다른 보이는 음식 또는 음료마다 하나의 항목을 반환하세요. regionIndex는 사진 내 항목을 구분하는 0부터 시작하는 고유한 정수입니다. 양은 g, ml, serving, bowl, piece 중 하나로만 표현하세요. 질문이 필요 없으면 question은 null, 대안 후보가 없으면 candidateLabels는 빈 배열로 반환하세요.`;

const labelSchema = { type: 'string', minLength: 1, maxLength: 120 };

export const OPENAI_MEAL_RECOGNITION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['foods'],
  properties: {
    foods: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'regionIndex',
          'recognizedLabel',
          'recognitionConfidenceBps',
          'portionConfidenceBps',
          'amountMilliunits',
          'unit',
          'question',
          'candidateLabels',
        ],
        properties: {
          regionIndex: { type: 'integer', minimum: 0, maximum: 19 },
          recognizedLabel: labelSchema,
          recognitionConfidenceBps: { type: 'integer', minimum: 0, maximum: 10_000 },
          portionConfidenceBps: { type: 'integer', minimum: 0, maximum: 10_000 },
          amountMilliunits: { type: 'integer', minimum: 1 },
          unit: { type: 'string', enum: ['g', 'ml', 'serving', 'bowl', 'piece'] },
          question: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 240 },
              { type: 'null' },
            ],
          },
          candidateLabels: {
            type: 'array',
            minItems: 0,
            maxItems: 5,
            items: labelSchema,
          },
        },
      },
    },
  },
} as const;

export interface OpenAIResponsesClient {
  responses: {
    create(
      request: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<OpenAIResponse>;
  };
}

export interface OpenAIResponse {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string }> }>;
  status?: string;
  incomplete_details?: unknown;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  _request_id?: string;
  request_id?: string;
}

export interface OpenAIMealRecognizerOptions {
  deadlineMs?: number;
  maxOutputTokens?: number;
}

export class OpenAIMealRecognizer implements MealRecognizer {
  private readonly deadlineMs: number;
  private readonly maxOutputTokens: number;

  constructor(
    private readonly client: OpenAIResponsesClient,
    options: OpenAIMealRecognizerOptions = {},
  ) {
    this.deadlineMs = positiveInteger(options.deadlineMs, OPENAI_MEAL_RECOGNITION_DEADLINE_MS);
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens,
      OPENAI_MEAL_RECOGNITION_MAX_OUTPUT_TOKENS,
    );
  }

  async recognize(input: MealRecognizerInput): Promise<MealRecognizerOutput> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new MealRecognitionFailure('DEADLINE_EXCEEDED'));
      }, this.deadlineMs);
    });

    let response: OpenAIResponse;
    try {
      response = await Promise.race([
        this.client.responses.create(
          createRequest(input, this.maxOutputTokens),
          { signal: controller.signal },
        ),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof MealRecognitionFailure) throw error;
      throw mapProviderError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timeout!);
    }

    if (typeof response !== 'object' || response === null) {
      throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
    }

    if (
      response.status === 'incomplete' ||
      response.incomplete_details != null ||
      (response.status !== undefined && response.status !== 'completed')
    ) {
      throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
    }
    if (hasRefusal(response)) {
      throw new MealRecognitionFailure('PROVIDER_REJECTED');
    }
    if (typeof response.output_text !== 'string') {
      throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.output_text);
    } catch {
      throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
    }

    const result = RecognitionResultV1.safeParse(parsed);
    if (!result.success) {
      throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
    }

    const providerRequestId = sanitizeRequestId(
      response._request_id ?? response.request_id,
    );
    return {
      provider: 'openai',
      model: sanitizeModel(response.model) ?? OPENAI_MEAL_RECOGNITION_MODEL,
      promptVersion: MEAL_RECOGNITION_PROMPT_VERSION,
      schemaVersion: MEAL_RECOGNITION_SCHEMA_VERSION,
      ...(providerRequestId ? { providerRequestId } : {}),
      inputTokens: nonnegativeInteger(response.usage?.input_tokens),
      outputTokens: nonnegativeInteger(response.usage?.output_tokens),
      result: result.data,
    };
  }
}

function createRequest(input: MealRecognizerInput, maxOutputTokens: number): Record<string, unknown> {
  return {
    model: OPENAI_MEAL_RECOGNITION_MODEL,
    store: false,
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: OPENAI_MEAL_RECOGNITION_SYSTEM_PROMPT }],
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: OPENAI_MEAL_RECOGNITION_USER_PROMPT },
          {
            type: 'input_image',
            image_url: `data:${input.imageContentType};base64,${encodeBase64(input.imageBytes)}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'meal_recognition_v1',
        strict: true,
        schema: OPENAI_MEAL_RECOGNITION_JSON_SCHEMA,
      },
    },
  };
}

function hasRefusal(response: OpenAIResponse): boolean {
  return response.output?.some((item) =>
    item.type === 'refusal' || item.content?.some((content) => content.type === 'refusal'),
  ) ?? false;
}

function mapProviderError(error: unknown, timedOut: boolean): MealRecognitionFailure {
  if (timedOut) return new MealRecognitionFailure('DEADLINE_EXCEEDED');

  const status = getStatus(error);
  if (status === 408 || status === 409 || status === 429)
    return new MealRecognitionFailure('PROVIDER_UNAVAILABLE');
  if (status === 400 || status === 401 || status === 403)
    return new MealRecognitionFailure('CONFIGURATION_INVALID');
  if (status !== undefined && status >= 400 && status < 500)
    return new MealRecognitionFailure('PROVIDER_REJECTED');
  return new MealRecognitionFailure('PROVIDER_UNAVAILABLE');
}

function getStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function sanitizeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function sanitizeModel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 0x03) << 4) | (second >> 4)];
    encoded += index + 1 < bytes.length ? alphabet[((second & 0x0f) << 2) | (third >> 6)] : '=';
    encoded += index + 2 < bytes.length ? alphabet[third & 0x3f] : '=';
  }
  return encoded;
}
