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
    QUICK_CONFIRM_POLICY_DISABLED: '이 식사는 확인 후 기록할 수 있어요.',
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

export function isCorrectionReviewReason(code: string) {
  return code !== 'QUICK_CONFIRM_POLICY_DISABLED';
}
const acknowledgeableReviewReasons = new Set([
  'IMAGE_QUALITY_LOW',
  'FOOD_CONFIDENCE_LOW',
  'FOOD_CANDIDATE_MARGIN_LOW',
  'MODEL_FOOD_QUESTION',
  'INITIAL_ALTERNATIVE_MAPPING',
  'PORTION_CONFIDENCE_LOW',
  'MODEL_PORTION_QUESTION',
  'LEGACY_REVIEW_REQUIRED',
]);

export function isAcknowledgeableReviewReason(code: string) {
  return acknowledgeableReviewReasons.has(code);
}

export function areReviewReasonsAcknowledgeable(codes: string[]) {
  const correctionReasons = codes.filter(isCorrectionReviewReason);
  return (
    correctionReasons.length > 0 &&
    correctionReasons.every(isAcknowledgeableReviewReason)
  );
}

export function deriveMealConfirmationActions(input: {
  reasonCodes: string[];
  reviewConfirmable: boolean;
  itemCount: number;
  allItemsResolved: boolean;
  hasUnsavedItemForms: boolean;
  hasManualForm: boolean;
}) {
  const hasCorrectionReasons = input.reasonCodes.some(isCorrectionReviewReason);
  const hasPolicyAcknowledgementOnly =
    input.reasonCodes.length > 0 && !hasCorrectionReasons;
  return {
    hasCorrectionReasons,
    hasPolicyAcknowledgementOnly,
    canConfirmMeal:
      input.itemCount > 0 &&
      input.allItemsResolved &&
      (input.reviewConfirmable || hasPolicyAcknowledgementOnly) &&
      !input.hasUnsavedItemForms &&
      !input.hasManualForm,
  };
}

type ReviewTransitionItem = {
  id: string;
  itemRevision: number;
  foodRevision: number;
  portionRevision: number;
  recognizedLabel: string;
  amountMilliunits: number;
  unit: string;
  recognitionRegionIndex: number | null;
  recognitionConfidenceBps: number | null;
  portionConfidenceBps: number | null;
  userCorrected: boolean;
  foodId: string | null;
  nutrientProfileId: string | null;
  mappingConfidenceBps: number | null;
  gramsMg: number | null;
  currentResolutionSource: string | null;
  foodAcknowledgedRevision: number | null;
  portionAcknowledgedRevision: number | null;
  origin: string;
  initialAssessment: unknown | null;
  currentResolution: {
    status: 'resolved' | 'unresolved';
    reason: string | null;
  } | null;
};

type TransitionMeal = {
  id: string;
  eatenAt: string;
  timezone: string;
  localDate: string;
  mealType: string;
  status: string;
  imageAssetId: string | null;
  recognitionStatus: RecognitionStatus;
  recognitionProvider: string | null;
  recognitionModel: string | null;
  recognitionPromptVersion: string | null;
  recognitionSchemaVersion: string | null;
  recognitionCompletedAt: string | null;
  recognitionLastErrorCode: string | null;
  recognitionAttemptCount: number;
  recognitionNextAttemptAt: string | null;
  draftRevision: number;
  confirmedAt: string | null;
  recognitionOutcome: string | null;
  recognitionEvidenceReason: string | null;
  recognitionManualOverride: unknown | null;
};

type ReviewTransitionDraft = {
  mealLog: TransitionMeal;
  items: ReviewTransitionItem[];
};

function hasSameMealState(current: TransitionMeal, previous: TransitionMeal) {
  return (
    current.id === previous.id &&
    current.eatenAt === previous.eatenAt &&
    current.timezone === previous.timezone &&
    current.localDate === previous.localDate &&
    current.mealType === previous.mealType &&
    current.status === previous.status &&
    current.imageAssetId === previous.imageAssetId &&
    current.recognitionStatus === previous.recognitionStatus &&
    current.recognitionProvider === previous.recognitionProvider &&
    current.recognitionModel === previous.recognitionModel &&
    current.recognitionPromptVersion === previous.recognitionPromptVersion &&
    current.recognitionSchemaVersion === previous.recognitionSchemaVersion &&
    current.recognitionCompletedAt === previous.recognitionCompletedAt &&
    current.recognitionLastErrorCode === previous.recognitionLastErrorCode &&
    current.recognitionAttemptCount === previous.recognitionAttemptCount &&
    current.confirmedAt === previous.confirmedAt &&
    current.recognitionNextAttemptAt === previous.recognitionNextAttemptAt &&
    current.recognitionOutcome === previous.recognitionOutcome &&
    current.recognitionEvidenceReason === previous.recognitionEvidenceReason &&
    hasSameStructuredValue(
      current.recognitionManualOverride,
      previous.recognitionManualOverride,
    )
  );
}

export function isExactReviewTransition(
  latest: ReviewTransitionDraft,
  baseline: ReviewTransitionDraft,
  input: {
    expectedDraftRevision: number;
    items: {
      itemId: string;
      expectedItemRevision: number;
      foodAcknowledgedRevision?: number;
      portionAcknowledgedRevision?: number;
    }[];
  },
) {
  if (
    baseline.mealLog.draftRevision !== input.expectedDraftRevision ||
    latest.mealLog.draftRevision !== baseline.mealLog.draftRevision + 1 ||
    !hasSameMealState(latest.mealLog, baseline.mealLog) ||
    latest.items.length !== baseline.items.length
  ) {
    return false;
  }
  const targets = new Map(input.items.map((item) => [item.itemId, item]));
  if (
    targets.size !== input.items.length ||
    input.items.some((target) => !baseline.items.some((item) => item.id === target.itemId))
  ) {
    return false;
  }
  return baseline.items.every((previous) => {
    const current = latest.items.find((item) => item.id === previous.id);
    if (!current) return false;
    const target = targets.get(previous.id);
    if (target && target.expectedItemRevision !== previous.itemRevision) return false;
    const expectedItemRevision = target
      ? previous.itemRevision + 1
      : previous.itemRevision;
    const expectedFoodAcknowledgement =
      target?.foodAcknowledgedRevision ?? previous.foodAcknowledgedRevision;
    const expectedPortionAcknowledgement =
      target?.portionAcknowledgedRevision ?? previous.portionAcknowledgedRevision;
    if (!target) return hasSameItemState(current, previous);
    return (
      current.itemRevision === expectedItemRevision &&
      current.foodRevision === previous.foodRevision &&
      current.portionRevision === previous.portionRevision &&
      current.recognizedLabel === previous.recognizedLabel &&
      current.amountMilliunits === previous.amountMilliunits &&
      current.unit === previous.unit &&
      current.recognitionRegionIndex === previous.recognitionRegionIndex &&
      current.recognitionConfidenceBps === previous.recognitionConfidenceBps &&
      current.portionConfidenceBps === previous.portionConfidenceBps &&
      current.userCorrected === previous.userCorrected &&
      current.foodId === previous.foodId &&
      current.nutrientProfileId === previous.nutrientProfileId &&
      current.mappingConfidenceBps === previous.mappingConfidenceBps &&
      current.gramsMg === previous.gramsMg &&
      current.currentResolutionSource === previous.currentResolutionSource &&
      current.foodAcknowledgedRevision === expectedFoodAcknowledgement &&
      current.portionAcknowledgedRevision === expectedPortionAcknowledgement &&
      current.origin === previous.origin &&
      hasSameStructuredValue(current.initialAssessment, previous.initialAssessment) &&
      hasSameStructuredValue(current.currentResolution, previous.currentResolution)
    );
  });
}

type MutationTransitionItem = ReviewTransitionItem;

type MutationTransitionDraft = {
  mealLog: TransitionMeal;
  items: MutationTransitionItem[];
};

function hasSameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => hasSameStructuredValue(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        hasSameStructuredValue(leftRecord[key], rightRecord[key]),
    )
  );
}
function hasSameItemState(current: MutationTransitionItem, previous: MutationTransitionItem) {
  return (
    current.itemRevision === previous.itemRevision &&
    current.foodRevision === previous.foodRevision &&
    current.portionRevision === previous.portionRevision &&
    current.recognizedLabel === previous.recognizedLabel &&
    current.amountMilliunits === previous.amountMilliunits &&
    current.unit === previous.unit &&
    current.recognitionConfidenceBps === previous.recognitionConfidenceBps &&
    current.portionConfidenceBps === previous.portionConfidenceBps &&
    current.recognitionRegionIndex === previous.recognitionRegionIndex &&
    current.userCorrected === previous.userCorrected &&
    current.foodId === previous.foodId &&
    current.nutrientProfileId === previous.nutrientProfileId &&
    current.mappingConfidenceBps === previous.mappingConfidenceBps &&
    current.gramsMg === previous.gramsMg &&
    current.currentResolutionSource === previous.currentResolutionSource &&
    current.foodAcknowledgedRevision === previous.foodAcknowledgedRevision &&
    current.portionAcknowledgedRevision === previous.portionAcknowledgedRevision &&
    current.origin === previous.origin &&
    hasSameStructuredValue(current.initialAssessment, previous.initialAssessment) &&
    hasSameStructuredValue(current.currentResolution, previous.currentResolution)
  );
}

function hasExactUnchangedItems(
  latest: MutationTransitionDraft,
  baseline: MutationTransitionDraft,
  targetItemId: string,
) {
  return baseline.items.every((previous) => {
    if (previous.id === targetItemId) return true;
    const current = latest.items.find((item) => item.id === previous.id);
    return current ? hasSameItemState(current, previous) : false;
  });
}

export function isExactItemUpdateTransition(
  latest: MutationTransitionDraft,
  baseline: MutationTransitionDraft,
  input: {
    itemId: string;
    expectedItemRevision: number;
    recognizedLabel?: string;
    amountMilliunits?: number;
    unit?: string;
  },
) {
  const previous = baseline.items.find((item) => item.id === input.itemId);
  const current = latest.items.find((item) => item.id === input.itemId);
  if (
    !previous ||
    !current ||
    previous.itemRevision !== input.expectedItemRevision ||
    latest.mealLog.draftRevision !== baseline.mealLog.draftRevision + 1 ||
    !hasSameMealState(latest.mealLog, baseline.mealLog) ||
    latest.items.length !== baseline.items.length ||
    !hasExactUnchangedItems(latest, baseline, input.itemId)
  ) {
    return false;
  }
  const foodChanged =
    input.recognizedLabel !== undefined &&
    input.recognizedLabel !== previous.recognizedLabel;
  const portionChanged =
    (input.amountMilliunits !== undefined &&
      input.amountMilliunits !== previous.amountMilliunits) ||
    (input.unit !== undefined && input.unit !== previous.unit);
  const unitChanged = input.unit !== undefined && input.unit !== previous.unit;
  if (!foodChanged && !portionChanged) return false;
  if (unitChanged) return false;
  return (
    current.itemRevision === previous.itemRevision + 1 &&
    current.foodRevision === previous.foodRevision + Number(foodChanged) &&
    current.portionRevision === previous.portionRevision + Number(portionChanged) &&
    current.recognizedLabel ===
      (foodChanged ? input.recognizedLabel : previous.recognizedLabel) &&
    current.amountMilliunits ===
      (input.amountMilliunits ?? previous.amountMilliunits) &&
    current.unit === (input.unit ?? previous.unit) &&
    current.recognitionRegionIndex === previous.recognitionRegionIndex &&
    current.recognitionConfidenceBps === previous.recognitionConfidenceBps &&
    current.portionConfidenceBps === previous.portionConfidenceBps &&
    current.userCorrected === true &&
    current.foodId === (foodChanged ? null : previous.foodId) &&
    current.nutrientProfileId ===
      (foodChanged ? null : previous.nutrientProfileId) &&
    current.mappingConfidenceBps ===
      (foodChanged ? null : previous.mappingConfidenceBps) &&
    current.gramsMg === previous.gramsMg &&
    current.currentResolutionSource ===
      (foodChanged ? null : previous.currentResolutionSource) &&
    current.foodAcknowledgedRevision ===
      (foodChanged ? null : previous.foodAcknowledgedRevision) &&
    current.portionAcknowledgedRevision ===
      (portionChanged ? current.portionRevision : previous.portionAcknowledgedRevision) &&
    current.origin === previous.origin &&
    hasSameStructuredValue(current.initialAssessment, previous.initialAssessment) &&
    (foodChanged
      ? current.currentResolution?.status === 'unresolved' &&
        current.currentResolution.reason === 'FOOD_MAPPING_MISSING'
      : hasSameStructuredValue(current.currentResolution, previous.currentResolution))
  );
}

export function isExactFoodMappingTransition(
  latest: MutationTransitionDraft,
  baseline: MutationTransitionDraft,
  input: {
    itemId: string;
    expectedItemRevision: number;
    foodId: string;
    recognizedLabel: string;
    nutrientProfileId: string;
  },
) {
  const previous = baseline.items.find((item) => item.id === input.itemId);
  const current = latest.items.find((item) => item.id === input.itemId);
  return Boolean(
    previous &&
      current &&
      previous.itemRevision === input.expectedItemRevision &&
      latest.mealLog.draftRevision === baseline.mealLog.draftRevision + 1 &&
      hasSameMealState(latest.mealLog, baseline.mealLog) &&
      latest.items.length === baseline.items.length &&
      hasExactUnchangedItems(latest, baseline, input.itemId) &&
      current.itemRevision === previous.itemRevision + 1 &&
      current.foodRevision === previous.foodRevision + 1 &&
      current.portionRevision === previous.portionRevision &&
      current.recognizedLabel === input.recognizedLabel &&
      current.foodId === input.foodId &&
      current.nutrientProfileId !== null &&
      current.nutrientProfileId === input.nutrientProfileId &&
      current.mappingConfidenceBps === 10_000 &&
      current.foodAcknowledgedRevision === current.foodRevision &&
      current.recognitionRegionIndex === previous.recognitionRegionIndex &&
      current.recognitionConfidenceBps === previous.recognitionConfidenceBps &&
      current.portionConfidenceBps === previous.portionConfidenceBps &&
      current.userCorrected === true &&
      current.gramsMg === previous.gramsMg &&
      current.currentResolutionSource === 'user_selected' &&
      current.amountMilliunits === previous.amountMilliunits &&
      current.unit === previous.unit &&
      current.portionAcknowledgedRevision === previous.portionAcknowledgedRevision &&
      current.origin === previous.origin &&
      hasSameStructuredValue(current.initialAssessment, previous.initialAssessment) &&
      current.currentResolution?.status === 'resolved' &&
      current.currentResolution.reason === null
  );
}

export function isExactItemDeleteTransition(
  latest: MutationTransitionDraft,
  baseline: MutationTransitionDraft,
  input: {
    itemId: string;
    expectedDraftRevision: number;
    expectedItemRevision: number;
  },
) {
  const previous = baseline.items.find((item) => item.id === input.itemId);
  return Boolean(
    previous &&
      baseline.mealLog.draftRevision === input.expectedDraftRevision &&
      previous.itemRevision === input.expectedItemRevision &&
      latest.mealLog.draftRevision === baseline.mealLog.draftRevision + 1 &&
      hasSameMealState(latest.mealLog, baseline.mealLog) &&
      latest.items.length === baseline.items.length - 1 &&
      !latest.items.some((item) => item.id === input.itemId) &&
      hasExactUnchangedItems(latest, baseline, input.itemId)
  );
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
