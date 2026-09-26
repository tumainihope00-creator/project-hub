import { enumCatalog, entityByPath, importableProjectFields } from './discovery.js';

/**
 * Document -> structured project information.
 *
 * This is a deterministic, local extractor. It runs entirely inside the backend
 * and calls no external service, matching the rest of Project Hub (which makes
 * no external AI calls and holds no AI credentials). Nothing here writes to the
 * database.
 *
 * The central rule is that the distinction between what the document SAYS and
 * what the extractor GUESSES is preserved all the way to the review screen:
 *
 *   explicit  - the document states it
 *   inferred  - derived from the document, and marked as a guess
 *   absent    - not found; never invented
 */

export type Provenance = 'explicit' | 'inferred';

export type Horizon = 'v1' | 'future' | 'unscoped';

export interface ExtractedField {
  /** Real Project Hub destination field, e.g. "targetUsers" */
  field: string;
  value: string;
  provenance: Provenance;
  /** Verbatim snippet from the document that justifies the value. */
  evidence: string;
  /** Rough 0-1 confidence, shown in the review UI. */
  confidence: number;
}

export interface ExtractedRecord {
  /** Project Hub entity path, e.g. "requirements" */
  entity: string;
  /** Field values keyed by the entity's real column names. */
  values: Record<string, string>;
  provenance: Provenance;
  evidence: string;
  confidence: number;
  horizon: Horizon;
  /** Set when this record repeats one already found in the same document. */
  duplicateOf?: number;
}

export interface UnsupportedFinding {
  concept: string;
  value: string;
  evidence: string;
  reason: string;
}

export interface ExtractionResult {
  /** Concept label -> real Project Hub project field. */
  projectFields: ExtractedField[];
  /** Required project fields the document did not state. Never invented. */
  missingRequired: string[];
  records: ExtractedRecord[];
  unsupported: UnsupportedFinding[];
  stats: {
    characters: number;
    lines: number;
    headings: number;
    bulletLines: number;
    listSections: number;
  };
  /** Names of the extraction rules that actually fired. */
  appliedRules: string[];
}

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

export interface Section {
  heading: string;
  level: number;
  lines: string[];
  /** Character offset in the source text, used for evidence. */
  start: number;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const SETEXT = /^(=+|-+)\s*$/;
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;

/** Split a document into sections, honouring Markdown and plain headings. */
export function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section = { heading: '(preamble)', level: 0, lines: [], start: 0 };
  let offset = 0;
  let pendingSetext = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineStart = offset;
    offset += raw.length + 1;

    const md = HEADING.exec(raw);
    if (md) {
      // Headings are kept even when they have no body: a heading with nothing
      // under it is a document title, which is the strongest name evidence.
      if (current.heading !== '(preamble)' || current.lines.length) sections.push(current);
      current = { heading: md[2].trim(), level: md[1].length, lines: [], start: lineStart };
      pendingSetext = false;
      continue;
    }

    if (SETEXT.test(raw.trim()) && pendingSetext && current.lines.length) {
      current.heading = current.lines.pop()!.trim();
      current.level = raw.trim().startsWith('=') ? 1 : 2;
      pendingSetext = false;
      continue;
    }

    // ALL-CAPS or Title-ish standalone line reads as a heading in plain text.
    if (raw.trim() && !BULLET.test(raw) && raw.trim().length <= 70) {
      const isCaps = /^[A-Z0-9][A-Z0-9 \t&/(),.\-']{2,}$/.test(raw.trim());
      if (isCaps) {
        if (current.heading !== '(preamble)' || current.lines.length) sections.push(current);
        current = { heading: raw.trim(), level: 1, lines: [], start: lineStart };
        pendingSetext = false;
        continue;
      }
      if (!raw.trim().endsWith('.') && !raw.trim().endsWith(',') && current.lines.length === 0) {
        pendingSetext = true;
        current.lines.push(raw);
        continue;
      }
      pendingSetext = false;
    } else {
      pendingSetext = false;
    }

    current.lines.push(raw);
  }
  if (current.heading !== '(preamble)' || current.lines.length) sections.push(current);
  return sections;
}

/** The document's own title: its top-level heading, if it has one. */
export function documentTitle(sections: Section[]): string | null {
  const titled = sections.filter(s => s.level > 0);
  if (titled.length === 0) return null;
  const top = Math.min(...titled.map(s => s.level));
  const first = titled.find(s => s.level === top);
  return first ? clean(first.heading) : null;
}

// ---------------------------------------------------------------------------
// Horizon: V1 vs future
// ---------------------------------------------------------------------------

const V1_HEADINGS = /\b(v\s?1|mvp|minimum viable|phase\s*1|first (?:usable )?(?:version|release)|initial release|launch|core)\b/i;
const FUTURE_HEADINGS = /\b(future|later|phase\s*[2-9]|v\s?2|next|roadmap|backlog|possible improvements|eventually|planned improvements|nice to have|if time)\b/i;

function headingHorizon(heading: string): Horizon {
  if (FUTURE_HEADINGS.test(heading)) return 'future';
  if (V1_HEADINGS.test(heading)) return 'v1';
  return 'unscoped';
}

/** A future marker anywhere in a block moves the whole block to "future". */
const FUTURE_INLINE = /\b(future|later on|phase\s*[2-9]|v\s?2|eventually|not in (?:v ?1|mvp)|out of scope|deferred|post-launch)\b/i;

const bulletItems = (lines: string[]): string[] =>
  lines
    .map(l => BULLET.exec(l)?.[1]?.trim() ?? null)
    .filter((x): x is string => Boolean(x));

/**
 * "Phase 2: ..." is future, "Phase 1: ..." is V1, wherever it appears.
 * A bare "V2" only counts at the start of a statement, so that the V1 in
 * "not in V1" is not mistaken for a phase label.
 */
const PHASE_LABELLED = /\bphase\s*([1-9])\b/i;
const PHASE_LEADING = /^\s*v\s?([1-9])\b/i;

function horizonOf(statement: string, sectionHorizon: Horizon): Horizon {
  const phase = PHASE_LABELLED.exec(statement) ?? PHASE_LEADING.exec(statement);
  if (phase) return Number(phase[1]) === 1 ? 'v1' : 'future';
  if (sectionHorizon !== 'unscoped') return sectionHorizon;
  if (FUTURE_INLINE.test(statement)) return 'future';
  if (V1_INLINE.test(statement)) return 'v1';
  return 'unscoped';
}

const V1_INLINE = /\b(?:v\s?1|mvp|in\s+scope|for\s+(?:v\s?1|the\s+first\s+release))\b/i;

// ---------------------------------------------------------------------------
// Concept vocabulary
//
// Each concept names the real Project Hub destination it maps to. The label
// patterns describe how humans write, not what the database stores.
// ---------------------------------------------------------------------------

interface FieldConcept {
  field: string;
  /** Human phrasing that signals this concept. */
  patterns: RegExp[];
  /**
   * The schema requires this field, so it may only be filled from something the
   * document actually states - it is never guessed.
   */
  required?: boolean;
}

const PROJECT_CONCEPTS: FieldConcept[] = [
  {
    field: 'name',
    required: true,
    patterns: [
      /^#\s+(.+)$/,
      /^\s*(?:project|product|app(?:lication)?|system)\s*(?:name|title)\s*[:\-–]\s*(.+)$/i,
      /^\s*name\s*[:\-–]\s*(.+)$/i,
      /^\s*(?:working\s+)?title\s*[:\-–]\s*(.+)$/i
    ]
  },
  {
    field: 'description',
    patterns: [
      /\b(?:short\s+)?(?:description|summary|overview|about|elevator\s+pitch|what\s+(?:is|does)\s+(?:this|the\s+project|the\s+app))\b/i,
      /\b(?:the\s+)?(?:project|app|application|system|product)\s+(?:is|will\s+be)\s+(?:an?|the)\b/i
    ]
  },
  {
    field: 'problem',
    patterns: [
      /\b(problem|pain\s+point|problem\s+statement|challenge|issue\s+(?:to\s+solve|being\s+solved)|the\s+problem)\b/i,
      /\b(users?|people|customers?)\s+(?:currently\s+)?(?:struggle|have\s+trouble|find\s+it\s+(?:hard|difficult)|cannot|can'?t)\b/i
    ]
  },
  {
    field: 'targetUsers',
    patterns: [
      /\b(target\s+users?|end\s+users?|audience|users?\s+(?:are|will\s+be)|who\s+(?:will\s+)?use|intended\s+(?:users?|audience)|personas?)\b/i
    ]
  },
  {
    field: 'expectedValue',
    patterns: [
      /\b(expected\s+(?:value|outcome|results?)|success\s+(?:criteria|means|looks)|goals?|objectives?|outcomes?|benefits?|value\s+proposition|definition\s+of\s+done)\b/i
    ]
  },
  {
    field: 'motivation',
    patterns: [/\b(motivation|why\s+(?:i|we|this)|inspiration|personal|driven\s+by|reason\s+for\s+building)\b/i]
  },
  {
    field: 'assumptions',
    patterns: [/\b(assumptions?|we\s+assume|assuming|given\s+that|constraints?)\b/i]
  },
  {
    field: 'initialQuestions',
    patterns: [/\b(open\s+questions?|initial\s+questions?|questions?\s+to\s+(?:answer|resolve)|unknowns?|tbd|to\s+be\s+determined)\b/i]
  },
  {
    field: 'inspiration',
    patterns: [/\b(inspired\s+by|reference|references?|based\s+on|similar\s+to|inspired\s+the\s+way)\b/i]
  },
  {
    field: 'v1Scope',
    patterns: [
      /\b(v\s?1\s+scope|scope|mvp\s+scope|minimum\s+viable|what\s+(?:must|should)\s+exist|in\s+scope|must\s+have)\b/i
    ]
  },
  {
    field: 'repositoryUrl',
    patterns: [/^\s*(?:repository|repo|source\s+code|github)\s*(?:url)?\s*[:\-–]\s*(\S+)$/i, /\bhttps?:\/\/github\.com\/[\w.\-]+\/[\w.\-]+/i]
  }
];

interface RecordConcept {
  entity: string;
  /** Section headings that indicate this entity's content. */
  headingPatterns: RegExp[];
  /** Inline sentence patterns, captured group 1 is the statement. */
  sentencePatterns: RegExp[];
  /** Field values derived from the matched statement. */
  build: (statement: string, context: string) => Record<string, string>;
  /** How to classify requirement type from the statement. */
  classifyType?: (statement: string) => string | undefined;
  classifyPriority?: (statement: string) => string | undefined;
  requiresFutureMarker?: boolean;
}

const stripBullet = (s: string) => s.replace(/^[-*+•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
const sentenceCase = (s: string) => {
  const t = stripBullet(s).trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const titleish = (s: string, max = 90) => {
  const t = sentenceCase(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const RECORD_CONCEPTS: RecordConcept[] = [
  {
    entity: 'requirements',
    headingPatterns: [
      /\b(requirements?|functional\s+requirements?|user\s+requirements?|system\s+requirements?|acceptance\s+criteria|spec(?:ification)?s?)\b/i
    ],
    sentencePatterns: [
      /\bthe\s+system\s+(?:must|shall|should|will)\s+(.{12,240}?)(?:[.;]|$)/i,
      /\b(?:must|shall)\s+be\s+able\s+to\s+(.{12,240}?)(?:[.;]|$)/i,
      /\busers?\s+(?:must|shall|should|can)\s+be\s+able\s+to\s+(.{12,240}?)(?:[.;]|$)/i,
      /\bit\s+(?:must|shall)\s+(?:be\s+possible\s+to\s+)?(?:.{12,240}?)(?:[.;]|$)/i
    ],
    build: (s) => ({ title: titleish(s), description: stripBullet(s) }),
    classifyType: (s) => {
      if (/\b(performance|fast|slow|response\s+time|throughput|scale|load|latency)\b/i.test(s)) return 'NON_FUNCTIONAL';
      if (/\b(must\s+use|shall\s+use|only\s+use|compatible\s+with|must\s+run\s+on|required\s+platform|licen[cs]e)\b/i.test(s)) {
        return 'CONSTRAINT';
      }
      return 'FUNCTIONAL';
    },
    classifyPriority: (s) => (/\b(must|critical|essential|required|shall)\b/i.test(s) ? 'HIGH' : undefined)
  },
  {
    entity: 'features',
    headingPatterns: [/\b(features?|functionality|main\s+functionality|capabilities|key\s+features?|what\s+it\s+does)\b/i],
    sentencePatterns: [
      /\b(?:feature|capability)\s*[:\-–]\s*(.{10,200}?)(?:[.;]|$)/i,
      /\ballows?\s+(?:the\s+user\s+|users?\s+|officers?\s+|staff\s+|you\s+)?to\s+(.{12,220}?)(?:[.;]|$)/i
    ],
    build: (s) => ({ name: titleish(s), description: stripBullet(s) })
  },
  {
    entity: 'tech-stack',
    headingPatterns: [/\b(tech(?:nology)?\s+stack|technologies|technology|stack|frameworks?|languages?|tools?)\b/i],
    sentencePatterns: [
      /\b(?:built|developed)\s+(?:using|with|in)\s+(.{6,160}?)(?:[.;]|$)/i,
      /\btech(?:nology)?\s+stack\s*[:\-–]\s*(.{4,160}?)(?:[.;]|$)/i
    ],
    build: (s) => ({ technology: clean(s.replace(/^(?:built|developed)\s+(?:using|with|in)\s+/i, '')) })
  },
  {
    entity: 'decisions',
    headingPatterns: [
      /\b(architecture\s+decisions?|decisions?|adrs?|design\s+decisions?|technical\s+decisions?)\b/i
    ],
    sentencePatterns: [
      /\bwe\s+(?:will\s+)?(?:use|chose|choose|decided\s+to|adopt)\s+(.{8,200}?)(?:[.;]|$)/i,
      /\bdecision\s*[:\-–]\s*(.{8,200}?)(?:[.;]|$)/i
    ],
    build: (s) => ({ title: titleish(s), decision: stripBullet(s), status: 'PROPOSED' })
  },
  {
    entity: 'database-tables',
    headingPatterns: [/\b(data\s?model|database\s+(?:schema|tables?|design)|tables?|storage\s+model|entities?)\b/i],
    sentencePatterns: [/^\s*table\s*[:\-–]?\s*([A-Za-z_][\w ]*?)(?:\s+[-(]|\s*$)/i],
    build: (s) => ({ name: titleish(s, 60) })
  },
  {
    entity: 'api-endpoints',
    headingPatterns: [/\b(api\s+(?:endpoints?|specification|reference)|endpoints?|routes?|rest\s+api)\b/i],
    sentencePatterns: [/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9\/_\-{}:.]*)/g],
    build: () => ({})
  },
  {
    entity: 'research',
    headingPatterns: [/\b(research|findings|literature|market\s+research|background|investigation|competitor\s+analysis)\b/i],
    sentencePatterns: [],
    build: (s, ctx) => ({ title: titleish(s, 120), summary: ctx.slice(0, 600) })
  },
  {
    entity: 'research-questions',
    headingPatterns: [/\b(research\s+questions?|open\s+questions?|questions?)\b/i],
    sentencePatterns: [],
    build: (s) => ({ question: sentenceCase(s) })
  },
  {
    entity: 'milestones',
    headingPatterns: [/\b(milestones?|phases?|roadmap|release\s+plan|iterations?|sprints?)\b/i],
    sentencePatterns: [],
    build: (s) => ({ name: titleish(s, 80), status: 'PLANNED' })
  },
  {
    entity: 'tasks',
    headingPatterns: [/\b(tasks?|action\s+items?|to-?do|implementation\s+plan|backlog)\b/i],
    sentencePatterns: [],
    build: (s) => ({ title: titleish(s, 100), status: 'TODO' })
  },
  {
    entity: 'issues',
    headingPatterns: [/\b(known\s+issues?|bugs?|problems?|limitations?)\b/i],
    sentencePatterns: [],
    build: (s) => ({ title: titleish(s, 100), status: 'OPEN' })
  },
  {
    entity: 'notes',
    headingPatterns: [/\b(notes?|additional\s+information|context|background\s+notes)\b/i],
    sentencePatterns: [],
    build: (s) => ({ title: titleish(s, 100), content: s })
  }
];

/**
 * The child entities this extractor can ever produce. The create endpoint takes
 * a client-supplied draft, so this list is also the allowlist: it stops a
 * hand-crafted draft from writing entities the importer never extracts, such as
 * an Attachment with a storagePath that points at a file nothing uploaded.
 */
export const EXTRACTABLE_ENTITIES: readonly string[] = RECORD_CONCEPTS.map(c => c.entity);

/**
 * Concepts the extractor can see in a document but that Project Hub has no
 * existing structure for. Reported, never silently dropped and never used to
 * invent a new table or field.
 */
const UNSUPPORTED_CONCEPTS: { concept: string; patterns: RegExp[]; reason: string }[] = [
  {
    concept: 'Budget / cost',
    patterns: [/\b(budget|estimated\s+cost|cost\s+estimate|licen[cs]ing\s+cost|price|pricing)\b/i],
    reason: 'Project Hub has no cost, budget or pricing field on any model.'
  },
  {
    concept: 'Timeline / schedule',
    patterns: [/\b(timeline|schedule|deadline|delivery\s+date|launch\s+date|estimated\s+duration|workload\s+estimate)\b/i],
    reason:
      'Project Hub has no project-level schedule field. Milestone.targetDate and Task.dueDate are per-record and are not derived from prose dates.'
  },
  {
    concept: 'Team / people',
    patterns: [/\b(our\s+team|the\s+team|developers?|engineers?|stakeholders?|roles?\s+and\s+responsibilit)/i],
    reason: 'Project Hub has no team, user or people entity.'
  },
  {
    concept: 'Non-functional quality attributes',
    patterns: [/\b(accessibility|wcag|a11y|compliance|gdpr|hipaa|regulatory|privacy\s+policy|security\s+certification)\b/i],
    reason:
      'No dedicated field exists. Requirement.type = NON_FUNCTIONAL is the closest existing structure and is used only for statements captured as requirements.'
  },
  {
    concept: 'UI / design specification',
    patterns: [/\b(wireframe|mockup|design\s+system|colour\s+scheme|color\s+scheme|typography|spacing\s+scale|figma)\b/i],
    reason: 'Project Hub stores no design or UI specification entity.'
  },
  {
    concept: 'Test plan',
    patterns: [/\b(test\s+plan|test\s+cases?|testing\s+strategy|acceptance\s+tests?)\b/i],
    reason: 'Project Hub has Issue records for defects but no test-plan or test-case entity.'
  }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clean = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s:>\-–—*•]+/, '')
    .replace(/[\s:;,.!?]+$/, '')
    .trim();

/** Normalised form used for duplicate detection inside one document. */
const fingerprint = (s: string): string => {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'be',
    'can', 'will', 'shall', 'must', 'should', 'user', 'users', 'system', 'allow', 'allows',
    'able', 'it', 'this', 'that', 'by', 'from', 'at', 'as', 'its', 'let', 'need', 'want'
  ]);
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stop.has(w))
    .sort()
    .join(' ');
};

const tokenSet = (s: string): Set<string> => new Set(fingerprint(s).split(' ').filter(Boolean));

/** Token-overlap similarity, so "add expense" and "adding an expense" collapse. */
function similarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

const DUP_THRESHOLD = 0.82;
/**
 * A shorter phrasing fully contained in a longer one is the same requirement
 * written twice ("let staff register a laptop" / "staff must be able to register
 * a laptop"). Jaccard alone misses that, so containment counts too - but only
 * when at least three meaningful words are shared, so two short items with one
 * word in common are never merged.
 */
const CONTAIN_THRESHOLD = 0.9;
const CONTAIN_MIN_TOKENS = 3;

function isDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  if (similarity(a, b) >= DUP_THRESHOLD) return true;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  const smallest = Math.min(ta.size, tb.size);
  if (smallest < CONTAIN_MIN_TOKENS) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / smallest >= CONTAIN_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Enum helpers - values are validated against the real schema
// ---------------------------------------------------------------------------

const enums = enumCatalog();

/** Only ever return a value the schema actually declares. */
function safeEnum(enumName: string, candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const allowed = enums[enumName];
  if (!allowed) return undefined;
  const up = candidate.toUpperCase();
  return allowed.includes(up) ? up : undefined;
}

const TECH_CATEGORY_HINTS: { pattern: RegExp; category: string }[] = [
  { pattern: /\b(react|vue|angular|svelte|next\.?js|html|css|tailwind|bootstrap|sveltekit)\b/i, category: 'FRONTEND' },
  { pattern: /\b(node|express|nest|fastify|django|flask|rails|spring|laravel|asp\.?net|\.net|java|golang|gin|php)\b/i, category: 'BACKEND' },
  { pattern: /\b(postgres|postgresql|mysql|mariadb|sqlite|mongodb|mongo|redis|firebase|supabase|oracle|sql\s*server|prisma)\b/i, category: 'DATABASE' },
  { pattern: /\b(vercel|netlify|aws|azure|gcp|heroku|docker|kubernetes|cloudflare|railway|fly\.?io|hosting)\b/i, category: 'HOSTING' }
];

const RESEARCH_TYPE_HINTS: { pattern: RegExp; type: string }[] = [
  { pattern: /\b(security|vulnerab|threat|attack)\b/i, type: 'SECURITY' },
  { pattern: /\b(competitor|alternative|comparison|versus|vs\.?)\b/i, type: 'COMPETITOR' },
  { pattern: /\b(market|audience\s+size|pricing\s+survey|segment)\b/i, type: 'MARKET' },
  { pattern: /\b(architecture|design\s+pattern|system\s+design)\b/i, type: 'ARCHITECTURE' },
  { pattern: /\b(framework|library|version|api\s+support|compatib)/i, type: 'TECHNOLOGY' },
  { pattern: /\b(paper|study|journal|academic|citation|et\s+al)\b/i, type: 'ACADEMIC' },
  { pattern: /\b(law|legal|licen[cs]e|regulation|gdpr|compliance)\b/i, type: 'LEGAL' },
  { pattern: /\b(user|persona|interview|survey|feedback)\b/i, type: 'USER' },
  { pattern: /\b(library|api|sdk|database|protocol|implementation)\b/i, type: 'TECHNICAL' }
];

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  filename: string;
  text: string;
}

export function extractDocument(doc: ExtractOptions): ExtractionResult {
  const { text } = doc;
  const sections = splitSections(text);
  const applied = new Set<string>();
  const projectFields = new Map<string, ExtractedField>();
  const records: ExtractedRecord[] = [];
  const unsupported: UnsupportedFinding[] = [];
  const seenUnsupported = new Set<string>();

  const importable = new Set(importableProjectFields().map(f => f.name));

  // --- Project fields ------------------------------------------------------
  for (const concept of PROJECT_CONCEPTS) {
    if (!importable.has(concept.field)) continue; // never target a field the DB lacks
    let best: ExtractedField | null = null;

    for (const section of sections) {
      // A field may be named by its own heading, or found inside prose.
      const headingHit = concept.patterns.find(p => p.test(section.heading));
      for (const pattern of concept.patterns) {
        // Heading-as-label: the section's own content is the value.
        if (pattern.test(section.heading) && section.lines.length) {
          const body = clean(section.lines.join(' '));
          if (body.length >= 8) {
            const viaHeading = concept.field === 'name' ? 0.95 : 0.8;
            if (!best || viaHeading > best.confidence) {
              best = { field: concept.field, value: body, provenance: 'explicit', evidence: section.heading, confidence: viaHeading };
            }
            applied.add(`field:${concept.field}`);
            continue;
          }
        }
        // Inline: "Problem: ..." or "The system must ..."
        for (const raw of section.lines) {
          const m = pattern.exec(raw);
          const captured = m?.[1] ? clean(m[1]) : null;
          if (captured && captured.length >= 4) {
            const conf = headingHit ? 0.85 : 0.7;
            if (!best || conf > best.confidence) {
              best = { field: concept.field, value: captured, provenance: 'explicit', evidence: clean(raw).slice(0, 200), confidence: conf };
            }
            applied.add(`field:${concept.field}`);
          }
        }
      }
      if (best) break;
    }
    if (best) projectFields.set(concept.field, best);
  }

  // A document title is an explicit project name only if nothing else claimed it.
  if (!projectFields.has('name')) {
    const title = documentTitle(sections);
    if (title && title.length >= 2) {
      projectFields.set('name', {
        field: 'name',
        value: title.slice(0, 120),
        provenance: 'explicit',
        evidence: 'Document title',
        confidence: 0.7
      });
      applied.add('field:name-from-title');
    }
  }

  // --- Child records -------------------------------------------------------
  for (const concept of RECORD_CONCEPTS) {
    const entity = entityByPath(concept.entity);
    if (!entity) continue; // the schema has no such structure
    const writable = new Set(entity.fields.map(f => f.name));

    for (const section of sections) {
      const headingMatched = concept.headingPatterns.some(p => p.test(section.heading));
      const sectionHorizon = headingHorizon(section.heading);

      // Bullet lists under a matching heading are the strongest signal.
      const bullets = bulletItems(section.lines);
      if (headingMatched && bullets.length) {
        applied.add(`records:${concept.entity}`);
        for (const item of bullets) {
          pushRecord(records, concept, entity.path, item, section, sectionHorizon, writable, applied);
        }
        // The heading's own prose is context, not another record.
        continue;
      }

      // Prose: one record per matching sentence.
      if (headingMatched || concept.sentencePatterns.length) {
        const blob = section.lines.join('\n');
        for (const pattern of concept.sentencePatterns) {
          if (pattern.global) {
            pattern.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(blob)) !== null) {
              const statement = clean(m[1] ?? m[0]);
              if (statement.length >= 10) {
                applied.add(`records:${concept.entity}`);
                pushRecord(records, concept, entity.path, statement, section, sectionHorizon, writable, applied);
              }
            }
            continue;
          }
          const m = pattern.exec(blob);
          if (!m) continue;
          const statement = clean(m[1] ?? m[0]);
          if (statement.length < 10) continue;
          // Only accept an inline match with heading support, unless the pattern
          // is strong enough to stand alone (requirements, API routes).
          const standalone = /must|shall|allows?|GET|POST|PUT|PATCH|DELETE/i.test(pattern.source);
          if (!headingMatched && !standalone) continue;
          applied.add(`records:${concept.entity}`);
          pushRecord(records, concept, entity.path, statement, section, sectionHorizon, writable, applied);
        }
      }

      // Notes: capture the prose itself, not each line.
      if (headingMatched && concept.entity === 'notes' && section.lines.length) {
        const body = clean(section.lines.join(' '));
        if (body.length >= 30) {
          applied.add('records:notes');
          pushRecord(records, concept, entity.path, body, section, sectionHorizon, writable, applied);
        }
      }
    }
  }

  // --- Unsupported concepts ----------------------------------------------
  for (const u of UNSUPPORTED_CONCEPTS) {
    for (const section of sections) {
      for (const raw of [section.heading, ...section.lines]) {
        if (!u.patterns.some(p => p.test(raw))) continue;
        const key = `${u.concept}::${clean(raw).slice(0, 40)}`;
        if (seenUnsupported.has(key)) continue;
        seenUnsupported.add(key);
        unsupported.push({ concept: u.concept, value: clean(raw).slice(0, 200), evidence: section.heading, reason: u.reason });
        break;
      }
    }
  }

  // --- Deduplicate within the document ------------------------------------
  dedupeRecords(records);

  // --- V1 scope prefers v1-horizon features -------------------------------
  refineV1Scope(projectFields, records);

  const headings = sections.filter(s => s.level > 0).length;
  return {
    projectFields: [...projectFields.values()],
    missingRequired: PROJECT_CONCEPTS.filter(c => c.required && !projectFields.has(c.field)).map(c => c.field),
    records,
    unsupported,
    stats: {
      characters: text.length,
      lines: text.split(/\r?\n/).length,
      headings,
      bulletLines: sections.reduce((n, s) => n + bulletItems(s.lines).length, 0),
      listSections: sections.filter(s => bulletItems(s.lines).length > 0).length
    },
    appliedRules: [...applied].sort()
  };
}

/** Build one record, dropping any value the schema cannot accept. */
function pushRecord(
  out: ExtractedRecord[],
  concept: RecordConcept,
  entity: string,
  statement: string,
  section: Section,
  sectionHorizon: Horizon,
  writable: Set<string>,
  applied: Set<string>
): void {
  if (FUTURE_INLINE.test(statement) && V1_HEADINGS.test(section.heading)) return; // contradicts its own section
  const horizon = horizonOf(statement, sectionHorizon);

  const built = concept.build(statement, section.lines.join(' ').trim());
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(built)) {
    if (!writable.has(k)) continue; // schema has no such column
    const trimmed = typeof v === 'string' ? v.trim() : String(v);
    if (trimmed) values[k] = trimmed;
  }

  // Entity-specific enrichment, always validated against real enum values.
  if (entity === 'requirements') {
    const t = safeEnum('RequirementType', concept.classifyType?.(statement));
    if (t) values.type = t;
    const p = safeEnum('Priority', concept.classifyPriority?.(statement));
    if (p) values.priority = p;
  }
  if (entity === 'tech-stack' && !values.category) {
    for (const h of TECH_CATEGORY_HINTS) {
      if (h.pattern.test(statement)) {
        const c = safeEnum('TechCategory', h.category);
        if (c) {
          values.category = c;
          break;
        }
      }
    }
    if (!values.category) {
      const c = safeEnum('TechCategory', 'OTHER');
      if (c) values.category = c;
    }
  }
  if (entity === 'research' && !values.type) {
    for (const h of RESEARCH_TYPE_HINTS) {
      if (h.pattern.test(statement)) {
        const t = safeEnum('ResearchType', h.type);
        if (t) {
          values.type = t;
          break;
        }
      }
    }
  }
  if (entity === 'milestones' && !values.status) {
    const s = safeEnum('MilestoneStatus', 'PLANNED');
    if (s) values.status = s;
  }
  if (entity === 'tasks' && !values.status) {
    const s = safeEnum('TaskStatus', 'TODO');
    if (s) values.status = s;
  }
  if (entity === 'issues' && !values.status) {
    const s = safeEnum('IssueStatus', 'OPEN');
    if (s) values.status = s;
  }
  if (entity === 'decisions' && !values.status) {
    const s = safeEnum('ADRStatus', 'PROPOSED');
    if (s) values.status = s;
  }
  if (entity === 'api-endpoints' && !values.method && !values.path) {
    const m = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9\/_\-{}:.]*)/i.exec(statement);
    if (m) {
      values.method = m[1].toUpperCase();
      values.path = m[2];
      // "GET /api/laptops" carries no description beyond the route itself.
      const redundant = clean(statement).toLowerCase() === `${values.method} ${values.path}`.toLowerCase();
      if (redundant) delete values.description;
    }
  }

  // A record with no writable, non-empty value is not a record.
  if (Object.keys(values).length === 0) return;

  out.push({
    entity,
    values,
    provenance: 'explicit',
    evidence: clean(statement).slice(0, 240),
    confidence: sectionHorizon === 'unscoped' ? 0.65 : 0.8,
    horizon
  });
  void applied;
}

/** Collapse repeats inside the uploaded document only. */
function dedupeRecords(records: ExtractedRecord[]): void {
  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    if (a.duplicateOf) continue;
    const aText = primaryText(a);
    for (let j = i + 1; j < records.length; j++) {
      const b = records[j];
      if (b.duplicateOf || b.entity !== a.entity || b.horizon !== a.horizon) continue;
      const bText = primaryText(b);
      if (!aText || !bText) continue;
      if (isDuplicate(aText, bText)) {
        b.duplicateOf = i;
      }
    }
  }
}

const primaryText = (r: ExtractedRecord): string =>
  r.values.title ?? r.values.name ?? r.values.question ?? r.values.technology ?? r.values.decision ?? r.values.content ?? '';

/**
 * V1 scope is only auto-filled from things the document actually places in V1.
 * Feature/requirement titles are joined so the scope reflects the document's
 * own prioritisation rather than everything that was mentioned.
 */
function refineV1Scope(fields: Map<string, ExtractedField>, records: ExtractedRecord[]): void {
  const v1Titles = records
    .filter(r => r.horizon === 'v1' && !r.duplicateOf)
    .map(r => r.values.title ?? r.values.name ?? '')
    .filter(Boolean);
  const futureTitles = records
    .filter(r => r.horizon === 'future' && !r.duplicateOf)
    .map(r => r.values.title ?? r.values.name ?? '')
    .filter(Boolean);

  const existing = fields.get('v1Scope');
  if (!existing) {
    if (v1Titles.length >= 1) {
      fields.set('v1Scope', {
        field: 'v1Scope',
        value: `Includes: ${v1Titles.join('; ')}.`,
        provenance: 'inferred',
        evidence: 'Derived from items the document places in V1 / MVP / Phase 1.',
        confidence: 0.55
      });
    }
    return;
  }

  // Append the explicit "out of scope" note the document itself provides.
  if (futureTitles.length >= 1 && !/out of scope|later|future|excluded/i.test(existing.value)) {
    fields.set('v1Scope', {
      ...existing,
      value: `${existing.value} Explicitly deferred: ${futureTitles.join('; ')}.`
    });
  }
}
