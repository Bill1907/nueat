export function normalizeKoreanFoodLabel(label: string) {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function isFoodMappingCurrent(
  recognizedLabel: string,
  food: { canonicalNameKo: string } | null,
) {
  return (
    food !== null &&
    normalizeKoreanFoodLabel(recognizedLabel) ===
      normalizeKoreanFoodLabel(food.canonicalNameKo)
  );
}
