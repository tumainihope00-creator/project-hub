// Text normalization + overlap detection used across the generator pipeline.
// The core "no repetition" requirement is enforced here and in build.ts.

const STOPWORDS = new Set([
  'this', 'that', 'the', 'and', 'for', 'are', 'was', 'were', 'with', 'will',
  'would', 'should', 'could', 'have', 'has', 'had', 'from', 'they', 'them',
  'their', 'there', 'your', 'our', 'you', 'its', 'but', 'not', 'all', 'any',
  'can', 'may', 'its', 'into', 'upon', 'over', 'about', 'using', 'used'
]);

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Meaningful tokens (length > 2, not a stopword). */
export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/** Jaccard similarity of two token sets (0..1). */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Fraction of b's tokens present in a (0..1). */
export function containment(a: string[], b: string[]): number {
  if (b.length === 0) return 0;
  const setA = new Set(a);
  let count = 0;
  for (const t of new Set(b)) if (setA.has(t)) count++;
  return count / new Set(b).size;
}

export interface Statement {
  id: string;
  label: string;
  text: string;
}

export interface DedupeOutcome {
  kept: Statement[];
  /** id of the statement that absorbed each duplicate */
  duplicates: { absorbedBy: number; duplicate: Statement }[];
}

export function overlaps(a: string[], b: string[]): boolean {
  const j = jaccard(a, b);
  const c1 = containment(a, b);
  const c2 = containment(b, a);
  return j >= 0.55 || c1 >= 0.85 || c2 >= 0.85;
}

/**
 * Remove redundant statements. When two statements overlap, the longer (more
 * specific) one survives — the shorter claim is absorbed so the prompt does not
 * repeat the same idea in different sections.
 */
export function dedupeStatements(statements: Statement[]): DedupeOutcome {
  const kept: Statement[] = [];
  const duplicates: DedupeOutcome['duplicates'] = [];

  for (const s of statements) {
    if (!s.text.trim()) continue;
    const ta = tokenize(s.text);
    if (ta.length === 0) {
      kept.push(s);
      continue;
    }
    const idx = kept.findIndex(k => {
      const tb = tokenize(k.text);
      if (tb.length === 0) return false;
      return overlaps(ta, tb);
    });
    if (idx >= 0) {
      const current = kept[idx];
      if (s.text.length > current.text.length) {
        duplicates.push({ absorbedBy: statements.indexOf(s) + 1, duplicate: current });
        kept[idx] = s;
      } else {
        duplicates.push({ absorbedBy: statements.indexOf(current) + 1, duplicate: s });
      }
    } else {
      kept.push(s);
    }
  }

  return { kept, duplicates };
}

/** Join non-whitespace paragraphs while removing outright duplicated sentences. */
export function uniqueSentences(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (!text || !text.trim()) continue;
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)) {
      const key = normalizeText(sentence);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sentence);
    }
  }
  return out;
}