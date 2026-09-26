// Types for the V1 Prompt Readiness Check.
//
// The API is the single source of truth: `GET /projects/:id/generator/readiness`
// returns a ReadinessReport produced by backend/src/lib/generator/readiness.ts.
// Nothing here re-derives readiness — the UI only renders what it is given.

export type ReadinessStatus = 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'OPTIONAL' | 'ERROR';
export type ReadinessLevel = 'required' | 'recommended' | 'optional';
export type ReadinessGroup = 'core' | 'context' | 'research' | 'planning' | 'config';
export type ReadinessVerdict = 'ready' | 'needs-info' | 'error';

export type ReadinessInput =
  | { kind: 'text'; field: string; label: string; prompt: string; hint: string }
  | { kind: 'choice'; option: string; label: string; prompt: string; hint: string; choices: string[] }
  | {
      kind: 'choiceText';
      option: string;
      textOption: string;
      label: string;
      prompt: string;
      hint: string;
      choices: string[];
    }
  | { kind: 'count'; resource: string; label: string; prompt: string; hint: string }
  | null;

export interface ReadinessCheck {
  key: string;
  label: string;
  group: ReadinessGroup;
  level: ReadinessLevel;
  status: ReadinessStatus;
  detail: string;
  reason: string;
  action: string;
  gapInstruction: string;
  input: ReadinessInput;
  emphasiseIn: string[];
  emphasised: boolean;
  error?: { operation: string; reason: string; action: string };
}

export interface ReadinessTally {
  complete: number;
  partial: number;
  missing: number;
  total: number;
  available: number;
}

export interface WizardStep {
  key: string;
  label: string;
  level: ReadinessLevel;
  status: ReadinessStatus;
  prompt: string;
  hint: string;
  input: Exclude<ReadinessInput, null>;
  value: string;
}

export interface ReadinessReport {
  project: { id: number; name: string; slug: string; stage: string };
  checks: ReadinessCheck[];
  summary: { required: ReadinessTally; recommended: ReadinessTally; optional: ReadinessTally };
  score: number;
  ready: boolean;
  verdict: ReadinessVerdict;
  missingRequired: ReadinessCheck[];
  partialRecommended: ReadinessCheck[];
  missingOptional: ReadinessCheck[];
  failures: ReadinessCheck[];
  stage: string;
  wizardSteps: WizardStep[];
}

export interface GenOptions {
  targetPlatform: string;
  technology: string;
  customTech: string | null;
  developmentApproach: string;
  aiEnvironment: string;
}

export const DEFAULT_OPTIONS: GenOptions = {
  targetPlatform: 'Not decided',
  technology: 'Not decided',
  customTech: null,
  developmentApproach: 'Build from scratch',
  aiEnvironment: 'General AI coding agent'
};

/** Mirrors the legacy `analyze.ts` score, kept for the saved-generation history. */
export interface Analysis {
  readiness: {
    score: number;
    items: { key: string; label: string; kind: 'core' | 'foundation' | 'optional'; weight: number; present: boolean }[];
    ready: string[];
    missing: string[];
  };
  missing: { field: string; severity: 'high' | 'medium' | 'low'; guidance: string }[];
  ambiguities: { field: string; message: string }[];
  relevant: {
    research: string[];
    requirements: { code: string; title: string; status: string }[];
    features: { name: string; status: string }[];
    decisions: string[];
    techStack: string[];
    notes: string[];
    stage: string;
    repository: boolean;
  };
  dedupe: { total: number; kept: number; consolidated: number; examples: string[] };
  sectionProblems?: string[];
}

export interface Validation {
  passed: boolean;
  issues: { section: string; message: string; severity: 'error' | 'warning' | 'info' }[];
  checks: { key: string; label: string; ok: boolean }[];
}

export interface GenResult {
  promptText: string;
  analysis: Analysis;
  validation: Validation;
  options: GenOptions;
  v1Scope: string | null;
  readiness: ReadinessReport;
  proceededWithGaps: string[];
}

// ---------------------------------------------------------------------------
// Display mapping. The verdict, glyph and colour for each status live here so
// every surface (checklist, wizard, summary) shows the same thing.
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<ReadinessStatus, string> = {
  COMPLETE: '✓',
  PARTIAL: '⚠',
  MISSING: '✗',
  OPTIONAL: '○',
  ERROR: '!'
};

export const STATUS_COLOR: Record<ReadinessStatus, string> = {
  COMPLETE: 'var(--green)',
  PARTIAL: 'var(--yellow)',
  MISSING: 'var(--red)',
  OPTIONAL: 'var(--text-dim)',
  ERROR: 'var(--orange)'
};

export const STATUS_LABEL: Record<ReadinessStatus, string> = {
  COMPLETE: 'Complete',
  PARTIAL: 'Partial',
  MISSING: 'Missing',
  OPTIONAL: 'Optional',
  ERROR: 'Error'
};

export const LEVEL_LABEL: Record<ReadinessLevel, string> = {
  required: 'Required',
  recommended: 'Recommended',
  optional: 'Optional'
};

export const GROUP_LABEL: Record<ReadinessGroup, string> = {
  core: 'Core information',
  context: 'Project context',
  research: 'Research',
  planning: 'Planning',
  config: 'Generator configuration'
};

export const GROUP_ORDER: ReadinessGroup[] = ['core', 'context', 'research', 'planning', 'config'];

/** True when the item blocks generation. Nothing else does. */
export const isBlocking = (check: ReadinessCheck): boolean =>
  check.level === 'required' && (check.status === 'MISSING' || check.status === 'ERROR');

export const statusColorFor = (status: ReadinessStatus): string => STATUS_COLOR[status];

/** Project stage, humanised for the modal subtitle. */
export const stageLabel = (stage: string): string =>
  stage
    .toLowerCase()
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
