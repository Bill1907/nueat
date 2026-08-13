import { describe, expect, test } from 'bun:test';

import {
  MEAL_CONFIRMATION_CUTOVER_MODES,
  MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
  classifyMealConfirmationCutover,
} from '../src/services/meal-confirmation-cutover';

describe('classifyMealConfirmationCutover', () => {
  const retryAfterSeconds = 120;

  test.each([...MEAL_CONFIRMATION_CUTOVER_MODES])(
    'rejects a missing protocol in %s mode',
    (mode) => {
      expect(
        classifyMealConfirmationCutover(undefined, { mode, retryAfterSeconds }),
      ).toEqual({
        action: 'reject',
        statusCode: 426,
        errorCode: 'CLIENT_UPGRADE_REQUIRED',
        requiredProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
      });
    },
  );

  test.each([...MEAL_CONFIRMATION_CUTOVER_MODES])(
    'rejects an obsolete protocol in %s mode',
    (mode) => {
      expect(
        classifyMealConfirmationCutover('meal-confirmation-v1', {
          mode,
          retryAfterSeconds,
        }),
      ).toEqual({
        action: 'reject',
        statusCode: 426,
        errorCode: 'CLIENT_UPGRADE_REQUIRED',
        requiredProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
      });
    },
  );

  test('allows the exact protocol in normal mode', () => {
    expect(
      classifyMealConfirmationCutover(MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL, {
        mode: 'normal',
        retryAfterSeconds,
      }),
    ).toEqual({ action: 'proceed' });
  });

  test.each(['maintenance_bridge', 'safe_review_maintenance'])(
    'returns maintenance metadata for the exact protocol in %s mode',
    (mode) => {
      expect(
        classifyMealConfirmationCutover(MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL, {
          mode,
          retryAfterSeconds,
        }),
      ).toEqual({
        action: 'reject',
        statusCode: 503,
        errorCode: 'MEAL_CONFIRMATION_MAINTENANCE',
        retryAfterSeconds,
      });
    },
  );
});
