const DEFAULT_API_URL = 'https://api-nueat.boseong.dev';

export const API_URL = normalizeApiUrl(process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_URL);

export function normalizeApiUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('EXPO_PUBLIC_API_URL must use HTTPS outside localhost');
  }
  return url.toString().replace(/\/$/, '');
}
