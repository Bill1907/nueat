export const CATALOG_AUTO_SELECTION_COMPARATOR_VERSION = 'catalog-auto-selection-comparator-v1';
export const CATALOG_AUTO_SELECTION_POLICY_VERSION = 'catalog-auto-selection-policy-v1';

export type CatalogAutoSelectionPolicy = {
  version: typeof CATALOG_AUTO_SELECTION_POLICY_VERSION;
  comparatorVersion: typeof CATALOG_AUTO_SELECTION_COMPARATOR_VERSION;
  minimumWinnerScoreBps: number;
  minimumMarginBps: number;
  identitySha256: string;
};

/** Immutable identity captured with the resolver result and compared at selection time. */
export type CatalogAutoSelectionStackIdentity = {
  activationId: string;
  catalogReleaseId: string;
  activationIdentitySha256: string;
};

export type CatalogAutoSelectionInput = {
  winner: { foodId: string; scoreBps: number; eligible: boolean };
  runnerUp: { foodId: string; scoreBps: number } | null;
  resolvedStack: CatalogAutoSelectionStackIdentity | null;
  currentStack: CatalogAutoSelectionStackIdentity | null;
  policy: CatalogAutoSelectionPolicy | null;
  verifiedPolicyIdentitySha256: string | null;
};

export type CatalogAutoSelectionReason =
  | 'RUNNER_UP_ABSENT'
  | 'INVALID_SCORE'
  | 'WINNER_NOT_STRICTLY_ORDERED'
  | 'WINNER_INELIGIBLE'
  | 'STACK_UNAVAILABLE'
  | 'STACK_STALE'
  | 'POLICY_UNAVAILABLE'
  | 'POLICY_UNTRUSTED'
  | 'WINNER_SCORE_BELOW_MINIMUM'
  | 'MARGIN_BELOW_MINIMUM';

export type CatalogAutoSelectionResult =
  | { kind: 'selected'; foodId: string; winnerScoreBps: number; runnerUpScoreBps: number; marginBps: number; comparatorVersion: typeof CATALOG_AUTO_SELECTION_COMPARATOR_VERSION; policyVersion: typeof CATALOG_AUTO_SELECTION_POLICY_VERSION }
  | { kind: 'abstain'; reason: CatalogAutoSelectionReason };

/**
 * Authorizes only an unambiguous, release-current lexical winner. Every failed
 * precondition abstains; callers must route abstentions to confirmation.
 */
export function selectCatalogAutomatically(input: CatalogAutoSelectionInput): CatalogAutoSelectionResult {
  const { winner, runnerUp, resolvedStack, currentStack, policy, verifiedPolicyIdentitySha256 } = input;
  if (!runnerUp) return abstain('RUNNER_UP_ABSENT');
  if (!isBps(winner.scoreBps) || !isBps(runnerUp.scoreBps)) return abstain('INVALID_SCORE');
  if (winner.foodId.length === 0 || runnerUp.foodId.length === 0 || winner.foodId === runnerUp.foodId || winner.scoreBps <= runnerUp.scoreBps) {
    return abstain('WINNER_NOT_STRICTLY_ORDERED');
  }
  if (!winner.eligible) return abstain('WINNER_INELIGIBLE');
  if (!resolvedStack || !currentStack || !isValidStack(resolvedStack) || !isValidStack(currentStack)) {
    return abstain('STACK_UNAVAILABLE');
  }
  if (!sameStack(resolvedStack, currentStack)) return abstain('STACK_STALE');
  if (!policy) return abstain('POLICY_UNAVAILABLE');
  if (!isValidPolicy(policy) || verifiedPolicyIdentitySha256 === null || policy.identitySha256 !== verifiedPolicyIdentitySha256) {
    return abstain('POLICY_UNTRUSTED');
  }

  const marginBps = winner.scoreBps - runnerUp.scoreBps;
  if (winner.scoreBps < policy.minimumWinnerScoreBps) return abstain('WINNER_SCORE_BELOW_MINIMUM');
  if (marginBps < policy.minimumMarginBps) return abstain('MARGIN_BELOW_MINIMUM');
  return {
    kind: 'selected',
    foodId: winner.foodId,
    winnerScoreBps: winner.scoreBps,
    runnerUpScoreBps: runnerUp.scoreBps,
    marginBps,
    comparatorVersion: CATALOG_AUTO_SELECTION_COMPARATOR_VERSION,
    policyVersion: CATALOG_AUTO_SELECTION_POLICY_VERSION,
  };
}

function isBps(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function sameStack(left: CatalogAutoSelectionStackIdentity, right: CatalogAutoSelectionStackIdentity) {
  return left.activationId === right.activationId &&
    left.catalogReleaseId === right.catalogReleaseId &&
    left.activationIdentitySha256 === right.activationIdentitySha256;
}

function isValidStack(stack: CatalogAutoSelectionStackIdentity) {
  return stack.activationId.length > 0 &&
    stack.catalogReleaseId.length > 0 &&
    /^[a-f0-9]{64}$/.test(stack.activationIdentitySha256);
}

function isValidPolicy(policy: CatalogAutoSelectionPolicy) {
  return policy.version === CATALOG_AUTO_SELECTION_POLICY_VERSION &&
    policy.comparatorVersion === CATALOG_AUTO_SELECTION_COMPARATOR_VERSION &&
    isBps(policy.minimumWinnerScoreBps) &&
    isBps(policy.minimumMarginBps) &&
    /^[a-f0-9]{64}$/.test(policy.identitySha256);
}

function abstain(reason: CatalogAutoSelectionReason): CatalogAutoSelectionResult {
  return { kind: 'abstain', reason };
}
