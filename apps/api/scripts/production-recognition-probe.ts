type ProbeFetch = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ProductionRecognitionProbeInput {
  baseUrl: string;
  expectedMode: 'legacy_observe' | 'v2_one_call' | 'disabled';
  expectedCohortPercent: number;
  observedAt: string;
  fetchImpl?: ProbeFetch;
  signal?: AbortSignal;
}

export async function productionRecognitionProbe(
  input: ProductionRecognitionProbeInput,
) {
  const fetchImpl: ProbeFetch = input.fetchImpl ?? (
    (url, init) => fetch(
      url,
      init?.signal ? { signal: init.signal } : undefined,
    )
  );
  const url = new URL('/health/ready', input.baseUrl);
  const response = await fetchImpl(
    url.toString(),
    input.signal ? { signal: input.signal } : undefined,
  );
  const body = await response.json() as Record<string, any>;
  const reliability = body.mealConfirmation?.recognitionReliability;
  if (
    !response.ok ||
    body.status !== 'ready' ||
    body.dependencies?.database !== 'up' ||
    reliability?.mode !== input.expectedMode ||
    reliability?.cohortPercent !== input.expectedCohortPercent ||
    reliability?.sdkMaxRetries !== 0
  ) throw new Error('Production recognition readiness probe failed');
  const serialized = JSON.stringify(body);
  for (const forbidden of [
    'objectKey', 'signedUrl', 'base64', 'imageBytes', 'email',
    'providerRequestId', 'inputTokens', 'outputTokens',
  ]) {
    if (serialized.includes(forbidden))
      throw new Error('Production recognition privacy probe failed');
  }
  return {
    schemaVersion: 1,
    kind: 'production-recognition-probe',
    origin: url.origin,
    ready: true,
    mode: reliability.mode,
    cohortPercent: reliability.cohortPercent,
    recoveryEnabled: reliability.recoveryEnabled === true,
    sdkMaxRetries: reliability.sdkMaxRetries,
    observedAt: input.observedAt,
  } as const;
}

if (import.meta.main) {
  const baseUrl = process.env.NUEAT_PRODUCTION_API_URL;
  const mode = process.env.RECOGNITION_RELIABILITY_PROTOCOL_MODE;
  const cohortPercent = Number(
    process.env.RECOGNITION_RELIABILITY_COHORT_PERCENT,
  );
  if (
    !baseUrl ||
    (mode !== 'legacy_observe' &&
      mode !== 'v2_one_call' &&
      mode !== 'disabled') ||
    !Number.isInteger(cohortPercent)
  ) throw new Error('Production recognition probe configuration is incomplete');
  const receipt = await productionRecognitionProbe({
    baseUrl,
    expectedMode: mode,
    expectedCohortPercent: cohortPercent,
    observedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify(receipt));
}
