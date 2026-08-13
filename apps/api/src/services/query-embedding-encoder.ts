export const LOCAL_QUERY_EMBEDDING_ENCODER_VERSION = 'local-query-embedding-encoder-v1';

export type LocalEmbeddingArtifactManifest = Readonly<{
  provider: 'local';
  modelId: string;
  artifactSha256: string;
  tokenizerSha256: string;
  configSha256?: string;
  modelManifestSha256?: string;
  license?: 'mit';
  onnxOpset?: number;
  runtimeBackend?: 'onnxruntime-node';
  dimension: number;
  normalization: 'l2';
  templateVersion: string;
}>;

export interface LocalQueryEmbeddingBackend {
  readonly manifest: LocalEmbeddingArtifactManifest;
  readonly runtimeBackend?: 'onnxruntime-node';
  /**
   * Verifies the pinned local ONNX model, tokenizer, config, and manifest
   * files immediately before inference. Network and hash-only adapters are
   * intentionally not eligible to satisfy this boundary.
   */
  verifyLocalArtifacts?(): Promise<boolean>;
  embed(texts: readonly string[], options: { signal: AbortSignal }): Promise<readonly (readonly number[])[]>;
}

export type QueryEmbeddingEncoderOptions = Readonly<{
  manifest: LocalEmbeddingArtifactManifest;
  backend: LocalQueryEmbeddingBackend;
  maxBatchSize: number;
  timeoutMs: number;
}>;

export type QueryEmbeddingEncoding = Readonly<{
  manifest: LocalEmbeddingArtifactManifest;
  vectors: readonly (readonly number[])[];
}>;

export type QueryEmbeddingEncoderErrorCode =
  | 'ARTIFACT_MANIFEST_INVALID'
  | 'ARTIFACT_MANIFEST_MISMATCH'
  | 'ARTIFACT_NOT_VERIFIED'
  | 'BATCH_BUDGET_EXCEEDED'
  | 'INVALID_INPUT'
  | 'TIMEOUT'
  | 'BACKEND_FAILURE'
  | 'OUTPUT_COUNT_MISMATCH'
  | 'DIMENSION_MISMATCH'
  | 'NONFINITE_VECTOR'
  | 'ZERO_NORM_VECTOR';

export class QueryEmbeddingEncoderError extends Error {
  constructor(readonly code: QueryEmbeddingEncoderErrorCode) {
    super(code);
    this.name = 'QueryEmbeddingEncoderError';
  }
}

/**
 * Local-only adapter. The backend is injected so this boundary has no provider,
 * network, persistence, or fallback path.
 */
export class QueryEmbeddingEncoder {
  private readonly manifest: LocalEmbeddingArtifactManifest;
  private readonly backend: LocalQueryEmbeddingBackend;
  private readonly maxBatchSize: number;
  private readonly timeoutMs: number;

  constructor(options: QueryEmbeddingEncoderOptions) {
    if (!isManifest(options.manifest)) throw new QueryEmbeddingEncoderError('ARTIFACT_MANIFEST_INVALID');
    if (!isManifest(options.backend.manifest) || !sameManifest(options.manifest, options.backend.manifest)) {
      throw new QueryEmbeddingEncoderError('ARTIFACT_MANIFEST_MISMATCH');
    }
    if (options.backend.runtimeBackend !== 'onnxruntime-node') {
      throw new QueryEmbeddingEncoderError('ARTIFACT_NOT_VERIFIED');
    }
    if (!Number.isInteger(options.maxBatchSize) || options.maxBatchSize < 1) {
      throw new QueryEmbeddingEncoderError('BATCH_BUDGET_EXCEEDED');
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new QueryEmbeddingEncoderError('INVALID_INPUT');
    }
    this.manifest = options.manifest;
    this.backend = options.backend;
    this.maxBatchSize = options.maxBatchSize;
    this.timeoutMs = options.timeoutMs;
  }

  async encode(texts: readonly string[]): Promise<QueryEmbeddingEncoding> {
    if (texts.length === 0 || texts.length > this.maxBatchSize || texts.some((text) => typeof text !== 'string' || text.length === 0)) {
      throw new QueryEmbeddingEncoderError(texts.length > this.maxBatchSize ? 'BATCH_BUDGET_EXCEEDED' : 'INVALID_INPUT');
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      let output: readonly (readonly number[])[];
      try {
        output = await Promise.race([
          (async () => {
            if (
              this.backend.verifyLocalArtifacts === undefined ||
              !await this.backend.verifyLocalArtifacts()
            ) {
              throw new QueryEmbeddingEncoderError('ARTIFACT_NOT_VERIFIED');
            }
            return this.backend.embed(texts, { signal: controller.signal });
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new QueryEmbeddingEncoderError('TIMEOUT'));
            }, this.timeoutMs);
          }),
        ]);
      } catch (error) {
        if (controller.signal.aborted) throw new QueryEmbeddingEncoderError('TIMEOUT');
        if (error instanceof QueryEmbeddingEncoderError) throw error;
        throw new QueryEmbeddingEncoderError('BACKEND_FAILURE');
      }
      if (controller.signal.aborted) throw new QueryEmbeddingEncoderError('TIMEOUT');
      if (output.length !== texts.length) throw new QueryEmbeddingEncoderError('OUTPUT_COUNT_MISMATCH');
      return { manifest: this.manifest, vectors: output.map((vector) => normalizeVector(vector, this.manifest.dimension)) };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function normalizeVector(vector: readonly number[], dimension: number): readonly number[] {
  if (vector.length !== dimension) throw new QueryEmbeddingEncoderError('DIMENSION_MISMATCH');
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new QueryEmbeddingEncoderError('NONFINITE_VECTOR');
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm)) throw new QueryEmbeddingEncoderError('NONFINITE_VECTOR');
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0) throw new QueryEmbeddingEncoderError('ZERO_NORM_VECTOR');
  return vector.map((value) => value / norm);
}

function isManifest(value: unknown): value is LocalEmbeddingArtifactManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.provider === 'local'
    && manifest.modelId === 'intfloat/multilingual-e5-small'
    && isSha256(manifest.artifactSha256)
    && isSha256(manifest.tokenizerSha256)
    && isSha256(manifest.configSha256)
    && isSha256(manifest.modelManifestSha256)
    && manifest.license === 'mit'
    && Number.isInteger(manifest.onnxOpset) && (manifest.onnxOpset as number) > 0
    && manifest.runtimeBackend === 'onnxruntime-node'
    && manifest.dimension === 384
    && Number.isInteger(manifest.dimension) && (manifest.dimension as number) > 0
    && manifest.normalization === 'l2'
    && typeof manifest.templateVersion === 'string' && manifest.templateVersion.length > 0;
}

function sameManifest(left: LocalEmbeddingArtifactManifest, right: LocalEmbeddingArtifactManifest): boolean {
  return left.provider === right.provider
    && left.modelId === right.modelId
    && left.artifactSha256 === right.artifactSha256
    && left.tokenizerSha256 === right.tokenizerSha256
    && left.configSha256 === right.configSha256
    && left.modelManifestSha256 === right.modelManifestSha256
    && left.license === right.license
    && left.onnxOpset === right.onnxOpset
    && left.runtimeBackend === right.runtimeBackend
    && left.dimension === right.dimension
    && left.normalization === right.normalization
    && left.templateVersion === right.templateVersion;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
