/**
 * Retry utility with exponential backoff for transient API failures.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 30000) */
  maxDelayMs?: number;
  /** Multiplier applied to delay after each retry (default: 2) */
  backoffMultiplier?: number;
  /** Optional callback invoked before each retry with the error and attempt number */
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Execute an async function with exponential backoff retries.
 *
 * Retries on any error by default. Use this to wrap transient API calls
 * (LLM providers, embedding services) that may fail due to rate limits,
 * network issues, or temporary outages.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30_000,
    backoffMultiplier = 2,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        break;
      }

      const delay = Math.min(initialDelayMs * backoffMultiplier ** attempt, maxDelayMs);
      onRetry?.(error, attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
