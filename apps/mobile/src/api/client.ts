import { Platform } from 'react-native';

import { authClient } from '@/auth/client';
import { API_URL } from '@/config/environment';

export class ApiError extends Error {
  constructor(
    message = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');

  if (options.body !== undefined)
    headers.set('Content-Type', 'application/json');

  if (Platform.OS !== 'web') {
    const cookie = (
      authClient as unknown as { getCookie: () => string }
    ).getCookie();
    if (cookie) headers.set('Cookie', cookie);
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      credentials: Platform.OS === 'web' ? 'include' : undefined,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    throw new ApiError('네트워크 연결을 확인하고 다시 시도해 주세요.');
  }

  if (!response.ok) {
    if (response.status === 401)
      throw new ApiError('로그인 상태를 확인해 주세요.');
    try {
      const payload = (await response.json()) as {
        error?: { message?: unknown };
      };
      if (typeof payload.error?.message === 'string') {
        throw new ApiError(payload.error.message);
      }
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
    }
    throw new ApiError();
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError();
  }
}
