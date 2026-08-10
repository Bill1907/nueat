import { expoClient } from '@better-auth/expo/client';
import type { BetterAuthClientPlugin } from 'better-auth/client';
import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

import { authStorage } from './storage';

import { API_URL } from '@/config/environment';

const expoAuthClient = expoClient({
  scheme: 'nueat',
  storage: authStorage,
  storagePrefix: 'nueat-auth',
  cookiePrefix: 'better-auth',
}) as unknown as BetterAuthClientPlugin;

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [emailOTPClient(), expoAuthClient],
});

export interface AuthSessionData {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
  };
  session: {
    id: string;
    expiresAt: Date;
  };
}

export function useAuthSession() {
  // @better-auth/expo 1.6.26 widens the generic plugin type under TypeScript 6.
  // Keep the compatibility cast isolated until the upstream client types converge.
  return authClient.useSession() as unknown as {
    data: AuthSessionData | null;
    isPending: boolean;
    error: Error | null;
  };
}
