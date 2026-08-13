import { describe, expect, test } from 'bun:test';

import {
  QueryEmbeddingEncoder,
  type LocalEmbeddingArtifactManifest,
} from '../src/services/query-embedding-encoder';
import { VectorShadowEvaluator } from '../src/services/vector-shadow-evaluator';

const manifest: LocalEmbeddingArtifactManifest = {
  provider: 'local',
  modelId: 'intfloat/multilingual-e5-small',
  artifactSha256: 'a'.repeat(64),
  tokenizerSha256: 'b'.repeat(64),
  configSha256: 'c'.repeat(64),
  modelManifestSha256: 'd'.repeat(64),
  license: 'mit',
  onnxOpset: 17,
  runtimeBackend: 'onnxruntime-node',
  dimension: 384,
  normalization: 'l2',
  templateVersion: 'e5-v1',
};

function evaluator(vectors: readonly (readonly number[])[]) {
  return new VectorShadowEvaluator({
    encoder: new QueryEmbeddingEncoder({
      manifest,
      backend: {
        manifest,
        runtimeBackend: 'onnxruntime-node',
        verifyLocalArtifacts: async () => true,
        embed: async () => vectors,
      },
      maxBatchSize: 3,
      timeoutMs: 20,
    }),
    maxCandidatesPerMeal: 2,
    maxBatchSizePerMeal: 3,
  });
}

const input = {
  mode: 'shadow' as const,
  catalogReleaseId: 'release-1',
  queryText: 'sensitive raw label',
  productWinnerDocumentId: 'doc-b',
  exhaustiveDocumentCount: 2,
  stackIds: { productResolver: 'catalog-lexical-resolver-v1', vectorEvaluator: 'vector-shadow-evaluator-v1' },
  releaseDocuments: [
    { id: 'doc-b', catalogReleaseId: 'release-1', embeddingText: 'product document label' },
    { id: 'doc-a', catalogReleaseId: 'release-1', embeddingText: 'vector document label' },
  ],
};

const vector = (first: number, second: number) => [
  first,
  second,
  ...Array(382).fill(0),
];

describe('VectorShadowEvaluator', () => {
  test('records deterministic aggregate ranks without raw query, document, or vector evidence', async () => {
    const result = await evaluator([vector(1, 0), vector(0, 1), vector(1, 0)]).evaluate(input);
    expect(result).toMatchObject({
      status: 'recorded',
      evidence: { documentsScored: 2, productWinnerRank: 2, vectorTopDiffersFromProductWinner: true, correctionSuggested: true },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sensitive raw label');
    expect(serialized).not.toContain('product document label');
    expect(serialized).not.toContain('vector document label');
    expect(serialized).not.toContain('[1,0]');
  });

  test('uses UTF-8 document IDs to make equal-score ranks deterministic', async () => {
    const first = await evaluator([vector(1, 0), vector(1, 0), vector(1, 0)]).evaluate(input);
    const second = await evaluator([vector(1, 0), vector(1, 0), vector(1, 0)]).evaluate({ ...input, releaseDocuments: [...input.releaseDocuments].reverse() });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'recorded', evidence: { productWinnerRank: 2 } });
  });

  test('fails silently to the product when release documents are incomplete or budgets are exceeded', async () => {
    const incomplete = await evaluator([vector(1, 0), vector(1, 0), vector(1, 0)]).evaluate({ ...input, exhaustiveDocumentCount: 3 });
    expect(incomplete).toMatchObject({ status: 'unavailable', code: 'RELEASE_DOCUMENTS_NOT_EXHAUSTIVE' });
    const overBudget = await evaluator([vector(1, 0), vector(1, 0), vector(1, 0)]).evaluate({
      ...input,
      releaseDocuments: [...input.releaseDocuments, { id: 'doc-c', catalogReleaseId: 'release-1', embeddingText: 'third' }],
      exhaustiveDocumentCount: 3,
    });
    expect(overBudget).toMatchObject({ status: 'unavailable', code: 'CANDIDATE_BUDGET_EXCEEDED' });
  });

  test('returns disabled telemetry without invoking the encoder', async () => {
    const result = await evaluator([]).evaluate({ ...input, mode: 'off' });
    expect(result).toEqual({ status: 'disabled', code: 'VECTOR_SHADOW_DISABLED', stackIds: input.stackIds });
  });
});
