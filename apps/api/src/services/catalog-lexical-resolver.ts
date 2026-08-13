import { normalizeFoodText, FOOD_NORMALIZER_VERSION } from '@nueat/database/catalog-normalization';
import {
  CATALOG_CATEGORY_TO_V3_V1,
  CATALOG_PREPARATION_TO_V3_V1,
} from '@nueat/database/catalog-release';

export const CATALOG_LEXICAL_RESOLVER_VERSION = 'catalog-lexical-resolver-v3';
export const CATALOG_LEXICAL_TAXONOMY_VERSION = 'catalog-lexical-taxonomy-v3';

const SCORE_WEIGHTS_BPS = {
  tokenDice: 4_500,
  trigramDice: 3_500,
  category: 1_000,
  preparation: 1_000,
} as const;

type TaxonomyFamily =
  | 'staple'
  | 'soup_stew'
  | 'meat'
  | 'seafood'
  | 'vegetable'
  | 'noodle_dumpling'
  | 'snack_dessert'
  | 'beverage'
  | 'mixed'
  | 'unknown';

type PreparationFamily = 'raw' | 'boiled' | 'steamed' | 'grilled' | 'fried' | 'baked' | 'braised' | 'fermented' | 'mixed' | 'unknown';

export const CATALOG_LEXICAL_CATEGORY_FAMILIES: Readonly<Record<string, TaxonomyFamily>> = {
  staple: 'staple', soup_stew: 'soup_stew', meat: 'meat', seafood: 'seafood',
  vegetable: 'vegetable', noodle_dumpling: 'noodle_dumpling', snack_dessert: 'snack_dessert',
  beverage: 'beverage', mixed: 'mixed', unknown: 'unknown',
  ...CATALOG_CATEGORY_TO_V3_V1,
};

export const CATALOG_LEXICAL_PREPARATION_FAMILIES: Readonly<Record<string, PreparationFamily>> = {
  raw: 'raw', boiled: 'boiled', steamed: 'steamed', grilled: 'grilled', fried: 'fried',
  baked: 'baked', braised: 'braised', fermented: 'fermented', mixed: 'mixed', unknown: 'unknown',
  ...CATALOG_PREPARATION_TO_V3_V1,
};


export type CatalogLexicalObservation = {
  labelKo: string;
  category: string | null;
  preparation: string | readonly string[] | null;
};

export type CatalogSearchDocument = {
  id: string;
  catalogReleaseId: string;
  foodId: string;
  displayTextKo: string;
  normalizedCompact: string;
  orderedTokens: readonly string[];
  orderedTrigrams: readonly string[];
  normalizerVersion: string;
  category: string;
  preparation: string | null;
};

export type CatalogLexicalRows = {
  catalogRelease: { id: string; status: 'draft' | 'published' | 'revoked'; normalizerVersion: string } | null;
  documents: readonly CatalogSearchDocument[];
};

export interface CatalogLexicalQueryAdapter {
  load(catalogReleaseId: string): Promise<CatalogLexicalRows>;
}

export type CatalogLexicalReason =
  | 'CATALOG_RELEASE_UNAVAILABLE'
  | 'NORMALIZER_VERSION_MISMATCH'
  | 'NO_SEARCH_DOCUMENTS'
  | 'ZERO_LEXICAL_SCORE'
  | 'TAXONOMY_CONTRADICTION'
  | 'AMBIGUOUS_FOOD_SCORE'
  | 'LOW_SCORE_MARGIN'
  | 'WINNING_FOOD_UNAVAILABLE';

export type CatalogLexicalResolution = {
  kind: 'resolved';
  catalogReleaseId: string;
  winner: CatalogLexicalFoodCandidate;
  runnerUp: CatalogLexicalFoodCandidate | null;
  winnerScoreBps: number;
  runnerUpScoreBps: number | null;
  marginBps: number | null;
  candidates: CatalogLexicalFoodCandidate[];
  review: { reasons: CatalogLexicalReason[]; documentsScored: number; foodsScored: number };
};

export type CatalogLexicalUnavailable = {
  kind: 'unavailable';
  winner?: CatalogLexicalFoodCandidate;
  review: { reasons: CatalogLexicalReason[]; documentsScored: number; foodsScored: number };
};

export type CatalogLexicalResult = CatalogLexicalResolution | CatalogLexicalUnavailable;

export type CatalogLexicalFoodCandidate = {
  foodId: string;
  documentId: string;
  displayTextKo: string;
  scoreBps: number;
  evidence: CatalogLexicalEvidence;
};

export type CatalogLexicalEvidence = {
  exactCompactBps: number;
  tokenDiceBps: number;
  trigramDiceBps: number;
  categoryCompatibilityBps: number;
  preparationCompatibilityBps: number;
  categoryContradiction: boolean;
  preparationContradiction: boolean;
};

export async function resolveCatalogLexically(
  adapter: CatalogLexicalQueryAdapter,
  catalogReleaseId: string,
  observation: CatalogLexicalObservation,
  minimumMarginBps = 500,
): Promise<CatalogLexicalResult> {
  return resolveCatalogLexicalRows(catalogReleaseId, observation, await adapter.load(catalogReleaseId), minimumMarginBps);
}

/** Scores every document supplied by the one selected release. Eligibility is intentionally not consulted. */
export function resolveCatalogLexicalRows(
  catalogReleaseId: string,
  observation: CatalogLexicalObservation,
  rows: CatalogLexicalRows,
  minimumMarginBps = 500,
): CatalogLexicalResult {
  if (!rows.catalogRelease || rows.catalogRelease.id !== catalogReleaseId || rows.catalogRelease.status !== 'published') {
    return unavailable(['CATALOG_RELEASE_UNAVAILABLE']);
  }
  if (rows.catalogRelease.normalizerVersion !== FOOD_NORMALIZER_VERSION) return unavailable(['NORMALIZER_VERSION_MISMATCH']);
  if (rows.documents.length === 0) return unavailable(['NO_SEARCH_DOCUMENTS']);
  if (rows.documents.some((document) => document.catalogReleaseId !== catalogReleaseId || document.normalizerVersion !== FOOD_NORMALIZER_VERSION)) {
    return unavailable(['NORMALIZER_VERSION_MISMATCH']);
  }

  const query = normalizeFoodText(observation.labelKo);
  const candidates = rows.documents.map((document) => scoreDocument(query, observation, document));
  const documentWinners = new Map<string, CatalogLexicalFoodCandidate>();
  for (const candidate of candidates) {
    const prior = documentWinners.get(candidate.foodId);
    if (!prior || compareCandidates(candidate, prior) < 0) documentWinners.set(candidate.foodId, candidate);
  }
  const foods = [...documentWinners.values()].sort(compareCandidates);
  const winner = foods[0]!;
  const runnerUp = foods[1] ?? null;
  const winnerScoreBps = winner.scoreBps;
  const runnerUpScoreBps = runnerUp?.scoreBps ?? null;
  const marginBps = runnerUpScoreBps === null ? null : winnerScoreBps - runnerUpScoreBps;
  const reasons: CatalogLexicalReason[] = [];
  if (winner.scoreBps === 0) reasons.push('ZERO_LEXICAL_SCORE');
  if (winner.evidence.categoryContradiction || winner.evidence.preparationContradiction) reasons.push('TAXONOMY_CONTRADICTION');
  if (runnerUpScoreBps === winnerScoreBps) reasons.push('AMBIGUOUS_FOOD_SCORE');
  if (marginBps !== null && marginBps < minimumMarginBps) reasons.push('LOW_SCORE_MARGIN');
  return { kind: 'resolved', catalogReleaseId, winner, runnerUp, winnerScoreBps, runnerUpScoreBps, marginBps, candidates: foods.slice(0, 8), review: { reasons, documentsScored: candidates.length, foodsScored: foods.length } };
}

/** Availability is assessed only for the lexical winner; a failing winner never falls through to its runner-up. */
export function requireAvailableLexicalWinner(
  result: CatalogLexicalResult,
  isAvailable: (foodId: string) => boolean,
): CatalogLexicalResult {
  if (result.kind === 'unavailable' || isAvailable(result.winner.foodId)) return result;
  return {
    kind: 'unavailable',
    winner: result.winner,
    review: { ...result.review, reasons: [...result.review.reasons, 'WINNING_FOOD_UNAVAILABLE'] },
  };
}

export function positiveHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('positiveHalfUp requires a non-negative numerator and positive denominator');
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function scoreDocument(
  query: ReturnType<typeof normalizeFoodText>,
  observation: CatalogLexicalObservation,
  document: CatalogSearchDocument,
): CatalogLexicalFoodCandidate {
  const categoryCompatibility = compatibility(observation.category, document.category, CATALOG_LEXICAL_CATEGORY_FAMILIES);
  const preparationCompatibility = preparationCompatibilityFor(observation.preparation, document.preparation);
  const evidence = {
    exactCompactBps: query.compact !== '' && query.compact === document.normalizedCompact ? 10_000 : 0,
    tokenDiceBps: diceBps(query.orderedTokens, document.orderedTokens),
    trigramDiceBps: diceBps(query.orderedTrigrams, document.orderedTrigrams),
    categoryCompatibilityBps: categoryCompatibility.score,
    preparationCompatibilityBps: preparationCompatibility.score,
    categoryContradiction: categoryCompatibility.contradiction,
    preparationContradiction: preparationCompatibility.contradiction,
  };
  const scoreBps = evidence.exactCompactBps === 10_000 ? 10_000 : weightedScore(evidence);
  return { foodId: document.foodId, documentId: document.id, displayTextKo: document.displayTextKo, scoreBps, evidence };
}

function weightedScore(evidence: CatalogLexicalEvidence): number {
  const sum = BigInt(evidence.tokenDiceBps) * BigInt(SCORE_WEIGHTS_BPS.tokenDice)
    + BigInt(evidence.trigramDiceBps) * BigInt(SCORE_WEIGHTS_BPS.trigramDice)
    + BigInt(evidence.categoryCompatibilityBps) * BigInt(SCORE_WEIGHTS_BPS.category)
    + BigInt(evidence.preparationCompatibilityBps) * BigInt(SCORE_WEIGHTS_BPS.preparation);
  const penalty = evidence.categoryContradiction || evidence.preparationContradiction ? 3_000 : 0;
  return Math.max(0, Math.min(10_000, Number(positiveHalfUp(sum, 10_000n)) - penalty));
}

function diceBps(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  let leftIndex = 0;
  let rightIndex = 0;
  let intersection = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const comparison = compareUtf8(left[leftIndex]!, right[rightIndex]!);
    if (comparison === 0) { intersection += 1; leftIndex += 1; rightIndex += 1; }
    else if (comparison < 0) leftIndex += 1;
    else rightIndex += 1;
  }
  return Number(positiveHalfUp(BigInt(intersection * 20_000), BigInt(left.length + right.length)));
}

function compatibility<T extends string>(
  observed: string | null,
  candidate: string | null,
  families: Readonly<Record<string, T>>,
): { score: number; contradiction: boolean } {
  if (!observed || !candidate) return { score: 5_000, contradiction: false };
  const observationFamily = families[observed];
  const candidateFamily = families[candidate];
  if (!observationFamily || !candidateFamily) return { score: 5_000, contradiction: false };
  if (observationFamily === candidateFamily) return { score: 10_000, contradiction: false };
  if (observationFamily === 'unknown' || candidateFamily === 'unknown' || observationFamily === 'mixed' || candidateFamily === 'mixed')
    return { score: 5_000, contradiction: false };
  return { score: 0, contradiction: true };
}

function preparationCompatibilityFor(
  observed: string | readonly string[] | null,
  candidate: string | null,
): { score: number; contradiction: boolean } {
  const values = typeof observed === 'string' ? [observed] : observed;
  if (!values || values.length === 0 || !candidate) return { score: 5_000, contradiction: false };
  const scores = values.map((preparation) => compatibility(preparation, candidate, CATALOG_LEXICAL_PREPARATION_FAMILIES));
  if (scores.some((score) => score.contradiction)) return { score: 0, contradiction: true };
  if (scores.some((score) => score.score === 10_000)) return { score: 10_000, contradiction: false };
  return { score: 5_000, contradiction: false };
}

function compareCandidates(left: CatalogLexicalFoodCandidate, right: CatalogLexicalFoodCandidate): number {
  return right.scoreBps - left.scoreBps || compareUuidBytes(left.documentId, right.documentId) || compareUuidBytes(left.foodId, right.foodId);
}

function unavailable(reasons: CatalogLexicalReason[]): CatalogLexicalUnavailable {
  return { kind: 'unavailable', review: { reasons, documentsScored: 0, foodsScored: 0 } };
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

function compareUuidBytes(left: string, right: string): number {
  const leftBytes = uuidBytes(left);
  const rightBytes = uuidBytes(right);
  return leftBytes && rightBytes ? compareBytes(leftBytes, rightBytes) : compareUtf8(left, right);
}

function uuidBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return null;
  const compact = value.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
