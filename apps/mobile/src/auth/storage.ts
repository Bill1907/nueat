import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const webMemoryStorage = new Map<string, string>();

export const authStorage =
  Platform.OS === 'web'
    ? {
        getItem(key: string) {
          if (typeof localStorage === 'undefined') return webMemoryStorage.get(key) ?? null;
          return localStorage.getItem(key);
        },
        setItem(key: string, value: string) {
          if (typeof localStorage === 'undefined') {
            webMemoryStorage.set(key, value);
            return;
          }
          localStorage.setItem(key, value);
        },
      }
    : {
        getItem: SecureStore.getItem,
        setItem: SecureStore.setItem,
      };
