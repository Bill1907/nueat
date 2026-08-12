export function normalizeKoreanFoodLabel(label: string) {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function isFoodMappingCurrent(
  resolution: {
    status: 'resolved' | 'unresolved';
    reason?: string | null;
  } | null,
) {
  return resolution?.status === 'resolved';
}
