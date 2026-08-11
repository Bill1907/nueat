import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type PendingRecommendationDraftIntent = {
  recommendationId: string;
  candidateRank: 1 | 2 | 3;
};

const prefix = 'nueat.pending-recommendation-draft.';

export async function getPendingRecommendationDraftIntent(userId: string) {
  const raw = await getItem(key(userId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingRecommendationDraftIntent>;
    if (
      typeof value.recommendationId === 'string' &&
      (value.candidateRank === 1 || value.candidateRank === 2 || value.candidateRank === 3)
    ) {
      return value as PendingRecommendationDraftIntent;
    }
  } catch {
    // Invalid local state is discarded below.
  }
  await deleteItem(key(userId));
  return null;
}

export function setPendingRecommendationDraftIntent(
  userId: string,
  intent: PendingRecommendationDraftIntent,
) {
  return setItem(key(userId), JSON.stringify(intent));
}

export function clearPendingRecommendationDraftIntent(userId: string) {
  return deleteItem(key(userId));
}

function key(userId: string) {
  return `${prefix}${userId}`;
}

async function getItem(storageKey: string) {
  if (Platform.OS !== 'web') return SecureStore.getItemAsync(storageKey);
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
}

async function setItem(storageKey: string, value: string) {
  if (Platform.OS !== 'web') return SecureStore.setItemAsync(storageKey, value);
  if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, value);
}

async function deleteItem(storageKey: string) {
  if (Platform.OS !== 'web') return SecureStore.deleteItemAsync(storageKey);
  if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey);
}
