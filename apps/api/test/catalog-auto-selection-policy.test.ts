import { describe, expect, test } from 'bun:test';

import {
  CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
  CATALOG_AUTO_SELECTION_POLICY_VERSION,
  selectCatalogAutomatically,
  type CatalogAutoSelectionInput,
} from '../src/services/catalog-auto-selection-policy';

const sha = 'a'.repeat(64);
const stack = { activationId: 'activation-1', catalogReleaseId: 'release-1', activationIdentitySha256: sha };

function input(overrides: Partial<CatalogAutoSelectionInput> = {}): CatalogAutoSelectionInput {
  return {
    winner: { foodId: 'food-winner', scoreBps: 8_000, eligible: true },
    runnerUp: { foodId: 'food-runner-up', scoreBps: 7_000 },
    resolvedStack: stack,
    currentStack: stack,
    policy: {
      version: CATALOG_AUTO_SELECTION_POLICY_VERSION,
      comparatorVersion: CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
      minimumWinnerScoreBps: 8_000,
      minimumMarginBps: 1_000,
      identitySha256: sha,
    },
    verifiedPolicyIdentitySha256: sha,
    ...overrides,
  };
}

describe('catalog auto-selection policy', () => {
  test('selects at inclusive minimum winner score and margin with comparator evidence', () => {
    expect(selectCatalogAutomatically(input())).toEqual({
      kind: 'selected', foodId: 'food-winner', winnerScoreBps: 8_000, runnerUpScoreBps: 7_000, marginBps: 1_000,
      comparatorVersion: CATALOG_AUTO_SELECTION_COMPARATOR_VERSION, policyVersion: CATALOG_AUTO_SELECTION_POLICY_VERSION,
    });
  });

  test('abstains below either inclusive threshold', () => {
    expect(selectCatalogAutomatically(input({ winner: { foodId: 'food-winner', scoreBps: 7_999, eligible: true } }))).toEqual({ kind: 'abstain', reason: 'WINNER_SCORE_BELOW_MINIMUM' });
    expect(selectCatalogAutomatically(input({ runnerUp: { foodId: 'food-runner-up', scoreBps: 7_001 } }))).toEqual({ kind: 'abstain', reason: 'MARGIN_BELOW_MINIMUM' });
  });

  test('requires a distinct strictly lower runner-up', () => {
    expect(selectCatalogAutomatically(input({ runnerUp: { foodId: 'food-runner-up', scoreBps: 8_000 } }))).toEqual({ kind: 'abstain', reason: 'WINNER_NOT_STRICTLY_ORDERED' });
    expect(selectCatalogAutomatically(input({ runnerUp: { foodId: 'food-winner', scoreBps: 7_000 } }))).toEqual({ kind: 'abstain', reason: 'WINNER_NOT_STRICTLY_ORDERED' });
    expect(selectCatalogAutomatically(input({ runnerUp: null }))).toEqual({ kind: 'abstain', reason: 'RUNNER_UP_ABSENT' });
  });

  test('fails closed for ineligible, unavailable, stale, or untrusted evidence', () => {
    expect(selectCatalogAutomatically(input({ winner: { foodId: 'food-winner', scoreBps: 8_000, eligible: false } }))).toEqual({ kind: 'abstain', reason: 'WINNER_INELIGIBLE' });
    expect(selectCatalogAutomatically(input({ currentStack: null }))).toEqual({ kind: 'abstain', reason: 'STACK_UNAVAILABLE' });
    expect(selectCatalogAutomatically(input({ currentStack: { ...stack, activationId: 'activation-2' } }))).toEqual({ kind: 'abstain', reason: 'STACK_STALE' });
    expect(selectCatalogAutomatically(input({ verifiedPolicyIdentitySha256: 'b'.repeat(64) }))).toEqual({ kind: 'abstain', reason: 'POLICY_UNTRUSTED' });
  });
});
