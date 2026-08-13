import { describe, expect, test } from 'bun:test';
import {
  FOOD_NORMALIZER_VERSION,
  normalizeFoodText,
  reportNormalizationCollisions,
} from './catalog-normalization';

describe('food-normalization-v1', () => {
  test('normalizes NFKC, Korean case, punctuation, symbols, and separators deterministically', () => {
    expect(FOOD_NORMALIZER_VERSION).toBe('food-normalization-v1');
    expect(normalizeFoodText(' ＣＡＦÉ—비빔_밥™  ')).toEqual({
      spaced: 'café 비빔 밥',
      compact: 'café비빔밥',
      orderedTokens: ['café', '밥', '비빔'],
      orderedTrigrams: ['^^c', '^ca', 'afé', 'caf', 'fé비', 'é비빔', '비빔밥', '빔밥$'],
    });
  });

  test('treats symbols as separators before producing Unicode-scalar trigrams', () => {
    expect(normalizeFoodText('🍚 밥').orderedTrigrams).toEqual(['^^밥', '^밥$']);
  });

  test('reports only deterministic compact-text collisions without mutating input', () => {
    const entries = [
      { id: 'one', label: '비빔-밥' },
      { id: 'two', label: '비빔 밥' },
      { id: 'three', label: '김밥' },
    ];

    expect(reportNormalizationCollisions(entries, (entry) => entry.label)).toEqual([
      { normalizedCompact: '비빔밥', entries: [entries[0]!, entries[1]!] },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['one', 'two', 'three']);
  });
});
