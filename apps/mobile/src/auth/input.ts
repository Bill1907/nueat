const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

export function normalizeOtp(value: string) {
  return value.replace(/\D/g, '').slice(0, 6);
}

export function isCompleteOtp(value: string) {
  return /^\d{6}$/.test(value);
}
