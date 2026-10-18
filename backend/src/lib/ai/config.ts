import { prisma } from '../prisma.js';
import { DEFAULT_PROVIDER_ID, getAiProvider, listAiProviders } from './registry.js';
import type { AiProviderInfo } from './types.js';

/**
 * Phase 9: AI configuration and status.
 *
 * Where each value comes from, in precedence order:
 *
 *   API key        env AI_PROVIDER_API_KEY  →  app_settings `ai_api_key`
 *   provider       app_settings `ai_provider`  →  env AI_PROVIDER  →  'openai'
 *   default model  app_settings `ai_model`     →  env AI_MODEL     →  provider default
 *   enabled        app_settings `ai_enabled`   →  env AI_ENABLED   →  true
 *   timeout        app_settings `ai_timeout_ms`→  env AI_TIMEOUT_MS →  60000
 *   base URL       env AI_BASE_URL             →  provider default
 *   max response   env AI_MAX_RESPONSE_CHARS   →  200000
 *
 * Design rules, all load-bearing:
 *
 *  - The API key is a secret read from server-side configuration only. It is
 *    never returned by any function here; callers get `apiKeyConfigured` and
 *    `apiKeySource`, which is everything the UI needs to say "Configured ✓".
 *  - The base URL is environment-only on purpose: a client-supplied URL would
 *    turn the backend into an open relay that posts secrets to attacker-chosen
 *    hosts, so no request body or query string can ever set it.
 *  - app_settings holds the user-tunable values (provider, model, enabled,
 *    timeout, optional stored key) under fixed, known keys - the same
 *    key/value table the Projects Root already uses. There is still no generic
 *    "set any key" endpoint.
 *  - Nothing here is read at module load: every value is re-read per request,
 *    so a settings change or an env edit takes effect without a restart for the
 *    stored values, and tests can control the environment precisely.
 */

export const AI_SETTING_KEYS = {
  provider: 'ai_provider',
  model: 'ai_model',
  enabled: 'ai_enabled',
  timeoutMs: 'ai_timeout_ms',
  apiKey: 'ai_api_key'
} as const;

export const AI_ENV = {
  apiKey: 'AI_PROVIDER_API_KEY',
  provider: 'AI_PROVIDER',
  model: 'AI_MODEL',
  enabled: 'AI_ENABLED',
  timeoutMs: 'AI_TIMEOUT_MS',
  baseUrl: 'AI_BASE_URL',
  maxResponseChars: 'AI_MAX_RESPONSE_CHARS'
} as const;

export const TIMEOUT_MIN_MS = 1_000;
export const TIMEOUT_MAX_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_CHARS = 200_000;
const MAX_KEY_LENGTH = 500;

export type AiKeySource = 'environment' | 'application' | null;

/** Everything the UI may see about the configuration. Never contains the key. */
export interface AiSettingsView {
  provider: string;
  providerLabel: string | null;
  model: string;
  enabled: boolean;
  timeoutMs: number;
  /** Read-only: response cap is an environment concern (AI_MAX_RESPONSE_CHARS). */
  maxResponseChars: number;
  /** Read-only: whether AI_BASE_URL overrides the provider's default endpoint. */
  baseUrlSource: 'environment' | 'provider_default';
  apiKeyConfigured: boolean;
  /** Which configuration currently holds the active key. null = none. */
  apiKeySource: AiKeySource;
}

export interface AiStatus extends AiSettingsView {
  /** True only when a request could actually be attempted right now. */
  configured: boolean;
  /** Why not configured, when it is not. null when it is. */
  reason: 'disabled' | 'missing_api_key' | 'unknown_provider' | null;
  providers: AiProviderInfo[];
}

/** The resolved, secret-bearing configuration. Server-side use only. */
export interface AiRuntimeConfig {
  providerId: string;
  providerLabel: string | null;
  model: string;
  enabled: boolean;
  apiKey: string | null;
  apiKeySource: AiKeySource;
  baseUrl: string;
  timeoutMs: number;
  maxResponseChars: number;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function envFlag(name: string): boolean | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

async function readStored(): Promise<Record<string, string>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: Object.values(AI_SETTING_KEYS) } }
  });
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/** Resolve the effective configuration without ever exposing the key value. */
export async function resolveAiConfig(): Promise<AiRuntimeConfig> {
  const stored = await readStored();

  const providerId =
    stored[AI_SETTING_KEYS.provider]?.trim() ||
    process.env[AI_ENV.provider]?.trim() ||
    DEFAULT_PROVIDER_ID;

  const adapter = getAiProvider(providerId);
  const model =
    stored[AI_SETTING_KEYS.model]?.trim() ||
    process.env[AI_ENV.model]?.trim() ||
    adapter?.defaultModel ||
    '';

  const storedEnabled = stored[AI_SETTING_KEYS.enabled];
  const enabled =
    storedEnabled !== undefined ? storedEnabled === 'true' : (envFlag(AI_ENV.enabled) ?? true);

  const timeoutMs = stored[AI_SETTING_KEYS.timeoutMs]
    ? Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Number(stored[AI_SETTING_KEYS.timeoutMs]) || DEFAULT_TIMEOUT_MS))
    : envInt(AI_ENV.timeoutMs, DEFAULT_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);

  const envKey = process.env[AI_ENV.apiKey]?.trim();
  const storedKey = stored[AI_SETTING_KEYS.apiKey]?.trim();
  const apiKey = envKey || storedKey || null;

  const envBaseUrl = process.env[AI_ENV.baseUrl]?.trim();
  const baseUrl = envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : adapter?.defaultBaseUrl ?? '';

  return {
    providerId,
    providerLabel: adapter?.label ?? null,
    model,
    enabled,
    apiKey,
    apiKeySource: envKey ? 'environment' : storedKey ? 'application' : null,
    baseUrl,
    timeoutMs,
    maxResponseChars: envInt(AI_ENV.maxResponseChars, DEFAULT_MAX_RESPONSE_CHARS, 1_000, 5_000_000)
  };
}

/** The user-facing settings view: the same resolution, key redacted. */
export async function getAiSettings(): Promise<AiSettingsView> {
  const cfg = await resolveAiConfig();
  return {
    provider: cfg.providerId,
    providerLabel: cfg.providerLabel,
    model: cfg.model,
    enabled: cfg.enabled,
    timeoutMs: cfg.timeoutMs,
    maxResponseChars: cfg.maxResponseChars,
    baseUrlSource: process.env[AI_ENV.baseUrl]?.trim() ? 'environment' : 'provider_default',
    apiKeyConfigured: cfg.apiKey !== null,
    apiKeySource: cfg.apiKeySource
  };
}

/** Status plus the registered providers, for the workspace and settings UI. */
export async function getAiStatus(): Promise<AiStatus> {
  const settings = await getAiSettings();
  const reason: AiStatus['reason'] = !settings.enabled
    ? 'disabled'
    : settings.providerLabel === null
      ? 'unknown_provider'
      : !settings.apiKeyConfigured
        ? 'missing_api_key'
        : null;
  return {
    ...settings,
    configured: reason === null,
    reason,
    providers: listAiProviders()
  };
}

export interface AiSettingsInput {
  provider?: string;
  model?: string;
  enabled?: boolean;
  timeoutMs?: number;
  /** Write-only. Empty string or null clears the stored key. Never echoed back. */
  apiKey?: string | null;
}

/**
 * Validate and persist user-tunable settings.
 *
 * Only fields the API contract defines are accepted (routes use a strict zod
 * schema before calling this), and only known provider ids are stored, so the
 * client cannot smuggle arbitrary configuration - especially not a URL - into
 * the server.
 */
export async function saveAiSettings(input: AiSettingsInput): Promise<AiSettingsView> {
  const updates: { key: string; value: string }[] = [];

  if (input.provider !== undefined) {
    if (!getAiProvider(input.provider)) {
      throw new AiSettingsError(
        `Unknown AI provider "${input.provider}". Registered providers: ${listAiProviders()
          .map(p => p.id)
          .join(', ')}.`
      );
    }
    updates.push({ key: AI_SETTING_KEYS.provider, value: input.provider });
  }

  if (input.model !== undefined) {
    const model = input.model.trim();
    if (model.length === 0 || model.length > 100) {
      throw new AiSettingsError('The model name must be between 1 and 100 characters.');
    }
    updates.push({ key: AI_SETTING_KEYS.model, value: model });
  }

  if (input.enabled !== undefined) {
    updates.push({ key: AI_SETTING_KEYS.enabled, value: input.enabled ? 'true' : 'false' });
  }

  if (input.timeoutMs !== undefined) {
    const value = Math.floor(input.timeoutMs);
    if (!Number.isFinite(value) || value < TIMEOUT_MIN_MS || value > TIMEOUT_MAX_MS) {
      throw new AiSettingsError(
        `The request timeout must be between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} milliseconds.`
      );
    }
    updates.push({ key: AI_SETTING_KEYS.timeoutMs, value: String(value) });
  }

  if (input.apiKey !== undefined) {
    const key = (input.apiKey ?? '').trim();
    if (key.length > MAX_KEY_LENGTH) {
      throw new AiSettingsError(`The API key must be at most ${MAX_KEY_LENGTH} characters.`);
    }
    updates.push({
      key: AI_SETTING_KEYS.apiKey,
      value: key // empty string below is normalized to a delete
    });
  }

  await prisma.$transaction(async tx => {
    for (const update of updates) {
      if (update.key === AI_SETTING_KEYS.apiKey && update.value === '') {
        await tx.appSetting.deleteMany({ where: { key: update.key } });
      } else {
        await tx.appSetting.upsert({
          where: { key: update.key },
          create: { key: update.key, value: update.value },
          update: { value: update.value }
        });
      }
    }
  });

  return getAiSettings();
}

/** Validation failure in a settings write. Carries no secret, ever. */
export class AiSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiSettingsError';
  }
}

/** Remove every stored AI setting (used by tests and future cleanup flows). */
export async function clearAiSettings(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(AI_SETTING_KEYS) } } });
}
