export function isInRecognitionCohort(userId: string, percent: number) {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 100 < percent;
}
