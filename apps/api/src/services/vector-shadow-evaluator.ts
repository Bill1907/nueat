import {
  QueryEmbeddingEncoder,
  QueryEmbeddingEncoderError,
  type LocalEmbeddingArtifactManifest,
} from './query-embedding-encoder';

export const VECTOR_SHADOW_EVALUATOR_VERSION = 'vector-shadow-evaluator-v1';

export type VectorShadowMode = 'off' | 'shadow';

export type VectorShadowReleaseDocument = Readonly<{
  id: string;
  catalogReleaseId: string;
  embeddingText: string;
}>;

export type VectorShadowEvaluationInput = Readonly<{
  mode: VectorShadowMode;
  catalogReleaseId: string;
  queryText: string;
  productWinnerDocumentId: string | null;
  releaseDocuments: readonly VectorShadowReleaseDocument[];
  exhaustiveDocumentCount: number;
  stackIds: Readonly<{
    productResolver: string;
    vectorEvaluator: string;
  }>;
}>;

export type VectorShadowEvaluatorOptions = Readonly<{
  encoder: QueryEmbeddingEncoder;
  maxCandidatesPerMeal: number;
  maxBatchSizePerMeal: number;
}>;

export type VectorShadowTelemetry =
  | Readonly<{
    status: 'disabled';
    code: 'VECTOR_SHADOW_DISABLED';
    stackIds: VectorShadowEvaluationInput['stackIds'];
  }>
  | Readonly<{
    status: 'recorded';
    code: 'VECTOR_SHADOW_RECORDED';
    artifact: LocalEmbeddingArtifactManifest;
    stackIds: VectorShadowEvaluationInput['stackIds'];
    evidence: Readonly<{
      documentsScored: number;
      vectorTopScoreBps: number;
      productWinnerRank: number | null;
      productWinnerScoreBps: number | null;
      vectorTopDiffersFromProductWinner: boolean | null;
      correctionSuggested: boolean;
      scoreDeltaBps: number | null;
    }>;
  }>
  | Readonly<{
    status: 'unavailable';
    code: VectorShadowUnavailableCode;
    stackIds: VectorShadowEvaluationInput['stackIds'];
  }>;

export type VectorShadowUnavailableCode =
  | 'INVALID_INPUT'
  | 'RELEASE_DOCUMENTS_NOT_EXHAUSTIVE'
  | 'CANDIDATE_BUDGET_EXCEEDED'
  | 'BATCH_BUDGET_EXCEEDED'
  | 'ENCODER_TIMEOUT'
  | 'ENCODER_UNAVAILABLE';

/**
 * Computes shadow-only aggregate telemetry. It deliberately returns neither a
 * candidate ID nor a vector, and is not connected to any product resolver.
 */
export class VectorShadowEvaluator {
  constructor(private readonly options: VectorShadowEvaluatorOptions) {
    if (!Number.isInteger(options.maxCandidatesPerMeal) || options.maxCandidatesPerMeal < 1) {
      throw new Error('maxCandidatesPerMeal must be a positive integer');
    }
    if (!Number.isInteger(options.maxBatchSizePerMeal) || options.maxBatchSizePerMeal < 2) {
      throw new Error('maxBatchSizePerMeal must be at least two');
    }
  }

  async evaluate(input: VectorShadowEvaluationInput): Promise<VectorShadowTelemetry> {
    if (input.mode === 'off') return { status: 'disabled', code: 'VECTOR_SHADOW_DISABLED', stackIds: input.stackIds };
    const validationCode = validateInput(input);
    if (validationCode) return { status: 'unavailable', code: validationCode, stackIds: input.stackIds };
    if (input.releaseDocuments.length > this.options.maxCandidatesPerMeal) {
      return { status: 'unavailable', code: 'CANDIDATE_BUDGET_EXCEEDED', stackIds: input.stackIds };
    }
    if (input.releaseDocuments.length + 1 > this.options.maxBatchSizePerMeal) {
      return { status: 'unavailable', code: 'BATCH_BUDGET_EXCEEDED', stackIds: input.stackIds };
    }

    try {
      const embedding = await this.options.encoder.encode([
        input.queryText,
        ...input.releaseDocuments.map((document) => document.embeddingText),
      ]);
      const queryVector = embedding.vectors[0]!;
      const ranked = input.releaseDocuments
        .map((document, index) => ({ id: document.id, scoreBps: toBps(dot(queryVector, embedding.vectors[index + 1]!)) }))
        .sort(compareRankedDocuments);
      const productWinnerIndex = input.productWinnerDocumentId === null
        ? -1
        : ranked.findIndex((candidate) => candidate.id === input.productWinnerDocumentId);
      const productWinner = productWinnerIndex < 0 ? null : ranked[productWinnerIndex]!;
      const vectorTop = ranked[0]!;
      const vectorTopDiffersFromProductWinner = productWinner === null
        ? null
        : productWinnerIndex !== 0;
      return {
        status: 'recorded',
        code: 'VECTOR_SHADOW_RECORDED',
        artifact: embedding.manifest,
        stackIds: input.stackIds,
        evidence: {
          documentsScored: ranked.length,
          vectorTopScoreBps: vectorTop.scoreBps,
          productWinnerRank: productWinnerIndex < 0 ? null : productWinnerIndex + 1,
          productWinnerScoreBps: productWinner?.scoreBps ?? null,
          vectorTopDiffersFromProductWinner,
          correctionSuggested: vectorTopDiffersFromProductWinner === true,
          scoreDeltaBps: productWinner === null ? null : vectorTop.scoreBps - productWinner.scoreBps,
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        code: error instanceof QueryEmbeddingEncoderError && error.code === 'TIMEOUT'
          ? 'ENCODER_TIMEOUT'
          : 'ENCODER_UNAVAILABLE',
        stackIds: input.stackIds,
      };
    }
  }
}

function validateInput(input: VectorShadowEvaluationInput): VectorShadowUnavailableCode | null {
  if (input.mode !== 'shadow' || !nonEmpty(input.catalogReleaseId) || !nonEmpty(input.queryText)
    || !nonEmpty(input.stackIds.productResolver) || !nonEmpty(input.stackIds.vectorEvaluator)
    || !Number.isInteger(input.exhaustiveDocumentCount) || input.exhaustiveDocumentCount < 1) return 'INVALID_INPUT';
  if (input.releaseDocuments.length !== input.exhaustiveDocumentCount
    || input.releaseDocuments.some((document) => document.catalogReleaseId !== input.catalogReleaseId
      || !nonEmpty(document.id) || !nonEmpty(document.embeddingText))
    || new Set(input.releaseDocuments.map((document) => document.id)).size !== input.releaseDocuments.length) {
    return 'RELEASE_DOCUMENTS_NOT_EXHAUSTIVE';
  }
  if (input.productWinnerDocumentId !== null
    && !input.releaseDocuments.some((document) => document.id === input.productWinnerDocumentId)) return 'INVALID_INPUT';
  return null;
}

function dot(left: readonly number[], right: readonly number[]): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index]! * right[index]!;
  return score;
}

function toBps(score: number): number {
  return Math.round(score * 10_000);
}

function compareRankedDocuments(left: { id: string; scoreBps: number }, right: { id: string; scoreBps: number }): number {
  return right.scoreBps - left.scoreBps || compareUtf8(left.id, right.id);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.length > 0;
}
