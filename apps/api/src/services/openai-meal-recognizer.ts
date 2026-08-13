import {
  MEAL_RECOGNITION_V3_PROMPT_VERSION,
  MEAL_RECOGNITION_V3_SCHEMA_VERSION,
  MealRecognitionFailure,
  type MealRecognizer,
  type MealRecognizerInput,
  type MealRecognizerOutput,
  parseRecognitionResultV3,
} from './meal-recognizer';

export const OPENAI_MEAL_RECOGNITION_MODEL = 'gpt-5.4-mini-2026-03-17';
export const OPENAI_MEAL_RECOGNITION_MAX_OUTPUT_TOKENS = 1_200;
export const OPENAI_MEAL_RECOGNITION_DEADLINE_MS = 15_000;

export const OPENAI_MEAL_RECOGNITION_SYSTEM_PROMPT = `당신은 식사 사진 관찰기입니다. 사진에서 보이는 음식, 음료, 구성 요소, 대략적인 양과 불확실성만 구조화하세요.
반드시 제공된 JSON 스키마만 따르세요. 음식이나 음료가 없으면 no_food를, 사진 근거가 부족하면 insufficient_evidence를 반환하고 음식 항목을 만들지 마세요.
에너지, 칼로리, 영양소, 건강 진단, 정식 Food ID, NutrientProfile ID, 출처, 카탈로그, 레시피, 서빙 또는 다른 공식 ID를 출력하거나 추론하지 마세요. 질문은 자유 문장이 아닌 enum 사유 코드만 사용하세요. 사진으로 뒷받침되지 않는 확실성을 주장하지 마세요.`;

export const OPENAI_MEAL_RECOGNITION_USER_PROMPT = `이 식사 사진을 관찰하세요. outcome은 recognized, no_food, insufficient_evidence 중 하나입니다. recognized일 때만 observations를 반환하세요. regionIndex는 0부터 19의 고유 정수입니다. parentRegionIndex는 루트면 null이고 구성 요소면 더 이른 루트 regionIndex입니다. 루트 kind는 dish 또는 drink, 자식 kind는 component만 가능합니다. 양은 g, ml, serving, bowl, piece 중 하나입니다. categoryHint와 preparationCodes는 제공된 enum만 쓰고, uncertaintyCodes와 questionReasonCodes도 enum 코드만 쓰세요. alternatives는 주 관찰보다 낮은 confidence의 서로 다른 label을 confidence 내림차순으로 반환하세요. evidenceReason은 insufficient_evidence일 때만 반환하세요.`;

const labelSchema = { type: 'string', minLength: 1, maxLength: 120 };
const confidenceBpsSchema = { type: 'integer', minimum: 0, maximum: 10_000 };

const recognitionObservationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'regionIndex',
    'parentRegionIndex',
    'kind',
    'rawLabel',
    'foodConfidenceBps',
    'portionConfidenceBps',
    'amountMilliunits',
    'unit',
    'categoryHint',
    'preparationCodes',
    'uncertaintyCodes',
    'questionReasonCodes',
    'alternatives',
  ],
  properties: {
    regionIndex: { type: 'integer', minimum: 0, maximum: 19 },
    parentRegionIndex: { type: ['integer', 'null'], minimum: 0, maximum: 19 },
    kind: { type: 'string', enum: ['dish', 'drink', 'component'] },
    rawLabel: labelSchema,
    foodConfidenceBps: confidenceBpsSchema,
    portionConfidenceBps: confidenceBpsSchema,
    amountMilliunits: { type: 'integer', minimum: 1 },
    unit: { type: 'string', enum: ['g', 'ml', 'serving', 'bowl', 'piece'] },
    categoryHint: { type: 'string', enum: ['staple', 'soup_stew', 'meat', 'seafood', 'vegetable', 'noodle_dumpling', 'snack_dessert', 'beverage', 'mixed', 'unknown'] },
    preparationCodes: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['raw', 'boiled', 'steamed', 'grilled', 'fried', 'baked', 'braised', 'fermented', 'mixed', 'unknown'] } },
    uncertaintyCodes: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'string', enum: ['identity_uncertain', 'portion_uncertain', 'occluded', 'overlapping', 'mixed_dish', 'preparation_uncertain'] } },
    questionReasonCodes: { type: 'array', minItems: 0, maxItems: 2, items: { type: 'string', enum: ['confirm_identity', 'confirm_portion', 'confirm_component'] } },
    alternatives: {
      type: 'array',
      minItems: 0,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'confidenceBps'],
        properties: {
          label: labelSchema,
          confidenceBps: confidenceBpsSchema,
        },
      },
    },
  },
} as const;

export const OPENAI_MEAL_RECOGNITION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'imageQualityConfidenceBps', 'observations'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['recognized', 'no_food', 'insufficient_evidence'],
    },
    imageQualityConfidenceBps: confidenceBpsSchema,
    evidenceReason: {
      type: 'string',
      enum: ['blurred', 'too_dark', 'occluded', 'not_meal_photo', 'other'],
    },
    observations: {
      type: 'array',
      minItems: 0,
      maxItems: 20,
      items: recognitionObservationSchema,
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
  model?: string;
  deadlineMs?: number;
  maxOutputTokens?: number;
}

export class OpenAIMealRecognizer implements MealRecognizer {
  private readonly model: string;
  private readonly deadlineMs: number;
  private readonly maxOutputTokens: number;

  constructor(
    private readonly client: OpenAIResponsesClient,
    options: OpenAIMealRecognizerOptions = {},
  ) {
    this.model = options.model?.trim() || OPENAI_MEAL_RECOGNITION_MODEL;
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
          createRequest(input, this.model, this.maxOutputTokens),
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

    let result;
    try {
      result = parseRecognitionResultV3(normalizeProviderResult(parsed));
    } catch {
      throw new MealRecognitionFailure('INVALID_PROVIDER_RESPONSE');
    }

    const providerRequestId = sanitizeRequestId(
      response._request_id ?? response.request_id,
    );
    return {
      provider: 'openai',
      model: sanitizeModel(response.model) ?? this.model,
      promptVersion: MEAL_RECOGNITION_V3_PROMPT_VERSION,
      schemaVersion: MEAL_RECOGNITION_V3_SCHEMA_VERSION,
      ...(providerRequestId ? { providerRequestId } : {}),
      inputTokens: nonnegativeInteger(response.usage?.input_tokens),
      outputTokens: nonnegativeInteger(response.usage?.output_tokens),
      result,
    };
  }
}

function normalizeProviderResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return result;
  }
  const normalized = { ...result } as Record<string, unknown>;
  if (
    (normalized.outcome === 'recognized' || normalized.outcome === 'no_food') &&
    normalized.evidenceReason === null
  ) {
    delete normalized.evidenceReason;
  }
  return normalized;
}

function createRequest(
  input: MealRecognizerInput,
  model: string,
  maxOutputTokens: number,
): Record<string, unknown> {
  return {
    model,
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
        name: 'meal_recognition_v3',
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
