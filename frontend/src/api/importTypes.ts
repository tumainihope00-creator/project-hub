/** Wire types for the document importer, mirroring the backend's own shapes. */

export type Provenance = 'explicit' | 'inferred';
export type Horizon = 'v1' | 'future' | 'unscoped';

export interface DraftField {
  field: string;
  value: string;
  provenance: Provenance;
  confidence: number;
  evidence: string;
  include: boolean;
}

export interface DraftRecord {
  entity: string;
  values: Record<string, string>;
  provenance: Provenance;
  confidence: number;
  horizon: Horizon;
  evidence: string;
  include: boolean;
  duplicateOf?: number;
}

export interface DraftSource {
  filename: string;
  format: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  characters: number;
  /** Always false: the uploaded file's contents are never stored. */
  stored: false;
}

export interface UnsupportedFinding {
  concept: string;
  value: string;
  evidence: string;
  reason: string;
}

export interface ImportDraft {
  project: DraftField[];
  records: DraftRecord[];
  tags: string[];
  source: DraftSource;
  unsupported: UnsupportedFinding[];
}

export interface ImportCapabilities {
  formats: {
    format: string;
    label: string;
    extensions: string[];
    mimeTypes: string[];
    reliable: boolean;
    note: string;
  }[];
  limits: Record<string, number>;
  maxBytes: number;
  projectFields: { name: string; kind: string; required: boolean; values?: string[] }[];
  entities: {
    path: string;
    label: string;
    model: string;
    table: string;
    codePrefix?: string;
    fields: { name: string; kind: string; required: boolean; values?: string[] }[];
  }[];
  enums: Record<string, string[]>;
  guarantees: {
    createsNewProjectOnly: boolean;
    modifiesExistingProjects: boolean;
    storesUploadedFile: boolean;
    usesExternalServices: boolean;
    requiresNetwork: boolean;
  };
}

export interface AnalyzeResult {
  draft: ImportDraft;
  stats: { characters: number; lines: number; headings: number; bulletLines: number; listSections: number };
  warnings: string[];
  appliedRules: string[];
  counts: {
    projectFields: number;
    records: number;
    duplicates: number;
    inferred: number;
    unsupportedConcepts: number;
  };
  /** Importable project fields the document did not mention. */
  notFound: string[];
}

export interface CreateResult {
  projectId: number;
  slug: string;
  created: Record<string, number>;
  totalRecords: number;
}

/** A value the review screen sent that Project Hub has no place for. */
export interface UnmappedItem {
  where: string;
  key: string;
  value: string;
  reason: string;
}

export interface CreateResponse {
  data: CreateResult;
  meta: {
    unmapped: UnmappedItem[];
    skipped: { entity: string; reason: string; evidence: string }[];
    source: DraftSource;
  };
}
