/**
 * Phase 9: the provider-independent vocabulary of the AI layer.
 *
 * Everything above this file (routes, the AI service, the workspace UI) speaks
 * only these types. Everything below it (provider adapters) implements them.
 * That is the whole abstraction: one interface, one error class, no provider
 * response shapes leaking upward.
 *
 * The chain, top to bottom:
 *
 *   AI Workspace  →  AI Service (lib/ai/aiService.ts)
 *                      ↓ builds the request, normalizes errors
 *                   Provider Adapter (lib/ai/providers/*)
 *                      ↓ provider-specific HTTP
 *                   AI Provider (external service)
 */

/** Why an AI request failed, in provider-neutral terms. */
export type AiProviderErrorCode =
  // Configuration problems - the request never left the machine.
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'UNKNOWN_PROVIDER'
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'INVALID_MODEL'
  // Transport problems.
  | 'TIMEOUT'
  | 'NETWORK'
  // Provider-side problems.
  | 'RATE_LIMIT'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'EMPTY_RESPONSE'
  | 'UNKNOWN';

/**
 * A normalized AI failure.
 *
 * Adapters throw this instead of their own errors, and the AI service converts
 * it to an ApiError. The message is always user-facing and never contains the
 * API key, request headers, or a provider stack trace.
 */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(code: AiProviderErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AiProviderError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
  }
}

const DEFAULT_RETRYABLE = new Set<AiProviderErrorCode>(['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'PROVIDER_ERROR']);

/** Token usage, only ever populated when the provider actually reported it. */
export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** What an adapter receives. No project ids, no database, no file paths. */
export interface AiGenerateRequest {
  messages: AiMessage[];
  model: string;
  /** Server-side secret. Never logged, never returned, never stored by an adapter. */
  apiKey: string;
  /** Provider endpoint root (e.g. https://api.openai.com/v1). From server config only. */
  baseUrl: string;
  timeoutMs: number;
}

/** What an adapter returns, after normalizing the provider's response shape. */
export interface AiGenerateResult {
  text: string;
  usage: AiUsage | null;
  /** The model the provider reports it used; falls back to the requested model. */
  model: string;
}

/**
 * One registered provider. Adding a provider later means implementing this
 * interface and registering it in lib/ai/registry.ts - nothing else changes.
 */
export interface AiProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly defaultModel: string;
  /**
   * Suggested models for the picker. A suggestion list, never an allowlist:
   * self-hosted and compatible endpoints serve models this list cannot know.
   */
  readonly models: readonly string[];
  readonly defaultBaseUrl: string;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}

/** The public description of a provider - safe to send to the frontend. */
export interface AiProviderInfo {
  id: string;
  label: string;
  defaultModel: string;
  models: readonly string[];
}
