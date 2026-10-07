/**
 * Theme vocabulary shared by the switcher, persistence layer and the
 * no-flash bootstrap in index.html (which mirrors VALID_IDS inline so the
 * first paint never shows the wrong palette).
 *
 * To add a theme: add its CSS block in styles/tokens.css, then add an entry
 * here with the same id. The switcher and persistence pick it up automatically.
 */
export interface ThemeDef {
  id: string;
  label: string;
  /** Sidebar tint, surface, accent, rail — tiny preview swatches. */
  swatches: [string, string, string, string];
  mode: 'light' | 'dark';
}

export const THEMES: ThemeDef[] = [
  { id: 'ocean-light', label: 'Ocean', mode: 'light', swatches: ['#f3f6fb', '#ffffff', '#2563eb', '#0b1220'] },
  { id: 'emerald-light', label: 'Emerald', mode: 'light', swatches: ['#f1f8f3', '#ffffff', '#047857', '#0b1220'] },
  { id: 'violet-light', label: 'Violet', mode: 'light', swatches: ['#f7f5fc', '#ffffff', '#6d28d9', '#0b1220'] },
  { id: 'amber-light', label: 'Amber', mode: 'light', swatches: ['#faf6ed', '#ffffff', '#b45309', '#0b1220'] },
  { id: 'midnight', label: 'Midnight', mode: 'dark', swatches: ['#0a1020', '#111a30', '#60a5fa', '#070d1a'] },
  { id: 'graphite', label: 'Graphite', mode: 'dark', swatches: ['#0d1117', '#161b22', '#58a6ff', '#0a0f16'] }
];

export const THEME_KEY = 'phub.theme';

export function isThemeId(value: unknown): value is string {
  return typeof value === 'string' && THEMES.some(t => t.id === value);
}

/** Read the persisted theme without touching the DOM (SSR-safe, storage-safe). */
export function readStoredTheme(): string | null {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isThemeId(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function resolveInitialTheme(): string {
  return readStoredTheme() ?? (prefersDark() ? 'midnight' : 'ocean-light');
}

/** Apply + persist. The attribute flip is what every token block keys off. */
export function applyTheme(id: string): void {
  if (!isThemeId(id)) return;
  document.documentElement.setAttribute('data-theme', id);
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* private mode — session-only theme is fine */
  }
}

export function currentTheme(): string {
  return document.documentElement.getAttribute('data-theme') || resolveInitialTheme();
}
