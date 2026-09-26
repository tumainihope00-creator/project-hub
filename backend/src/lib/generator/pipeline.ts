import { collectGenerationData } from './collect.js';
import { analyzeContext } from './analyze.js';
import { buildV1Prompt } from './build.js';
import { validatePrompt } from './validate.js';
import { buildPromptReadiness } from './readiness.js';
import { DEFAULT_OPTIONS } from './types.js';
import type { GenerationResult, GeneratorOptions, ReadinessReport, SourceFailure } from './types.js';

export { collectGenerationContext, collectGenerationData } from './collect.js';
export { analyzeContext } from './analyze.js';
export { buildV1Prompt } from './build.js';
export { validatePrompt } from './validate.js';
export { buildPromptReadiness, assessText } from './readiness.js';
export * from './types.js';

/**
 * Readiness only: what Project Hub expects, what exists, what is missing and why.
 * This is what the "V1 Prompt Readiness Check" modal renders. It never throws for
 * missing information — that is the whole point of the check.
 */
export async function buildReadinessReport(
  projectId: number,
  options: GeneratorOptions = DEFAULT_OPTIONS
): Promise<{ readiness: ReadinessReport; failures: SourceFailure[] }> {
  const { context, failures } = await collectGenerationData(projectId);
  return {
    readiness: buildPromptReadiness(context, options, failures, projectId),
    failures
  };
}

/**
 * Run the full generation pipeline for a project.
 * Deterministic given the same project data + options — no external AI calls.
 *
 * `allowGaps` is the user's "Proceed anyway" decision. When it is false and
 * required information is missing, `generateV1Prompt` throws
 * MissingInformationError so the caller can render the checklist rather than a
 * bare failure. When it is true, the prompt is built from what exists and every
 * gap is stated explicitly inside the prompt text.
 */
export async function generateV1Prompt(
  projectId: number,
  options: GeneratorOptions = DEFAULT_OPTIONS,
  allowGaps = false
): Promise<GenerationResult> {
  const { context, failures } = await collectGenerationData(projectId);
  const readiness = buildPromptReadiness(context, options, failures, projectId);

  if (!allowGaps && !readiness.ready) {
    throw new MissingInformationError(readiness);
  }

  const analysis = analyzeContext(context, options);
  const gaps = readiness.checks.filter(
    c => c.status === 'MISSING' || c.status === 'PARTIAL' || c.status === 'ERROR'
  );
  const { promptText, sectionProblems } = buildV1Prompt(context, analysis, options, gaps);

  const analysisWithProblems = sectionProblems.length > 0
    ? { ...analysis, sectionProblems }
    : analysis;

  const validation = validatePrompt(promptText, context, analysis, options);

  return {
    promptText,
    analysis: analysisWithProblems,
    validation,
    options,
    v1Scope: context.project.v1Scope,
    readiness,
    // Every acknowledged gap, not only the ones that forced "proceed anyway":
    // the prompt lists them all, so this is what the UI reports back.
    proceededWithGaps: gaps.map(g => g.key)
  };
}

/**
 * Thrown when generation is refused because required project information is
 * missing and the user has not chosen "Proceed anyway". Carries the full report
 * so the API can return the exact list of items that need attention.
 */
export class MissingInformationError extends Error {
  readonly readiness: ReadinessReport;

  constructor(readiness: ReadinessReport) {
    const n = readiness.missingRequired.length;
    super(
      `V1 prompt generation needs more project information: ${n} required item${n === 1 ? '' : 's'} missing.`
    );
    this.name = 'MissingInformationError';
    this.readiness = readiness;
  }
}
