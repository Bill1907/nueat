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
