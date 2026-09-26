import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createProject, destroyProject, prisma, uniqueName } from './helpers';

interface TestProject {
  id: number;
  slug: string;
  name: string;
  stage: string;
}

const base = () => (p: TestProject) => `/api/projects/${p.id}`;

async function createProjectWith(fields: Record<string, unknown>): Promise<TestProject> {
  const res = await api.post('/api/projects').send({ name: uniqueName('Gener'), ...fields });
  if (res.status !== 201) {
    throw new Error(`Failed to seed project (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

/** A fully documented project: idea fields + requirements, features, research,
 *  tech stack, decisions, db tables and api endpoints. */
async function seedWellDocumentedProject(): Promise<TestProject> {
  const project = await createProjectWith({
    description: 'A mobile expense tracker that helps users record daily expenses.',
    problem: 'People lose track of where their money goes because recording expenses is tedious.',
    motivation: 'I want to understand my own spending habits and improve budgeting.',
    targetUsers: 'Individuals who want to track personal spending without manual spreadsheets.',
    expectedValue: 'A working app where a user can add expenses, see categories and a monthly summary.',
    assumptions: 'The user is on a modern smartphone browser.',
    initialQuestions: 'Should categories be user-defined or fixed?',
    v1Scope: 'Add expenses, list them, show a monthly total per category. No multi-currency support in V1.',
    repositoryUrl: 'https://github.com/example/expense',
    stage: 'ARCHITECTURE'
  });

  const req1 = await api.post(`/api/projects/${project.id}/requirements`).send({
    title: 'Record an expense',
    description: 'The user can record an expense with amount, category and date.',
    priority: 'HIGH',
    status: 'APPROVED'
  });
  const req2 = await api.post(`/api/projects/${project.id}/requirements`).send({
    title: 'Monthly summary',
    description: 'The user can see a monthly summary grouped by category.',
    status: 'PROPOSED'
  });
  const feat = await api.post(`/api/projects/${project.id}/features`).send({
    name: 'Expense list',
    description: 'Shows all recorded expenses with category filters.',
    priority: 'HIGH'
  });
  await api.post(`/api/projects/${project.id}/research`).send({
    title: 'Expense tracking apps',
    type: 'MARKET',
    findings: 'Most apps are subscription based; a simple free tracker wins on simplicity.'
  });
  await api.post(`/api/projects/${project.id}/tech-stack`).send({
    category: 'FRONTEND',
    technology: 'React',
    version: '18'
  });
  await api.post(`/api/projects/${project.id}/tech-stack`).send({
    category: 'BACKEND',
    technology: 'Node',
    version: '20'
  });
  await api.post(`/api/projects/${project.id}/decisions`).send({
    title: 'Use a single small database',
    decision: 'SQLite for V1',
    status: 'ACCEPTED'
  });
  await api.post(`/api/projects/${project.id}/database-tables`).send({
    name: 'expenses',
    purpose: 'Stores recorded expenses'
  });
  await api.post(`/api/projects/${project.id}/api-endpoints`).send({
    method: 'POST',
    path: '/expenses',
    description: 'Creates an expense'
  });

  return { id: project.id, slug: project.slug, name: project.name, stage: project.stage };
}

let projectA: TestProject;
let projectB: TestProject;
let projectC: TestProject;
let projectD: TestProject;

beforeAll(async () => {
  projectA = await seedWellDocumentedProject();
  projectD = await seedWellDocumentedProject(); // used by the save/versioning suite
  projectB = await createProjectWith({ description: 'Minimal idea only.' });
  projectC = await createProjectWith({ description: 'Already being built.', repositoryUrl: 'https://github.com/example/cont' });
});

afterAll(async () => {
  for (const p of [projectA, projectB, projectC, projectD]) {
    if (p?.id) await destroyProject(p.id);
  }
  await prisma.$disconnect();
});

describe('generator context', () => {
  it('returns collected project data', async () => {
    const res = await api.get(`${base()(projectA)}/generator/context`);
    expect(res.status).toBe(200);
    expect(res.body.data.project.name).toBe(projectA.name);
    expect(res.body.data.requirements.length).toBeGreaterThan(0);
    expect(res.body.data.techStack.some((t: any) => t.technology === 'React')).toBe(true);
    expect(res.body.data.tags).toEqual([]);
  });

  it('rejects invalid options', async () => {
    const res = await api.post(`${base()(projectA)}/generator/generate`).send({ options: { targetPlatform: 'Nope' } });
    expect(res.status).toBe(400);
  });

  it('404s for a missing project', async () => {
    const res = await api.post('/api/projects/999999999/generator/generate').send({});
    expect(res.status).toBe(404);
  });
});

describe('scenario A: well-documented project', () => {
  it('builds a complete prompt with high readiness', async () => {
    const res = await api.post(`${base()(projectA)}/generator/generate`).send({
      options: {
        targetPlatform: 'Web',
        technology: 'Use existing project stack',
        developmentApproach: 'Build from scratch',
        aiEnvironment: 'Claude Code'
      }
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    const prompt: string = d.promptText;

    for (const section of ['ROLE', 'PROJECT', 'PROBLEM', 'TARGET USERS', 'V1 OBJECTIVE', 'V1 SCOPE', 'OUT OF SCOPE', 'CORE REQUIREMENTS', 'CORE FEATURES', 'ASSUMPTIONS', 'CONSTRAINTS', 'TECHNICAL DIRECTION', 'ARCHITECTURE', 'IMPLEMENTATION EXPECTATIONS', 'VALIDATION', 'FINAL EXPECTED RESULT']) {
      expect(prompt).toContain(`## ${section}`);
    }

    expect(d.analysis.readiness.score).toBeGreaterThanOrEqual(80);
    expect(d.analysis.readiness.ready).toContain('V1 scope');
    expect(d.validation.passed).toBe(true);
    expect(d.options.targetPlatform).toBe('Web');
    expect(d.options.aiEnvironment).toBe('Claude Code');

    // Real data lands in the prompt; placeholders do not.
    expect(prompt).toContain('People lose track of where their money goes');
    expect(prompt).toContain('Add expenses, list them, show a monthly total per category');
    expect(prompt).toContain('Record an expense');
    expect(prompt).toContain('Expense list');
    expect(prompt).toMatch(/React/);
    expect(prompt).not.toContain('Not documented.');
  });

  it('warns about ambiguity when the docs hint at conflicting platforms', async () => {
    const res = await api.post(`${base()(projectD)}/generator/generate`).send({
      options: { targetPlatform: 'Not decided' }
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    const hasPlatformAmbiguity = d.analysis.ambiguities.some((a: any) => a.field === 'Target platform');
    const swiftMention = d.promptText.includes('confirm the target platform');
    expect(hasPlatformAmbiguity || swiftMention).toBe(true);
  });
});

describe('scenario B: minimal idea', () => {
  it('degrades gracefully without inventing requirements', async () => {
    // A minimal project is gated by the readiness check, so this asserts on
    // the "proceed anyway" path: degrade, never fabricate.
    const res = await api.post(`${base()(projectB)}/generator/generate`).send({ proceedAnyway: true });
    expect(res.status).toBe(200);
    const d = res.body.data;
    const prompt: string = d.promptText;

    expect(d.analysis.readiness.score).toBeLessThan(60);
    expect(d.validation.passed).toBe(true);
    expect(d.options.targetPlatform).toBe('Not decided');

    // Missing context is flagged as confirm-before-build, not fabricated.
    expect(prompt).toContain('## V1 SCOPE');
    expect(prompt).toMatch(/not formally defined|confirm.*scope/i);
    expect(prompt).toContain('## PROBLEM');
    expect(prompt).toMatch(/not documented/i);
    expect(prompt).not.toContain('Record an expense');
  });
});

describe('scenario C: existing BUILDING project', () => {
  it('detects build history and steers continuation', async () => {
    const dev = await api.post(`/api/projects/${projectC.id}/development-sessions`).send({
      goal: 'Set up the backend skeleton',
      completed: 'Express server running',
      nextStep: 'Add the expenses endpoint'
    });
    expect(dev.status).toBe(201);
    await api.post(`/api/projects/${projectC.id}/prompts`).send({
      title: 'Fix the budget bug',
      text: 'The monthly summary overcounts income.',
      result: 'FAILED'
    });
    await api.post(`/api/projects/${projectC.id}/tasks`).send({ title: 'Wire up login screen', status: 'COMPLETED' });
    await api.post(`/api/projects/${projectC.id}/requirements`).send({
      title: 'Continue the expenses endpoint',
      description: 'The endpoint started in the earlier session must be finished.',
      status: 'IN_PROGRESS'
    });
    await api.post(`/api/projects/${projectC.id}/features`).send({
      name: 'Budget overview',
      description: 'Monthly budget overview for a user.'
    });
    await api.post(`/api/projects/${projectC.id}/research`).send({
      title: 'Budget patterns',
      findings: 'Simple budget categories reduce churn.'
    });
    await api.post(`/api/projects/${projectC.id}/tech-stack`).send({
      category: 'BACKEND',
      technology: 'Express'
    });
    const stage = await api.post(`/api/projects/${projectC.id}/stage`).send({ stage: 'BUILDING' });
    expect(stage.status).toBe(200);

    const res = await api.post(`${base()(projectC)}/generator/generate`).send({
      proceedAnyway: true,
      options: {
        targetPlatform: 'Web',
        technology: 'Use existing project stack',
        developmentApproach: 'Continue existing project',
        aiEnvironment: 'Codex'
      }
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    const prompt: string = d.promptText;

    expect(prompt).toContain('## TECHNICAL DIRECTION');
    expect(prompt).toMatch(/existing project stack/i);
    expect(d.analysis.readiness.score).toBeGreaterThanOrEqual(50);
    expect(d.analysis.ambiguities.some((a: any) => a.field === 'Development approach')).toBe(false);
  });
});

describe('dedupe', () => {
  it('consolidates overlapping statements', async () => {
    const project = await createProjectWith({
      description: 'Users record daily expenses to build a monthly budget.',
      problem: 'Users record expenses daily so the app can build a monthly budget.'
    });
    await api.post(`/api/projects/${project.id}/features`).send({
      name: 'Budget builder',
      description: 'A user records daily expenses so they can build a monthly budget.'
    });
    const res = await api.post(`${base()(project)}/generator/generate`).send({ proceedAnyway: true });
    expect(res.status).toBe(200);
    expect(res.body.data.analysis.dedupe.total).toBeGreaterThan(0);
    expect(res.body.data.analysis.dedupe.consolidated).toBeGreaterThanOrEqual(1);
    await destroyProject(project.id);
  });
});

describe('save & versioning', () => {
  it('saves a generation and appends versions to the same prompt series', async () => {
    const first = await api.post(`${base()(projectD)}/generator/save`).send({
      promptText: 'You are building the expense tracker. ## V1 SCOPE\nAdd expenses.\n',
      options: { targetPlatform: 'Web' },
      readiness: 82,
      items: '[]',
      analysis: '{}',
      sourceSnapshot: '{"project":"x"}'
    });
    expect(first.status).toBe(201);
    expect(first.body.data.versionNumber).toBe(1);
    expect(first.body.data.prompt.code).toMatch(/^PROMPT-\d+$/);
    expect(first.body.data.prompt.category).toBe('V1 Build Prompt');
    expect(first.body.meta.updatedProjectV1Scope).toBe(false);

    const promptId = first.body.data.prompt.id;

    const second = await api.post(`${base()(projectD)}/generator/save`).send({
      promptText: 'v2 of the prompt',
      changes: 'Tightened wording'
    });
    expect(second.status).toBe(201);
    expect(second.body.data.versionNumber).toBe(2);
    expect(second.body.data.prompt.id).toBe(promptId);

    const versions = await api.get(`${base()(projectD)}/generator/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.data.length).toBeGreaterThanOrEqual(2);
    const latest = versions.body.data[0];
    expect(latest.promptType).toBe('V1_BUILD_PROMPT');
    expect(latest.version).toBe(2);

    // The prompt is visible in the regular AI Prompt history and has both versions.
    const prompts = await api.get(`/api/projects/${projectD.id}/prompts?category=${encodeURIComponent('V1 Build Prompt')}`);
    const row = prompts.body.data.find((r: any) => r.id === promptId);
    expect(row).toBeTruthy();
    expect(row.result).toBe('GENERATED');
    expect(row.versions.length).toBe(2);

    // Activity is recorded.
    const events = await prisma.activityEvent.findMany({
      where: { projectId: projectD.id, type: 'PROMPT_GENERATED' },
      orderBy: { createdAt: 'desc' }
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('requires text to save', async () => {
    const res = await api.post(`${base()(projectD)}/generator/save`).send({});
    expect(res.status).toBe(400);
  });

  it('writes v1Scope back to the project when asked and it is empty', async () => {
    const project = await createProjectWith({ description: 'fresh' });
    const res = await api.post(`${base()(project)}/generator/save`).send({
      promptText: 'Fresh project prompt.',
      v1Scope: 'Sign up, add items, checkout.',
      updateProjectScope: true
    });
    expect(res.status).toBe(201);
    expect(res.body.meta.updatedProjectV1Scope).toBe(true);

    const fetched = await api.get(`/api/projects/${project.id}`);
    expect(fetched.body.data.v1Scope).toBe('Sign up, add items, checkout.');

    // Second save with a different scope does not overwrite an existing value.
    const again = await api.post(`${base()(project)}/generator/save`).send({
      promptText: 'Another prompt.',
      v1Scope: 'A conflicting scope.',
      updateProjectScope: true
    });
    expect(again.body.meta.updatedProjectV1Scope).toBe(false);
    const refetched = await api.get(`/api/projects/${project.id}`);
    expect(refetched.body.data.v1Scope).toBe('Sign up, add items, checkout.');

    await destroyProject(project.id);
  });

  it('exposes the v1Scope field on projects', async () => {
    const res = await api.get(`/api/projects/${projectA.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('v1Scope');
  });
});
// ---------------------------------------------------------------------------
// V1 Prompt Readiness Check
//
// Readiness is a read-only evaluation: it must always answer, never fail just
// because information is missing, and never invent a value.
// ---------------------------------------------------------------------------

interface ReadinessCheckShape {
  key: string;
  label: string;
  level: 'required' | 'recommended' | 'optional';
  status: 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'OPTIONAL' | 'ERROR';
  detail: string;
  reason: string;
  action: string;
  gapInstruction: string;
  input: { kind: string; field?: string; option?: string; resource?: string } | null;
  error?: { operation: string; reason: string; action: string };
}

interface ReadinessReportShape {
  project: { id: number; name: string; stage: string };
  checks: ReadinessCheckShape[];
  summary: Record<string, { complete: number; available: number; total: number }>;
  ready: boolean;
  verdict: string;
  missingRequired: ReadinessCheckShape[];
  failures: ReadinessCheckShape[];
  wizardSteps: { key: string; input: { kind: string } }[];
}

const REQUIRED_TEXT = ['description', 'problem', 'targetUsers', 'expectedValue', 'v1Scope'];

const readinessOf = async (project: TestProject, query = ''): Promise<{ status: number; report: ReadinessReportShape }> => {
  const res = await api.get(`${base()(project)}/generator/readiness${query}`);
  return { status: res.status, report: res.body.data as ReadinessReportShape };
};

const checkFor = (report: ReadinessReportShape, key: string): ReadinessCheckShape => {
  const found = report.checks.find(c => c.key === key);
  if (!found) throw new Error(`No readiness check for "${key}". Got: ${report.checks.map(c => c.key).join(', ')}`);
  return found;
};

describe('readiness check', () => {
  it('reports a fully documented project as ready', async () => {
    const { status, report } = await readinessOf(projectA);
    expect(status).toBe(200);
    expect(report.ready).toBe(true);
    expect(report.verdict).toBe('ready');
    expect(report.missingRequired).toEqual([]);
    // Ready means no *required* step remains. Recommended gaps are still
    // offered, because filling them is optional and still improves the prompt.
    for (const step of report.wizardSteps) {
      expect(checkFor(report, step.key).level).not.toBe('required');
    }

    for (const key of REQUIRED_TEXT) {
      expect(checkFor(report, key).status).toBe('COMPLETE');
    }
  });

  it('lists every missing required item with a reason, an action and a gap instruction', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const { status, report } = await readinessOf(project);
      expect(status).toBe(200);
      expect(report.ready).toBe(false);
      expect(report.verdict).toBe('needs-info');

      // The project has a name, so name is complete; the other five are not.
      expect(checkFor(report, 'name').status).toBe('COMPLETE');
      const missing = report.missingRequired.map(c => c.key).sort();
      expect(missing).toEqual([...REQUIRED_TEXT].sort());

      for (const key of REQUIRED_TEXT) {
        const check = checkFor(report, key);
        expect(check.status).toBe('MISSING');
        expect(check.level).toBe('required');
        expect(check.detail).toBeTruthy();
        expect(check.reason.length).toBeGreaterThan(10);
        expect(check.action.length).toBeGreaterThan(10);
        // The prompt must be able to acknowledge this gap without inventing it.
        expect(check.gapInstruction.length).toBeGreaterThan(20);
        expect(check.input?.kind).toBe('text');
      }
    } finally {
      await destroyProject(project.id);
    }
  });

  it('treats placeholder and very short text as missing rather than complete', async () => {
    const project = await createProjectWith({
      description: 'test',
      problem: 'none',
      targetUsers: 'users',
      expectedValue: 'app works',
      v1Scope: 'stuff'
    });
    try {
      const { report } = await readinessOf(project);
      for (const key of REQUIRED_TEXT) {
        const check = checkFor(report, key);
        expect(check.status, `"${check.detail}" should not count as complete`).not.toBe('COMPLETE');
      }
      expect(report.ready).toBe(false);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('distinguishes optional items from missing required items', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const { report } = await readinessOf(project);
      const optional = report.checks.filter(c => c.level === 'optional');
      expect(optional.length).toBeGreaterThan(0);
      // Optional items are reported, but never block generation.
      for (const check of optional) {
        expect(report.missingRequired.some(c => c.key === check.key)).toBe(false);
        expect(report.wizardSteps.some(s => s.key === check.key)).toBe(false);
      }
      expect(report.summary.optional.total).toBe(optional.length);
      expect(report.summary.required.total).toBeGreaterThanOrEqual(6);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('treats missing generator options as readiness gaps, not as project errors', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const { report } = await readinessOf(project);
      const platform = checkFor(report, 'targetPlatform');
      expect(platform.status).toBe('MISSING');
      expect(platform.error).toBeUndefined();
      expect(platform.input?.kind).toBe('choice');
    } finally {
      await destroyProject(project.id);
    }
  });

  it('404s a missing project with an explanatory message, not a bare "Not found"', async () => {
    const res = await api.get('/api/projects/999999999/generator/readiness');
    expect(res.status).toBe(404);
    expect(res.body.error.message).not.toBe('Not found');
    expect(res.body.error.message).toMatch(/999999999/);
    expect(res.body.error.category).toBe('NOT_FOUND');
    expect(res.body.error.possibleAction).toBeTruthy();
  });

  it('returns a usable report for a project with no data at all', async () => {
    const project = await createProjectWith({ name: uniqueName('Empty') });
    try {
      const { status, report } = await readinessOf(project);
      expect(status).toBe(200);
      expect(report.checks.length).toBeGreaterThan(0);
      expect(report.failures).toEqual([]);
      expect(report.missingRequired.length).toBeGreaterThanOrEqual(5);
      // Generation is still possible via "proceed anyway".
      const gen = await api.post(`${base()(project)}/generator/generate`).send({ proceedAnyway: true });
      expect(gen.status).toBe(200);
      expect(gen.body.data.promptText.length).toBeGreaterThan(0);
    } finally {
      await destroyProject(project.id);
    }
  });
});

describe('readiness gating and "proceed anyway"', () => {
  it('refuses to generate an incomplete project and returns the readiness report', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const res = await api.post(`${base()(project)}/generator/generate`).send({ options: {} });
      expect(res.status).toBe(409);
      expect(res.body.error.category).toBe('DATA_MISSING');
      expect(res.body.error.possibleAction).toMatch(/Proceed anyway/);

      const report = res.body.error.details.readiness as ReadinessReportShape;
      expect(report.ready).toBe(false);
      expect(report.missingRequired.length).toBeGreaterThan(0);
      for (const check of report.missingRequired) {
        expect(check.reason).toBeTruthy();
        expect(check.gapInstruction).toBeTruthy();
      }
    } finally {
      await destroyProject(project.id);
    }
  });

  it('generates on request and acknowledges each gap in the prompt', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const { report } = await readinessOf(project);
      const res = await api.post(`${base()(project)}/generator/generate`).send({ proceedAnyway: true });
      expect(res.status).toBe(200);

      const prompt: string = res.body.data.promptText;
      expect(prompt).toContain('MISSING INFORMATION');
      // Every acknowledged gap is reported, at every level - the prompt lists
      // them all, so the UI must not under-report.
      const allGaps = report.checks
        .filter(c => c.status === 'MISSING' || c.status === 'PARTIAL' || c.status === 'ERROR')
        .map(c => c.key);
      expect(res.body.data.proceededWithGaps).toEqual(allGaps);
      for (const gap of report.missingRequired) {
        expect(prompt).toContain(gap.label);
      }
      // The gaps must be presented as questions to confirm, not as requirements.
      expect(prompt).toMatch(/Do not invent|ask the user|Ask the user/);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('never invents a value for a missing required item', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const { report } = await readinessOf(project);
      const res = await api.post(`${base()(project)}/generator/generate`).send({ proceedAnyway: true });
      const prompt: string = res.body.data.promptText;
      for (const check of report.missingRequired) {
        // The section must name the gap and forbid filling it in silently.
        expect(prompt).toContain(check.label);
      }
      expect(prompt).toMatch(/Do not invent it, and do not silently assume it/);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('does not use the "missing" heading when only recommended items are absent', async () => {
    const res = await api.post(`${base()(projectA)}/generator/generate`).send({ options: {} });
    expect(res.status).toBe(200);
    const prompt: string = res.body.data.promptText;
    expect(res.body.data.readiness.missingRequired).toEqual([]);
    // projectA is complete on everything required, so the prompt must not
    // accuse the project of missing required information.
    expect(prompt).not.toContain('MISSING INFORMATION');
    if (res.body.data.proceededWithGaps.length > 0) {
      expect(prompt).toContain('NOT RECORDED');
    }
  });
});

describe('wizard: completing information', () => {
  it('saves answers to the project and recalculates readiness', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const answers: Record<string, string> = {
        description: 'A mobile expense tracker that helps users record daily expenses.',
        problem: 'People lose track of their spending because recording expenses by hand is tedious.',
        targetUsers: 'Individuals who want to track personal spending without maintaining a spreadsheet.',
        expectedValue: 'A working app where a user adds expenses and sees a monthly summary per category.',
        v1Scope: 'Add expenses, list them, and show a monthly total per category.'
      };

      const res = await api.post(`${base()(project)}/generator/readiness/complete`).send({ values: answers });
      expect(res.status).toBe(200);
      expect(res.body.data.saved.sort()).toEqual(Object.keys(answers).sort());

      // Answers really landed on the project, not in wizard-local storage.
      const fetched = await api.get(base()(project));
      for (const [field, value] of Object.entries(answers)) {
        expect(fetched.body.data[field]).toBe(value);
      }

      // Readiness is recalculated from the project, never cached.
      const after = res.body.data.readiness as ReadinessReportShape;
      for (const key of REQUIRED_TEXT) {
        expect(checkFor(after, key).status).toBe('COMPLETE');
      }
      const reread = await readinessOf(project);
      expect(checkFor(reread.report, 'description').status).toBe('COMPLETE');

      // Once complete, the normal generate path works without proceedAnyway.
      const gen = await api.post(`${base()(project)}/generator/generate`).send({ options: {} });
      expect(gen.status).toBe(200);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('rejects fields the project does not have', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const res = await api.post(`${base()(project)}/generator/readiness/complete`).send({
        values: { notAProjectField: 'nope' }
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/existing project fields/);

      // A rejected field must not have been written.
      const fetched = await api.get(base()(project));
      expect(fetched.body.data.notAProjectField).toBeUndefined();
    } finally {
      await destroyProject(project.id);
    }
  });

  it('offers only actionable, non-optional, unfinished steps in order', async () => {
    const project = await createProjectWith({ stage: 'IDEA' });
    try {
      const { report } = await readinessOf(project);
      expect(report.wizardSteps.length).toBeGreaterThan(0);
      for (const step of report.wizardSteps) {
        // The wizard must not ask for optional items, finished items, or lists
        // it has no way to create.
        expect(step.input.kind).not.toBe('count');
        const check = checkFor(report, step.key);
        expect(check.level).not.toBe('optional');
        expect(['MISSING', 'PARTIAL']).toContain(check.status);
      }
      // Required project text comes first, in field order.
      expect(report.wizardSteps.slice(0, 5).map(s => s.key)).toEqual([
        'description',
        'problem',
        'targetUsers',
        'expectedValue',
        'v1Scope'
      ]);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('404s a wizard save for a missing project', async () => {
    const res = await api.post('/api/projects/999999999/generator/readiness/complete').send({
      values: { description: 'x'.repeat(80) }
    });
    expect(res.status).toBe(404);
    expect(res.body.error.category).toBe('NOT_FOUND');
  });
});
