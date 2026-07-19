import { ModelConfig } from '../types';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const JITTER_RATIO = 0.2;

export interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestTimeoutMs: number;
}

export class LLMRequestError extends Error {
  constructor(
    message: string,
    public readonly options: {
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      code?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'LLMRequestError';
  }
}

export async function retryLLMCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  configured?: ModelConfig['retry']
): Promise<T> {
  const options = resolveRetryOptions(configured);
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new LLMRequestError(
        `模型调用超时（${options.requestTimeoutMs}ms）`,
        { retryable: true, code: 'LLM_TIMEOUT' }
      ));
    }, options.requestTimeoutMs);

    try {
      return await operation(controller.signal);
    } catch (error) {
      lastError = normalizeError(error, controller.signal);
      if (attempt >= options.maxAttempts || !isRetryableLLMError(lastError)) {
        throw lastError;
      }

      const delayMs = calculateDelay(attempt, options, lastError);
      console.warn(
        `LLM call failed (attempt ${attempt}/${options.maxAttempts}); retrying in ${delayMs}ms:`,
        errorMessage(lastError)
      );
      await delay(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export function isRetryableLLMError(error: unknown): boolean {
  if (error instanceof LLMRequestError) {
    if (error.options.retryable !== undefined) return error.options.retryable;
    if (error.options.status !== undefined) return isRetryableStatus(error.options.status);
  }

  const candidate = error as any;
  const status = Number(candidate?.status ?? candidate?.statusCode);
  if (Number.isFinite(status)) return isRetryableStatus(status);

  const code = String(candidate?.code || '').toUpperCase();
  if ([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET'
  ].includes(code)) return true;

  if (candidate?.name === 'AbortError' || candidate?.name === 'TimeoutError') return true;
  if (candidate instanceof TypeError && /fetch|network|socket|connect/i.test(candidate.message)) return true;

  return false;
}

export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function resolveRetryOptions(configured?: ModelConfig['retry']): ResolvedRetryOptions {
  const maxAttempts = positiveInteger(configured?.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = nonNegativeNumber(configured?.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = nonNegativeNumber(configured?.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const requestTimeoutMs = positiveInteger(
    configured?.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs: Math.max(baseDelayMs, maxDelayMs),
    requestTimeoutMs
  };
}

function calculateDelay(
  failedAttempt: number,
  options: ResolvedRetryOptions,
  error: unknown
): number {
  const retryAfterMs = error instanceof LLMRequestError
    ? error.options.retryAfterMs
    : undefined;
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, options.maxDelayMs);

  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * Math.pow(2, failedAttempt - 1)
  );
  if (exponential === 0) return 0;
  const jitter = exponential * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

function normalizeError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    return new LLMRequestError('模型调用已取消', {
      retryable: true,
      code: 'LLM_TIMEOUT',
      cause: error
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
