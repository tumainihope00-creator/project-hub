import type {
  AmbiguityItem,
  DedupeReport,
  GeneratorOptions,
  GenerationContext,
  MissingItem,
  PromptAnalysis,
  ReadinessItem
} from './types.js';
import { dedupeStatements, tokenize, type Statement } from './normalize.js';

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const present = (v: string | null | undefined | string[]): boolean => {
  if (Array.isArray(v)) return v.length > 0;
  return !!v && v.trim().length > 0;
};

interface ReadinessDef {
  key: string;
  label: string;
  kind: ReadinessItem['kind'];
  weight: number;
  present: (c: GenerationContext) => boolean;
  hint: string;
}

const READINESS_DEFS: ReadinessDef[] = [
  { key: 'name', label: 'Project identity', kind: 'core', weight: 10, present: c => present(c.project.name), hint: 'The project has a name.' },
  { key: 'description', label: 'Short description', kind: 'core', weight: 10, present: c => present(c.project.description), hint: 'A concise description is recorded.' },
  { key: 'problem', label: 'Problem definition', kind: 'core', weight: 10, present: c => present(c.project.problem), hint: 'The problem the project solves is defined.' },
  { key: 'targetUsers', label: 'Target users', kind: 'core', weight: 10, present: c => present(c.project.targetUsers), hint: 'Who will use the system is documented.' },
  { key: 'expectedValue', label: 'Expected outcome', kind: 'core', weight: 10, present: c => present(c.project.expectedValue), hint: 'The intended V1 outcome is documented.' },
  { key: 'v1Scope', label: 'V1 scope', kind: 'core', weight: 10, present: c => present(c.project.v1Scope), hint: 'What must exist in the first usable version is defined.' },
  { key: 'requirements', label: 'Requirements', kind: 'foundation', weight: 8, present: c => c.requirements.length > 0, hint: 'At least one requirement is recorded.' },
  { key: 'features', label: 'Features', kind: 'foundation', weight: 8, present: c => c.features.length > 0, hint: 'At least one feature is recorded.' },
  { key: 'motivation', label: 'Motivation', kind: 'optional', weight: 3, present: c => present(c.project.motivation), hint: 'Why the project matters to you.' },
  { key: 'assumptions', label: 'Assumptions', kind: 'optional', weight: 3, present: c => present(c.project.assumptions), hint: 'Recorded assumptions.' },
  { key: 'initialQuestions', label: 'Initial questions', kind: 'optional', weight: 3, present: c => present(c.project.initialQuestions), hint: 'Open questions worth resolving.' },
  { key: 'research', label: 'Research', kind: 'optional', weight: 4, present: c => c.research.length > 0, hint: 'Research entries exist.' },
  { key: 'architecture', label: 'Architecture & stack', kind: 'optional', weight: 5, present: c => c.decisions.length + c.techStack.length > 0, hint: 'Architecture decisions or technology stack exist.' },
  { key: 'repository', label: 'Repository', kind: 'optional', weight: 5, present: c => present(c.project.repositoryUrl) || c.gitReferences.some(g => g.kind === 'REPOSITORY'), hint: 'A repository URL or git reference is recorded.' }
];

const TOTAL_WEIGHT = READINESS_DEFS.reduce((a, d) => a + d.weight, 0); // 100

function readiness(c: GenerationContext): PromptAnalysis['readiness'] {
  const items: ReadinessItem[] = READINESS_DEFS.map(def => ({
    key: def.key,
    label: def.label,
    kind: def.kind,
    weight: def.weight,
    present: def.present(c),
    hint: def.hint
  }));
  const earned = items.reduce((a, i) => a + (i.present ? i.weight : 0), 0);
  const score = Math.round((earned / TOTAL_WEIGHT) * 100);
  return {
    score,
    items,
    ready: items.filter(i => i.present).map(i => i.label),
    missing: items.filter(i => !i.present).map(i => i.label)
  };
}

// ---------------------------------------------------------------------------
// Missing information & ambiguity
// ---------------------------------------------------------------------------

const AUTH_RE = /\b(login|log\s*in|sign\s*in|signup|sign\s*up|account|password|authentication|authenticate|auth\b|permission|user\s*role|role[s]?|authoriz\w+)\b/;

function platformHints(c: GenerationContext): { mobile: boolean; web: boolean; desktop: boolean; api: boolean } {
  let web = false;
  let mobile = false;
  let desktop = false;
  let api = false;

  const stackText = c.techStack
    .map(t => `${t.technology} ${t.category}`)
    .join(' ')
    .toLowerCase();
  if (/react\s*native|expo|android|ios|swift|kotlin|flutter|mobile/.test(stackText)) mobile = true;
  if (/react|vue|angular|next|browser|web|html|css|typescript/.test(stackText)) web = true;
  if (/electron|tauri|pyqt|desktop|tray|overlay|windows/.test(stackText)) desktop = true;
  if (/node|express|api|server|backend|graphql|postgres|prisma/.test(stackText)) api = true;

  for (const text of [
    c.project.description,
    c.project.problem,
    c.project.targetUsers,
    ...c.features.map(f => `${f.name} ${f.description ?? ''}`),
    ...c.requirements.map(r => `${r.title} ${r.description ?? ''}`)
  ]) {
    if (!text) continue;
    const t = text.toLowerCase();
    if (/(mobile app|android|ios app|iphone|app on (their )?phone)/.test(t)) mobile = true;
    if (/(web app|website|browser|in[\s-]browser|web application|online)/.test(t)) web = true;
    if (/(desktop app|desktop application|tray|overlay|runs on the desktop)/.test(t)) desktop = true;
    if (/(backend|behind an api|public api|api first|rest api|server)/.test(t)) api = true;
  }
  return { mobile, web, desktop, api };
}

function missingInfo(c: GenerationContext, options: GeneratorOptions): MissingItem[] {
  const missing: MissingItem[] = [];
  const early = ['IDEA', 'RESEARCH', 'PLANNING'].includes(c.project.stage);

  if (!present(c.project.v1Scope)) {
    missing.push({
      field: 'V1 scope',
      severity: 'high',
      guidance:
        'V1 scope has not been defined. Without it, the generated prompt may include more functionality than intended. Define what must exist in the first usable version, or the prompt will instruct the AI agent to confirm scope before building.'
    });
  }

  const hints = platformHints(c);
  if (options.targetPlatform === 'Not decided' && !hints.web && !hints.mobile && !hints.desktop && !hints.api) {
    missing.push({
      field: 'Target platform',
      severity: 'high',
      guidance:
        'No target platform is recorded and none can be inferred from the documentation. The AI agent needs to know whether to produce a web, mobile, desktop or API project.'
    });
  }

  if (c.techStack.length === 0 && c.decisions.length === 0 && options.technology === 'Not decided') {
    missing.push({
      field: 'Technology stack',
      severity: 'medium',
      guidance:
        'No technology stack is recorded. Either choose one in the generator options or let the AI agent recommend a stack and flag the choice.'
    });
  }

  const allText = [
    c.project.description,
    c.project.problem,
    c.project.motivation,
    ...c.features.map(f => `${f.name} ${f.description ?? ''}`),
    ...c.requirements.map(r => `${r.title} ${r.description ?? ''}`),
    ...c.notes.map(n => `${n.title ?? ''} ${n.content}`)
  ]
    .filter(Boolean)
    .join(' ');

  const authMention = AUTH_RE.test(allText);
  const hasAuthRequirement = c.requirements.some(
    r => AUTH_RE.test(`${r.title} ${r.description ?? ''}`)
  );
  if (authMention && !hasAuthRequirement) {
    missing.push({
      field: 'Authentication requirements',
      severity: 'medium',
      guidance:
        'The project documentation mentions accounts or authentication, but no explicit requirement records it. Without a decision the AI agent should ask whether auth is in V1.'
    });
  }

  const developmentExists =
    c.devSessions.length > 0 ||
    c.gitReferences.length > 0 ||
    c.prompts.length > 0 ||
    c.aiSessions.length > 0 ||
    c.tasks.some(t => t.status === 'COMPLETED');
  if (['BUILDING', 'TESTING', 'DEPLOYMENT', 'PRODUCTION', 'MAINTENANCE'].includes(c.project.stage) && !present(c.project.repositoryUrl) && !c.gitReferences.some(g => g.kind === 'REPOSITORY')) {
    missing.push({
      field: 'Repository reference',
      severity: 'low',
      guidance:
        'The project is in an active development stage but no repository URL is recorded. A continuation prompt benefits from a repository link the AI agent can open.'
    });
  }

  if (!developmentExists && early && c.tasks.length === 0 && options.developmentApproach === 'Continue existing project') {
    missing.push({
      field: 'Development history',
      severity: 'low',
      guidance:
        'No development sessions, git references, prompts or completed tasks were found. "Continue existing project" may not match reality for this project.'
    });
  }

  return missing;
}

function ambiguities(c: GenerationContext, options: GeneratorOptions): AmbiguityItem[] {
  const list: AmbiguityItem[] = [];
  const hints = platformHints(c);

  if (options.targetPlatform === 'Not decided') {
    if (hints.mobile && hints.web) {
      list.push({
        field: 'Target platform',
        message: 'The documentation suggests both a web and a mobile target. It is unclear which one V1 should be — the AI agent must ask before committing.'
      });
    } else if (hints.mobile && !hints.web) {
      list.push({
        field: 'Target platform',
        message: 'Documentation hints at a mobile application but platform is marked "Not decided". Confirm before generation, or the prompt will instruct the agent to choose and flag it.'
      });
    } else if (hints.web && !hints.mobile) {
      list.push({
        field: 'Target platform',
        message: 'Documentation hints at a web application but platform is marked "Not decided". Confirm before generation, or the prompt will instruct the agent to choose and flag it.'
      });
    } else if (!hints.desktop && !hints.api) {
      list.push({
        field: 'Target platform',
        message: 'It is unclear whether this is intended to be a web, mobile, desktop or API-only project. Nothing in the documentation disambiguates it.'
      });
    }
  }

  if (options.developmentApproach === 'Build from scratch') {
    const developmentExists =
      c.devSessions.length > 0 ||
      c.gitReferences.length > 0 ||
      c.prompts.length > 0 ||
      c.tasks.some(t => t.status === 'COMPLETED');
    if (developmentExists) {
      list.push({
        field: 'Development approach',
        message:
          'This project already has development history (sessions, git references or completed tasks), but "Build from scratch" is selected. That would discard existing work — switching to "Continue existing project" is recommended unless rebuilding is intended.'
      });
    }
  }

  const authText = [
    c.project.description,
    c.project.problem,
    c.project.targetUsers,
    ...c.features.map(f => `${f.name} ${f.description ?? ''}`),
    ...c.requirements.map(r => `${r.title} ${r.description ?? ''}`)
  ]
    .filter(Boolean)
    .join(' ');
  if (AUTH_RE.test(authText) && c.requirements.length === 0) {
    list.push({
      field: 'Authentication',
      message:
        'Authentication is mentioned but there are no recorded requirements. Do not assume a specific auth model — treat it as a decision for the user or a clearly-flagged AI choice.'
    });
  }

  return list;
}

// ---------------------------------------------------------------------------
// Relevant data (drives the UI "Relevant project data" panel)
// ---------------------------------------------------------------------------

function relevant(c: GenerationContext): PromptAnalysis['relevant'] {
  const inScopeRequirements = c.requirements
    .filter(r => !['REJECTED', 'DEFERRED'].includes(r.status))
    .slice(0, 60)
    .map(r => ({ code: r.code, title: r.title, status: r.status }));
  const inScopeFeatures = c.features
    .filter(f => f.status !== 'DROPPED')
    .slice(0, 60)
    .map(f => ({ name: f.name, status: f.status }));
  const acceptedDecisions = c.decisions
    .filter(d => d.status === 'ACCEPTED')
    .slice(0, 20)
    .map(d => `${d.code} ${d.title}`);
  return {
    stage: c.project.stage,
    repository: present(c.project.repositoryUrl) || c.gitReferences.some(g => g.kind === 'REPOSITORY'),
    research: c.research.slice(0, 20).map(r => r.title),
    requirements: inScopeRequirements,
    features: inScopeFeatures,
    decisions: acceptedDecisions,
    techStack: c.techStack.slice(0, 30).map(t => (t.version ? `${t.technology} ${t.version}` : t.technology)),
    notes: c.notes.slice(0, 15).map(n => n.title ?? '(untitled note)')
  };
}

// ---------------------------------------------------------------------------
// Dedupe report (across the statements that would otherwise repeat)
// ---------------------------------------------------------------------------

function dedupeReport(c: GenerationContext): DedupeReport {
  const statements: Statement[] = [
    { id: 'description', label: 'Description', text: c.project.description ?? '' },
    { id: 'problem', label: 'Problem', text: c.project.problem ?? '' },
    { id: 'motivation', label: 'Motivation', text: c.project.motivation ?? '' },
    { id: 'targetUsers', label: 'Target users', text: c.project.targetUsers ?? '' },
    { id: 'outcome', label: 'Expected outcome', text: c.project.expectedValue ?? '' }
  ];
  c.features.forEach((f, i) =>
    statements.push({ id: `feature-${i}`, label: `Feature: ${f.name}`, text: `${f.name} ${f.description ?? ''}`.trim() })
  );
  c.requirements.forEach((r, i) =>
    statements.push({ id: `req-${i}`, label: `${r.code} ${r.title}`, text: `${r.title} ${r.description ?? ''}`.trim() })
  );

  const outcome = dedupeStatements(statements.filter(s => s.text));
  const total = outcome.kept.length + outcome.duplicates.length;
  return {
    total,
    kept: outcome.kept.length,
    consolidated: outcome.duplicates.length,
    examples: outcome.duplicates
      .slice(0, 5)
      .map(d => `"${d.duplicate.text.length > 90 ? d.duplicate.text.slice(0, 90) + '…' : d.duplicate.text}" was consolidated into a single statement`)
  };
}

export function analyzeContext(c: GenerationContext, options: GeneratorOptions): PromptAnalysis {
  return {
    readiness: readiness(c),
    missing: missingInfo(c, options),
    ambiguities: ambiguities(c, options),
    relevant: relevant(c),
    dedupe: dedupeReport(c)
  };
}

/** Count of non-trivial tokens, used to gauge whether a section has substance. */
export function substance(texts: Array<string | null | undefined>): boolean {
  return tokenize(texts.filter(Boolean).join(' ')).length >= 3;
}