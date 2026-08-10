export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type MealUnit = 'g' | 'ml' | 'serving' | 'bowl' | 'piece';

export function inferMealType(date: Date): MealType {
  const hour = date.getHours();
  if (hour >= 5 && hour <= 10) return 'breakfast';
  if (hour >= 11 && hour <= 15) return 'lunch';
  if (hour >= 16 && hour <= 21) return 'dinner';
  return 'snack';
}

export function decimalToMilliunits(value: string) {
  const amount = Number(value.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const milliunits = Math.round(amount * 1000);
  return milliunits > 0 && Number.isSafeInteger(milliunits) ? milliunits : null;
}

export function mealUnitLabel(unit: MealUnit) {
  switch (unit) {
    case 'serving':
      return '인분';
    case 'bowl':
      return '공기';
    case 'piece':
      return '조각';
    default:
      return unit;
  }
}
