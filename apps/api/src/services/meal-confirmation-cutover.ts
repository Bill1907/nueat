export const MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL =
  'meal-confirmation-safe-review-v1';

export const MEAL_CONFIRMATION_CUTOVER_MODES = [
  'normal',
  'maintenance_bridge',
  'safe_review_maintenance',
] as const;

export type MealConfirmationCutoverMode =
  (typeof MEAL_CONFIRMATION_CUTOVER_MODES)[number];

export type MealConfirmationCutoverConfig = {
  mode: MealConfirmationCutoverMode;
  retryAfterSeconds: number;
};

export type MealConfirmationCutoverDecision =
  | {
      action: 'proceed';
    }
  | {
      action: 'reject';
      statusCode: 426;
      errorCode: 'CLIENT_UPGRADE_REQUIRED';
      requiredProtocol: typeof MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL;
    }
  | {
      action: 'reject';
      statusCode: 503;
      errorCode: 'MEAL_CONFIRMATION_MAINTENANCE';
      retryAfterSeconds: number;
    };

/**
 * Classifies a request before any meal-confirmation schema or persistence work.
 * The bridge mode deliberately depends only on the client protocol and config.
 */
export function classifyMealConfirmationCutover(
  clientProtocol: string | undefined,
  config: MealConfirmationCutoverConfig,
): MealConfirmationCutoverDecision {
  if (clientProtocol !== MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL) {
    return {
      action: 'reject',
      statusCode: 426,
      errorCode: 'CLIENT_UPGRADE_REQUIRED',
      requiredProtocol: MEAL_CONFIRMATION_SAFE_REVIEW_PROTOCOL,
    };
  }

  if (config.mode !== 'normal') {
    return {
      action: 'reject',
      statusCode: 503,
      errorCode: 'MEAL_CONFIRMATION_MAINTENANCE',
      retryAfterSeconds: config.retryAfterSeconds,
    };
  }

  return { action: 'proceed' };
}
