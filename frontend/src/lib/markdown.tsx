import { createElement, type ReactNode } from 'react';

/**
 * A deliberately small Markdown renderer for PROJECT.md.
 *
 * Why not a Markdown library: the only thing rendered here is a document Project
 * Hub generated itself, so it needs front matter, headings, paragraphs, lists,
 * block quotes, code, and links. That is a small enough grammar to handle
 * directly, and handling it directly is what makes the security story simple.
 *
 * Why not `dangerouslySetInnerHTML`: the file on disk is editable by the user and
 * may contain raw HTML, and PROJECT.md is read back for display only. Building
 * React elements means every piece of text reaches the DOM as a text node. There
 * is no path from the file's contents to `innerHTML`, so a `<script>` tag or an
 * `onerror=` attribute in the document renders as visible characters instead of
 * executing.
 *
 * Anything not understood is shown as text. A renderer that silently drops what
 * it cannot parse is worse than one that shows it plainly.
 *
 * The grammar is a subset of CommonMark, not CommonMark: tables, nested block
 * structure, reference links, and raw HTML are not supported on purpose.
 */

const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Only `http`, `https` and `mailto` links become clickable. `javascript:` and
 * `data:` URLs are rendered as plain text, which is why this is an allowlist
 * rather than a blocklist of the schemes that are known to be dangerous.
 */
function linkTarget(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_LINK.test(trimmed) ? trimmed : null;
}

/** Resolve `**bold**`, `*italic*`, `` `code` ``, `[label](href)` and `<url>`. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // The autolink branch only matches an http, https or mailto scheme, so an HTML
  // tag such as `<img onerror=...>` never matches and is left as text.
  const pattern =
    /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(<(https?:\/\/|mailto:)[^>\s]+>)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;

    if (token.startsWith('**')) {
      nodes.push(createElement('strong', { key }, token.slice(2, -2)));
    } else if (token.startsWith('`')) {
      nodes.push(createElement('code', { key, className: 'md-code' }, token.slice(1, -1)));
    } else if (token.startsWith('<')) {
      // Autolink, as written by the generator for repository and deployment URLs.
      const href = token.slice(1, -1);
      const target = linkTarget(href);
      if (target) {
        nodes.push(
          createElement(
            'a',
            { key, href: target, target: '_blank', rel: 'noopener noreferrer nofollow' },
            target
          )
        );
      } else {
        nodes.push(createElement('span', { key, className: 'md-unsafe-link' }, token));
      }
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
      const target = link ? linkTarget(link[2]) : null;
      if (link && target) {
        nodes.push(
          createElement('a', { key, href: target, target: '_blank', rel: 'noopener noreferrer nofollow' }, link[1])
        );
      } else {
        // Unsafe or malformed scheme: show exactly what was in the file.
        nodes.push(createElement('span', { key, className: 'md-unsafe-link' }, token));
      }
    } else {
      nodes.push(createElement('em', { key }, token.slice(1, -1)));
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Cursor = { lines: string[]; i: number; key: number };

function nextKey(state: Cursor): string {
  return `md-${state.key++}`;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+/;
const QUOTE = /^\s*>/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const STARTS_BLOCK = /^(#{1,6}\s|>\s?|\s*[-*+]\s|```|~~~)/;

/** Render the block grammar over `content`, starting at `state.i`. */
function renderBlocks(state: Cursor, out: ReactNode[]): void {
  const { lines } = state;

  while (state.i < lines.length) {
    const line = lines[state.i];

    if (line.trim() === '') {
      state.i += 1;
      continue;
    }

    // Fenced code: the contents are shown verbatim and never parsed.
    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3);
      const body: string[] = [];
      state.i += 1;
      while (state.i < lines.length && !lines[state.i].trim().startsWith(fence)) {
        body.push(lines[state.i]);
        state.i += 1;
      }
      state.i += 1;
      out.push(
        createElement(
          'pre',
          { key: nextKey(state), className: 'md-pre' },
          createElement('code', null, body.join('\n'))
        )
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // The document's own H1 is the first heading, so `#` maps to <h2> and the
      // page keeps a single top-level heading.
      const level = Math.min(heading[1].length + 1, 6);
      out.push(
        createElement(
          `h${level}` as 'h2',
          { key: nextKey(state), className: 'md-h' },
          inline(heading[2], `h${state.key}`)
        )
      );
      state.i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push(createElement('hr', { key: nextKey(state), className: 'md-hr' }));
      state.i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (state.i < lines.length && QUOTE.test(lines[state.i])) {
        quoted.push(lines[state.i].replace(/^\s*>\s?/, ''));
        state.i += 1;
      }
      const inner: ReactNode[] = [];
      renderBlocks({ lines: quoted, i: 0, key: state.key }, inner);
      state.key += 1000; // keep nested keys from colliding with the outer ones
      out.push(createElement('blockquote', { key: nextKey(state), className: 'md-quote' }, inner));
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (state.i < lines.length) {
        const current = lines[state.i];
        if (BULLET.test(current)) {
          items.push(current.replace(BULLET, ''));
          state.i += 1;
        } else if (current.trim() === '') {
          // A blank line only continues the list when an indented line follows.
          const following = lines[state.i + 1];
          if (following && /^\s{2,}\S/.test(following)) {
            items.push('');
            state.i += 1;
          } else {
            break;
          }
        } else if (/^\s{2,}\S/.test(current)) {
          // An indented line continues the bullet above it.
          items[items.length - 1] += `\n${current.replace(/^\s{2,}/, '')}`;
          state.i += 1;
        } else {
          break;
        }
      }
      out.push(
        createElement(
          'ul',
          { key: nextKey(state), className: 'md-list' },
          items.map((item, index) => {
            const itemKey = `li-${nextKey(state)}-${index}`;
            const [first, ...rest] = item.split('\n');
            return createElement(
              'li',
              { key: itemKey, className: 'md-item' },
              createElement('span', { className: 'md-item-main' }, inline(first, `${itemKey}-m`)),
              ...rest.map((sub, s) =>
                createElement(
                  'span',
                  { key: `${itemKey}-s${s}`, className: 'md-item-sub' },
                  inline(sub, `${itemKey}-s${s}`)
                )
              )
            );
          })
        )
      );
      continue;
    }

    // Paragraph.
    const paragraph: string[] = [];
    while (
      state.i < lines.length &&
      lines[state.i].trim() !== '' &&
      !STARTS_BLOCK.test(lines[state.i]) &&
      !RULE.test(lines[state.i])
    ) {
      paragraph.push(lines[state.i].replace(/^\s{2,}/, ''));
      state.i += 1;
    }
    if (paragraph.length) {
      out.push(
        createElement(
          'p',
          { key: nextKey(state), className: 'md-p' },
          inline(paragraph.join('\n'), `p${state.key}`)
        )
      );
    } else {
      state.i += 1;
    }
  }
}

export interface MarkdownProps {
  content: string;
  className?: string;
}

/**
 * Render markdown to React elements.
 *
 * Front matter is skipped: it is machine metadata, and showing it to the user
 * would be noise. The rest is rendered block by block.
 */
export function Markdown({ content, className }: MarkdownProps) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const state: Cursor = { lines, i: 0, key: 0 };

  // Skip the YAML front matter block, if there is one.
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close > 0) state.i = close + 1;
  }

  const blocks: ReactNode[] = [];
  renderBlocks(state, blocks);

  return createElement('div', { className: className ? `markdown ${className}` : 'markdown' }, blocks);
}
