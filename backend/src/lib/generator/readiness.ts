import {
  AI_ENVIRONMENTS,
  READINESS_GROUP_LABELS,
  TARGET_PLATFORMS,
  TECHNOLOGY_PREFERENCES
} from './types.js';
import type {
  GenerationContext,
  GeneratorOptions,
  ReadinessCheck,
  ReadinessGroup,
  ReadinessInput,
  ReadinessLevel,
  ReadinessReport,
  ReadinessStatus,
  ReadinessTally,
  SourceFailure,
  WizardStep
} from './types.js';
import { tokenize } from './normalize.js';

// ---------------------------------------------------------------------------
// Prompt Readiness Check — the single source of truth.
//
// buildPromptReadiness(project data + generator options) -> ReadinessReport
//
// Every expected item is evaluated independently and receives one of
// COMPLETE / PARTIAL / MISSING / OPTIONAL / ERROR. The API serves this report,
// the wizard walks its steps, and the prompt builder consumes the same report.
// There is deliberately no second implementation of these rules anywhere.
// ---------------------------------------------------------------------------

// --- Content quality --------------------------------------------------------

/** Values that are clearly not documentation. Matched case-insensitively. */
const PLACEHOLDERS = new Set([
  'x', 'xx', 'xxx', 'test', 'testing', 'test test', 'asdf', 'qwerty', 'lorem',
  'lorem ipsum', 'ipsum', 'todo', 'tbd', 'tba', 'n/a', 'na', 'none', 'nope',
  'nothing', 'nil', 'null', 'undefined', 'no', 'unknown', 'pending', 'placeholder',
  'example', 'foo', 'bar', 'baz', '???', '...', '-', '--', '?', '??', '.',
  'not sure', 'idk', 'to be decided', 'to be defined', 'to be determined',
  'coming soon', 'later', 'stuff', 'things', 'etc', 'more', 'misc'
]);

export type TextQuality = 'empty' | 'placeholder' | 'thin' | 'ok';

export interface TextAssessment {
  quality: TextQuality;
  /** Sentence explaining the verdict, shown in the checklist. */
  message: string;
  tokens: number;
}

/**
 * Judge whether free text is usable project documentation.
 *
 * Deliberately conservative: it catches empty/whitespace/placeholder/very short
 * values and nothing more. It is not an AI-style quality score and never judges
 * the quality of the user's writing.
 */
export function assessText(
  value: string | null | undefined,
  opts: { minTokens?: number } = {}
): TextAssessment {
  const minTokens = opts.minTokens ?? 3;
  const raw = (value ?? '').trim();
  if (raw.length === 0) {
    return { quality: 'empty', message: 'No information has been recorded.', tokens: 0 };
  }

  const tokens = tokenize(raw);
  const collapsed = raw.toLowerCase().replace(/[.!?,;:]+$/g, '').trim();

  if (PLACEHOLDERS.has(collapsed) || PLACEHOLDERS.has(raw.toLowerCase())) {
    return {
      quality: 'placeholder',
      message: `Recorded as "${truncate(raw)}", which is a placeholder rather than real documentation.`,
      tokens: tokens.length
    };
  }

  if (tokens.length < minTokens) {
    return {
      quality: 'thin',
      message: `Only ${tokens.length} meaningful word${tokens.length === 1 ? '' : 's'} recorded — this is too brief to work from.`,
      tokens: tokens.length
    };
  }

  return { quality: 'ok', message: truncate(raw), tokens: tokens.length };
}

const truncate = (v: string, max = 180): string => {
  const clean = v.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

const countOf = (n: number, singular: string, plural?: string): string =>
  `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;

// --- Item definitions -------------------------------------------------------

/** Project columns the wizard may write to. Mirrors projectUpdateSchema. */
export const COMPLETABLE_PROJECT_FIELDS = [
  'name',
  'description',
  'problem',
  'motivation',
  'targetUsers',
  'expectedValue',
  'assumptions',
  'initialQuestions',
  'inspiration',
  'v1Scope',
  'repositoryUrl'
] as const;

export type CompletableProjectField = (typeof COMPLETABLE_PROJECT_FIELDS)[number];

interface Definition {
  key: string;
  label: string;
  group: ReadinessGroup;
  level: ReadinessLevel;
  /** Stages where the project should pay extra attention to this item. */
  emphasiseIn: string[];
  reason: string;
  action: string;
  /**
   * What the generated prompt must say when this item is missing. The user
   * explicitly chose to proceed, so the prompt acknowledges the gap instead of
   * silently inventing the information. Empty string = nothing to add.
   */
  gapInstruction?: string;
  /** Evaluates the item from collected data + generator options. */
  evaluate: (ctx: {
    c: GenerationContext;
    options: GeneratorOptions;
    /** Present when a source read for this item failed. */
    failure?: SourceFailure;
  }) => { status: Exclude<ReadinessStatus, 'ERROR'>; detail: string; input: ReadinessInput };
}

const textInput = (
  field: CompletableProjectField,
  label: string,
  prompt: string,
  hint: string
): ReadinessInput => ({ kind: 'text', field, label, prompt, hint });

const choiceInput = (
  option: string,
  label: string,
  prompt: string,
  hint: string,
  choices: string[]
): ReadinessInput => ({ kind: 'choice', option, label, prompt, hint, choices });

/** Required, text-backed project field. */
function requiredText(
  key: string,
  label: string,
  field: CompletableProjectField,
  prompt: string,
  hint: string,
  reason: string,
  action: string,
  /** Sentence shown when the field is empty, phrased for this specific item. */
  missingDetail: string,
  group: ReadinessGroup = 'core',
  gapInstruction?: string
): Definition {
  return {
    key,
    label,
    group,
    level: 'required',
    emphasiseIn: [],
    reason,
    action,
    gapInstruction,
    evaluate: ({ c }) => {
      const a = assessText(c.project[field] as string | null | undefined);
      if (a.quality === 'ok') {
        return { status: 'COMPLETE', detail: a.message, input: null };
      }
      return {
        status: 'MISSING',
        detail: a.quality === 'empty' ? missingDetail : a.message,
        input: textInput(field, label, prompt, hint)
      };
    }
  };
}

/** How many records of a kind are enough to stop calling it thin. */
const SOLID_COUNTS: Record<string, number> = {
  requirements: 3,
  features: 3,
  researchEntries: 1,
  decisions: 1
};

const DEFINITIONS: Definition[] = [
  // --- Core information (required) ----------------------------------------
  {
    key: 'name',
    label: 'Project name',
    group: 'core',
    level: 'required',
    emphasiseIn: [],
    reason: 'The prompt has to name the project so the AI agent builds the right thing.',
    action: 'Give the project a name.',
    gapInstruction:
      'The project has no recorded name. Use a neutral placeholder derived from the description below and ask the user to confirm the name at the start of the task.',
    evaluate: ({ c }) => {
      const a = assessText(c.project.name, { minTokens: 1 });
      return a.quality === 'ok'
        ? { status: 'COMPLETE', detail: a.message, input: null }
        : {
            status: 'MISSING',
            detail: 'The project has no name.',
            input: textInput('name', 'Project name', 'What is this project called?', 'A short, recognisable name.')
          };
    }
  },
  requiredText(
    'description',
    'Short description',
    'description',
    'What should the first usable version of this project contain, in a sentence or two?',
    'Describe the system in plain language — what it is and what it does.',
    'The description is the first thing the AI agent reads. Without it there is nothing concrete to build from.',
    'Describe what the system does.',
    'No short description has been recorded.',
    'core',
    'The project has no short description. Do not invent a product description. Build strictly from the requirements and features recorded below, and ask the user to describe the system at the start of the task.'
  ),
  requiredText(
    'problem',
    'Problem it solves',
    'problem',
    'What problem does this project solve?',
    'Describe the pain today, and why the usual approach does not work.',
    'A build prompt without a problem statement produces a feature list with no reason behind it.',
    'State the problem this project solves.',
    'No problem statement has been recorded.',
    'core',
    'The problem this project solves has not been documented. Do not invent one. Before implementing, ask the user which problem this is meant to solve, and treat their answer as the problem statement.'
  ),
  requiredText(
    'targetUsers',
    'Target users',
    'targetUsers',
    'Who will use this system?',
    'Name the primary user and their context — experience level, device, situation.',
    'Target users drive nearly every design decision: platform, terminology, onboarding and defaults.',
    'Define who will use the system.',
    'No target users have been defined.',
    'core',
    'Target users have not been specified. Do not assume an audience. Ask the user who the primary user is during the briefing, and keep every design decision provisional until they answer.'
  ),
  requiredText(
    'expectedValue',
    'Expected outcome',
    'expectedValue',
    'What does a successful V1 achieve?',
    'Describe the outcome a user gets once V1 works — not a task list, the result.',
    'The expected outcome is the definition of done. Without it the AI agent cannot tell when V1 is finished.',
    'Describe what success looks like for V1.',
    'No expected outcome has been recorded.',
    'core',
    'The expected outcome has not been documented. Do not define success yourself. Treat the core requirements and features below as the provisional definition of done, and ask the user what a successful V1 achieves.'
  ),
  requiredText(
    'v1Scope',
    'V1 scope',
    'v1Scope',
    'What must exist in the first usable version?',
    'List the minimum functionality. Be explicit about what is deliberately excluded.',
    'V1 scope is the boundary of the build. Without it the AI agent may add functionality that was never wanted.',
    'Define what the first usable version should contain.',
    'No V1 scope has been defined.',
    'core',
    'V1 scope has not been explicitly defined. Treat the documented features and requirements as the provisional V1 scope and avoid introducing additional functionality.'
  ),

  // --- Project context (recommended / optional) ----------------------------
  {
    key: 'motivation',
    label: 'Motivation',
    group: 'context',
    level: 'optional',
    emphasiseIn: ['IDEA', 'RESEARCH'],
    reason: 'Motivation helps the AI agent understand the trade-offs you care about.',
    action: 'Optional - record why you want to build this.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const a = assessText(c.project.motivation);
      return a.quality === 'ok'
        ? { status: 'COMPLETE', detail: a.message, input: null }
        : {
            status: 'OPTIONAL',
            detail: a.quality === 'empty' ? 'No motivation recorded. Optional.' : a.message,
            input: textInput('motivation', 'Motivation', 'Why do you want to build this?', 'Personal driver behind the project.')
          };
    }
  },
  {
    key: 'assumptions',
    label: 'Assumptions',
    group: 'context',
    level: 'recommended',
    emphasiseIn: ['RESEARCH', 'PLANNING', 'ARCHITECTURE'],
    reason: 'Assumptions become constraints. Unstated assumptions are where AI builds go wrong.',
    action: 'Record the assumptions the design depends on.',
    gapInstruction: 'No assumptions are recorded. When a decision is needed and the project data does not answer it, either ask the user or make the smallest reasonable assumption and flag it explicitly in your plan.',
    evaluate: ({ c }) => {
      const a = assessText(c.project.assumptions);
      if (a.quality === 'ok') return { status: 'COMPLETE', detail: a.message, input: null };
      if (a.quality === 'thin') {
        return {
          status: 'PARTIAL',
          detail: a.message,
          input: textInput('assumptions', 'Assumptions', 'What does this design assume to be true?', 'Device, user skill, data volume, network, budget.')
        };
      }
      return {
        status: 'MISSING',
        detail: 'No assumptions recorded.',
        input: textInput('assumptions', 'Assumptions', 'What does this design assume to be true?', 'Device, user skill, data volume, network, budget.')
      };
    }
  },
  {
    key: 'initialQuestions',
    label: 'Initial questions',
    group: 'context',
    level: 'optional',
    emphasiseIn: ['IDEA', 'RESEARCH'],
    reason: 'Open questions tell the AI agent what you are genuinely unsure about.',
    action: 'Optional - note the questions you still need answered.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const a = assessText(c.project.initialQuestions);
      return a.quality === 'ok'
        ? { status: 'COMPLETE', detail: a.message, input: null }
        : {
            status: 'OPTIONAL',
            detail: a.quality === 'empty' ? 'No open questions recorded. Optional.' : a.message,
            input: textInput('initialQuestions', 'Initial questions', 'What are you still unsure about?', 'Anything the build could get wrong.')
          };
    }
  },
  {
    key: 'inspiration',
    label: 'Inspiration',
    group: 'context',
    level: 'optional',
    emphasiseIn: ['IDEA'],
    reason: 'References the build should resemble give the AI agent a concrete direction.',
    action: 'Optional - link the projects or ideas this is based on.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const a = assessText(c.project.inspiration, { minTokens: 1 });
      return a.quality === 'ok'
        ? { status: 'COMPLETE', detail: a.message, input: null }
        : {
            status: 'OPTIONAL',
            detail: a.quality === 'empty' ? 'No inspiration recorded. Optional.' : a.message,
            input: textInput('inspiration', 'Inspiration', 'What is this based on or inspired by?', 'Other apps, products, articles or people.')
          };
    }
  },

  // --- Research ------------------------------------------------------------
  {
    key: 'researchEntries',
    label: 'Research entries',
    group: 'research',
    level: 'recommended',
    emphasiseIn: ['RESEARCH', 'PLANNING'],
    reason: 'Research shows which decisions are already settled and which are guesses.',
    action: 'Add research entries so the prompt can cite what you already learned.',
    gapInstruction: 'No research is recorded for this project. Treat every statement in this prompt as an untested assumption about the domain, and do not present unverified assumptions as established requirements.',
    evaluate: ({ c }) => {
      const n = c.research.length;
      if (n === 0) {
        return {
          status: 'MISSING',
          detail: 'No research entries yet.',
          action: 'Add a research entry.',
          input: { kind: 'count', resource: 'research', label: 'Research entry', prompt: 'What have you already looked into?', hint: 'Add at least one research entry describing what you checked and what you concluded.' }
        };
      }
      const withFindings = c.research.filter(r => assessText(r.findings ?? r.summary ?? r.relevance).quality === 'ok').length;
      if (withFindings === 0) {
        return {
          status: 'PARTIAL',
          detail: `${countOf(n, 'entry', 'entries')} recorded, but none contain findings or a summary.`,
          action: 'Add findings to a research entry.',
          input: { kind: 'count', resource: 'research', label: 'Research entry', prompt: 'Which entry should record what you concluded?', hint: 'Findings turn research into something the prompt can use.' }
        };
      }
      return { status: 'COMPLETE', detail: `${countOf(n, 'entry', 'entries')}, ${withFindings} with findings.`, input: null };
    }
  },
  {
    key: 'researchFindings',
    label: 'Relevant findings',
    group: 'research',
    level: 'recommended',
    action: 'Record the findings that affect the V1 decision.',
    emphasiseIn: ['RESEARCH', 'PLANNING', 'ARCHITECTURE'],
    reason: 'Findings are the only research that changes what gets built. Titles alone do not.',
    gapInstruction: 'Research entries exist but none record findings. Do not cite research conclusions that are not written down; the sections below are the only verified input.',
    evaluate: ({ c }) => {
      const findings = c.research
        .map(r => r.findings ?? r.summary ?? r.relevance ?? '')
        .filter(t => assessText(t).quality === 'ok');
      if (findings.length === 0) {
        return {
          status: 'MISSING',
          detail: 'No research findings or summaries recorded.',
          action: 'Record a research finding.',
          input: { kind: 'count', resource: 'research', label: 'Research finding', prompt: 'What did the research actually conclude?', hint: 'Write the conclusion, not just the topic.' }
        };
      }
      return { status: 'COMPLETE', detail: `${countOf(findings.length, 'finding')}.`, input: null };
    }
  },

  // --- Planning ------------------------------------------------------------
  {
    key: 'requirements',
    label: 'Requirements',
    group: 'planning',
    action: 'Record the requirements V1 must satisfy.',
    level: 'recommended',
    emphasiseIn: ['IDEA', 'PLANNING', 'BUILDING', 'TESTING'],
    reason: 'Requirements are what the build is verified against. Without them the prompt can only list features.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const active = c.requirements.filter(r => !['REJECTED', 'DEFERRED'].includes(r.status));
      const solid = SOLID_COUNTS.requirements;
      if (active.length === 0) {
        return {
          status: 'MISSING',
          detail: 'No requirements recorded.',
          action: 'Add a requirement.',
          input: { kind: 'count', resource: 'requirements', label: 'Requirement', prompt: 'What must the system do?', hint: `Aim for at least ${solid} requirements so the build has a definition of done.` }
        };
      }
      if (active.length < solid) {
        return {
          status: 'PARTIAL',
          detail: `${countOf(active.length, 'requirement')} found. A more complete requirements definition may improve the generated prompt.`,
          action: 'Add more requirements.',
          input: { kind: 'count', resource: 'requirements', label: 'Requirement', prompt: 'Which requirements are still undefined?', hint: `${countOf(solid - active.length, 'requirement')} more would cover the core behaviour.` }
        };
      }
      return { status: 'COMPLETE', detail: `${countOf(active.length, 'requirement')} recorded.`, input: null };
    }
  },
  {
    key: 'features',
    action: 'Record the features V1 should contain.',
    label: 'Features',
    group: 'planning',
    level: 'recommended',
    emphasiseIn: ['IDEA', 'PLANNING', 'BUILDING'],
    reason: 'Features define the shape of the first usable version.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const active = c.features.filter(f => f.status !== 'DROPPED');
      const solid = SOLID_COUNTS.features;
      if (active.length === 0) {
        return {
          status: 'MISSING',
          detail: 'No features recorded.',
          action: 'Add a feature.',
          input: { kind: 'count', resource: 'features', label: 'Feature', prompt: 'What can a user actually do in V1?', hint: `Aim for at least ${solid} features.` }
        };
      }
      if (active.length < solid) {
        return {
          status: 'PARTIAL',
          detail: `${countOf(active.length, 'feature')} found. More detail would sharpen the V1 boundary.`,
          action: 'Add more features.',
          input: { kind: 'count', resource: 'features', label: 'Feature', prompt: 'Which capabilities are still undefined?', hint: `${countOf(solid - active.length, 'feature')} more would round out V1.` }
        };
      }
      return { status: 'COMPLETE', detail: `${countOf(active.length, 'feature')} recorded.`, input: null };
    }
  },
  {
    key: 'architecture',
    label: 'Architecture',
    group: 'planning',
    level: 'optional',
    emphasiseIn: ['ARCHITECTURE', 'BUILDING', 'TESTING', 'DEPLOYMENT', 'PRODUCTION'],
    reason: 'Recorded structure and stack stop the AI agent from reinventing what already exists.',
    action: 'Optional - record the architecture so the build matches it.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const decisions = c.decisions.filter(d => d.status === 'ACCEPTED');
      const parts: string[] = [];
      if (c.techStack.length) parts.push(countOf(c.techStack.length, 'technology', 'technologies'));
      if (decisions.length) parts.push(`${countOf(decisions.length, 'accepted decision')}`);
      if (c.databaseTables.length) parts.push(`${countOf(c.databaseTables.length, 'table')}`);
      if (c.apiEndpoints.length) parts.push(`${countOf(c.apiEndpoints.length, 'endpoint')}`);
      if (parts.length === 0) {
        return {
          status: 'OPTIONAL',
          detail: 'No architecture, stack or data model recorded. Optional.',
          input: null
        };
      }
      return { status: 'COMPLETE', detail: parts.join(' · ') + '.', input: null };
    }
  },
  {
    key: 'technicalDecisions',
    label: 'Technical decisions',
    group: 'planning',
    level: 'optional',
    emphasiseIn: ['ARCHITECTURE', 'BUILDING'],
    reason: 'Decisions already made are decisions the AI agent must not reopen.',
    action: 'Optional - record the decisions already taken.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const decisions = c.decisions.filter(d => d.status === 'ACCEPTED');
      if (decisions.length === 0) {
        return {
          status: 'OPTIONAL',
          detail: 'No accepted technical decisions recorded. Optional.',
          action: 'Optional — record a decision.',
          input: { kind: 'count', resource: 'decisions', label: 'Technical decision', prompt: 'Which technical decisions are already settled?', hint: 'The AI agent must respect these rather than choosing again.' }
        };
      }
      const withBody = decisions.filter(d => assessText(d.decision ?? d.reasoning).quality === 'ok').length;
      if (withBody === 0) {
        return {
          status: 'PARTIAL',
          detail: `${countOf(decisions.length, 'decision')} recorded, but none state what was decided.`,
          action: 'Optional — fill in the decision.',
          input: { kind: 'count', resource: 'decisions', label: 'Technical decision', prompt: 'What was actually decided?', hint: 'Record the decision itself, not only the title.' }
        };
      }
      return { status: 'COMPLETE', detail: `${countOf(decisions.length, 'accepted decision')}.`, input: null };
    }
  },
  {
    key: 'repository',
    label: 'Repository',
    group: 'planning',
    level: 'optional',
    emphasiseIn: ['BUILDING', 'TESTING', 'DEPLOYMENT', 'PRODUCTION', 'MAINTENANCE'],
    reason: 'A repository reference lets a continuing prompt point the AI agent at the real code.',
    action: 'Optional - record the repository URL.',
    gapInstruction: '',
    evaluate: ({ c }) => {
      const url = c.project.repositoryUrl;
      const git = c.gitReferences.filter(g => g.kind === 'REPOSITORY' && g.repositoryUrl);
      if (assessText(url, { minTokens: 1 }).quality === 'ok') {
        return { status: 'COMPLETE', detail: truncate(url as string), input: null };
      }
      if (git.length > 0) {
        return { status: 'COMPLETE', detail: truncate(git[0].repositoryUrl as string), input: null };
      }
      return {
        status: 'OPTIONAL',
        detail: 'No repository recorded. Optional.',
        input: textInput('repositoryUrl', 'Repository', 'Where does the code live?', 'A GitHub/GitLab URL. Leave empty if there is no code yet.')
      };
    }
  },
  {
    key: 'developmentHistory',
    label: 'Existing development history',
    group: 'planning',
    level: 'optional',
    emphasiseIn: ['BUILDING', 'TESTING', 'DEPLOYMENT', 'PRODUCTION', 'MAINTENANCE'],
    reason: 'A continuing prompt needs to know what has already been built.',
    action: 'Optional - record sessions, prompts or tasks so the prompt can continue existing work.',
    gapInstruction: 'No development history is recorded, so you cannot see prior work. Before changing anything, inspect the current state of the project and report any difference between what you find and what this prompt assumes.',
    evaluate: ({ c, options }) => {
      const sessions = c.devSessions.length;
      const ai = c.aiSessions.length;
      const prompts = c.prompts.length;
      const done = c.tasks.filter(t => t.status === 'COMPLETED').length;
      const parts: string[] = [];
      if (sessions) parts.push(`${countOf(sessions, 'development session')}`);
      if (ai) parts.push(`${countOf(ai, 'AI session')}`);
      if (prompts) parts.push(`${countOf(prompts, 'prompt')}`);
      if (done) parts.push(`${countOf(done, 'completed task')}`);

      if (parts.length === 0) {
        const severity: Exclude<ReadinessStatus, 'ERROR'> =
          options.developmentApproach === 'Continue existing project' ? 'MISSING' : 'OPTIONAL';
        return {
          status: severity,
          detail:
            severity === 'MISSING'
              ? 'The project is marked as an existing project, but repository/development information is limited.'
              : 'No development history yet. Optional.',
          input: {
            kind: 'count',
            resource: 'developmentSessions',
            label: 'Development session',
            prompt: 'What has already been built?',
            hint: 'A continuing prompt cannot describe work it cannot see.'
          }
        };
      }
      return { status: 'COMPLETE', detail: parts.join(' · ') + '.', input: null };
    }
  },

  // --- Generator configuration --------------------------------------------
  {
    key: 'targetPlatform',
    label: 'Target platform',
    group: 'config',
    level: 'recommended',
    emphasiseIn: ['IDEA', 'RESEARCH', 'PLANNING', 'ARCHITECTURE', 'BUILDING'],
    reason: 'The platform decides UI, storage, permissions and deployment. The AI agent must not assume one.',
    action: 'Select the target platform, or "Not decided" to make the agent evaluate it.',
    gapInstruction: 'Target platform has not been specified. Do not assume a platform without first evaluating the project requirements: state which platform you are choosing, why it fits the documented requirements, and flag it as a decision for the user to confirm.',
    evaluate: ({ options }) => {
      if (options.targetPlatform === 'Not decided') {
        return {
          status: 'MISSING',
          detail: 'No platform selected.',
          input: choiceInput(
            'targetPlatform',
            'Target platform',
            'Where will this run?',
            'Pick a platform, or choose "Not decided" to have the AI agent evaluate the requirements first.',
            [...TARGET_PLATFORMS]
          )
        };
      }
      return { status: 'COMPLETE', detail: options.targetPlatform, input: null };
    }
  },
  {
    key: 'technology',
    label: 'Technology preference',
    group: 'config',
    level: 'recommended',
    emphasiseIn: ['ARCHITECTURE', 'BUILDING', 'DEPLOYMENT', 'PRODUCTION'],
    reason: 'The stack has to come from somewhere — either you choose it, or the AI agent recommends one.',
    action: 'Choose how the technology stack should be decided.',
    gapInstruction: 'No technology preference has been recorded. Choose a mainstream stack that fits the problem and the target platform, state the choice and the reason, and flag it as a decision for the user.',
    evaluate: ({ options }) => {
      if (options.technology === 'Not decided') {
        return {
          status: 'MISSING',
          detail: 'No technology preference selected.',
          input: choiceInput(
            'technology',
            'Technology',
            'How should the technology stack be decided?',
            'Choose "Recommend appropriate stack" to let the AI agent pick, or "Specify technology" to name it yourself.',
            [...TECHNOLOGY_PREFERENCES]
          )
        };
      }
      if (options.technology === 'Specify technology') {
        const a = assessText(options.customTech, { minTokens: 1 });
        if (a.quality !== 'ok') {
          return {
            status: 'MISSING',
            detail: 'No technology specified.',
            input: {
              kind: 'choiceText',
              option: 'technology',
              textOption: 'customTech',
              label: 'Technology stack',
              prompt: 'Which technology stack should be used?',
              hint: 'e.g. React 18 + TypeScript + Node + PostgreSQL. This is required because you selected "Specify technology".',
              choices: [...TECHNOLOGY_PREFERENCES]
            }
          };
        }
        return { status: 'COMPLETE', detail: a.message, input: null };
      }
      if (options.technology === 'Recommend appropriate stack') {
        return { status: 'COMPLETE', detail: 'AI agent will recommend an appropriate stack.', input: null };
      }
      return { status: 'COMPLETE', detail: options.technology, input: null };
    }
  },
  {
    key: 'developmentApproach',
    label: 'Development approach',
    group: 'config',
    level: 'recommended',
    emphasiseIn: ['IDEA', 'RESEARCH', 'PLANNING', 'ARCHITECTURE', 'BUILDING', 'TESTING'],
    reason: 'Whether to build fresh or continue changes the whole shape of the prompt.',
    action: 'Choose how the AI agent should approach the build.',
    gapInstruction: '',
    evaluate: ({ options }) => ({
      status: 'COMPLETE' as const,
      detail: options.developmentApproach,
      input: null
    })
  },
  {
    key: 'aiEnvironment',
    label: 'AI environment',
    group: 'config',
    level: 'optional',
    emphasiseIn: ['IDEA', 'BUILDING', 'TESTING'],
    reason: 'The prompt is framed for the tool that will run it.',
    action: 'Optional - tell the generator which AI tool will receive the prompt.',
    gapInstruction: '',
    evaluate: ({ options }) => ({
      status: 'OPTIONAL' as const,
      detail: options.aiEnvironment === 'General AI coding agent'
        ? 'Using a general AI coding agent. Optional — name a specific tool if you have one.'
        : options.aiEnvironment,
      input: choiceInput(
        'aiEnvironment',
        'AI environment',
        'Which AI tool will run this prompt?',
        'The prompt is framed for the tool that receives it.',
        [...AI_ENVIRONMENTS]
      )
    })
  }
];

/** Failure keys that invalidate a specific check. */
const FAILURE_TARGETS: Record<string, string[]> = {
  researchEntries: ['researchEntries', 'researchFindings'],
  researchQuestions: ['researchEntries'],
  requirements: ['requirements'],
  features: ['features'],
  decisions: ['technicalDecisions', 'architecture'],
  techStack: ['architecture', 'technology'],
  databaseTables: ['architecture'],
  apiEndpoints: ['architecture'],
  developmentSessions: ['developmentHistory'],
  aiSessions: ['developmentHistory'],
  prompts: ['developmentHistory'],
  gitReferences: ['repository', 'developmentHistory']
};

// --- Report assembly -------------------------------------------------------

const tally = (checks: ReadinessCheck[]): ReadinessTally => {
  const complete = checks.filter(c => c.status === 'COMPLETE').length;
  const partial = checks.filter(c => c.status === 'PARTIAL').length;
  const missing = checks.filter(c => c.status === 'MISSING' || c.status === 'ERROR').length;
  return { complete, partial, missing, total: checks.length, available: complete + partial };
};

/** Required first, then recommended, then optional — inside each, display order. */
const LEVEL_ORDER: Record<ReadinessLevel, number> = { required: 0, recommended: 1, optional: 2 };

function orderChecks(checks: ReadinessCheck[]): ReadinessCheck[] {
  return [...checks].sort((a, b) => {
    // A failed read is surfaced immediately, whatever its level.
    const aErr = a.status === 'ERROR' ? 0 : 1;
    const bErr = b.status === 'ERROR' ? 0 : 1;
    if (aErr !== bErr) return aErr - bErr;
    if (LEVEL_ORDER[a.level] !== LEVEL_ORDER[b.level]) return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    return 0;
  });
}

const currentValue = (
  input: ReadinessInput,
  c: GenerationContext,
  options: GeneratorOptions
): string => {
  if (!input) return '';
  if (input.kind === 'text') {
    return (c.project as unknown as Record<string, string | null>)[input.field] ?? '';
  }
  if (input.kind === 'choice' || input.kind === 'choiceText') {
    return (options as unknown as Record<string, string>)[input.option] ?? '';
  }
  return '';
};

/**
 * Ordered items the wizard walks through, one at a time.
 *
 * Only items the wizard can genuinely fill are included: a project text column
 * or a generator option. Counted resources (requirements, features, research,
 * decisions) are reported in the checklist as "add these on their own page"
 * instead of pretending the wizard can create them. Optional items are never
 * required to generate, so they are not put in front of the user as work.
 */
function wizardStepsFrom(checks: ReadinessCheck[], c: GenerationContext, options: GeneratorOptions): WizardStep[] {
  return checks
    .filter(
      check =>
        check.status !== 'COMPLETE' &&
        check.status !== 'ERROR' &&
        check.level !== 'optional' &&
        check.input !== null &&
        check.input.kind !== 'count'
    )
    .map(check => {
      const input = check.input as Exclude<ReadinessInput, null>;
      let value = currentValue(input, c, options);
      if (input.kind === 'choiceText') {
        value = (options as unknown as Record<string, string>)[input.textOption] ?? '';
      }
      return {
        key: check.key,
        label: check.label,
        level: check.level,
        status: check.status,
        prompt: input.prompt,
        hint: input.hint,
        input,
        value
      };
    });
}

/**
 * Build the readiness report for a project.
 * Pure: same context + options always produce the same report.
 */
export function buildPromptReadiness(
  context: GenerationContext,
  options: GeneratorOptions,
  failures: SourceFailure[] = [],
  projectId = 0
): ReadinessReport {
  const stage = context.project.stage;
  const failureByCheck = new Map<string, SourceFailure>();
  for (const f of failures) {
    for (const key of FAILURE_TARGETS[f.source] ?? []) failureByCheck.set(key, f);
  }

  const checks: ReadinessCheck[] = DEFINITIONS.map(def => {
    const failure = failureByCheck.get(def.key);
    const base: Omit<ReadinessCheck, 'status' | 'detail' | 'error'> = {
      key: def.key,
      label: def.label,
      group: def.group,
      level: def.level,
      reason: def.reason,
      action: def.action,
      gapInstruction: '',
      input: null,
      emphasiseIn: def.emphasiseIn,
      emphasised: def.emphasiseIn.includes(stage)
    };

    if (failure) {
      return {
        ...base,
        status: 'ERROR',
        detail: `Unable to retrieve ${labelise(def.key)}.`,
        gapInstruction:
          'The project data for this item could not be read, so nothing may be assumed about it. Verify it yourself before relying on it.',
        input: null,
        error: {
          operation: failure.operation,
          reason: failure.reason,
          action: failure.action
        }
      };
    }

    const result = def.evaluate({ c: context, options });
    return {
      ...base,
      status: result.status,
      detail: result.detail,
      // Only carried into the prompt when the item is genuinely not usable.
      gapInstruction:
        result.status === 'COMPLETE' || result.status === 'OPTIONAL'
          ? ''
          : def.gapInstruction ?? `No ${def.label.toLowerCase()} has been recorded. Do not invent it — ask the user or state it as an explicit assumption.`,
      input: result.input
    };
  });

  const ordered = orderChecks(checks);

  const required = ordered.filter(c => c.level === 'required');
  const recommended = ordered.filter(c => c.level === 'recommended');
  const optional = ordered.filter(c => c.level === 'optional');

  const failuresList = ordered.filter(c => c.status === 'ERROR');
  const missingRequired = required.filter(c => c.status === 'MISSING' || c.status === 'ERROR');
  const ready = missingRequired.length === 0;

  const summary = {
    required: tally(required),
    recommended: tally(recommended),
    optional: tally(optional)
  };

  // Informational blend. Required counts for most, so an empty optional section
  // can never look better than a broken required item.
  const weighted = (t: ReadinessTally) => (t.total === 0 ? t.total : t.available / t.total);
  const score = Math.round((weighted(summary.required) * 0.6 + weighted(summary.recommended) * 0.3 + weighted(summary.optional) * 0.1) * 100);

  return {
    project: {
      id: projectId,
      name: context.project.name,
      slug: context.project.slug,
      stage
    },
    checks: ordered,
    summary,
    score,
    ready,
    verdict: failuresList.length > 0 && missingRequired.length > 0 ? 'error' : ready ? 'ready' : 'needs-info',
    missingRequired,
    partialRecommended: recommended.filter(c => c.status === 'PARTIAL'),
    missingOptional: optional.filter(c => c.status === 'OPTIONAL' || c.status === 'MISSING'),
    failures: failuresList,
    stage,
    wizardSteps: wizardStepsFrom(ordered, context, options)
  };
}

const LABEL_OVERRIDES: Record<string, string> = {
  researchEntries: 'research entries',
  researchFindings: 'research findings',
  requirements: 'project requirements',
  features: 'project features',
  decisions: 'architecture decisions',
  techStack: 'the technology stack',
  databaseTables: 'database tables',
  apiEndpoints: 'API endpoints',
  developmentSessions: 'development sessions',
  aiSessions: 'AI sessions',
  prompts: 'AI prompts',
  gitReferences: 'git references',
  tags: 'project tags',
  researchQuestions: 'research questions',
  tasks: 'project tasks',
  notes: 'project notes'
};

const labelise = (key: string): string => LABEL_OVERRIDES[key] ?? key;

/** Human title for the readiness modal, kept beside the report so the UI matches. */
export function readinessTitle(report: ReadinessReport): string {
  if (report.failures.length > 0 && !report.ready) return 'PROMPT GENERATION UNAVAILABLE';
  return report.ready ? 'V1 PROMPT READY' : 'V1 PROMPT NEEDS MORE INFORMATION';
}

export { READINESS_GROUP_LABELS };
export type { Definition as ReadinessDefinition };
