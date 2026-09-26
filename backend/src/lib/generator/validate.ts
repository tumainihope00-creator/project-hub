import type { GenerationContext, PromptAnalysis, PromptValidation, ValidationIssue } from './types.js';
import { tokenize } from './normalize.js';

// Post-generation sanity check. Looks for structural problems that would ruin
// the prompt, not for editing mistakes — the user reviews the text before saving.

const SECTION_RE = /## (ROLE|PROJECT|PROBLEM|TARGET USERS|V1 OBJECTIVE|V1 SCOPE|OUT OF SCOPE|CORE REQUIREMENTS|CORE FEATURES|USER WORKFLOW|RESEARCH FINDINGS|ASSUMPTIONS|CONSTRAINTS|TECHNICAL DIRECTION|ARCHITECTURE|IMPLEMENTATION EXPECTATIONS|VALIDATION|FINAL EXPECTED RESULT|MISSING INFORMATION — CONFIRM BEFORE BUILDING)/g;

function countTokens(text: string): number {
  return tokenize(text).length;
}

export function validatePrompt(
  promptText: string,
  context: GenerationContext,
  analysis: PromptAnalysis,
  _options: unknown
): PromptValidation {
  const issues: ValidationIssue[] = [];
  const totalTokens = countTokens(promptText);

  const checks: PromptValidation['checks'] = [
    { key: 'hasRole', label: 'Has ROLE section', ok: /^## ROLE/m.test(promptText) },
    { key: 'hasSections', label: 'Has all required sections', ok: false },
    { key: 'hasScope', label: 'Defines V1 scope', ok: /^## V1 SCOPE/m.test(promptText) && !/## V1 SCOPE\s*$/m.test(promptText) },
    { key: 'notEmpty', label: 'Non-empty prompt', ok: promptText.trim().length > 0 },
    { key: 'sensibleLength', label: 'Sensible length', ok: totalTokens >= 50 && totalTokens <= 8000 }
  ];

  const found = new Set<string>();
  for (const m of promptText.matchAll(SECTION_RE)) found.add(m[1]);
  const requiredSections = [
    'ROLE', 'PROJECT', 'PROBLEM', 'TARGET USERS', 'V1 OBJECTIVE', 'V1 SCOPE',
    'OUT OF SCOPE', 'ASSUMPTIONS', 'CONSTRAINTS', 'TECHNICAL DIRECTION',
    'ARCHITECTURE', 'IMPLEMENTATION EXPECTATIONS', 'VALIDATION', 'FINAL EXPECTED RESULT'
  ];
  const missing = requiredSections.filter(s => !found.has(s));
  checks.find(c => c.key === 'hasSections')!.ok = missing.length === 0;
  if (missing.length > 0) {
    issues.push({
      section: 'structure',
      message: `Missing sections: ${missing.join(', ')}.`,
      severity: 'error'
    });
  }

  if (totalTokens < 50) {
    issues.push({ section: 'size', message: 'The generated prompt is very short — check that collected data was meaningful.', severity: 'warning' });
  }

  const reqLines = (promptText.match(/^[A-Z]{2,}-\d+\s*—/gm) ?? []).length;
  const reqCount = context.requirements.filter(r => !['REJECTED', 'DEFERRED'].includes(r.status)).length;
  if (reqCount > 0 && reqLines === 0) {
    issues.push({
      section: 'CORE REQUIREMENTS',
      message: `The project records ${reqCount} active requirements but none appear in the prompt.`,
      severity: 'warning'
    });
  }

  const feats = context.features.filter(f => f.status !== 'DROPPED');
  const hasFeatures = feats.length > 0;
  const featSectionEmpty = /^## CORE FEATURES\n(No features are recorded\.)/m.test(promptText);
  if (hasFeatures && featSectionEmpty) {
    issues.push({
      section: 'CORE FEATURES',
      message: `The project records ${feats.length} features but the section says none exist.`,
      severity: 'error'
    });
  }

  const placeholders = promptText.match(/TODO|FIXME|Lorem ipsum|PLACEHOLDER|\[insert|\[your /gi);
  if (placeholders) {
    issues.push({
      section: 'content',
      message: `Placeholder text present: ${placeholders.slice(0, 3).join(', ')}.`,
      severity: 'warning'
    });
  }

  let incompleteNotice = 0;
  incompleteNotice += /Not documented|not recorded|No explicit/.test(promptText) ? 1 : 0;
  if (analysis.readiness.score < 60 && incompleteNotice === 0) {
    issues.push({
      section: 'content',
      message: 'Readiness is low but the prompt does not tell the AI about missing context.',
      severity: 'warning'
    });
  }

  const passed = issues.every(i => i.severity !== 'error');
  return { passed, issues, checks };
}