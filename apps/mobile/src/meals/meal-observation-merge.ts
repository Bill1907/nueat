import type { MealDraftItem, MealUnit } from '@/api/meal-drafts';

export type MealDraftItemForm = {
  recognizedLabel: string;
  amount: string;
  unit: MealUnit;
};

export function formsFromMealDraftItems(
  items: MealDraftItem[],
): Record<string, MealDraftItemForm> {
  return Object.fromEntries(items.map((item) => [item.id, formFromItem(item)]));
}

/** Keeps locally edited fields while accepting new immutable observations. */
export function mergeObservationRefreshForms(
  current: Record<string, MealDraftItemForm>,
  previousItems: MealDraftItem[],
  nextItems: MealDraftItem[],
): Record<string, MealDraftItemForm> {
  const previous = formsFromMealDraftItems(previousItems);
  return Object.fromEntries(nextItems.map((item) => {
    const incoming = formFromItem(item);
    const prior = previous[item.id];
    const local = current[item.id];
    if (!prior || !local) return [item.id, incoming];
    return [item.id, {
      recognizedLabel:
        local.recognizedLabel === prior.recognizedLabel
          ? incoming.recognizedLabel
          : local.recognizedLabel,
      amount: local.amount === prior.amount ? incoming.amount : local.amount,
      unit: local.unit === prior.unit ? incoming.unit : local.unit,
    }];
  }));
}

function formFromItem(item: MealDraftItem): MealDraftItemForm {
  return {
    recognizedLabel: item.recognizedLabel,
    amount: (item.amountMilliunits / 1000).toString(),
    unit: item.unit,
  };
}
