import type {
  GeneratorOptions,
  GenerationContext,
  PromptAnalysis,
  ReadinessCheck
} from './types.js';

// Builds the V1 build prompt. Section order follows the project grammar.
// NEVER invent requirements: every claimed fact must trace back to project data.

interface BuildDeps {
  context: GenerationContext;
  analysis: PromptAnalysis;
  options: GeneratorOptions;
  /** Items the readiness check could not confirm, for the acknowledgement section. */
  gaps: ReadinessCheck[];
}

/** True if the entry is worth including (not empty, has substance). */
const nonEmpty = (v: string | null | undefined | string[]): boolean => {
  if (Array.isArray(v)) return v.length > 0;
  return !!v && v.trim().length > 0;
};

const techSummary = (c: GenerationContext): string => {
  const t = c.techStack;
  if (t.length === 0) return '';
  return t
    .map(x => `${x.technology}${x.version ? ` ${x.version}` : ''}${x.notes ? ` (${x.notes})` : ''}`)
    .join(', ');
};

const decisionSummary = (c: GenerationContext): string => {
  const accepted = c.decisions.filter(d => d.status === 'ACCEPTED');
  return accepted
    .map(d => {
      const parts = [`${d.code}: ${d.title}`];
      if (nonEmpty(d.decision)) parts.push(d.decision!);
      if (nonEmpty(d.reasoning)) parts.push(`Reason: ${d.reasoning}`);
      return parts.join('. ');
    })
    .join('\n');
};

const tableSummary = (c: GenerationContext): string => {
  if (c.databaseTables.length === 0) return '';
  return c.databaseTables
    .map(t => `${t.name}${nonEmpty(t.purpose) ? ` — ${t.purpose}` : ''}`)
    .join(', ');
};

const endpointSummary = (c: GenerationContext): string => {
  if (c.apiEndpoints.length === 0) return '';
  const rows = c.apiEndpoints
    .slice(0, 40)
    .map(e => `${e.method.toUpperCase()} ${e.path}${nonEmpty(e.description) ? ` — ${e.description}` : ''}`);
  if (c.apiEndpoints.length > 40) rows.push(`… and ${c.apiEndpoints.length - 40} more endpoints.`);
  return rows.join('\n');
};

const activeRequirements = (c: GenerationContext) =>
  c.requirements.filter(r => !['REJECTED', 'DEFERRED'].includes(r.status));

const activeFeatures = (c: GenerationContext) => c.features.filter(f => f.status !== 'DROPPED');

const buildV1Scope = (d: BuildDeps): string => {
  const { context: c } = d;
  if (nonEmpty(c.project.v1Scope)) return c.project.v1Scope!;
  const fromFeatures = activeFeatures(c).map(f => f.name);
  if (fromFeatures.length > 0) {
    return `Defined by the core features below being delivered, working, and meeting their acceptance criteria. Specifically: ${fromFeatures.join('; ')}. (No explicit V1 scope was recorded in the project.)`;
  }
  return (
    'Not formally defined. The following instructions for the AI agent apply: ' +
    'before building, either (a) confirm a V1 scope boundary with the user, or (b) if the user defers, ' +
    'assume the smallest coherent feature set that satisfies the core requirements below and say so explicitly in your plan.'
  );
};

const buildOutOfScope = (d: BuildDeps): string => {
  const { context: c, analysis } = d;
  const lines: string[] = [];
  const hasAuth =
    analysis.missing.some(m => m.field === 'Authentication requirements') ||
    analysis.ambiguities.some(a => a.field === 'Authentication');
  if (!hasAuth) {
    const cText = [
      c.project.description,
      c.project.problem,
      ...c.features.map(f => `${f.name} ${f.description ?? ''}`),
      ...c.requirements.map(r => `${r.title} ${r.description ?? ''}`)
    ].join(' ');
    if (!/\b(email\s*(notifications|sending|delivery)|password\s*(reset|recovery)|multi[\s-]language|i18n|localization|theme\s*(manager|switcher|changer)|push\s*(notifications)|dark\s*mode)\b/i.test(cText)) {
      lines.push('Anything not present in the requirements/features above — the AI agent must not invent or add unrequested functionality.');
    }
  }
  if (lines.length === 0) lines.push('Anything not present in the requirements/features above — the AI agent must not invent or add unrequested functionality.');
  if (nonEmpty(c.project.assumptions)) lines.push(`Per recorded assumptions: ${c.project.assumptions}.`);
  return lines.join('\n');
};

const buildTechnicalDirection = (d: BuildDeps): string => {
const { context: c, options } = d;

  const out: string[] = [];
  if (options.technology === 'Use existing project stack') {
    const stack = techSummary(c);
    out.push(
      stack
        ? `Use the existing project stack already recorded: ${stack}.`
        : 'Use the existing project stack where it is already recorded in the project history.'
    );
  } else if (options.technology === 'Specify technology') {
    out.push(
      nonEmpty(options.customTech)
        ? `Use this exact technology stack, as specified by the user: ${options.customTech}.`
        : 'The user has specified a preferred technology stack — confirm it with them before implementation if it is not recorded in this prompt.'
    );
  } else if (options.technology === 'Recommend appropriate stack') {
    const stack = techSummary(c);
    if (stack) {
      out.push(`A technology stack has already been recorded (${stack}). Keep it unless there is a technical reason to change it, and flag any change as a decision for the user.`);
    } else {
      out.push('No stack is recorded. Choose a mainstream stack that fits the problem and the target platform, state the choice and the reason, and keep it simple.');
    }
  } else {
    out.push('Technology choice deliberately left open: if no stack is recorded, choose a mainstream stack that fits the target platform, state the choice and the reason.');
  }

  if (c.techStack.length > 0) {
    out.push(`Recorded technologies: ${techSummary(c)}.`);
  }
  if (c.apiEndpoints.length > 0) {
    out.push(`Backend surface to preserve/align with:\n${endpointSummary(c)}`);
  }
  if (c.databaseTables.length > 0) {
    out.push(`Recorded database tables: ${tableSummary(c)}. Reproduce these if the storage model is recreated.`);
  }

  return out.join('\n\n');
};

const buildArchitecture = (d: BuildDeps): string => {
  const { context: c } = d;
  const decisions = decisionSummary(c);
  const sections: string[] = [];

  if (nonEmpty(c.project.assumptions)) {
    sections.push(`Recorded assumptions that constrain the design:\n${c.project.assumptions}`);
  }

  if (decisions) {
    sections.push(`Accepted architecture decisions that must be respected:\n${decisions}`);
  } else {
    sections.push(
      'No accepted architecture decisions are recorded. Keep the architecture minimal and conventional for the chosen stack; ' +
      'do not over-engineer.'
    );
  }

  const db = c.databaseTables;
  if (db.length > 0) {
    sections.push(`Data model to use: ${tableSummary(c)}.`);
  } else {
    sections.push('Use the smallest data model that supports the core requirements and features.');
  }

  return sections.join('\n\n');
};

const buildAssumptions = (d: BuildDeps): string => {
  const { context: c } = d;
  const lines: string[] = [];
  if (nonEmpty(c.project.assumptions)) {
    lines.push(`Recorded assumptions:\n${c.project.assumptions}`);
  }
  if (nonEmpty(c.project.initialQuestions)) {
    lines.push(`Open questions from the project that the AI agent may need answers to:\n${c.project.initialQuestions}`);
  }
  if (lines.length === 0) {
    lines.push(
      'No recorded assumptions. When a decision is needed and the project data does not answer it, ' +
      'either ask the user or make the smallest reasonable assumption and flag it explicitly.'
    );
  }
  return lines.join('\n\n');
};

const buildResearchFindings = (d: BuildDeps): string => {
  const { context: c } = d;
  const findings: string[] = [];
  for (const r of c.research) {
    const text = r.findings || r.summary || r.relevance;
    if (!nonEmpty(text)) continue;
    findings.push(`${r.type}: ${text}`);
  }
  if (nonEmpty(c.project.inspiration)) {
    findings.push(`Inspiration: ${c.project.inspiration}`);
  }
  if (findings.length === 0) return '';
  return findings.join('\n');
};

const buildUserWorkflow = (d: BuildDeps): string => {
  const { context: c } = d;
  const workflows: string[] = [];
  for (const t of c.tasks) {
    if (!nonEmpty(t.description)) continue;
    if (t.status === 'COMPLETED') continue;
    workflows.push(`${t.code} ${t.title}: ${t.description}`);
  }
  if (workflows.length > 0) return workflows.join('\n');
  return '';
};

const buildCoreRequirements = (d: BuildDeps): string => {
  const reqs = activeRequirements(d.context);
  if (reqs.length === 0) return '';
  return reqs
    .map(r => {
      const parts = [`${r.code} — ${r.title}`];
      if (nonEmpty(r.description)) parts.push(r.description!);
      if (r.priority) parts.push(`Priority: ${r.priority}`);
      parts.push(`Status: ${r.status}`);
      return parts.join('\n');
    })
    .join('\n\n');
};

const buildCoreFeatures = (d: BuildDeps): string => {
  const feats = activeFeatures(d.context);
  if (feats.length === 0) return '';
  return feats
    .map(f => {
      const parts = [`- ${f.name}${f.priority ? ` (priority: ${f.priority})` : ''}${f.status ? ` (status: ${f.status})` : ''}`];
      if (nonEmpty(f.description)) parts.push(`  ${f.description}`);
      return parts.join('\n');
    })
    .join('\n');
};

const buildConstraints = (d: BuildDeps): string => {
  const { context: c } = d;
  const lines: string[] = [];
  const stack = techSummary(c);
  if (stack) lines.push(`Keep the implementation compatible with the recorded stack: ${stack}.`);
  if (nonEmpty(c.project.expectedValue)) lines.push(`Focus on the expected outcome: ${c.project.expectedValue}.`);
  if (nonEmpty(c.project.repositoryUrl)) lines.push(`Repository: ${c.project.repositoryUrl}`);
  if (lines.length === 0) lines.push('No explicit constraints are recorded beyond the requirements, features, and the stated V1 scope.');
  return lines.join('\n');
};

/**
 * Items the readiness check could not confirm. The user chose "Proceed anyway",
 * so the prompt is built from what exists — but every gap is stated here
 * explicitly. This section is generated from the readiness report, so the prompt
 * can never disagree with the checklist the user just saw.
 */
const buildMissingInformation = (d: BuildDeps): string => {
  const gaps = d.gaps.filter(g => g.gapInstruction.trim().length > 0);
  if (gaps.length === 0) return '';

  const levelWord = (level: ReadinessCheck['level']): string =>
    level === 'required' ? 'REQUIRED' : level === 'recommended' ? 'RECOMMENDED' : 'OPTIONAL';

  const lines: string[] = [
    gaps.some(g => g.level === 'required')
      ? 'The project documentation is incomplete. The user was shown exactly what is missing and chose to generate anyway.'
      : 'The project documentation is usable but not complete. The user was shown what is not recorded and chose to generate anyway.',
    'The following information does NOT exist in the project data. Do not invent it, and do not silently assume it:'
  ];
  for (const g of gaps) {
    lines.push(`- ${g.label} [${levelWord(g.level)}] — ${g.detail} ${g.gapInstruction}`);
  }
  lines.push(
    'Everything else in this prompt comes from recorded project data. If you need one of the items above, ask the user during the briefing instead of guessing.'
  );
  return lines.join('\n');
};

const buildPrompt = (d: BuildDeps): { text: string; problems: string[] } => {
  const { context: c, options } = d;
  const problems: string[] = [];
  const sections: { title: string; body: string; group: 'intro' | 'body' | 'final' }[] = [];

  const scopeText = buildV1Scope(d);
  const platform =
    options.targetPlatform === 'Not decided'
      ? 'the target platform (confirm with the user during the task briefing)'
      : options.targetPlatform;

  const gapsSection = buildMissingInformation(d);
  if (gapsSection) {
    // The heading states the severity honestly: a project missing only
    // recommended information is not "incomplete" in the same way.
    const blocking = d.gaps.some(g => g.level === 'required' && g.gapInstruction.trim().length > 0);
    sections.push({
      title: blocking
        ? 'MISSING INFORMATION — CONFIRM BEFORE BUILDING'
        : 'NOT RECORDED — CONFIRM BEFORE BUILDING',
      group: 'intro',
      body: gapsSection
    });
  }

  sections.push({ title: 'ROLE', group: 'intro', body: 'You are a senior software engineer implementing the first usable version (V1) of the product described below. Work in a focused, well-structured way: plan the file structure, implement the smallest coherent milestone, and verify it before moving on.' });

  sections.push({
    title: 'PROJECT',
    group: 'intro',
    body: [
      c.project.name,
      c.project.slug,
      c.project.stage ? `Current project lifecycle stage: ${c.project.stage}.` : null,
      nonEmpty(c.project.description) ? `Description: ${c.project.description}` : null,
      nonEmpty(c.project.repositoryUrl) ? `Repository: ${c.project.repositoryUrl}` : null,
      c.tags.length > 0 ? `Tags: ${c.tags.join(', ')}.` : null
    ]
      .filter((l): l is string => !!l)
      .join('\n')
  });

  sections.push({
    title: 'PROBLEM',
    group: 'intro',
    body:
      nonEmpty(c.project.problem)
        ? c.project.problem!
        : 'The problem statement is not documented in the project. Confirm it with the user during the briefing and record their answer before implementing.'
  });

  sections.push({
    title: 'TARGET USERS',
    group: 'intro',
    body:
      nonEmpty(c.project.targetUsers)
        ? c.project.targetUsers!
        : 'Not documented. If the smallest decisions (e.g. who the primary user is) affect the design, ask during the briefing; otherwise note the assumption.'
  });

  sections.push({
    title: 'V1 OBJECTIVE',
    group: 'intro',
    body:
      nonEmpty(c.project.expectedValue)
        ? c.project.expectedValue!
        : 'Not documented. Treat the core requirements and features below as the definition of done for V1.'
  });

  sections.push({ title: 'V1 SCOPE', group: 'body', body: scopeText });

  sections.push({ title: 'OUT OF SCOPE', group: 'body', body: buildOutOfScope(d) });

  const reqBody = buildCoreRequirements(d);
  if (reqBody) {
    sections.push({ title: 'CORE REQUIREMENTS', group: 'body', body: reqBody });
  } else {
    problems.push('No active requirements recorded — the prompt PIVOTS on the feature list; flag this to the user.');
    sections.push({
      title: 'CORE REQUIREMENTS',
      group: 'body',
      body: 'No requirements are recorded for this project. The core features below therefore act as the requirements for V1.'
    });
  }

  const featBody = buildCoreFeatures(d);
  if (featBody) {
    sections.push({ title: 'CORE FEATURES', group: 'body', body: featBody });
  } else {
    sections.push({
      title: 'CORE FEATURES',
      group: 'body',
      body: 'No features are recorded. Do not invent features beyond what the recorded requirements imply.'
    });
  }

  const wfBody = buildUserWorkflow(d);
  if (wfBody) {
    sections.push({ title: 'USER WORKFLOW', group: 'body', body: wfBody });
  }

  const researchBody = buildResearchFindings(d);
  if (researchBody) {
    sections.push({ title: 'RESEARCH FINDINGS', group: 'body', body: researchBody });
  }

  sections.push({ title: 'ASSUMPTIONS', group: 'body', body: buildAssumptions(d) });

  sections.push({ title: 'CONSTRAINTS', group: 'body', body: buildConstraints(d) });

  sections.push({ title: 'TECHNICAL DIRECTION', group: 'body', body: buildTechnicalDirection(d) });

  sections.push({ title: 'ARCHITECTURE', group: 'body', body: buildArchitecture(d) });

  sections.push({
    title: 'IMPLEMENTATION EXPECTATIONS',
    group: 'final',
    body: [
      '1. Ask for the missing context up front: the project does not record everything, so do the briefing now, when the cost of being wrong is lowest.',
      `2. Target ${platform}. Treat the platform as a hard input to your design decisions.`,
      '3. V1 means small and real: implement the core requirements and features above, nothing more, nothing implied. Do not scaffold for scale.',
      '4. Follow an incremental plan: propose the milestone, implement it, run the checks, then report. Do not try to build everything in one pass.',
      '5. Prefer exactly the V1 scope; if you believe a requirement is ambiguous, prefer the smallest interpretation and flag it.'
    ].join('\n')
  });

  sections.push({
    title: 'VALIDATION',
    group: 'final',
    body:
      'Build must be reproducible: the project must start with the recorded commands, and the implemented behavior must be testable against the core requirements and features above. Automated checks that guard the core behavior are expected where a test setup is standard for the chosen stack.'
  });

  sections.push({
    title: 'FINAL EXPECTED RESULT',
    group: 'final',
    body:
      'A working first usable version of this project for ' +
      platform +
      ', implementing the V1 scope, matching the recorded requirements and features, in a well-structured repository the user actually runs. If anything needed is missing from the project documentation, state it as an assumption or question — never silently invent requirements.'
  });

  let text =
    'You are building the first usable version (V1) of the project described below. ' +
    'Read the whole prompt before doing anything. ' +
    'Where the project data below is incomplete, treat it as information to CONFIRM with the user during the briefing.\n\n';

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    text += `## ${s.title}\n${s.body}\n\n`;
  }

  text +=
    'Above all: implement only what the project says, keep V1 minimal, and make sure it runs. ' +
    'If this prompt ever disagrees with the project documentation, the project documentation wins.\n';

  return { text, problems };
};

export function buildV1Prompt(
  context: GenerationContext,
  analysis: PromptAnalysis,
  options: GeneratorOptions,
  gaps: ReadinessCheck[] = []
): { promptText: string; sectionProblems: string[] } {
  const d: BuildDeps = { context, analysis, options, gaps };
  const out = buildPrompt(d);
  return { promptText: out.text, sectionProblems: out.problems };
}