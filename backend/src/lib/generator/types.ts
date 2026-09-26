// Types for the V1 Prompt Generator pipeline.
// Pipeline: Project Data -> Generation Context -> Prompt Analysis -> Prompt Builder
//           -> Prompt Validator -> Generated Prompt -> UI
// Generation logic lives here (separate from UI) so the generator can evolve
// without rewriting the interface.

export const TARGET_PLATFORMS = [
  'Web',
  'Android',
  'iOS',
  'Desktop',
  'Web + Mobile',
  'Backend/API',
  'Other',
  'Not decided'
] as const;

export const TECHNOLOGY_PREFERENCES = [
  'Use existing project stack',
  'Specify technology',
  'Recommend appropriate stack',
  'Not decided'
] as const;

export const DEVELOPMENT_APPROACHES = [
  'Build from scratch',
  'Continue existing project',
  'Prototype',
  'Production-oriented V1'
] as const;

export const AI_ENVIRONMENTS = [
  'Claude Code',
  'Codex',
  'Cursor',
  'VS Code + AI',
  'ChatGPT',
  'Other',
  'General AI coding agent'
] as const;

export interface GeneratorOptions {
  targetPlatform: (typeof TARGET_PLATFORMS)[number];
  technology: (typeof TECHNOLOGY_PREFERENCES)[number];
  customTech: string | null;
  developmentApproach: (typeof DEVELOPMENT_APPROACHES)[number];
  aiEnvironment: (typeof AI_ENVIRONMENTS)[number];
}

export const DEFAULT_OPTIONS: GeneratorOptions = {
  targetPlatform: 'Not decided',
  technology: 'Not decided',
  customTech: null,
  developmentApproach: 'Build from scratch',
  aiEnvironment: 'General AI coding agent'
};

// ---------------------------------------------------------------------------
// Generation context (normalized, filtered project data)
// ---------------------------------------------------------------------------

export interface ProjectIdeaFields {
  name: string;
  slug: string;
  stage: string;
  description: string | null;
  problem: string | null;
  motivation: string | null;
  targetUsers: string | null;
  expectedValue: string | null;
  assumptions: string | null;
  initialQuestions: string | null;
  inspiration: string | null;
  v1Scope: string | null;
  originalIdea: string | null;
  repositoryUrl: string | null;
}

export interface CollectedRequirement {
  id: number;
  code: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  description: string | null;
}

export interface CollectedFeature {
  id: number;
  name: string;
  priority: string;
  status: string;
  description: string | null;
}

export interface CollectedResearch {
  id: number;
  title: string;
  type: string;
  findings: string | null;
  summary: string | null;
  relevance: string | null;
}

export interface CollectedDecision {
  id: number;
  code: string;
  title: string;
  decision: string | null;
  context: string | null;
  reasoning: string | null;
  consequences: string | null;
  status: string;
}

export interface CollectedTech {
  id: number;
  category: string;
  technology: string;
  version: string | null;
  notes: string | null;
}

/**
 * A project data source that could not be read. Surfaced to the user as an
 * ERROR check so a broken read is never confused with missing information.
 */
export interface SourceFailure {
  /** Machine name, matches the readiness check key it invalidates. */
  source: string;
  /** Human sentence describing the failure. */
  reason: string;
  /** What the system was trying to do when it failed. */
  operation: string;
  /** What the user can do about it. */
  action: string;
}

export interface GenerationContext {
  project: ProjectIdeaFields;
  tags: string[];
  research: CollectedResearch[];
  researchQuestions: { id: number; question: string; answer: string | null; status: string }[];
  requirements: CollectedRequirement[];
  features: CollectedFeature[];
  tasks: { id: number; code: string; title: string; status: string; description: string | null }[];
  decisions: CollectedDecision[];
  techStack: CollectedTech[];
  databaseTables: { id: number; name: string; purpose: string | null }[];
  apiEndpoints: { id: number; method: string; path: string; description: string | null }[];
  notes: { id: number; title: string | null; content: string }[];
  devSessions: { id: number; number: number; goal: string | null; completed: string | null; nextStep: string | null }[];
  aiSessions: { id: number; number: number; tool: string; purpose: string | null; result: string }[];
  prompts: { id: number; code: string; title: string | null; category: string | null }[];
  gitReferences: { id: number; kind: string; commitMessage: string | null; branch: string | null; repositoryUrl: string | null }[];
  counts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Prompt Readiness Check
//
// This is the single source of truth for "can we generate a good V1 prompt?".
// The readiness service (readiness.ts) produces a ReadinessReport; the API serves
// it to the UI and the prompt builder consumes the same report. Nothing else
// re-implements these rules.
// ---------------------------------------------------------------------------

/** Verdict for one expected piece of information. */
export type ReadinessStatus =
  /** Exists and is usable. */
  | 'COMPLETE'
  /** Exists but is thin — usable, may weaken the prompt. */
  | 'PARTIAL'
  /** Required information does not exist. */
  | 'MISSING'
  /** Not necessary for generation; never blocks. */
  | 'OPTIONAL'
  /** The system could not retrieve or process this information. */
  | 'ERROR';

/** How strongly the item is needed. */
export type ReadinessLevel = 'required' | 'recommended' | 'optional';

/** The sections of the checklist, in the order they are shown. */
export type ReadinessGroup =
  | 'core'
  | 'context'
  | 'research'
  | 'planning'
  | 'config';

export const READINESS_GROUP_LABELS: Record<ReadinessGroup, string> = {
  core: 'Core information',
  context: 'Project context',
  research: 'Research',
  planning: 'Planning',
  config: 'Generator configuration'
};

/** What a check needs from the user in order to become complete. */
export type ReadinessInput =
  /** A single project column. The wizard writes straight to the project. */
  | { kind: 'text'; field: string; label: string; prompt: string; hint: string }
  /** A generator option held in the UI (not project data). */
  | { kind: 'choice'; option: string; label: string; prompt: string; hint: string; choices: string[] }
  /** A generator option with a free-text companion (e.g. Specify technology). */
  | {
      kind: 'choiceText';
      option: string;
      textOption: string;
      label: string;
      prompt: string;
      hint: string;
      choices: string[];
    }
  /** A counted project resource (requirements, features, research, decisions). */
  | { kind: 'count'; resource: string; label: string; prompt: string; hint: string }
  /** Nothing the wizard can fill inside this workflow. */
  | null;

export interface ReadinessCheck {
  key: string;
  label: string;
  group: ReadinessGroup;
  level: ReadinessLevel;
  status: ReadinessStatus;
  /** What the project actually holds, in plain language. */
  detail: string;
  /** Why this item matters for a V1 build prompt. */
  reason: string;
  /** What to do about it when it is not complete. */
  action: string;
  /**
   * The instruction injected into the generated prompt when this item is
   * missing and the user chose "Proceed anyway". Empty string when complete.
   * Lives here so the readiness check and the prompt builder cannot disagree.
   */
  gapInstruction: string;
  /** Present only when the item is NOT complete/optional. */
  input: ReadinessInput;
  /** Stages where this item deserves extra attention. */
  emphasiseIn: string[];
  /** True when this stage is one where the item is emphasised. */
  emphasised: boolean;
  /** Set when status === 'ERROR'. */
  error?: { operation: string; reason: string; action: string };
}

export interface ReadinessTally {
  complete: number;
  partial: number;
  missing: number;
  total: number;
  /** complete + partial, i.e. "available". */
  available: number;
}

export type ReadinessVerdict = 'ready' | 'needs-info' | 'error';

export interface ReadinessReport {
  project: { id: number; name: string; slug: string; stage: string };
  /** Every expected item, evaluated independently, in display order. */
  checks: ReadinessCheck[];
  summary: {
    required: ReadinessTally;
    recommended: ReadinessTally;
    optional: ReadinessTally;
  };
  /** 0-100 blend of the tallies. Informational only — never a gate. */
  score: number;
  /** True when every REQUIRED item is complete and nothing errored. */
  ready: boolean;
  verdict: ReadinessVerdict;
  missingRequired: ReadinessCheck[];
  partialRecommended: ReadinessCheck[];
  missingOptional: ReadinessCheck[];
  failures: ReadinessCheck[];
  /** The project stage, used for stage-aware ordering. */
  stage: string;
  /** Ordered actionable items the wizard walks through one at a time. */
  wizardSteps: WizardStep[];
}

export interface WizardStep {
  key: string;
  label: string;
  level: ReadinessLevel;
  status: ReadinessStatus;
  prompt: string;
  hint: string;
  input: Exclude<ReadinessInput, null>;
  /** Current value, so the field can be pre-filled. */
  value: string;
}

// ---------------------------------------------------------------------------
// Prompt analysis (readiness / gaps / ambiguity)
// ---------------------------------------------------------------------------

export type ReadinessKind = 'core' | 'foundation' | 'optional';

export interface ReadinessItem {
  key: string;
  label: string;
  kind: ReadinessKind;
  weight: number;
  present: boolean;
  hint: string;
}

export interface MissingItem {
  field: string;
  severity: 'high' | 'medium' | 'low';
  guidance: string;
}

export interface AmbiguityItem {
  field: string;
  message: string;
}

export interface DedupeReport {
  total: number;
  kept: number;
  consolidated: number;
  examples: string[];
}

export interface PromptAnalysis {
  readiness: {
    score: number;
    items: ReadinessItem[];
    ready: string[];
    missing: string[];
  };
  missing: MissingItem[];
  ambiguities: AmbiguityItem[];
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
  dedupe: DedupeReport;
  /** Non-fatal notes raised while assembling sections. */
  sectionProblems?: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  section: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface PromptValidation {
  passed: boolean;
  issues: ValidationIssue[];
  checks: { key: string; label: string; ok: boolean }[];
}

// ---------------------------------------------------------------------------
// Generation result
// ---------------------------------------------------------------------------

export interface GenerationResult {
  promptText: string;
  analysis: PromptAnalysis;
  validation: PromptValidation;
  options: GeneratorOptions;
  v1Scope: string | null;
  /** The same report the readiness modal showed, so the UI never re-derives it. */
  readiness: ReadinessReport;
  /**
   * Keys of items that were missing/partial when the user chose "Proceed anyway".
   * The prompt text explicitly acknowledges each of these; it never invents them.
   */
  proceededWithGaps: string[];
}
