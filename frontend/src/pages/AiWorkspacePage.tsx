import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDateTime } from '../api/client';
import { useApi, useDebounced } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { EmptyState, ErrorBox, Loading, Modal } from '../components/ui';
import { Markdown } from '../lib/markdown';
import type {
  AiContextKey,
  AiContextPreview,
  AiGenerateResult,
  AiInteraction,
  AiStatus,
  ResourceRow
} from '../api/types';

/**
 * Phase 9: the AI Workspace.
 *
 * The flow it implements, in order and always under the user's control:
 *
 *   project → prompt (existing or custom) → selected project context →
 *   review the effective request → provider/model check → Send →
 *   read the response → explicitly save the interaction (or not).
 *
 * Boundaries that are structural here, not conventions:
 *
 *  - Nothing is sent automatically. Generation and sending are separate
 *    deliberate clicks, and the request is reviewable before it goes out.
 *  - Only the sections the user ticked are requested from the backend, and the
 *    preview shows the exact text that will be sent (the server renders the
 *    same string it sends).
 *  - The response is rendered with the same safe Markdown renderer as
 *    PROJECT.md: text nodes only, no innerHTML, no script execution. Actions
 *    on the response (copy, save as note, new prompt) each need a click;
 *    the response can never modify project data by itself.
 *  - The page never sees an API key - only `configured` / `model` / `provider`
 *    from GET /api/ai/status.
 *  - History is local data: it stays readable even when the provider is
 *    unconfigured or the machine is offline.
 */

const CONTEXT_SECTIONS: { key: AiContextKey; label: string }[] = [
  { key: 'description', label: 'Project description' },
  { key: 'problem', label: 'Problem statement' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'features', label: 'Features' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'issues', label: 'Issues' },
  { key: 'decisions', label: 'Architecture decisions' },
  { key: 'techStack', label: 'Technology stack' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'deployments', label: 'Deployment history' },
  { key: 'notes', label: 'Project notes' },
  { key: 'research', label: 'Research entries' }
];

interface PromptOption extends ResourceRow {
  code: string;
  title?: string | null;
  content?: string;
  status: string;
}

/** Shared styling for the "exactly what was sent" blocks. */
const REQUEST_PRE: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 320,
  overflow: 'auto',
  fontSize: 12,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '10px 12px',
  margin: 0
};

const REASON_TEXT: Record<NonNullable<AiStatus['reason']>, { title: string; body: string }> = {
  disabled: {
    title: 'The AI provider is disabled.',
    body: 'Enable it in Settings → AI Provider. Everything else in Project Hub keeps working while it is off.'
  },
  missing_api_key: {
    title: 'No API key is configured.',
    body: 'Set AI_PROVIDER_API_KEY in backend/.env, or store a key in Settings → AI Provider. The key stays on the server and is never shown in the browser.'
  },
  unknown_provider: {
    title: 'The configured provider is not available in this build.',
    body: 'Choose a registered provider in Settings → AI Provider.'
  }
};

export function AiWorkspacePage() {
  const { project } = useProject();
  const { toast } = useApp();

  const { data: status, loading: statusLoading } = useApi<AiStatus>('/ai/status');
  const { data: promptOptions, reload: reloadPrompts } = useApi<PromptOption[]>(
    `/projects/${project.id}/prompts?pageSize=100`
  );
  const { data: history, reload: reloadHistory } = useApi<AiInteraction[]>(`/projects/${project.id}/ai/interactions`);

  // Prompt source: '' = custom prompt typed here; otherwise the selected stored prompt.
  const [sourcePromptId, setSourcePromptId] = useState('');
  const [promptText, setPromptText] = useState('');
  // null = not initialized yet: the first preview load preselects only the
  // sections this project actually has data for.
  const [sections, setSections] = useState<AiContextKey[] | null>(null);
  const [preview, setPreview] = useState<AiContextPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<AiGenerateResult | null>(null);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [viewing, setViewing] = useState<AiInteraction | null>(null);

  // ---- context preview -----------------------------------------------------
  const sectionParam: string | null = sections === null ? null : sections.join(',');
  const debouncedParam = useDebounced(sectionParam, 350);

  useEffect(() => {
    let cancelled = false;
    const query = debouncedParam === null ? '' : `?sections=${encodeURIComponent(debouncedParam)}`;
    api
      .get<AiContextPreview>(`/projects/${project.id}/ai/context${query}`)
      .then(res => {
        if (cancelled) return;
        setPreview(res.data);
        setPreviewError(null);
        if (debouncedParam === null) {
          // First load: preselect only sections with recorded data, so nothing
          // unrelated is sent by default.
          setSections(res.data.sections.filter(s => s.present).map(s => s.key));
        }
      })
      .catch(err => {
        if (!cancelled) setPreviewError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, debouncedParam]);

  const toggleSection = (key: AiContextKey) => {
    setSections(prev => {
      const current = prev ?? [];
      return current.includes(key) ? current.filter(k => k !== key) : [...current, key];
    });
  };

  const providerModels = useMemo(() => {
    const provider = status?.providers.find(p => p.id === status.provider);
    return provider?.models ?? [];
  }, [status]);

  // ---- sending -------------------------------------------------------------
  const send = async () => {
    if (!promptText.trim()) {
      toast('Write or select a prompt first.', 'error');
      return;
    }
    setSending(true);
    setSendError(null);
    setResult(null);
    setSaved(false);
    try {
      const res = await api.post<AiGenerateResult>('/ai/generate', {
        projectId: project.id,
        promptId: sourcePromptId ? Number(sourcePromptId) : undefined,
        prompt: promptText,
        sections: sections ?? [],
        model: model.trim() || undefined
      });
      setResult(res.data);
    } catch (err) {
      setSendError(err instanceof ApiError ? err : new ApiError(0, String(err)));
    } finally {
      setSending(false);
    }
  };

  // ---- explicit response actions (each one a user click, never automatic) ---
  const copyResponse = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      toast('Response copied');
    } catch {
      toast('Could not access the clipboard.', 'error');
    }
  };

  const saveInteraction = async () => {
    if (!result) return;
    setBusyAction('save');
    try {
      await api.post(`/projects/${project.id}/ai/interactions`, {
        promptId: sourcePromptId ? Number(sourcePromptId) : undefined,
        provider: result.provider,
        model: result.model,
        promptText: result.prompt,
        contextSections: result.sectionKeys,
        contextText: result.contextText,
        responseText: result.text,
        usage: result.usage,
        durationMs: result.durationMs
      });
      setSaved(true);
      toast('AI interaction saved to the project history');
      reloadHistory();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The interaction could not be saved.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const saveAsNote = async () => {
    if (!result) return;
    setBusyAction('note');
    try {
      await api.post(`/projects/${project.id}/notes`, {
        title: titleFrom(result.prompt),
        content: result.text
      });
      toast('Response saved as a note');
      window.dispatchEvent(new CustomEvent('data-changed'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The note could not be created.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const promptFromResponse = async () => {
    if (!result) return;
    setBusyAction('prompt');
    try {
      await api.post(`/projects/${project.id}/prompts`, {
        title: titleFrom(result.prompt),
        category: 'General',
        status: 'DRAFT',
        text: result.text
      });
      toast('New draft prompt created from the response');
      reloadPrompts();
      window.dispatchEvent(new CustomEvent('data-changed'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The prompt could not be created.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const loadIntoWorkspace = (row: AiInteraction) => {
    setPromptText(row.promptText);
    setSections(row.contextSections);
    setSourcePromptId(row.promptId ? String(row.promptId) : '');
    setResult(null);
    setSendError(null);
    setSaved(false);
    setViewing(null);
    toast('Interaction loaded into the workspace');
  };

  const selectPrompt = (value: string) => {
    setSourcePromptId(value);
    if (value) {
      const option = (promptOptions ?? []).find(p => String(p.id) === value);
      if (option) setPromptText(option.content ?? '');
    }
    setResult(null);
    setSendError(null);
    setSaved(false);
  };

  const configured = status?.configured ?? false;
  const reasonInfo = status?.reason ? REASON_TEXT[status.reason] : null;
  const effectiveModel = model.trim() || status?.model || 'provider default';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI Workspace</h1>
          <div className="sub">
            Review a prompt with its project context, send it to the configured provider, and keep the
            interactions you choose to save.
          </div>
        </div>
        <div className="actions">
          <ProviderChip status={status} loading={statusLoading} />
        </div>
      </div>

      {!statusLoading && status && !configured ? (
        <div className="alert-card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>AI Provider — Not configured</div>
          <div className="dim">{reasonInfo?.title}</div>
          <div className="tiny dim" style={{ marginTop: 4 }}>
            {reasonInfo?.body} Prompt management, PROJECT.md, STATUS.md and everything else keep working
            without a provider.
          </div>
          <div style={{ marginTop: 10 }}>
            <Link className="btn sm" to="/settings">
              Configure
            </Link>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ------------------------------------------------ composable column */}
        <div style={{ flex: '1 1 520px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 1 — prompt */}
          <div className="card" style={{ marginTop: 0 }}>
            <SectionTitle n="1" title="Prompt" />
            <div className="toolbar" style={{ marginTop: 0 }}>
              <select value={sourcePromptId} onChange={e => selectPrompt(e.target.value)}>
                <option value="">Custom prompt (not stored)</option>
                {(promptOptions ?? []).map(p => (
                  <option key={p.id} value={String(p.id)}>
                    {p.code} {p.title ?? ''} {p.status !== 'DRAFT' ? `· ${p.status}` : ''}
                  </option>
                ))}
              </select>
              {sourcePromptId ? (
                <span className="tiny dim">Editing a copy — the stored prompt is unchanged until you save it.</span>
              ) : null}
            </div>
            <textarea
              value={promptText}
              onChange={e => {
                setPromptText(e.target.value);
                setSaved(false);
              }}
              placeholder="Write the prompt you want to send, or select one of this project's prompts above…"
              rows={10}
              style={{ width: '100%', marginTop: 8, resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 13 }}
              spellCheck
            />
            <div className="tiny dim" style={{ marginTop: 6 }}>
              {promptText.trim().length.toLocaleString()} characters. Nothing is sent until you press Send.
            </div>
          </div>

          {/* 2 — context */}
          <div className="card" style={{ marginTop: 0 }}>
            <SectionTitle n="2" title="Project context" />
            <div className="tiny dim" style={{ marginBottom: 8 }}>
              Only the sections you select are included in the request. Sections with no recorded data are
              marked "Not provided in Project Hub." — missing information is never invented.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {CONTEXT_SECTIONS.map(({ key, label }) => {
                const selected = (sections ?? []).includes(key);
                const present = preview?.presence[key] ?? false;
                return (
                  <button
                    key={key}
                    className={'tag-chip' + (selected ? ' tag' : '')}
                    onClick={() => toggleSection(key)}
                    title={present ? label : `${label} — nothing recorded`}
                    style={{
                      cursor: 'pointer',
                      opacity: sections === null ? 0.5 : 1,
                      borderColor: selected
                        ? 'var(--accent)'
                        : present
                          ? 'color-mix(in srgb, var(--green) 45%, transparent)'
                          : 'var(--border)',
                      background: selected ? 'var(--accent-soft, transparent)' : 'transparent',
                      color: 'var(--text)'
                    }}
                  >
                    <span style={{ color: present ? 'var(--green)' : 'var(--text-dim)', marginRight: 5 }}>
                      {present ? '●' : '○'}
                    </span>
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="toolbar">
              <button
                className="btn sm"
                onClick={() => {
                  if (!preview) return;
                  setSections(CONTEXT_SECTIONS.filter(s => preview.presence[s.key]).map(s => s.key));
                }}
                disabled={!preview}
              >
                Select sections with data
              </button>
              <button className="btn sm" onClick={() => setSections([])} disabled={sections === null}>
                Clear
              </button>
              <span className="tiny dim">{(sections ?? []).length} of 12 sections selected</span>
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="tiny dim" style={{ marginBottom: 4 }}>
                Context preview — exactly what will be appended to the prompt
              </div>
              {previewError ? (
                <ErrorBox message={previewError} />
              ) : !preview ? (
                <Loading label="Loading context…" />
              ) : (
                <pre
                  className="mono"
                  style={{
                    maxHeight: 240,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    padding: '10px 12px',
                    fontSize: 12,
                    margin: 0
                  }}
                >
                  {preview.text}
                </pre>
              )}
            </div>
          </div>

          {/* 3 — review & send */}
          <div className="card" style={{ marginTop: 0 }}>
            <SectionTitle n="3" title="Review & send" />
            <div className="toolbar" style={{ marginTop: 0 }}>
              <label className="tiny dim" htmlFor="ai-model">
                Model
              </label>
              <input
                id="ai-model"
                list="ai-model-options"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder={status?.model || 'configured default'}
                style={{ maxWidth: 260 }}
                spellCheck={false}
                autoComplete="off"
              />
              <datalist id="ai-model-options">
                {providerModels.map(m => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <span className="tiny dim">Provider: {status?.providerLabel ?? status?.provider ?? '—'}</span>
              <button className="btn sm" onClick={() => setShowRequest(v => !v)}>
                {showRequest ? 'Hide request' : 'Review request'}
              </button>
            </div>

            {showRequest ? (
              <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                <RequestPart label="Provider" value={status?.providerLabel ?? status?.provider ?? '—'} />
                <RequestPart label="Model" value={effectiveModel} />
                <RequestPart label="Prompt" value={promptText || '(empty)'} mono />
                <RequestPart label="Context" value={preview?.text ?? '(not loaded)'} mono />
                <div className="tiny dim">The API key and endpoint URL are server-side and are never part of this preview.</div>
              </div>
            ) : null}

            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={send} disabled={sending || !promptText.trim()}>
                {sending ? 'Sending…' : sendError ? 'Retry' : 'Send'}
              </button>
              {sending ? <span className="tiny dim">Waiting for the provider…</span> : null}
            </div>

            {sendError ? (
              <div style={{ marginTop: 10 }}>
                <ErrorBox message={sendError.message} />
                {sendError.possibleAction ? (
                  <div className="tiny dim" style={{ marginTop: 6 }}>
                    {sendError.possibleAction}
                  </div>
                ) : null}
                <div className="tiny dim" style={{ marginTop: 6 }}>
                  Nothing was saved. Retrying creates at most one interaction once you save it.
                </div>
              </div>
            ) : null}
          </div>

          {/* 4 — response */}
          {result ? (
            <div className="card" style={{ marginTop: 0 }}>
              <SectionTitle n="4" title="Response" />
              <div className="tiny dim" style={{ marginBottom: 8 }}>
                {result.providerLabel} · {result.model} · {Math.round(result.durationMs)} ms
                {result.usage?.totalTokens != null ? ` · ${result.usage.totalTokens} tokens` : ''}
                {result.truncated ? ' · truncated to the configured maximum size' : ''}
              </div>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '12px 14px',
                  background: 'var(--bg)'
                }}
              >
                <Markdown content={result.text} />
              </div>
              <div className="tiny dim" style={{ marginTop: 8 }}>
                Displayed as text only — Project Hub never executes anything an AI response contains.
              </div>
              <div className="toolbar" style={{ marginTop: 10 }}>
                <button className="btn sm" onClick={copyResponse}>
                  Copy response
                </button>
                <button className="btn sm primary" onClick={saveInteraction} disabled={saved || busyAction !== null}>
                  {saved ? 'Saved ✓' : busyAction === 'save' ? 'Saving…' : 'Save interaction'}
                </button>
                <button className="btn sm" onClick={saveAsNote} disabled={busyAction !== null}>
                  {busyAction === 'note' ? 'Saving…' : 'Save as note'}
                </button>
                <button className="btn sm" onClick={promptFromResponse} disabled={busyAction !== null}>
                  {busyAction === 'prompt' ? 'Creating…' : 'Create prompt from response'}
                </button>
              </div>
              {!saved ? (
                <div className="tiny dim" style={{ marginTop: 6 }}>
                  Not in the project history yet — saving is your call.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ---------------------------------------------------- history column */}
        <div style={{ flex: '0 1 330px', minWidth: 280 }}>
          <div className="card" style={{ marginTop: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>AI History</h3>
              <span className="tiny dim">{history?.length ?? 0} saved</span>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => reloadHistory()}>
                Refresh
              </button>
            </div>
            {!history ? (
              <Loading label="Loading history…" />
            ) : history.length === 0 ? (
              <EmptyState
                title="No AI interactions yet"
                hint="Saved interactions are kept per project, with the prompt, context and response that were used."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {history.map(row => (
                  <button
                    key={row.id}
                    className="btn"
                    style={{ display: 'block', width: '100%', textAlign: 'left', whiteSpace: 'normal' }}
                    onClick={() => setViewing(row)}
                  >
                    <div style={{ fontWeight: 600 }}>{row.title ?? 'AI interaction'}</div>
                    <div className="tiny dim" style={{ marginTop: 2 }}>
                      {formatDateTime(row.createdAt)} · {row.model}
                      {row.promptCode ? ` · ${row.promptCode}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <div className="tiny dim" style={{ margin: 0 }}>
              History stays local to this machine. AI activity never changes a project's stage, STATUS.md or
              PROJECT.md on its own.
            </div>
          </div>
        </div>
      </div>

      {viewing ? (
        <Modal title={viewing.title ?? 'AI interaction'} onClose={() => setViewing(null)} wide>
          <div className="kv">
            <dt>When</dt>
            <dd>{formatDateTime(viewing.createdAt)}</dd>
            <dt>Provider</dt>
            <dd>{viewing.provider}</dd>
            <dt>Model</dt>
            <dd>{viewing.model}</dd>
            <dt>Duration</dt>
            <dd>{viewing.durationMs != null ? `${viewing.durationMs} ms` : '—'}</dd>
            <dt>Tokens</dt>
            <dd>
              {viewing.totalTokens != null
                ? `${viewing.totalTokens} total (${viewing.inputTokens ?? '?'} in / ${viewing.outputTokens ?? '?'} out)`
                : 'Not reported by the provider'}
            </dd>
            <dt>From prompt</dt>
            <dd>{viewing.promptCode ?? 'Custom prompt (not linked)'}</dd>
          </div>

          <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>Prompt</h4>
          <pre className="mono" style={REQUEST_PRE}>
            {viewing.promptText}
          </pre>

          <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>
            Context ({viewing.contextSections.length} section{viewing.contextSections.length === 1 ? '' : 's'})
          </h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
            {viewing.contextSections.length === 0 ? (
              <span className="tiny dim">No project context was sent with this prompt.</span>
            ) : (
              viewing.contextSections.map(key => (
                <span key={key} className="tag-chip tag">
                  {CONTEXT_SECTIONS.find(s => s.key === key)?.label ?? key}
                </span>
              ))
            )}
          </div>
          {viewing.contextText ? (
            <pre className="mono" style={REQUEST_PRE}>
              {viewing.contextText}
            </pre>
          ) : null}

          <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>Response</h4>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '10px 12px',
              background: 'var(--bg)'
            }}
          >
            <Markdown content={viewing.responseText} />
          </div>

          <div className="toolbar" style={{ marginTop: 14 }}>
            <button
              className="btn sm"
              onClick={() => {
                navigator.clipboard
                  .writeText(viewing.responseText)
                  .then(() => toast('Response copied'))
                  .catch(() => toast('Could not access the clipboard.', 'error'));
              }}
            >
              Copy response
            </button>
            <button className="btn sm" onClick={() => loadIntoWorkspace(viewing)}>
              Load into workspace
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function SectionTitle({ n, title }: { n: string; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: 'var(--accent)',
          color: 'var(--accent-contrast)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700
        }}
      >
        {n}
      </span>
      <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
    </div>
  );
}

function RequestPart({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="tiny dim">{label}</div>
      <div
        className={mono ? 'mono' : undefined}
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: mono ? 12 : 13,
          maxHeight: mono ? 160 : undefined,
          overflow: mono ? 'auto' : undefined,
          border: mono ? '1px solid var(--border)' : undefined,
          borderRadius: mono ? 'var(--radius)' : undefined,
          padding: mono ? '8px 10px' : undefined,
          background: mono ? 'var(--bg)' : undefined
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ProviderChip({ status, loading }: { status: AiStatus | null; loading: boolean }) {
  if (loading && !status) return <span className="tiny dim">Checking AI provider…</span>;
  if (!status) return null;
  const ok = status.configured;
  return (
    <span
      className="badge"
      style={{
        color: ok ? 'var(--green)' : 'var(--yellow)',
        background: ok ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'color-mix(in srgb, var(--yellow) 12%, transparent)',
        borderColor: 'color-mix(in srgb, currentColor 30%, transparent)'
      }}
      title={ok ? `${status.providerLabel} · ${status.model}` : status.reason ?? 'not configured'}
    >
      <span className="bdot" />
      {ok ? `Configured ✓ · ${status.model}` : 'Not configured'}
    </span>
  );
}

/** First non-empty line of the prompt, clipped - shared by the save actions. */
function titleFrom(prompt: string): string {
  const first = prompt
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length > 0);
  const text = first ?? 'AI response';
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text;
}
