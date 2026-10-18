import type { AiProviderAdapter, AiProviderInfo } from './types.js';
import { openAiAdapter } from './providers/openai.js';

/**
 * Phase 9: the provider registry.
 *
 * The single place that knows which adapters exist. The AI service, the routes
 * and the frontend all resolve providers through this module (or through the
 * endpoints backed by it), so adding Provider B later is:
 *
 *   1. write `providers/b.ts` implementing AiProviderAdapter
 *   2. add one line to ADAPTERS below
 *
 * Nothing in the workspace, the routes, the settings or the interaction store
 * changes - they already speak the adapter interface. No adapter is ever
 * constructed from user input; ids are matched against this fixed table, which
 * is also what keeps a client from pointing the backend at an arbitrary URL.
 */

const ADAPTERS: Record<string, AiProviderAdapter> = {
  openai: openAiAdapter
};

export const DEFAULT_PROVIDER_ID = 'openai';

/** Registered providers, described with fields that are safe for the frontend. */
export function listAiProviders(): AiProviderInfo[] {
  return Object.values(ADAPTERS).map(a => ({
    id: a.id,
    label: a.label,
    defaultModel: a.defaultModel,
    models: a.models
  }));
}

export function getAiProvider(id: string): AiProviderAdapter | null {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, id) ? ADAPTERS[id] : null;
}

export function isKnownProvider(id: string): boolean {
  return getAiProvider(id) !== null;
}
