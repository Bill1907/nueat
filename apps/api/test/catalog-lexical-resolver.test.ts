import { describe, expect, test } from 'bun:test';

import { FOOD_NORMALIZER_VERSION, normalizeFoodText } from '@nueat/database/catalog-normalization';

import {
  positiveHalfUp,
  requireAvailableLexicalWinner,
  resolveCatalogLexicalRows,
  type CatalogLexicalRows,
} from '../src/services/catalog-lexical-resolver';

function document(
  id: string,
  foodId: string,
  displayTextKo: string,
  category = '밥류',
  preparation: string | null = null,
) {
  const normalized = normalizeFoodText(displayTextKo);
  return {
    id,
    catalogReleaseId: 'release-1',
    foodId,
    displayTextKo,
    normalizedCompact: normalized.compact,
    orderedTokens: normalized.orderedTokens,
    orderedTrigrams: normalized.orderedTrigrams,
    normalizerVersion: FOOD_NORMALIZER_VERSION,
    category,
    preparation,
  };
}

function rows(...documents: ReturnType<typeof document>[]): CatalogLexicalRows {
  return {
    catalogRelease: { id: 'release-1', status: 'published', normalizerVersion: FOOD_NORMALIZER_VERSION },
    documents,
  };
}

function resolve(
  labelKo: string,
  data: CatalogLexicalRows,
  observation: Partial<{ category: string | null; preparation: string | null }> = {},
) {
  return resolveCatalogLexicalRows('release-1', {
    labelKo,
    category: null,
    preparation: null,
    ...observation,
  }, data);
}

describe('catalog lexical resolver', () => {
  test('uses positive half-up integer arithmetic', () => {
    expect(positiveHalfUp(1n, 2n)).toBe(1n);
    expect(positiveHalfUp(1n, 3n)).toBe(0n);
    expect(positiveHalfUp(3n, 2n)).toBe(2n);
  });

  test('scores an exact compact Korean match and punctuation-equivalent spelling', () => {
    const result = resolve('돼지고기볶음 제육볶음', rows(
      document('doc-1', 'food-pork', '돼지고기볶음(제육볶음)', '볶음류'),
      document('doc-2', 'food-rice', '쌀밥'),
    ));
    expect(result).toMatchObject({
      kind: 'resolved',
      winner: {
        foodId: 'food-pork',
        evidence: { exactCompactBps: 10_000, tokenDiceBps: 10_000, trigramDiceBps: 10_000 },
      },
    });
  });

  test('uses winning document UUID-byte order before Food UUID-byte order', () => {
    const result = resolve('김밥', rows(
      document('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', '김밥'),
      document('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000099', '김밥'),
      document('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000099', '김밥'),
    ));
    expect(result).toMatchObject({
      kind: 'resolved',
      winner: {
        foodId: '00000000-0000-4000-8000-000000000099',
        documentId: '00000000-0000-4000-8000-000000000010',
      },
      review: { reasons: ['AMBIGUOUS_FOOD_SCORE', 'LOW_SCORE_MARGIN'] },
    });
  });

  test('keeps exact documents at the exact score despite taxonomy mismatch', () => {
    const result = resolve('김치찌개', rows(
      document('exact', 'food-stew', '김치찌개', '찌개 및 전골류'),
      document('partial', 'food-rice', '김치', '밥류'),
    ), { category: '밥류' });
    expect(result).toMatchObject({
      kind: 'resolved',
      winner: { foodId: 'food-stew', scoreBps: 10_000, evidence: { categoryContradiction: true } },
    });
  });

  test('bounds deduplicated evidence to eight Foods', () => {
    const result = resolve('김밥', rows(...Array.from(
      { length: 10 },
      (_, index) => document(`doc-${index}`, `food-${index}`, `김밥${index}`),
    )));
    expect(result).toMatchObject({ kind: 'resolved' });
    if (result.kind === 'resolved') {
      expect(result.candidates).toHaveLength(8);
      expect(new Set(result.candidates.map((candidate) => candidate.foodId)).size).toBe(8);
    }
  });

  test('calculates the review margin after Food deduplication', () => {
    const result = resolve('쌀밥', rows(
      document('food-a-canonical', 'food-a', '쌀밥'),
      document('food-a-alias', 'food-a', '흰쌀밥'),
      document('food-b', 'food-b', '쌀밥밥'),
    ));
    expect(result).toMatchObject({
      kind: 'resolved',
      winner: { foodId: 'food-a' },
      runnerUp: { foodId: 'food-b' },
    });
    if (result.kind === 'resolved') {
      expect(result.winnerScoreBps).toBe(result.winner.scoreBps);
      expect(result.runnerUpScoreBps).toBe(result.runnerUp!.scoreBps);
      expect(result.marginBps).toBe(result.winnerScoreBps - result.runnerUpScoreBps!);
    }
  });

  test('exposes no margin or runner-up score when only one deduplicated Food exists', () => {
    const result = resolve('김밥', rows(
      document('canonical', 'food-kimbap', '김밥'),
      document('alias', 'food-kimbap', '김밥(김밥)'),
    ));
    expect(result).toMatchObject({
      kind: 'resolved',
      winnerScoreBps: 10_000,
      runnerUp: null,
      runnerUpScoreBps: null,
      marginBps: null,
    });
  });

  test('scores each document atomically instead of combining aliases', () => {
    const result = resolve('김치찌개', rows(
      document('food-a-kimchi', 'food-a', '김치'),
      document('food-a-stew', 'food-a', '찌개'),
      document('food-b', 'food-b', '김치찌개', '찌개 및 전골류'),
    ));
    expect(result).toMatchObject({ kind: 'resolved', winner: { foodId: 'food-b' } });
  });

  test('records a known taxonomy contradiction without changing lexical retrieval membership', () => {
    const result = resolve('김치찌개', rows(
      document('stew', 'food-stew', '김치찌개', '찌개 및 전골류'),
    ), { category: '밥류' });
    expect(result).toMatchObject({
      kind: 'resolved',
      winner: { foodId: 'food-stew', evidence: { categoryContradiction: true } },
      review: { reasons: ['TAXONOMY_CONTRADICTION'] },
    });
  });

  test('does not promote the runner-up when later Food availability rejects the winner', () => {
    const result = resolve('김밥', rows(
      document('winner', 'food-winner', '김밥'),
      document('runner-up', 'food-runner-up', '김밥x'),
    ));
    const unavailable = requireAvailableLexicalWinner(result, (foodId) => foodId !== 'food-winner');
    expect(unavailable).toMatchObject({
      kind: 'unavailable',
      winner: { foodId: 'food-winner' },
      review: { reasons: expect.arrayContaining(['WINNING_FOOD_UNAVAILABLE']) },
    });
  });

  test('returns identical ordering and evidence for repeated resolution', () => {
    const data = rows(
      document('b', 'food-b', '비빔밥'),
      document('a', 'food-a', '비빔밥'),
      document('c', 'food-c', '김밥'),
    );
    expect(resolve('비빔밥', data)).toEqual(resolve('비빔밥', data));
  });
});
