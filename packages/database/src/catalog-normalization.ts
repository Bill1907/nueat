export const FOOD_NORMALIZER_VERSION = 'food-normalization-v1';

export type NormalizedFoodText = {
  spaced: string;
  compact: string;
  orderedTokens: string[];
  orderedTrigrams: string[];
};

export type NormalizationCollision<T> = {
  normalizedCompact: string;
  entries: readonly T[];
};

const separatorRun = /[\p{P}\p{S}\p{Z}\s]+/gu;

export function normalizeFoodText(input: string): NormalizedFoodText {
  // Remove symbols before NFKC so compatibility symbols such as ™ cannot
  // expand into ordinary letters and accidentally become searchable text.
  const spaced = input
    .replace(separatorRun, ' ')
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(separatorRun, ' ')
    .trim();
  const tokens = spaced === '' ? [] : spaced.split(' ');
  const compact = tokens.join('');

  return {
    spaced,
    compact,
    orderedTokens: [...tokens].sort(compareUtf8),
    orderedTrigrams: unicodeScalarTrigrams(`^^${compact}$`).sort(compareUtf8),
  };
}

export function reportNormalizationCollisions<T>(
  entries: readonly T[],
  textForEntry: (entry: T) => string,
): NormalizationCollision<T>[] {
  const entriesByCompact = new Map<string, T[]>();

  for (const entry of entries) {
    const compact = normalizeFoodText(textForEntry(entry)).compact;
    const matches = entriesByCompact.get(compact);
    if (matches) {
      matches.push(entry);
    } else {
      entriesByCompact.set(compact, [entry]);
    }
  }

  return [...entriesByCompact.entries()]
    .filter(([, matches]) => matches.length > 1)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([normalizedCompact, matches]) => ({ normalizedCompact, entries: matches }));
}

function unicodeScalarTrigrams(value: string): string[] {
  const scalars = Array.from(value);
  const trigrams: string[] = [];

  for (let index = 0; index <= scalars.length - 3; index += 1) {
    trigrams.push(scalars.slice(index, index + 3).join(''));
  }

  return trigrams;
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
