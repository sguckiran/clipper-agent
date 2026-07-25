/**
 * Small async retry helper with exponential backoff. Used for flaky network calls
 * (e.g. per-chunk transcription) so a single transient error doesn't fail a whole job.
 */
export interface RetryOptions {
  /** Number of retries after the first attempt (total attempts = retries + 1). */
  retries?: number;
  /** Base backoff in ms; delay for attempt n is baseDelayMs * 2^n. */
  baseDelayMs?: number;
  /** Called before each retry with the error and the upcoming attempt number. */
  onRetry?: (err: unknown, attempt: number) => void;
  /** Sleep function (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      opts.onRetry?.(err, attempt + 1);
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
