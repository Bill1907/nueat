export type RecognitionStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'manual';

export const RECOGNITION_MAX_ELAPSED_MS = 60_000;
const INITIAL_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 8_000;

export function isRecognitionTerminal(status: RecognitionStatus) {
  return status === 'ready' || status === 'failed' || status === 'manual';
}

export function recognitionPollDelay({
  status,
  attempt,
  elapsedMs,
  isAppActive,
}: {
  status: RecognitionStatus;
  attempt: number;
  elapsedMs: number;
  isAppActive: boolean;
}) {
  if (
    !isAppActive ||
    isRecognitionTerminal(status) ||
    elapsedMs >= RECOGNITION_MAX_ELAPSED_MS
  ) {
    return null;
  }

  const remainingMs = RECOGNITION_MAX_ELAPSED_MS - elapsedMs;
  return Math.min(
    INITIAL_POLL_DELAY_MS * 2 ** Math.max(0, attempt),
    MAX_POLL_DELAY_MS,
    remainingMs,
  );
}
