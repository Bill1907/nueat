import { GOAL_OPTIONS, LIMITED_REASON_LABELS } from '@nueat/domain';

export function goalLabel(goalType: string) {
  return GOAL_OPTIONS.find((option) => option.value === goalType)?.labelKo ?? goalType;
}

export function limitedReasonLabel(reason: string) {
  return LIMITED_REASON_LABELS[reason as keyof typeof LIMITED_REASON_LABELS] ?? reason;
}

export function formatKilocalories(millicalories: number) {
  return `${formatNumber(millicalories / 1_000)}kcal`;
}

export function formatGrams(milligrams: number) {
  return `${formatNumber(milligrams / 1_000)}g`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value);
}
