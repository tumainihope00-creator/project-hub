import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { Markdown } from './src/lib/markdown';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
}

const real = readFileSync(process.argv[2], 'utf8');
// 1. A real generated document renders structure, not one giant text blob.
const html = renderToStaticMarkup(<Markdown content={real} />);
// The page already owns the <h2> level ("Workspace", "Project document"), so the
// document's own `##` sections are rendered one level down as <h3>.
check('renders headings as elements', (html.match(/<h3 class="md-h">/g) ?? []).length >= 20, `${(html.match(/<h3/g) ?? []).length} h3 tags`);
check('renders the single h1 as h2', (html.match(/<h2 class="md-h">/g) ?? []).length === 1);
check('renders lists', html.includes('<ul class="md-list">'));
check('renders the block quote', html.includes('<blockquote class="md-quote">'));
check('skips front matter', !html.includes('p-hub-document-version'));
check('shows the project name', html.includes(process.env.EXPECT_NAME ?? 'Project Hub'));
// Only sample-a.md carries a URL; sample-b.md has none.
if (/<https?:\/\//.test(real)) {
  check('renders an autolink as an anchor', /<a href="https:\/\/[^"]+"[^>]*rel="noopener noreferrer nofollow"/.test(html));
}
check('does not escape the document as a code blob', !html.includes('&lt;h1&gt;'));
check('sub-bullet attributes render', html.includes('md-item-sub'));

// 2. The document is user-editable on disk, so it is untrusted input.
const hostile = [
  '# Title',
  '',
  '<script>window.__pwned = true;</script>',
  '',
  '<img src=x onerror="window.__pwned2 = true">',
  '',
  '[click me](javascript:window.__pwned3=true)',
  '',
  '[real](https://example.com/ok)',
  '',
  '- item with <b>html</b> in it',
  '',
  '```',
  '<script>inside code fence</script>',
  '```'
].join('\n');
const hostileHtml = renderToStaticMarkup(<Markdown content={hostile} />);

check('no script tag is created from content', !/<script/i.test(hostileHtml), hostileHtml.slice(0, 120));
check('script text is shown escaped, not executed', hostileHtml.includes('&lt;script&gt;'));
check('no img tag is created from content', !/<img/i.test(hostileHtml));
// The dangerous text is still present, escaped, which is the point: it is shown,
// not executed. What must not exist is a real element or a real attribute.
check('img markup is escaped rather than dropped', hostileHtml.includes('&lt;img'));
check('no real onerror attribute exists', !/<[^>]*\son\w+\s*=/i.test(hostileHtml));
check('javascript: link is not a live anchor', !/href="javascript:/i.test(hostileHtml));
check('javascript: link is shown as plain text', hostileHtml.includes('md-unsafe-link'));
check('https link still works', hostileHtml.includes('href="https://example.com/ok"'));
check('html inside a list item is escaped', hostileHtml.includes('&lt;b&gt;html&lt;/b&gt;'));
check('code fence content is escaped', hostileHtml.includes('&lt;script&gt;inside code fence&lt;/script&gt;'));

// 3. Malformed input must not throw.
for (const input of ['', '   ', '---', '---\n---', '#', '- ', '```', '>', '| a | b |', '[x](']) {
  try {
    renderToStaticMarkup(<Markdown content={input} />);
  } catch (e) {
    check(`does not throw on ${JSON.stringify(input)}`, false, String(e));
  }
}
check('survives malformed input', true);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
