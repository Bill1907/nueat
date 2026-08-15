import type {
  ConfirmMealDraftInput,
  DraftMealLog,
  MealDraftItem,
  RecognitionRecovery,
} from '@/api/meal-drafts';

export type RecognitionStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'manual';

export const RECOGNITION_MAX_ELAPSED_MS = 60_000;
const INITIAL_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 8_000;

export function isRecognitionTerminal(status: RecognitionStatus) {
  return status === 'ready' || status === 'failed' || status === 'manual';
}

export function reviewReasonCopy(code: string) {
  const copy: Record<string, string> = {
    NO_FOOD_DETECTED: '사진에서 음식을 확인하지 못했어요. 새 사진을 찍거나 직접 입력해 주세요.',
    INSUFFICIENT_IMAGE_EVIDENCE: '사진 정보가 부족해요. 새 사진을 찍거나 직접 입력해 주세요.',
    IMAGE_QUALITY_LOW: '사진 품질이 낮아 음식과 양을 확인해 주세요.',

    FOOD_CONFIDENCE_LOW: '음식 이름을 확인해 주세요.',
    FOOD_CANDIDATE_MARGIN_LOW: '음식 후보를 확인해 주세요.',
    MODEL_FOOD_QUESTION: '음식 이름을 확인해 주세요.',
    INITIAL_ALTERNATIVE_MAPPING: '공식 음식 DB 연결을 확인해 주세요.',
    PORTION_CONFIDENCE_LOW: '양을 확인해 주세요.',
    MODEL_PORTION_QUESTION: '양을 확인해 주세요.',
    LEGACY_REVIEW_REQUIRED: '음식과 양을 확인해 주세요.',
    FOOD_MAPPING_MISSING: '공식 음식 DB에서 음식을 선택해 주세요.',
    FOOD_NOT_FOUND: '공식 음식 DB에서 다른 음식을 검색해 주세요.',
    FOOD_DEPRECATED: '사용할 수 없는 음식입니다. 다른 음식을 선택해 주세요.',
    NUTRIENT_PROFILE_MISSING: '공식 영양 정보를 다시 선택해 주세요.',
    NUTRIENT_PROFILE_MISMATCHED: '공식 영양 정보를 다시 선택해 주세요.',
    NUTRIENT_PROFILE_UNTRUSTED: '신뢰할 수 있는 공식 영양 정보를 선택해 주세요.',
    CORE_NUTRIENTS_MISSING: '필수 영양 정보가 있는 음식을 선택해 주세요.',
    SERVING_CONVERSION_MISSING: '양을 g 또는 지원되는 제공량으로 수정해 주세요.',
    SERVING_CONVERSION_AMBIGUOUS: '양을 g 또는 하나의 제공량으로 수정해 주세요.',
    SERVING_CONVERSION_UNTRUSTED: '신뢰할 수 있는 제공량으로 수정해 주세요.',
    CATALOG_SEARCH_EMPTY: '검색 결과가 없어요. 다른 검색어를 쓰거나 항목을 삭제해 주세요.',
    EMPTY_MEAL: '최소 한 개의 음식을 추가해 주세요.',
  };
  return copy[code] ?? '확인할 수 없는 항목이 있어 식사를 기록할 수 없어요.';
}

export function isRetakeReason(code: string) {
  return (
    code === 'NO_FOOD_DETECTED' ||
    code === 'INSUFFICIENT_IMAGE_EVIDENCE' ||
    code === 'no_food' ||
    code === 'insufficient_evidence'
  );
}

export function canAddMealDraftItem(
  status: RecognitionStatus,
  outcome: string | null,
) {
  return status === 'manual' || (status === 'ready' && outcome === 'recognized');
}

export type RecognitionRecoveryPolicy = {
  canRetryRecognition: boolean;
  canStartDirectEntry: boolean;
  retryLabel: string | null;
  showRefresh: boolean;
  showProgress: boolean;
  message: string;
};

const inProgressRecoveryPolicy: RecognitionRecoveryPolicy = {
  canRetryRecognition: false,
  canStartDirectEntry: false,
  retryLabel: null,
  showRefresh: false,
  showProgress: true,
  message: '사진에서 음식을 인식하고 있어요. 완료될 때까지 잠시만 기다려 주세요.',
};

const localTimeoutRecoveryPolicy: RecognitionRecoveryPolicy = {
  canRetryRecognition: false,
  canStartDirectEntry: true,
  retryLabel: null,
  showRefresh: true,
  showProgress: false,
  message: '분석에 시간이 더 걸리고 있어요. 새로고침하거나 직접 입력해 주세요.',
};

const unknownRecoveryPolicy: RecognitionRecoveryPolicy = {
  canRetryRecognition: false,
  canStartDirectEntry: true,
  retryLabel: null,
  showRefresh: true,
  showProgress: false,
  message: '인식 상태를 확인할 수 없어요. 새로고침하거나 직접 입력해 주세요.',
};

export function formatRecognitionRetryAt(
  retryAt: string,
  {
    locale = Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  }: { locale?: string; timeZone?: string } = {},
) {
  const date = new Date(retryAt);
  if (Number.isNaN(date.getTime())) return '잠시 후';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function createConfirmMealDraftInput(
  draft: {
    mealLog: Pick<DraftMealLog, 'draftRevision'>;
    items: Pick<
      MealDraftItem,
      'id' | 'itemRevision' | 'origin' | 'confirmationProof'
    >[];
  },
  idempotencyKey: string,
): ConfirmMealDraftInput | null {
  const items: ConfirmMealDraftInput['items'] = [];
  for (const item of draft.items) {
    const proof = item.confirmationProof;
    if (proof === null) {
      items.push({
        itemId: item.id,
        expectedItemRevision: item.itemRevision,
      });
      continue;
    }
    items.push({
      itemId: item.id,
      expectedItemRevision: item.itemRevision,
      mappingDecisionId: proof.mappingDecisionId,
      calculationPreviewId: proof.calculationPreviewId,
      ...(proof.decompositionRevisionId === undefined
        ? {}
        : { decompositionRevisionId: proof.decompositionRevisionId }),
    });
  }

  return {
    expectedDraftRevision: draft.mealLog.draftRevision,
    idempotencyKey,
    items,
  };
}

function isRecognitionRecovery(value: unknown): value is RecognitionRecovery {
  if (!value || typeof value !== 'object') return false;
  const recovery = value as Record<string, unknown>;
  if (recovery.mode === 'none') {
    return (
      recovery.retryAt === null &&
      (recovery.reason === 'in_progress' ||
        recovery.reason === 'recognition_complete' ||
        recovery.reason === 'not_applicable')
    );
  }
  if (recovery.mode === 'retry_now') {
    return recovery.reason === 'recoverable_failure' && recovery.retryAt === null;
  }
  if (recovery.mode === 'retry_after') {
    return (
      (recovery.reason === 'cooldown' || recovery.reason === 'daily_quota') &&
      typeof recovery.retryAt === 'string'
    );
  }
  return (
    recovery.mode === 'manual_only' &&
    recovery.retryAt === null &&
    (recovery.reason === 'asset_unavailable' ||
      recovery.reason === 'recovery_exhausted' ||
      recovery.reason === 'terminal_failure')
  );
}

export function deriveRecognitionRecoveryPolicy({
  recovery,
  localPollingTimedOut,
  recognitionStatus,
  hasStoredObservation = false,
}: {
  recovery: RecognitionRecovery | null | undefined | unknown;
  localPollingTimedOut: boolean;
  recognitionStatus?: RecognitionStatus;
  hasStoredObservation?: boolean;
}): RecognitionRecoveryPolicy {
  if (localPollingTimedOut) return localTimeoutRecoveryPolicy;
  if (!isRecognitionRecovery(recovery)) {
    if (
      hasStoredObservation ||
      recognitionStatus === 'ready'
    ) {
      return {
        canRetryRecognition: false,
        canStartDirectEntry: false,
        retryLabel: null,
        showRefresh: false,
        showProgress: false,
        message: '음식 인식 결과를 확인해 주세요. 인식 복구 기능은 현재 사용할 수 없어요.',
      };
    }
    if (
      recognitionStatus === 'pending' ||
      recognitionStatus === 'processing'
    ) return inProgressRecoveryPolicy;
    if (recognitionStatus === 'manual') {
      return {
        ...inProgressRecoveryPolicy,
        canStartDirectEntry: true,
        showProgress: false,
        message: '직접 입력으로 식사를 기록할 수 있어요.',
      };
    }
    return unknownRecoveryPolicy;
  }

  switch (recovery.mode) {
    case 'none':
      switch (recovery.reason) {
        case 'in_progress':
          return inProgressRecoveryPolicy;
        case 'recognition_complete':
          return {
            ...inProgressRecoveryPolicy,
            showProgress: false,
            message: '음식 인식 결과를 확인해 주세요.',
          };
        case 'not_applicable':
          return {
            ...inProgressRecoveryPolicy,
            showProgress: false,
            message: '직접 입력으로 식사를 기록할 수 있어요.',
          };
      }
    case 'retry_now':
      return {
        canRetryRecognition: true,
        canStartDirectEntry: true,
        retryLabel: '인식 다시 시도',
        showRefresh: false,
        showProgress: false,
        message: '음식 인식을 다시 시도하거나 직접 입력해 주세요.',
      };
    case 'retry_after': {
      const retryAt = formatRecognitionRetryAt(recovery.retryAt);
      return {
        canRetryRecognition: false,
        canStartDirectEntry: true,
        retryLabel: '다시 시도',
        showRefresh: false,
        showProgress: false,
        message:
          recovery.reason === 'cooldown'
            ? `잠시 후 다시 시도할 수 있어요: ${retryAt}`
            : `오늘의 인식 횟수를 모두 사용했어요. 다시 시도 가능: ${retryAt}`,
      };
    }
    case 'manual_only':
      switch (recovery.reason) {
        case 'asset_unavailable':
          return {
            canRetryRecognition: false,
            canStartDirectEntry: true,
            retryLabel: null,
            showRefresh: false,
            showProgress: false,
            message: '사진을 다시 분석할 수 없어 직접 입력해 주세요.',
          };
        case 'recovery_exhausted':
          return {
            canRetryRecognition: false,
            canStartDirectEntry: true,
            retryLabel: null,
            showRefresh: false,
            showProgress: false,
            message: '추가 인식 시도 없이 직접 입력해 주세요.',
          };
        case 'terminal_failure':
          return {
            canRetryRecognition: false,
            canStartDirectEntry: true,
            retryLabel: null,
            showRefresh: false,
            showProgress: false,
            message: '이 사진은 직접 입력으로 기록해 주세요.',
          };
      }
  }
}

export function recognitionPollDelay({
  status,
  attempt,
  elapsedMs,
  isAppActive,
}: {
  status: RecognitionStatus;
  attempt: number;
  elapsedMs: number;
  isAppActive: boolean;
}) {
  if (
    !isAppActive ||
    isRecognitionTerminal(status) ||
    elapsedMs >= RECOGNITION_MAX_ELAPSED_MS
  ) {
    return null;
  }

  const remainingMs = RECOGNITION_MAX_ELAPSED_MS - elapsedMs;
  return Math.min(
    INITIAL_POLL_DELAY_MS * 2 ** Math.max(0, attempt),
    MAX_POLL_DELAY_MS,
    remainingMs,
  );
}
