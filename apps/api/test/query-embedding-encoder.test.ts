import { describe, expect, test } from 'bun:test';

import {
  QueryEmbeddingEncoder,
  type LocalEmbeddingArtifactManifest,
} from '../src/services/query-embedding-encoder';

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

function encoder(vectors: readonly (readonly number[])[], overrides: Partial<{ manifest: LocalEmbeddingArtifactManifest; maxBatchSize: number; timeoutMs: number; embed: (texts: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]> }> = {}) {
  return new QueryEmbeddingEncoder({
    manifest,
    backend: {
      manifest: overrides.manifest ?? manifest,
      runtimeBackend: 'onnxruntime-node',
      verifyLocalArtifacts: async () => true,
      embed: (texts, { signal }) => overrides.embed ? overrides.embed(texts, signal) : Promise.resolve(vectors),
    },
    maxBatchSize: overrides.maxBatchSize ?? 3,
    timeoutMs: overrides.timeoutMs ?? 20,
  });
}

describe('QueryEmbeddingEncoder', () => {
  test('requires the injected local backend to match the pinned artifact manifest', () => {
    expect(() => encoder([], { manifest: { ...manifest, artifactSha256: 'c'.repeat(64) } })).toThrow(
      'ARTIFACT_MANIFEST_MISMATCH',
    );
  });

  test('validates dimension and finite values before deterministic L2 normalization', async () => {
    await expect(encoder([[1, 2, 3]]).encode(['query'])).rejects.toMatchObject({ code: 'DIMENSION_MISMATCH' });
    await expect(encoder([[Number.NaN, ...Array(383).fill(0)]]).encode(['query'])).rejects.toMatchObject({ code: 'NONFINITE_VECTOR' });
    const vector = [3, 4, ...Array(382).fill(0)];
    const result = await encoder([vector]).encode(['query']);
    expect(result.vectors[0]?.slice(0, 2)).toEqual([0.6, 0.8]);
  });

  test('enforces batch and timeout budgets even when the backend ignores abort', async () => {
    await expect(encoder([], { maxBatchSize: 1 }).encode(['one', 'two'])).rejects.toMatchObject({ code: 'BATCH_BUDGET_EXCEEDED' });
    await expect(encoder([], {
      timeoutMs: 1,
      embed: () => new Promise(() => {}),
    }).encode(['query'])).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
