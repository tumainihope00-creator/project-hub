import { AiProviderError, type AiGenerateRequest, type AiGenerateResult, type AiProviderAdapter } from '../types.js';

/**
 * Phase 9: the first provider adapter - the OpenAI Chat Completions API.
 *
 * "OpenAI" is chosen because it is the protocol most compatible endpoints
 * already speak: api.openai.com, OpenRouter, DeepSeek, Groq, and local servers
 * such as LM Studio or Ollama's OpenAI-compatible route all answer the same
 * `POST {baseUrl}/chat/completions`. One adapter therefore covers the current
 * need and a realistic path to local/offline inference, while the registry
 * keeps the door open for a genuinely different provider later.
 *
 * Implemented with the platform `fetch` (Node 18+), so the backend gains no SDK
 * dependency and no provider client is ever constructed outside this file.
 *
 * What lives here and nowhere else: the Authorization header, the request body
 * shape, the response parsing, and the translation of provider HTTP statuses
 * into AiProviderError codes. The API key is read from the request, sent in
 * one header, and never logged, thrown or embedded in a message.
 */
export const openAiAdapter: AiProviderAdapter = {
  id: 'openai',
  label: 'OpenAI (or compatible)',
  defaultModel: 'gpt-4o-mini',
  models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  defaultBaseUrl: 'https://api.openai.com/v1',

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const url = `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AiProviderError(
          'TIMEOUT',
          `The AI provider did not answer within ${Math.round(request.timeoutMs / 1000)} seconds.`,
          { cause: err }
        );
      }
      throw networkError(err);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await httpError(response, request);

    let payload: unknown;
    const raw = await response.text();
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      throw new AiProviderError('MALFORMED_RESPONSE', 'The AI provider returned a response that is not valid JSON.', {
        cause: err
      });
    }

    const message = extractContent(payload);
    if (message === null) {
      throw new AiProviderError('MALFORMED_RESPONSE', 'The AI provider returned a response in an unexpected shape.');
    }
    if (message.trim().length === 0) {
      throw new AiProviderError('EMPTY_RESPONSE', 'The AI provider returned an empty response.');
    }

    const usage = extractUsage(payload);
    const reportedModel =
      typeof (payload as { model?: unknown } | null)?.model === 'string' && (payload as { model: string }).model
        ? (payload as { model: string }).model
        : request.model;

    return { text: message, usage, model: reportedModel };
  }
};

/** `choices[0].message.content` - the one field every compatible server fills. */
function extractContent(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = (choices[0] as { message?: { content?: unknown } } | null)?.message?.content;
  return typeof content === 'string' ? content : null;
}

/** Map `usage.*` when present; null when the provider sent none (never invented). */
function extractUsage(payload: unknown): AiGenerateResult['usage'] {
  const usage = (payload as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const inputTokens = num(u.prompt_tokens);
  const outputTokens = num(u.completion_tokens);
  const totalTokens = num(u.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Translate a non-2xx HTTP response into a normalized error.
 *
 * The provider's own message is passed through (trimmed and clipped) because it
 * is genuinely useful - "model not found", "quota exceeded" - but it is data
 * from an untrusted remote party, so it is length-capped and never allowed to
 * carry the request headers back with it.
 */
async function httpError(response: Response, request: AiGenerateRequest): Promise<AiProviderError> {
  const status = response.status;
  let providerMessage = '';
  try {
    const body = (await response.json()) as { error?: { message?: unknown } } | null;
    if (typeof body?.error?.message === 'string') providerMessage = body.error.message.trim().slice(0, 300);
  } catch {
    // A provider that answers with plain text or HTML gets the status line only.
  }
  const detail = providerMessage ? ` Provider message: ${providerMessage}` : '';

  if (status === 401 || status === 403) {
    return new AiProviderError(
      'INVALID_API_KEY',
      `The AI provider rejected the configured API key (HTTP ${status}).${detail} Check AI_PROVIDER_API_KEY and replace it if it has expired.`
    );
  }
  if (status === 429) {
    return new AiProviderError('RATE_LIMIT', `The AI provider rate-limited the request (HTTP 429).${detail}`, {
      retryable: true
    });
  }
  if (status === 400 || status === 404 || status === 422) {
    const looksLikeModel = /model|model_not_found|does not exist|unsupported/i.test(providerMessage);
    if (looksLikeModel) {
      return new AiProviderError(
        'INVALID_MODEL',
        `The AI provider did not accept the model "${request.model}".${detail} Pick another model in the AI settings or workspace.`
      );
    }
    return new AiProviderError('PROVIDER_ERROR', `The AI provider rejected the request (HTTP ${status}).${detail}`);
  }
  if (status >= 500) {
    return new AiProviderError('PROVIDER_ERROR', `The AI provider reported a server error (HTTP ${status}).${detail}`, {
      retryable: true
    });
  }
  return new AiProviderError('PROVIDER_ERROR', `The AI provider returned an unexpected status (HTTP ${status}).${detail}`);
}

/**
 * Connection-class failures get one honest, user-facing message. Offline and
 * "provider host unreachable" are the same failure from the user's point of
 * view: the request could not leave the machine.
 */
function networkError(err: unknown): AiProviderError {
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code ?? (err as { code?: string } | null)?.code ?? '';
  const detail =
    code && /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR/.test(code)
      ? ` (${code})`
      : '';
  return new AiProviderError(
    'NETWORK',
    `The AI provider could not be reached. Project Hub appears to be offline or the provider is unavailable${detail}.`,
    { retryable: true, cause: err }
  );
}
