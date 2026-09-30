const BASE = '/api';

export interface Meta {
  total?: number;
  page?: number;
  pageSize?: number;
}

/**
 * The backend always explains a failure with a category, the operation it was
 * attempting, and what the user can do next. Keeping all three on the error
 * means the UI never has to invent its own wording for a failure.
 */
export type ApiErrorCategory =
  | 'DATA_MISSING'
  | 'VALIDATION_FAILED'
  | 'SYSTEM_ERROR'
  | 'GENERATION_ERROR'
  | 'NOT_FOUND'
  | 'DOCUMENT_ERROR'
  | 'EXTRACTION_ERROR'
  | 'MAPPING_ERROR'
  | 'DATABASE_ERROR'
  // Phase 3/4. A file that already exists is a conflict the user must resolve,
  // and a filesystem refusal (permissions, a read-only volume) is neither a bad
  // request nor a plain system fault.
  | 'CONFLICT'
  | 'FILESYSTEM_ERROR';

export class ApiError extends Error {
  status: number;
  details?: unknown;
  category: ApiErrorCategory;
  operation?: string;
  possibleAction?: string;

  constructor(
    status: number,
    message: string,
    details?: unknown,
    category: ApiErrorCategory = 'SYSTEM_ERROR',
    operation?: string,
    possibleAction?: string
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.category = category;
    this.operation = operation;
    this.possibleAction = possibleAction;
  }
}

async function request<T, M = Meta>(method: string, path: string, body?: unknown): Promise<{ data: T; meta?: M }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const message = json?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(
      res.status,
      message,
      json?.error?.details,
      json?.error?.category,
      json?.error?.operation,
      json?.error?.possibleAction
    );
  }
  return json ?? { data: undefined as T };
}

export const api = {
  get: <T, M = Meta>(path: string) => request<T, M>('GET', path),
  post: <T, M = Meta>(path: string, body?: unknown) => request<T, M>('POST', path, body),
  put: <T, M = Meta>(path: string, body?: unknown) => request<T, M>('PUT', path, body),
  del: <T, M = Meta>(path: string) => request<T, M>('DELETE', path),

  /** Multipart upload. Separate from `post` because the body is FormData. */
  upload: async <T, M = Meta>(path: string, form: FormData): Promise<{ data: T; meta?: M }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', body: form });
    const text = await res.text();
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        json?.error?.message ?? `Upload failed (${res.status})`,
        json?.error?.details,
        json?.error?.category,
        json?.error?.operation,
        json?.error?.possibleAction
      );
    }
    return json ?? { data: undefined as T };
  }
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'no activity';
  const d = new Date(value).getTime();
  const diff = Date.now() - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}