import { useEffect, useState } from 'react';
import { api, ApiError, formatDateTime } from '../api/client';
import { useApi } from '../lib/useApi';
import { useApp } from '../context/AppContext';
import { ConfirmButton, ErrorBox, Loading } from '../components/ui';
import type { AiStatus, PathProblem, ProjectsRoot } from '../api/types';

type Busy = 'save' | 'test' | 'init' | 'clear' | null;

/**
 * Application settings: the Projects Root.
 *
 * The Projects Root is the folder that will contain every project folder Project
 * Hub manages. It is separate from the Project Hub application folder and from
 * any individual project, and it is never guessed: until it is set here, Project
 * Hub has no Projects Root at all.
 *
 * There is deliberately no native folder picker. Project Hub is a browser app
 * served over HTTP, and the browser gives a page no way to ask the operating
 * system for a real folder path - `<input type="file" webkitdirectory>` returns
 * a list of files the user selected, not a path P-Hub could manage. Showing a
 * "Choose folder" button that cannot actually do that would be worse than an
 * honest text field, so the path is typed and validated on the backend, which
 * is the only place that can actually check it.
 */
export function SettingsPage() {
  const { toast } = useApp();
  const { data, loading, reload } = useApi<ProjectsRoot>('/settings/projects-root');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [status, setStatus] = useState<ProjectsRoot | null>(null);

  // Seed the input from the stored value, and show whatever status came back.
  useEffect(() => {
    if (!data) return;
    setValue(prev => (prev && prev !== data.path ? prev : data.path ?? ''));
    setStatus(prev => (data.configured ? data : prev));
  }, [data]);

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<{ data: ProjectsRoot }>, successMessage: string) => {
    setBusy(kind);
    setError(null);
    try {
      const res = await action();
      setStatus(res.data);
      if (res.data.path) setValue(res.data.path);
      toast(successMessage);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(null);
    }
  };

  const save = () => run('save', () => api.put<ProjectsRoot>('/settings/projects-root', { path: value }), 'Projects Root saved');
  const test = () => run('test', () => api.post<ProjectsRoot>('/settings/projects-root/test', { path: value || undefined }), 'Connection tested');
  const initialize = () => run('init', () => api.post<ProjectsRoot>('/settings/projects-root/initialize', { path: value || undefined }), 'Folder ready');
  const clear = () => run('clear', () => api.del<ProjectsRoot>('/settings/projects-root'), 'Projects Root cleared');

  const configured = status?.configured ?? data?.configured ?? false;
  const current = status ?? data;
  const err = error instanceof ApiError ? error : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Application-wide configuration for Project Hub.</div>
        </div>
      </div>

      <h2 className="section">Project Workspace</h2>
      <div className="card">
        <div className="muted" style={{ marginTop: 0, maxWidth: 720 }}>
          The <strong>Projects Root</strong> is the single folder where Project Hub will keep the project folders it manages.
          It is not the Project Hub application folder, and each project will later live in its own folder inside it.
        </div>

        {loading && !current ? (
          <Loading />
        ) : !configured ? (
          <div
            className="dim"
            style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px', margin: '12px 0' }}
          >
            <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>Projects Root is not configured.</div>
            Configure a root folder where P-Hub will create and manage project workspaces. Project Hub will not guess a folder for you.
          </div>
        ) : (
          <div style={{ margin: '12px 0' }}>
            <div className="tiny dim">Projects Root</div>
            <div className="mono" style={{ fontSize: 14, wordBreak: 'break-all', marginTop: 2 }}>
              {current?.path}
            </div>
            {current?.updatedAt ? (
              <div className="tiny dim" style={{ marginTop: 4 }}>
                Last changed {formatDateTime(current.updatedAt)}
              </div>
            ) : null}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="tiny dim" htmlFor="projects-root-input">
            Absolute folder path
          </label>
          <input
            id="projects-root-input"
            className="mono"
            style={{ fontFamily: 'var(--mono)' }}
            value={value}
            placeholder="D:\Projects"
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && value.trim()) save();
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="tiny dim">
            Must be a full absolute path. Windows example: <span className="mono">D:\My Projects</span>. Project Hub checks the path on
            the backend before saving it.
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={save} disabled={busy !== null || !value.trim()}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" onClick={test} disabled={busy !== null || (!value.trim() && !configured)}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {current?.exists === false ? (
            <button className="btn" onClick={initialize} disabled={busy !== null}>
              {busy === 'init' ? 'Creating…' : 'Create folder'}
            </button>
          ) : null}
          <div style={{ marginLeft: 'auto' }}>
            {configured ? (
              <ConfirmButton
                className="btn sm danger"
                label="Clear"
                confirmLabel="Confirm clear"
                question="Forget the Projects Root? Your folder and its contents are not touched."
                onConfirm={clear}
              />
            ) : null}
          </div>
        </div>

        {busy === 'clear' ? <div className="tiny dim">Clearing…</div> : null}

        {error ? (
          <div style={{ marginTop: 12 }}>
            <ErrorBox message={error.message} />
            {err?.possibleAction ? (
              <div className="tiny dim" style={{ marginTop: 6 }}>
                {err.possibleAction}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {current && (status || configured) ? (
        <>
          <h2 className="section">Connection check</h2>
          <div className="card">
            {current.problems.length > 0 ? (
              <div style={{ marginBottom: 12 }}>
                {current.problems.map((p: PathProblem, i: number) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <div style={{ color: 'var(--yellow)' }}>{p.message}</div>
                    {p.possibleAction ? <div className="tiny dim">{p.possibleAction}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Configured</dt>
              <dd>
                <Check ok={configured} label={configured ? 'Yes' : 'No'} />
              </dd>
              <dt>Folder exists</dt>
              <dd>
                <Check
                  ok={current.exists === true}
                  unknown={current.exists === null}
                  label={current.exists === true ? 'Directory exists' : current.exists === false ? 'Folder does not exist' : 'Not checked'}
                />
              </dd>
              <dt>Is a folder</dt>
              <dd>
                <Check
                  ok={current.isDirectory === true}
                  unknown={current.isDirectory === null}
                  label={current.isDirectory === true ? 'Yes, it is a directory' : current.isDirectory === false ? 'No, it is a file' : 'Not checked'}
                />
              </dd>
              <dt>Readable</dt>
              <dd>
                <Check
                  ok={current.readable === true}
                  unknown={current.readable === null}
                  label={current.readable === true ? 'P-Hub can read it' : 'P-Hub cannot read it'}
                />
              </dd>
              <dt>Writable</dt>
              <dd>
                <Check
                  ok={current.writable === true}
                  unknown={!current.writableTested}
                  label={
                    current.writable === true
                      ? 'P-Hub can write to it'
                      : current.writable === false
                        ? 'The selected path exists but is not writable'
                        : 'Not tested yet — use "Test connection"'
                  }
                />
              </dd>
              {current.isSymbolicLink ? (
                <>
                  <dt>Link</dt>
                  <dd className="dim">The final path component is a link. Project Hub stores your path exactly as entered and does not resolve it.</dd>
                </>
              ) : null}
            </dl>
            <div className="tiny dim" style={{ marginTop: 10 }}>
              Checked {formatDateTime(current.checkedAt)}. Testing the connection writes and removes one temporary probe file inside the
              folder. Saving a path never creates anything.
            </div>
          </div>
        </>
      ) : null}

      <AiSettingsCard />
    </div>
  );
}

/**
 * Phase 9: AI provider configuration.
 *
 * The API key is write-only in both directions: the input is never prefilled
 * (the backend never returns a key, only `apiKeyConfigured` + `apiKeySource`),
 * and what is typed here is sent once to be stored server-side. The preferred
 * location remains the `AI_PROVIDER_API_KEY` environment variable in
 * backend/.env - when it is set, it takes precedence over a stored key and the
 * card says so instead of pretending the stored value is active.
 */
function AiSettingsCard() {
  const { toast } = useApp();
  const { data: status, loading, reload } = useApi<AiStatus>('/ai/status');

  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [timeoutSeconds, setTimeoutSeconds] = useState('60');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    if (!status) return;
    setProvider(status.provider);
    setModel(status.model);
    setEnabled(status.enabled);
    setTimeoutSeconds(String(Math.round(status.timeoutMs / 1000)));
    // The key input is deliberately left empty every time: there is no value
    // to reveal because the server never sends one.
    setApiKey('');
  }, [status]);

  const save = async (extra: { apiKey?: string | null } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const timeoutMs = Math.round(Number(timeoutSeconds) * 1000);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
        throw new Error('The request timeout must be between 1 and 600 seconds.');
      }
      await api.put<AiStatus>('/ai/settings', {
        provider,
        model,
        enabled,
        timeoutMs,
        ...extra
      });
      if (extra.apiKey !== undefined) setApiKey('');
      toast('AI settings saved');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const reasonText: Record<NonNullable<AiStatus['reason']>, string> = {
    disabled: 'The provider is switched off. AI requests are blocked until it is enabled.',
    missing_api_key: 'No API key is available, so requests cannot be authenticated.',
    unknown_provider: 'The configured provider id is not registered in this build.'
  };

  const err = error instanceof ApiError ? error : null;
  const sourceLabel =
    status?.apiKeySource === 'environment'
      ? 'environment variable AI_PROVIDER_API_KEY (backend/.env)'
      : status?.apiKeySource === 'application'
        ? 'stored on this machine (application settings)'
        : null;

  return (
    <>
      <h2 className="section">AI Provider</h2>
      <div className="card">
        <div className="muted" style={{ marginTop: 0, maxWidth: 720 }}>
          Project Hub sends prompts to this provider only from the AI Workspace, and only when you press
          Send. Everything else — projects, tasks, notes, PROJECT.md, STATUS.md, prompt management — works
          offline without a provider.
        </div>

        {loading && !status ? (
          <Loading />
        ) : status ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                margin: '12px 0',
                padding: '10px 12px',
                border: `1px solid ${status.configured ? 'color-mix(in srgb, var(--green) 45%, transparent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)',
                background: status.configured ? 'color-mix(in srgb, var(--green) 8%, transparent)' : 'var(--bg)'
              }}
            >
              <strong>AI Provider</strong>
              <span style={{ color: status.configured ? 'var(--green)' : 'var(--yellow)' }}>
                {status.configured ? 'Configured ✓' : 'Not configured'}
              </span>
              <span className="tiny dim">
                {status.providerLabel ?? status.provider} · model: {status.model || 'not set'}
              </span>
              {!status.configured && status.reason ? (
                <span className="tiny dim" style={{ flexBasis: '100%' }}>
                  {reasonText[status.reason]}
                </span>
              ) : null}
            </div>

            <div className="form-grid">
              <label className="field">
                <span className="tiny dim">Provider</span>
                <select value={provider} onChange={e => setProvider(e.target.value)} disabled={busy}>
                  {status.providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="tiny dim">Default model</span>
                <input
                  list="ai-settings-models"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder={status.providers.find(p => p.id === provider)?.defaultModel ?? 'model name'}
                  disabled={busy}
                  spellCheck={false}
                />
                <datalist id="ai-settings-models">
                  {(status.providers.find(p => p.id === provider)?.models ?? []).map(m => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span className="tiny dim">Request timeout (seconds)</span>
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={timeoutSeconds}
                  onChange={e => setTimeoutSeconds(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'end' }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  disabled={busy}
                />
                <span>AI provider enabled</span>
              </label>
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="tiny dim">API key</div>
              <div style={{ margin: '4px 0 8px' }}>
                {status.apiKeyConfigured ? (
                  <span>
                    <span style={{ color: 'var(--green)', marginRight: 6 }}>✓</span>
                    Configured ({sourceLabel}). The value is never displayed after it is stored.
                  </span>
                ) : (
                  <span>
                    <span style={{ color: 'var(--yellow)', marginRight: 6 }}>✗</span>
                    No key configured. Set <span className="mono">AI_PROVIDER_API_KEY</span> in{' '}
                    <span className="mono">backend/.env</span>, or paste one below.
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={status.apiKeyConfigured ? 'Enter a new key to replace it' : 'Paste API key'}
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={busy}
                  style={{ maxWidth: 340, fontFamily: 'var(--mono)' }}
                />
                <button
                  className="btn sm"
                  onClick={() => save({ apiKey: apiKey.trim() || null })}
                  disabled={busy || (!apiKey.trim() && status.apiKeySource !== 'application')}
                >
                  {apiKey.trim() ? 'Store key' : 'Replace key'}
                </button>
                {status.apiKeySource === 'application' ? (
                  <ConfirmButton
                    className="btn sm danger"
                    label="Remove stored key"
                    confirmLabel="Confirm removal"
                    question="Remove the stored key? An environment key in backend/.env, if present, stays active."
                    onConfirm={() => save({ apiKey: '' })}
                  />
                ) : null}
              </div>
              <div className="tiny dim" style={{ marginTop: 6 }}>
                Stored server-side only. It is never sent to the browser, never written to PROJECT.md or any
                prompt, and never committed to git (.env is ignored).
                {status.apiKeySource === 'environment'
                  ? ' The environment variable currently takes precedence over any stored key.'
                  : ''}
              </div>
            </div>

            <div className="toolbar" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={() => save()} disabled={busy}>
                {busy ? 'Saving…' : 'Save settings'}
              </button>
              <button className="btn" onClick={() => reload()} disabled={busy}>
                Refresh status
              </button>
              <span className="tiny dim">
                Endpoint: {status.baseUrlSource === 'environment' ? 'custom (AI_BASE_URL)' : 'provider default'} ·
                response cap: {status.maxResponseChars.toLocaleString()} chars
              </span>
            </div>
          </>
        ) : null}

        {error ? (
          <div style={{ marginTop: 12 }}>
            <ErrorBox message={error.message} />
            {err?.possibleAction ? (
              <div className="tiny dim" style={{ marginTop: 6 }}>
                {err.possibleAction}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

function Check({ ok, unknown, label }: { ok: boolean; unknown?: boolean; label: string }) {
  if (unknown) return <span className="dim">{label}</span>;
  return (
    <span>
      <span style={{ color: ok ? 'var(--green)' : 'var(--red)', marginRight: 6 }}>{ok ? '✓' : '✗'}</span>
      {label}
    </span>
  );
}
