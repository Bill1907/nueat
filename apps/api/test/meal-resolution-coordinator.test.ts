import { describe, expect, test } from 'bun:test';

import {
  resolveAutomaticMappingSelection,
  type VerifiedCatalogAutoSelectionPolicy,
} from '../src/services/meal-resolution-coordinator';
import {
  CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
  CATALOG_AUTO_SELECTION_POLICY_VERSION,
} from '../src/services/catalog-auto-selection-policy';

const hash = 'a'.repeat(64);
const activation = { id: 'activation-1', catalogReleaseId: 'catalog-1', identitySha256: hash };
const winner = { foodId: 'food-1', scoreBps: 9_500, eligible: true };
const runnerUp = { foodId: 'food-2', scoreBps: 8_000 };
const verifiedPolicy: VerifiedCatalogAutoSelectionPolicy = {
  policy: {
    version: CATALOG_AUTO_SELECTION_POLICY_VERSION,
    comparatorVersion: CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
    minimumWinnerScoreBps: 9_000,
    minimumMarginBps: 1_000,
    identitySha256: hash,
  },
  verifiedPolicyIdentitySha256: hash,
};

describe('meal resolution coordinator automatic mapping', () => {
  test('requires a verified policy and otherwise abstains to review', () => {
    expect(resolveAutomaticMappingSelection({
      winner, runnerUp, activation, verifiedPolicy: null,
    })).toEqual({ kind: 'abstain', reason: 'POLICY_UNAVAILABLE' });
  });

  test('selects only when the supplied policy is verified and thresholds pass', () => {
    expect(resolveAutomaticMappingSelection({
      winner, runnerUp, activation, verifiedPolicy,
    })).toMatchObject({
      kind: 'selected',
      foodId: 'food-1',
      winnerScoreBps: 9_500,
      marginBps: 1_500,
    });
  });

  test('abstains when a supplied policy identity is not verified', () => {
    expect(resolveAutomaticMappingSelection({
      winner,
      runnerUp,
      activation,
      verifiedPolicy: { ...verifiedPolicy, verifiedPolicyIdentitySha256: 'b'.repeat(64) },
    })).toEqual({ kind: 'abstain', reason: 'POLICY_UNTRUSTED' });
  });
});
