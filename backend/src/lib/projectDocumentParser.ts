import { PROJECT_DOCUMENT_FILENAME, PROJECT_DOCUMENT_VERSION } from './projectDocument.js';

/**
 * Phase 6, part one: read the structure out of a PROJECT.md document.
 *
 * This is the inverse of `renderProjectDocument` in `projectDocument.ts`. It is
 * deliberately small and totally deterministic:
 *
 *  - It recognises only the exact section headings, bold field labels and record
 *    shapes that `renderProjectDocument` emits. Anything else is either skipped
 *    (unknown heading) or reported as a warning; nothing is guessed.
 *  - There is no model, no heuristic and no LLM anywhere in this file. A field is
 *    synchronized only if this parser produced a value for it from a documented
 *    shape. Prose that "looks like" data is never interpreted.
 *  - The parser is total: it always returns a `ParsedProjectDocument`. Problems
 *    (bad front matter, unknown version, wrong project) are represented as
 *    `errors`, not thrown, so the caller can decide whether a preview can still
 *    be shown. Only genuinely unusable input makes `parseProjectDocument` unusable.
 *
 * Boundary note: `## Project Status` and the delivery/git/tag sections are parsed
 * only to the extent of noting that they exist and are NOT synchronized. STATUS.md
 * owns status; this phase never writes `stage`, `isArchived`, or dates.
 *
 * MISSING AND EMPTY SECTIONS (the conservative rule, deliberately chosen).
 *
 * The document format Project Hub generates has no way to say "clear this value".
 * A section that is absent, a field that is blank, and the `_Not yet documented._`
 * placeholder all mean the same thing to this parser: *nothing was expressed*, so
 * the corresponding key is left out of the result entirely rather than being set to
 * an empty string. The synchronization layer only ever writes a key that is present,
 * so a blank `## Assumptions` cannot erase a non-empty `assumptions` column.
 *
 * The consequence is stated here because it is a real limitation, not an accident:
 * there is currently no way to clear a project field from PROJECT.md. Clearing it
 * means clearing it in Project Hub and regenerating the document. That is the
 * safer of the two possible readings - a stray blank line must never be able to
 * destroy data - but it is a deliberate choice, and a later phase that adds an
 * explicit "clear" marker in the format should look here first.
 */

/** One `## Heading` block and the raw lines under it, in document order. */
interface SectionBlock {
  heading: string;
  lines: string[];
}

/** A single `- Title` record with its optional attribute row and detail lines. */
export interface ParsedRecord {
  /** The text after `- `, before the attribute row, with markdown emphasis kept. */
  title: string;
  /** The `  - a · b · c` attribute row split on ` · `, if present. */
  attributes: string[];
  /** The indented detail lines, de-indented and joined. */
  detail: string | null;
  /** 1-based line number of the `- ` bullet, for error messages. */
  line: number;
}

export interface ParsedProjectDocument {
  /** True when front matter was valid and matched this project. */
  metadataValid: boolean;
  projectIdFromDocument: number | null;
  documentVersion: number | null;
  projectNameFromDocument: string | null;
  /** Normalised core text fields, keyed by the label used in `## Overview`. */
  coreFields: Record<string, string>;
  /** Prose sections whose whole body is a single field (V1 Scope, etc.). */
  proseFields: Record<string, string>;
  /** `## Repository` body: the URL, or null when not documented. */
  repositoryUrl: string | null;
  /** Child records per supported section, keyed by section name. */
  records: Record<string, ParsedRecord[]>;
  /** Headings the document contains that this phase does not synchronize. */
  unsupportedSections: string[];
  /** Headings not recognised at all (kept verbatim for round-trip awareness). */
  unknownSections: string[];
  /** Non-fatal problems: unparsable enum, empty section, ignored detail, etc. */
  warnings: string[];
  /** Fatal problems that make synchronization unsafe. */
  errors: string[];
}

// The set of headings we synchronise. Everything else is reported, never applied.
const CORE_LABEL_SECTIONS = ['Overview'] as const;
const PROSE_SECTIONS = ['V1 Scope', 'Assumptions', 'Initial Questions', 'Inspiration'] as const;
const RECORD_SECTIONS = [
  'Research',
  'Research Questions',
  'Requirements',
  'Features',
  'Technology Stack',
  'Architecture Decisions',
  'Database Tables',
  'API Endpoints',
  'Milestones',
  'Tasks',
  'Issues',
  'Notes'
] as const;

// Sections that exist in the document but are explicitly out of scope for Phase 6.
const KNOWN_UNSUPPORTED_SECTIONS = [
  'Project Status',
  'Repository',
  'Deployment',
  'Development Sessions',
  'Git References',
  'Tags'
] as const;

const ALL_KNOWN_SECTIONS = new Set<string>([
  ...CORE_LABEL_SECTIONS,
  ...PROSE_SECTIONS,
  ...RECORD_SECTIONS,
  ...KNOWN_UNSUPPORTED_SECTIONS
]);

export { ALL_KNOWN_SECTIONS as ALL_KNOWN };

const EMPTY_PLACEHOLDER = /^_[^_]*yet\._$/;
const NOT_DOCUMENTED = '_Not yet documented._';

/**
 * Strip the double-quoting the generator's `yamlScalar` applies.
 *
 * `yamlScalar` wraps project name/slug/document in double quotes and escapes
 * backslashes and inner quotes. Undo exactly that, and nothing else: a value that
 * was not quoted is returned unchanged, so hand-written front matter still works.
 */
function unquoteYamlScalar(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return v;
}


/** `NON_FUNCTIONAL`, `non-functional`, `Non-Functional` -> `NON_FUNCTIONAL`. */
export function enumToken(label: string): string {
  return label
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
}

/** True for the generator's italic "nothing here" placeholders. */
function isPlaceholder(line: string): boolean {
  const t = line.trim();
  return t === NOT_DOCUMENTED || EMPTY_PLACEHOLDER.test(t);
}

/**
 * Split the document into its front matter and its `## ` sections.
 *
 * The front matter is the first `---` fenced block. Everything after it is
 * scanned for level-2 headings; lines before the first heading are ignored (the
 * `# Title` and the blockquote banner).
 */
function splitDocument(content: string): {
  frontMatter: Record<string, string> | null;
  sections: SectionBlock[];
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');

  let frontMatter: Record<string, string | null> | null = null;
  let bodyStart = 0;

  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close === -1) {
      errors.push('The front matter block is opened with "---" but never closed.');
    } else {
      frontMatter = {};
      for (let i = 1; i < close; i++) {
        const line = lines[i];
        const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
        if (m) frontMatter[m[1]] = m[2];
      }
      bodyStart = close + 1;
    }
  } else {
    errors.push('PROJECT.md has no front matter block. The first line must be "---".');
  }

  const sections: SectionBlock[] = [];
  let current: SectionBlock | null = null;
  for (let i = bodyStart; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      current = { heading: m[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(lines[i]);
    }
  }

  return { frontMatter: frontMatter as Record<string, string> | null, sections, errors, warnings };
}

/**
 * Parse one record block into its records.
 *
 * A record is a `- Title` bullet. A `  - a · b` bullet on the next line is that
 * record's attribute row. Any further `  ` (or deeper) indented lines are the
 * record's detail, de-indented by two spaces and rejoined. Blank lines between
 * records are ignored.
 */
function parseRecords(section: SectionBlock, warnings: string[], heading: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  const lines = section.lines;
  let i = 0;

  const trimmedBody = lines.filter((l) => l.trim() !== '');
  if (trimmedBody.length === 1 && isPlaceholder(trimmedBody[0])) {
    return records; // an explicit empty list
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || isPlaceholder(line)) {
      i++;
      continue;
    }
    // A top-level bullet starts a record. Anything not indented is a bullet.
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!bullet || /^\s{2,}/.test(line)) {
      warnings.push(`Ignored an unrecognised line in "## ${heading}": ${JSON.stringify(line.trim())}`);
      i++;
      continue;
    }

    const record: ParsedRecord = { title: bullet[1].trim(), attributes: [], detail: null, line: i + 1 };
    i++;

    // Attribute row: an indented bullet.
    const attr = /^\s{2,}[-*+]\s+(.*)$/.exec(lines[i] ?? '');
    if (attr) {
      record.attributes = attr[1]
        .split('·')
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    }

    // Detail lines: indented non-bullet lines until the next top-level bullet.
    const detailLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') {
        // A blank line ends the detail only if the next line closes the record.
        const next = lines[i + 1] ?? '';
        if (/^\s*[-*+]\s+/.test(next) && !/^\s{2,}/.test(next)) break;
        detailLines.push('');
        i++;
        continue;
      }
      if (/^\s*[-*+]\s+/.test(l) && !/^\s{2,}/.test(l)) break; // next record
      if (/^\s{2,}[-*+]\s+/.test(l)) break; // next record's attribute row
      if (/^\s{2,}/.test(l)) {
        detailLines.push(l.replace(/^\s{2}/, ''));
        i++;
        continue;
      }
      break; // unindented non-bullet: end of section content
    }
    const detail = detailLines.join('\n').trim();
    record.detail = detail === '' ? null : detail;

    // Undo the generator's prose escaping so a round-trip is lossless.
    record.title = unescape(record.title);
    if (record.detail) record.detail = unescape(record.detail);

    records.push(record);
  }

  return records;
}

/** Remove the `\` the generator puts in front of structural characters in prose. */
function unescape(text: string): string {
  return text.replace(/^\\(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/gm, '$1');
}

/** The horizontal ellipsis `oneLine` appends when it shortens a value. */
export const TRUNCATION_MARKER = '…';

/**
 * Was this value shortened by the generator?
 *
 * A title that ends in the ellipsis is a display value, not the stored one. The
 * changeset engine must never treat a truncated title as an authoritative new
 * value, because writing it back would replace a full title with a shortened one.
 */
export function isTruncated(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trimEnd().endsWith(TRUNCATION_MARKER);
}

/**
 * Split a record title into its stable code and its text.
 *
 * The generator writes codes as `**REQ-001** The system must ...`, so the code is
 * a bold token in leading position and everything after it is the title. Records
 * identified by name (features, notes, milestones, ...) simply have no bold code
 * and the whole title is returned.
 */
export function splitCodeAndTitle(title: string): { code: string | null; title: string } {
  const m = /^\*\*([^*]+)\*\*\s*(.*)$/s.exec(title.trim());
  if (!m) return { code: null, title: title.trim() };
  // The generator separates the code from the title with a spaced dash. Strip only
  // that exact leading separator; a title that genuinely starts with a dash is left
  // alone because the separator requires surrounding whitespace to be unambiguous.
  const rest = m[2].trim().replace(/^(?:—|–|-)\s+/, '');
  return { code: m[1].trim(), title: rest };
}

/**
 * Split an API endpoint title into its method and path.
 *
 * The generator writes `` `POST /api/login` ``. A hand-written `` POST /api/login``
 * without the backticks is accepted too, because the shape is unambiguous.
 */
export function splitEndpointTitle(title: string): { method: string; path: string } | null {
  const cleaned = title.trim().replace(/^`/, '').replace(/`$/, '').trim();
  const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(cleaned);
  if (!m) return null;
  return { method: m[1].toUpperCase(), path: m[2].trim() };
}

/**
 * Pull a `Label: value` attribute out of an attribute row.
 *
 * The generator writes attributes as `Functional · Priority: High · Proposed`, so
 * priority/target/due/version appear as `Priority: High` while type and status are
 * bare tokens. This finds the prefixed one and returns its value, or null.
 */
export function attributeValue(attributes: string[], label: string): string | null {
  const prefix = `${label.toLowerCase()}:`;
  for (const a of attributes) {
    const lower = a.toLowerCase();
    if (lower.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  return null;
}

/** The bare (unprefixed) tokens in an attribute row, in order. */
export function bareAttributes(attributes: string[], labels: string[]): string[] {
  const lowered = labels.map((l) => l.toLowerCase());
  return attributes.filter((a) => {
    const lower = a.toLowerCase();
    return !lowered.some((l) => lower.startsWith(`${l}:`));
  });
}

/**
 * Parse the `## Overview` block into its `**Label**` fields.
 *
 * A field is `**Label**` on its own line, followed by a blank line and the prose
 * value. Fields are only recognised for the labels we synchronise; anything else
 * is kept out of the result and reported.
 */
const OVERVIEW_FIELD_LABELS: Record<string, string> = {
  Description: 'description',
  Problem: 'problem',
  Motivation: 'motivation',
  'Target Users': 'targetUsers',
  'Expected Value': 'expectedValue'
};

function parseOverview(section: SectionBlock, warnings: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = section.lines;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\*\*([^*]+)\*\*\s*$/.exec(lines[i].trim());
    if (!m) continue;
    const label = m[1].trim();
    const key = OVERVIEW_FIELD_LABELS[label];
    if (!key) {
      warnings.push(`Ignored an unrecognised Overview field label: ${JSON.stringify(label)}`);
      continue;
    }
    // Collect the value: every line until the next `**Label**` header or end.
    const value: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\*\*[^*]+\*\*\s*$/.test(lines[j].trim())) break;
      value.push(lines[j]);
    }
    const text = unescape(value.join('\n')).trim();
    if (text !== '' && !isPlaceholder(text)) fields[key] = text;
    i = j - 1;
  }
  return fields;
}

/**
 * Parse a whole-prose section (V1 Scope, Assumptions, ...).
 *
 * The entire body is the value, minus any trailing placeholder. Leading and
 * trailing blank lines are dropped; internal structure is preserved verbatim.
 */
function parseProseSection(section: SectionBlock): string {
  const body = section.lines.join('\n');
  const trimmed = body.trim();
  if (trimmed === '' || isPlaceholder(trimmed)) return '';
  return unescape(trimmed);
}

/** Parse `## Repository`, which is just a link or the placeholder. */
function parseRepository(section: SectionBlock): string | null {
  const body = section.lines.join('\n').trim();
  if (body === '' || isPlaceholder(body)) return null;
  const m = /^<([^>]+)>$/.exec(body);
  return m ? m[1].trim() : body;
}

/**
 * Parse a PROJECT.md document into a normalised, validated structure.
 *
 * Never throws for content reasons: problems are reported through `errors` and
 * `warnings`. The caller decides whether `errors` should block a sync.
 */
export function parseProjectDocument(content: string): ParsedProjectDocument {
  const { frontMatter, sections, errors: fmErrors, warnings: fmWarnings } = splitDocument(content);
  const warnings = [...fmWarnings];
  const errors = [...fmErrors];

  const projectIdRaw = frontMatter?.['p-hub-project-id'] ?? null;
  let projectIdFromDocument: number | null = null;
  if (projectIdRaw != null && /^\d+$/.test(projectIdRaw.trim())) {
    projectIdFromDocument = Number(projectIdRaw.trim());
  } else if (projectIdRaw != null) {
    errors.push(`p-hub-project-id must be a whole number, found ${JSON.stringify(projectIdRaw)}.`);
  } else {
    errors.push('PROJECT.md has no p-hub-project-id, so it cannot be matched to a project.');
  }

  const versionRaw = frontMatter?.['p-hub-document-version'] ?? null;
  let documentVersion: number | null = null;
  if (versionRaw != null && /^\d+$/.test(versionRaw.trim())) {
    documentVersion = Number(versionRaw.trim());
    if (documentVersion !== PROJECT_DOCUMENT_VERSION) {
      errors.push(
        `This PROJECT.md uses document version ${documentVersion}, but this Project Hub reads version ${PROJECT_DOCUMENT_VERSION}. Open it in your editor to check it.`
      );
    }
  } else if (versionRaw != null) {
    errors.push(`p-hub-document-version must be a whole number, found ${JSON.stringify(versionRaw)}.`);
  } else {
    errors.push('PROJECT.md has no p-hub-document-version.');
  }

  const projectNameFromDocument = frontMatter?.['p-hub-project-name'] != null
    ? unquoteYamlScalar(frontMatter['p-hub-project-name'])
    : null;

  const coreFields: Record<string, string> = {};
  const proseFields: Record<string, string> = {};
  const records: Record<string, ParsedRecord[]> = {};
  const unsupportedSections: string[] = [];
  const unknownSections: string[] = [];
  let repositoryUrl: string | null = null;

  for (const section of sections) {
    if (CORE_LABEL_SECTIONS.includes(section.heading as never)) {
      Object.assign(coreFields, parseOverview(section, warnings));
    } else if ((PROSE_SECTIONS as readonly string[]).includes(section.heading)) {
      proseFields[section.heading] = parseProseSection(section);
    } else if ((RECORD_SECTIONS as readonly string[]).includes(section.heading)) {
      records[section.heading] = parseRecords(section, warnings, section.heading);
    } else if (section.heading === 'Repository') {
      repositoryUrl = parseRepository(section);
    } else if ((KNOWN_UNSUPPORTED_SECTIONS as readonly string[]).includes(section.heading)) {
      unsupportedSections.push(section.heading);
    } else {
      unknownSections.push(section.heading);
    }
  }

  return {
    metadataValid: errors.length === 0,
    projectIdFromDocument,
    documentVersion,
    projectNameFromDocument,
    coreFields,
    proseFields,
    repositoryUrl,
    records,
    unsupportedSections,
    unknownSections,
    warnings,
    errors
  };
}

export { PROJECT_DOCUMENT_FILENAME, PROJECT_DOCUMENT_VERSION };
