import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { documentError } from '../errors.js';

/**
 * Document text extraction.
 *
 * A format is only advertised as supported if it can be read reliably here.
 * Anything that cannot be parsed raises a DOCUMENT_ERROR that names the file
 * and the reason, so the UI never has to say "something went wrong".
 */

export type SupportedFormat = 'txt' | 'md' | 'json' | 'docx' | 'pdf';

export interface ParsedDocument {
  format: SupportedFormat;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Plain text used for extraction. */
  text: string;
  /** Structural hints when the source was machine-readable. */
  json?: unknown;
  /** How the text was obtained, reported to the user. */
  textSource: string;
  warnings: string[];
}

export interface FormatSupport {
  format: SupportedFormat;
  label: string;
  extensions: string[];
  mimeTypes: string[];
  reliable: boolean;
  note: string;
}

/**
 * Declared support. This is the single source of truth for what the upload UI
 * offers - a format is never shown unless this list says it can be read.
 */
export const SUPPORTED_FORMATS: FormatSupport[] = [
  {
    format: 'txt',
    label: 'Plain text',
    extensions: ['.txt', '.text'],
    mimeTypes: ['text/plain'],
    reliable: true,
    note: 'Read directly.'
  },
  {
    format: 'md',
    label: 'Markdown',
    extensions: ['.md', '.markdown', '.mdown'],
    mimeTypes: ['text/markdown', 'text/x-markdown'],
    reliable: true,
    note: 'Read directly, including heading structure.'
  },
  {
    format: 'json',
    label: 'JSON',
    extensions: ['.json'],
    mimeTypes: ['application/json', 'text/json'],
    reliable: true,
    note: 'Parsed as structure, then flattened to text for extraction.'
  },
  {
    format: 'docx',
    label: 'Word document (.docx)',
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    reliable: true,
    note: 'Text and headings extracted. Images, charts and embedded objects are ignored.'
  },
  {
    format: 'pdf',
    label: 'PDF',
    extensions: ['.pdf'],
    mimeTypes: ['application/pdf'],
    reliable: true,
    note: 'Text-layer PDFs only. A scanned or image-only PDF contains no text to read.'
  }
];

const extOf = (filename: string): string => {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
};

/** Which declared format, if any, a filename belongs to. */
export function formatForFilename(filename: string, mimeType?: string): SupportedFormat | null {
  const ext = extOf(filename);
  for (const f of SUPPORTED_FORMATS) {
    if (f.extensions.includes(ext)) return f.format;
  }
  const mt = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  for (const f of SUPPORTED_FORMATS) {
    if (f.mimeTypes.includes(mt)) return f.format;
  }
  return null;
}

/** Hard upload ceiling, enforced by both the route and the parser. */
export const MAX_BYTES = 15 * 1024 * 1024;
/**
 * Non-breaking and zero-width characters that PDF and Word text extraction
 * leave behind. Written as escapes so the intent survives any editor.
 */
const INVISIBLE_CHARS = /[\u00A0\u200B\u200C\u200D\uFEFF]/g;
const MIN_USABLE_CHARS = 40;

/** Flatten JSON to readable lines so the same extractor can read it. */
function flattenJson(value: unknown, prefix = '', out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenJson(v, prefix ? `${prefix}.${i + 1}` : String(i + 1), out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') flattenJson(v, key, out, depth + 1);
      else out.push(`${key}: ${String(v)}`);
    }
    return out;
  }
  out.push(`${prefix}: ${String(value)}`);
  return out;
}

async function fromPdf(buffer: Buffer, filename: string): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  let parser: InstanceType<typeof PDFParse> | null = null;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    const text = (result.text ?? '').replace(INVISIBLE_CHARS, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    const pages = result.pages?.length ?? 0;
    if (!text) {
      throw documentError(
        `The PDF "${filename}" has no text layer, so nothing could be read from it. ` +
          'This happens with scanned or image-only PDFs. Export a text-based PDF, or copy the text into a .md or .txt file and import that instead.',
        filename,
        'extract text from the PDF'
      );
    }
    if (pages > 0) warnings.push(`Read ${pages} page${pages === 1 ? '' : 's'} from the PDF.`);
    return { text, warnings };
  } catch (e) {
    if (e && typeof e === 'object' && (e as { category?: string }).category === 'DOCUMENT_ERROR') throw e;
    const reason = e instanceof Error ? e.message : String(e);
    throw documentError(
      `The PDF "${filename}" could not be parsed. Reason: ${reason}`,
      filename,
      'parse the PDF'
    );
  } finally {
    if (parser) await parser.destroy().catch(() => undefined);
  }
}

async function fromDocx(buffer: Buffer, filename: string): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value ?? '').trim();
    const messages = result.messages ?? [];
    if (messages.length) {
      warnings.push(
        `The Word document contained ${messages.length} formatting element(s) that were not converted to text.`
      );
    }
    return { text, warnings };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw documentError(
      `The Word document "${filename}" could not be parsed. Reason: ${reason}`,
      filename,
      'parse the .docx file'
    );
  }
}

/**
 * Turn an uploaded file into text. Raises DOCUMENT_ERROR for an unsupported
 * type, an oversized file, a corrupt file, or a file with no readable content.
 */
export async function parseDocument(file: {
  buffer: Buffer;
  filename: string;
  mimetype?: string;
  size?: number;
}): Promise<ParsedDocument> {
  const filename = file.filename || 'upload';
  const sizeBytes = file.size ?? file.buffer.length;
  const format = formatForFilename(filename, file.mimetype);

  if (!format) {
    const supported = SUPPORTED_FORMATS.flatMap(f => f.extensions).join(', ');
    throw documentError(
      `"${filename}" is not a format Project Hub can read. Supported formats: ${supported}.`,
      filename,
      'identify the document format'
    );
  }
  if (sizeBytes > MAX_BYTES) {
    throw documentError(
      `"${filename}" is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB.`,
      filename,
      'read the document'
    );
  }
  if (sizeBytes === 0) {
    throw documentError(`"${filename}" is empty, so there is nothing to read.`, filename, 'read the document');
  }

  const warnings: string[] = [];
  let text = '';
  let json: unknown;
  let textSource = '';

  if (format === 'txt' || format === 'md') {
    text = file.buffer.toString('utf8');
    textSource = format === 'md' ? 'Read as Markdown, preserving headings.' : 'Read as plain text.';
  } else if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.buffer.toString('utf8'));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw documentError(
        `"${filename}" is not valid JSON. Reason: ${reason}`,
        filename,
        'parse the JSON document'
      );
    }
    json = parsed;
    text = flattenJson(parsed).join('\n');
    textSource = 'Parsed as JSON structure, then read as field/value pairs.';
  } else if (format === 'docx') {
    const r = await fromDocx(file.buffer, filename);
    text = r.text;
    warnings.push(...r.warnings);
    textSource = 'Read the text of the Word document.';
  } else {
    const r = await fromPdf(file.buffer, filename);
    text = r.text;
    warnings.push(...r.warnings);
    textSource = 'Read the text layer of the PDF.';
  }

  text = text.replace(INVISIBLE_CHARS, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  if (text.length < MIN_USABLE_CHARS) {
    throw documentError(
      `"${filename}" produced only ${text.length} characters of readable text, which is not enough to identify any project information. ` +
        'If this is a scanned or image-only file, there is no text to read.',
      filename,
      'read usable text from the document'
    );
  }

  return {
    format,
    filename,
    mimeType: file.mimetype ?? '',
    sizeBytes,
    text,
    json,
    textSource,
    warnings
  };
}
