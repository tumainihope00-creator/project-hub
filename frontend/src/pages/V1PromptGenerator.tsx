import { useCallback, useMemo, useState } from 'react';
import { api, formatDateTime, qs } from '../api/client';
import { ApiError } from '../api/client';
import { useProject } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { useApi } from '../lib/useApi';
import { Badge, EmptyState, ErrorBox, Loading } from '../components/ui';
import { ReadinessModal, describeFailure, type ReadinessFailure } from '../components/ReadinessModal';
import { CompleteInfoWizard, InformationCompleteModal, type WizardSaveResult } from '../components/CompleteInfoWizard';
import type { GenOptions, GenResult, ReadinessReport } from '../lib/readiness';
import { DEFAULT_OPTIONS } from '../lib/readiness';
import { humanize } from '../resources';

const TARGET_PLATFORMS = ['Web', 'Android', 'iOS', 'Desktop', 'Web + Mobile', 'Backend/API', 'Other', 'Not decided'];
const TECHNOLOGY_PREFERENCES = ['Use existing project stack', 'Specify technology', 'Recommend appropriate stack', 'Not decided'];
const DEVELOPMENT_APPROACHES = ['Build from scratch', 'Continue existing project', 'Prototype', 'Production-oriented V1'];
const AI_ENVIRONMENTS = ['Claude Code', 'Codex', 'Cursor', 'VS Code + AI', 'ChatGPT', 'Other', 'General AI coding agent'];

interface SavedGeneration {
  id: number;
  promptId: number;
  promptType: string;
  version: number;
  versionId: number | null;
  config: string | null;
  readiness: number | null;
  createdAt: string;
  prompt: { id: number; code: string; title: string | null; category: string | null; updatedAt: string };
}

interface SaveResponse {
  generation: SavedGeneration;
  versionNumber: number;
  prompt: { id: number; code: string; title: string | null; category: string | null };
}

export function V1PromptGenerator() {
  const { project, reload: reloadProject } = useProject();
  const { toast } = useApp();

  const [options, setOptions] = useState<GenOptions>(DEFAULT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenResult | null>(null);
  const [promptText, setPromptText] = useState('');
  const [saveScope, setSaveScope] = useState(true);
  const [changes, setChanges] = useState('');

  // Readiness flow: check -> (checklist | wizard) -> complete -> generate.
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessFailure, setReadinessFailure] = useState<ReadinessFailure | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [wizardSaving, setWizardSaving] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const { data: versions, loading: loadingVersions, error: versionsError, reload: reloadVersions } = useApi<SavedGeneration[]>(
    `/projects/${project.id}/generator/versions`
  );

  const path = `/projects/${project.id}/generator`;

  const set = <K extends keyof GenOptions>(key: K, value: GenOptions[K]) =>
    setOptions(prev => (prev[key] === value ? prev : { ...prev, [key]: value }));

  /**
   * The readiness check runs first, always. It is a read-only GET, so it can
   * never fail because information is missing — that is the answer it reports.
   */
  const runReadiness = useCallback(async (): Promise<ReadinessReport | null> => {
    setReadinessLoading(true);
    setReadinessFailure(null);
    setReadinessOpen(true);
    try {
      const res = await api.get<ReadinessReport>(
        `${path}/readiness${qs({
          targetPlatform: options.targetPlatform,
          technology: options.technology,
          developmentApproach: options.developmentApproach,
          aiEnvironment: options.aiEnvironment
        })}`
      );
      setReadiness(res.data);
      return res.data;
    } catch (e) {
      setReadiness(null);
      setReadinessFailure(describeFailure(e, 'check whether this project has enough information to generate'));
      return null;
    } finally {
      setReadinessLoading(false);
    }
  }, [path, JSON.stringify(options)]);

  const applyGenerated = useCallback(
    (data: GenResult, message: string) => {
      setResult(data);
      setPromptText(data.promptText);
      setError(null);
      setReadinessOpen(false);
      setCompleteOpen(false);
      setWizardOpen(false);
      const gaps = data.proceededWithGaps?.length ?? 0;
      toast(
        gaps > 0 ? `${message} — ${gaps} gap${gaps === 1 ? '' : 's'} noted in the prompt` : message,
        gaps > 0 ? 'info' : undefined
      );
    },
    [toast]
  );

  /**
   * Generation. `proceedAnyway` is only ever set by an explicit click, so the
   * backend never silently generates from an incomplete project.
   */
  const runGenerate = useCallback(
    async (proceedAnyway: boolean) => {
      setBusy(true);
      setError(null);
      setReadinessFailure(null);
      try {
        const res = await api.post<GenResult>(`${path}/generate`, { options, proceedAnyway });
        applyGenerated(res.data, 'V1 prompt generated');
      } catch (e) {
        // A 409 means the project became incomplete between check and generate.
        // The report travels with the error, so the modal can show it as-is.
        if (e instanceof ApiError && e.status === 409) {
          const details = e.details as { readiness?: ReadinessReport } | undefined;
          if (details?.readiness) {
            setReadiness(details.readiness);
            setReadinessOpen(true);
            setWizardOpen(false);
            setCompleteOpen(false);
            setError(null);
          } else {
            setError(e.message);
          }
        } else {
          setReadinessFailure(describeFailure(e, 'generate the V1 build prompt'));
          setReadinessOpen(true);
        }
      } finally {
        setBusy(false);
      }
    },
    [path, options, applyGenerated]
  );

  const onGeneratePressed = useCallback(() => {
    setError(null);
    runReadiness();
  }, [runReadiness]);

  /**
   * Wizard step save. Project fields are written to the project by the API;
   * generator options are applied locally, because they are per-generation
   * configuration rather than project data.
   */
  const saveWizardStep = useCallback(
    async (values: Record<string, string>, index: number): Promise<WizardSaveResult> => {
      setWizardSaving(true);
      setWizardError(null);
      try {
        const res = await api.post<{ saved: string[]; rejected: Record<string, string>; readiness: ReadinessReport }>(
          `${path}/readiness/complete`,
          { values, options }
        );
        setReadiness(res.data.readiness);
        reloadProject();
        if (Object.values(res.data.rejected ?? {}).length > 0) {
          setWizardError(
            `Saved ${res.data.saved.length} item(s), but these were rejected: ${Object.keys(res.data.rejected).join(', ')}.`
          );
        }
        return { readiness: res.data.readiness, saved: res.data.saved, rejected: res.data.rejected ?? {} };
      } catch (e) {
        const message = describeFailure(e, 'save this answer to the project').reason;
        setWizardError(message);
        // Keep the user on the step they are on so nothing typed is lost.
        void index;
        return { readiness: (readiness as ReadinessReport) ?? ({} as ReadinessReport), saved: [], rejected: {} };
      } finally {
        setWizardSaving(false);
      }
    },
    [path, options, reloadProject, readiness]
  );

  const openWizard = useCallback(() => {
    setWizardError(null);
    setWizardOpen(true);
  }, []);

  const backToChecklist = useCallback(() => {
    setWizardOpen(false);
    setReadinessOpen(true);
  }, []);

  const finishWizard = useCallback(() => {
    setWizardOpen(false);
    setReadinessOpen(false);
    setCompleteOpen(true);
  }, []);

  const generatedScope = useMemo(() => {
    if (!result) return null;
    const m = result.promptText.split('\n## V1 SCOPE\n')[1];
    if (!m) return null;
    const end = m.search(/\n## (OUT OF SCOPE|CORE|ASSUMPTIONS|CONSTRAINTS)/);
    return (end >= 0 ? m.slice(0, end) : m).trim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const save = async () => {
    if (!result) return;
    if (!promptText.trim()) {
      setError('The prompt is empty — nothing to save.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<SaveResponse>(`${path}/save`, {
        promptText,
        options,
        changes: changes.trim() || 'Initial generation',
        readiness: result.analysis.readiness.score,
        items: JSON.stringify(result.analysis.readiness.items),
        analysis: JSON.stringify({ missing: result.analysis.missing, ambiguities: result.analysis.ambiguities, dedupe: result.analysis.dedupe, relevant: result.analysis.relevant }),
        sourceSnapshot: JSON.stringify({
          stage: result.analysis.relevant.stage,
          counts: {
            research: result.analysis.relevant.research.length,
            requirements: result.analysis.relevant.requirements.length,
            features: result.analysis.relevant.features.length,
            decisions: result.analysis.relevant.decisions.length,
            techStack: result.analysis.relevant.techStack.length,
            notes: result.analysis.relevant.notes.length
          }
        }),
        v1Scope: saveScope && !project.v1Scope && generatedScope ? generatedScope : undefined,
        updateProjectScope: saveScope && !project.v1Scope
      });
      const meta = res.meta as { updatedProjectV1Scope?: boolean } | undefined;
      const code = res.data.prompt.code;
      const version = meta?.updatedProjectV1Scope ? ' (scope updated)' : '';
      toast(`Saved as ${code} v${res.data.versionNumber}${version}`);
      setChanges('');
      reloadProject();
      reloadVersions();
      window.dispatchEvent(new CustomEvent('data-changed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      toast('Prompt copied');
    } catch {
      toast('Copy failed — select the text manually', 'error');
    }
  };

  const a = result?.analysis;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>V1 Prompt Generator</h1>
          <div className="sub">
            Collects this project's data, measures readiness, and drafts a staged build prompt with no external AI calls.
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={onGeneratePressed} disabled={busy}>
            {busy ? 'Generating…' : result ? 'Regenerate' : 'Generate V1 prompt'}
          </button>
          {result ? (
            <>
              <button className="btn" onClick={copy}>
                Copy
              </button>
              <button className="btn primary" onClick={save} disabled={saving || !promptText.trim()}>
                {saving ? 'Saving…' : 'Save to AI Prompts'}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBox message={error} /> : null}

      {readinessOpen ? (
        <ReadinessModal
          report={readiness}
          loading={readinessLoading}
          failure={readinessFailure}
          busy={busy}
          onClose={() => {
            setReadinessOpen(false);
            setReadinessFailure(null);
          }}
          onFill={openWizard}
          onProceed={() => runGenerate(true)}
          onGenerate={() => runGenerate(false)}
          onRetry={onGeneratePressed}
        />
      ) : null}

      {wizardOpen && readiness ? (
        <CompleteInfoWizard
          steps={readiness.wizardSteps}
          options={options}
          projectName={readiness.project.name}
          saving={wizardSaving}
          error={wizardError}
          onOptionsChange={setOptions}
          onSave={saveWizardStep}
          onBackToChecklist={backToChecklist}
          onFinish={finishWizard}
          onClose={() => {
            setWizardOpen(false);
            setReadinessOpen(true);
          }}
        />
      ) : null}

      {completeOpen && readiness ? (
        <InformationCompleteModal
          report={readiness}
          onGenerate={() => {
            setCompleteOpen(false);
            runGenerate(false);
          }}
          onReview={() => {
            setCompleteOpen(false);
            setReadinessOpen(true);
          }}
          onClose={() => setCompleteOpen(false)}
        />
      ) : null}

      <h2 className="section">Generator options</h2>
      <div className="card">
        <div className="form-grid">
          <div className="field">
            <label>Target platform</label>
            <select value={options.targetPlatform} onChange={e => set('targetPlatform', e.target.value)}>
              {TARGET_PLATFORMS.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <div className="hint">Used by the AI to shape UI, storage and deployment choices.</div>
          </div>
          <div className="field">
            <label>Technology</label>
            <select value={options.technology} onChange={e => set('technology', e.target.value)}>
              {TECHNOLOGY_PREFERENCES.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <div className="hint">How the tech stack should be decided.</div>
          </div>
          {options.technology === 'Specify technology' ? (
            <div className="field full">
              <label>Technology stack</label>
              <input
                value={options.customTech ?? ''}
                placeholder="e.g. React 18 + TypeScript + Node + PostgreSQL"
                onChange={e => set('customTech', e.target.value || null)}
              />
            </div>
          ) : null}
          <div className="field">
            <label>Development approach</label>
            <select value={options.developmentApproach} onChange={e => set('developmentApproach', e.target.value)}>
              {DEVELOPMENT_APPROACHES.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>AI environment</label>
            <select value={options.aiEnvironment} onChange={e => set('aiEnvironment', e.target.value)}>
              {AI_ENVIRONMENTS.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <div className="hint">Just informs the prompt's "assistant" framing.</div>
          </div>
        </div>
      </div>

      {!a && !error ? (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            title="Nothing generated yet"
            hint="Adjust the options above and press Generate. The generator runs locally from your project data."
          />
        </div>
      ) : null}

      {a ? (
        <div className="grid c2" style={{ marginTop: 16 }}>
          <div>
            <h2 className="section">Readiness — {a.readiness.score}/100</h2>
            <div className="card">
              <div className="progress">
                <div style={{ width: `${a.readiness.score}%`, background: readinessColor(a.readiness.score) }} />
              </div>
              <div style={{ marginTop: 10 }}>
                {a.readiness.items.map(item => (
                  <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <span style={{ width: 14, color: item.present ? 'var(--green)' : 'var(--red)' }}>{item.present ? '✓' : '–'}</span>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    <Badge value={item.kind} />
                    <span className="dim tiny">{item.weight}pts</span>
                  </div>
                ))}
              </div>
            </div>

            {a.readiness.missing.length > 0 ? (
              <>
                <h2 className="section">Still missing</h2>
                <div className="card">
                  {a.readiness.missing.map(m => (
                    <div key={m} className="tl-desc" style={{ padding: '4px 0' }}>
                      {m}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {a.missing.length > 0 ? (
              <>
                <h2 className="section">Gaps the AI must confirm</h2>
                <div className="card">
                  {a.missing.map((m, i) => (
                    <div key={i} style={{ padding: '6px 0', borderBottom: i < a.missing.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Badge value={m.severity} />
                        <span>{m.field}</span>
                      </div>
                      <div className="dim" style={{ whiteSpace: 'pre-wrap', marginTop: 3 }}>
                        {m.guidance}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {a.ambiguities.length > 0 ? (
              <>
                <h2 className="section">Ambiguities to resolve</h2>
                <div className="card">
                  {a.ambiguities.map((am, i) => (
                    <div key={i} style={{ padding: '6px 0' }}>
                      <span className="dim">{am.field}: </span>
                      {am.message}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <h2 className="section">Relevant project data</h2>
            <div className="card">
              <dl className="kv">
                <dt>Stage</dt>
                <dd>{humanize(a.relevant.stage)}</dd>
                <dt>Repository</dt>
                <dd>{a.relevant.repository ? 'recorded' : '—'}</dd>
                <dt>Requirements</dt>
                <dd>{a.relevant.requirements.length} in scope</dd>
                <dt>Features</dt>
                <dd>{a.relevant.features.length}</dd>
                <dt>Research</dt>
                <dd>{a.relevant.research.length} entries</dd>
                <dt>Tech stack</dt>
                <dd className="mono">{a.relevant.techStack.length ? a.relevant.techStack.join(', ') : '—'}</dd>
                <dt>Decisions</dt>
                <dd>{a.relevant.decisions.length} accepted</dd>
                <dt>Notes</dt>
                <dd>{a.relevant.notes.length}</dd>
              </dl>
              {a.sectionProblems && a.sectionProblems.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  {a.sectionProblems.map((p, i) => (
                    <div key={i} className="dim tiny">
                      ⚠ {p}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <h2 className="section">No-repetition check</h2>
            <div className="card">
              <div className="dim">
                {a.dedupe.total} statements · {a.dedupe.kept} kept · {a.dedupe.consolidated} consolidated as duplicates
              </div>
              {a.dedupe.examples.map((ex, i) => (
                <div key={i} className="dim tiny" style={{ marginTop: 4 }}>
                  {ex}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="section">Generated prompt (editable)</h2>
            <div className="card">
              <textarea
                style={{ width: '100%', minHeight: 520, fontFamily: 'var(--mono)', fontSize: 12 }}
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
              />
              {promptText !== result.promptText ? (
                <div className="dim tiny" style={{ marginTop: 8 }}>
                  Edited — saving creates a new version, never overwrites the previous one.
                </div>
              ) : null}
            </div>

            <h2 className="section">Validation</h2>
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Badge value={result.validation.passed ? 'OK' : 'NEEDS REVIEW'} />
                {result.validation.passed ? <span className="dim">No blocking issues found.</span> : null}
              </div>
              {result.validation.issues.map((iss, i) => (
                <div key={i} className={iss.severity === 'error' ? '' : 'dim'} style={{ padding: '2px 0' }}>
                  <span className="mono">{iss.section}: </span>
                  {iss.message}
                </div>
              ))}
              {result.validation.issues.length === 0 ? <div className="dim">All checks passed.</div> : null}
            </div>

            {!project.v1Scope && generatedScope ? (
              <div className="card" style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                  <input type="checkbox" checked={saveScope} onChange={e => setSaveScope(e.target.checked)} />
                  Save the generated V1 scope to this project (it currently has none)
                </label>
                <div className="dim tiny" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{generatedScope}</div>
              </div>
            ) : null}

            {project.v1Scope ? (
              <div className="dim tiny" style={{ marginTop: 12 }}>
                Recording V1 scope as of now: “{project.v1Scope}”
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <h2 className="section" style={{ marginTop: 24 }}>
        Saved generations
      </h2>
      <div className="card">
        {loadingVersions && !versions ? (
          <Loading label="Loading saved generations…" />
        ) : versionsError ? (
          <ErrorBox message={versionsError} />
        ) : !versions || versions.length === 0 ? (
          <EmptyState title="No generations saved yet" hint="Generated prompts appear here once you press “Save to AI Prompts”." />
        ) : (
          <div className="timeline">
            {versions.map(v => (
              <div className="timeline-item" key={v.id}>
                <div className="tl-head">
                  <span className="tl-type mono">
                    {v.prompt.code} · v{v.version}
                  </span>
                  <span className="dim tiny">{v.readiness != null ? `readiness ${v.readiness}/100` : ''}</span>
                  <span className="tl-time">{formatDateTime(v.createdAt)}</span>
                </div>
                <div className="tl-desc">
                  {v.prompt.title ?? 'V1 Build Prompt'} · category{' '}
                  <span className="mono">{v.prompt.category}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function readinessColor(score: number): string {
  if (score >= 80) return 'var(--green)';
  if (score >= 50) return 'var(--yellow)';
  return 'var(--red)';
}