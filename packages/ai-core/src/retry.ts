export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCodes?: string[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

export function shouldRetry(code: string, policy: RetryPolicy): boolean {
  return !policy.retryableCodes || policy.retryableCodes.includes(code);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const code = error instanceof Error ? error.message.split(":")[0] ?? "" : "";
      if (attempt >= policy.maxAttempts || !shouldRetry(code, policy)) throw error;
      const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RETRY_FAILED");
}
