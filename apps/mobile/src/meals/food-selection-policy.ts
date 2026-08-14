export function normalizeKoreanFoodLabel(label: string) {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function isFoodMappingCurrent(item: {
  review: {
    status: 'current' | 'required';
    authority: { fingerprint: string | null };
  };
  origin: 'model_estimate' | 'manual_entry' | 'user_added' | 'legacy_unknown';
  confirmationProof: unknown | null;
  foodId: string | null;
  nutrientProfileId: string | null;
}) {
  return (
    item.review.status === 'current' &&
    (item.confirmationProof !== null ||
      (item.origin !== 'model_estimate' &&
        item.review.authority.fingerprint !== null &&
        item.foodId !== null &&
        item.nutrientProfileId !== null))
  );
}
