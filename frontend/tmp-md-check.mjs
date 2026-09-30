// tmp-md-check.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

// src/lib/markdown.tsx
import { createElement } from "react";
var SAFE_LINK = /^(https?:|mailto:)/i;
function linkTarget(href) {
  const trimmed = href.trim();
  return SAFE_LINK.test(trimmed) ? trimmed : null;
}
function inline(text, keyPrefix) {
  const nodes = [];
  const pattern = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(<(https?:\/\/|mailto:)[^>\s]+>)/g;
  let last = 0;
  let match;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) {
      nodes.push(createElement("strong", { key }, token.slice(2, -2)));
    } else if (token.startsWith("`")) {
      nodes.push(createElement("code", { key, className: "md-code" }, token.slice(1, -1)));
    } else if (token.startsWith("<")) {
      const href = token.slice(1, -1);
      const target = linkTarget(href);
      if (target) {
        nodes.push(
          createElement(
            "a",
            { key, href: target, target: "_blank", rel: "noopener noreferrer nofollow" },
            target
          )
        );
      } else {
        nodes.push(createElement("span", { key, className: "md-unsafe-link" }, token));
      }
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
      const target = link ? linkTarget(link[2]) : null;
      if (link && target) {
        nodes.push(
          createElement("a", { key, href: target, target: "_blank", rel: "noopener noreferrer nofollow" }, link[1])
        );
      } else {
        nodes.push(createElement("span", { key, className: "md-unsafe-link" }, token));
      }
    } else {
      nodes.push(createElement("em", { key }, token.slice(1, -1)));
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
function nextKey(state) {
  return `md-${state.key++}`;
}
var HEADING = /^(#{1,6})\s+(.*)$/;
var BULLET = /^\s*[-*+]\s+/;
var QUOTE = /^\s*>/;
var FENCE = /^\s*(```|~~~)/;
var RULE = /^\s*([-*_])\1{2,}\s*$/;
var STARTS_BLOCK = /^(#{1,6}\s|>\s?|\s*[-*+]\s|```|~~~)/;
function renderBlocks(state, out) {
  const { lines } = state;
  while (state.i < lines.length) {
    const line = lines[state.i];
    if (line.trim() === "") {
      state.i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3);
      const body = [];
      state.i += 1;
      while (state.i < lines.length && !lines[state.i].trim().startsWith(fence)) {
        body.push(lines[state.i]);
        state.i += 1;
      }
      state.i += 1;
      out.push(
        createElement(
          "pre",
          { key: nextKey(state), className: "md-pre" },
          createElement("code", null, body.join("\n"))
        )
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      out.push(
        createElement(
          `h${level}`,
          { key: nextKey(state), className: "md-h" },
          inline(heading[2], `h${state.key}`)
        )
      );
      state.i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push(createElement("hr", { key: nextKey(state), className: "md-hr" }));
      state.i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (state.i < lines.length && QUOTE.test(lines[state.i])) {
        quoted.push(lines[state.i].replace(/^\s*>\s?/, ""));
        state.i += 1;
      }
      const inner = [];
      renderBlocks({ lines: quoted, i: 0, key: state.key }, inner);
      state.key += 1e3;
      out.push(createElement("blockquote", { key: nextKey(state), className: "md-quote" }, inner));
      continue;
    }
    if (BULLET.test(line)) {
      const items = [];
      while (state.i < lines.length) {
        const current = lines[state.i];
        if (BULLET.test(current)) {
          items.push(current.replace(BULLET, ""));
          state.i += 1;
        } else if (current.trim() === "") {
          const following = lines[state.i + 1];
          if (following && /^\s{2,}\S/.test(following)) {
            items.push("");
            state.i += 1;
          } else {
            break;
          }
        } else if (/^\s{2,}\S/.test(current)) {
          items[items.length - 1] += `
${current.replace(/^\s{2,}/, "")}`;
          state.i += 1;
        } else {
          break;
        }
      }
      out.push(
        createElement(
          "ul",
          { key: nextKey(state), className: "md-list" },
          items.map((item, index) => {
            const itemKey = `li-${nextKey(state)}-${index}`;
            const [first, ...rest] = item.split("\n");
            return createElement(
              "li",
              { key: itemKey, className: "md-item" },
              createElement("span", { className: "md-item-main" }, inline(first, `${itemKey}-m`)),
              ...rest.map(
                (sub, s) => createElement(
                  "span",
                  { key: `${itemKey}-s${s}`, className: "md-item-sub" },
                  inline(sub, `${itemKey}-s${s}`)
                )
              )
            );
          })
        )
      );
      continue;
    }
    const paragraph = [];
    while (state.i < lines.length && lines[state.i].trim() !== "" && !STARTS_BLOCK.test(lines[state.i]) && !RULE.test(lines[state.i])) {
      paragraph.push(lines[state.i].replace(/^\s{2,}/, ""));
      state.i += 1;
    }
    if (paragraph.length) {
      out.push(
        createElement(
          "p",
          { key: nextKey(state), className: "md-p" },
          inline(paragraph.join("\n"), `p${state.key}`)
        )
      );
    } else {
      state.i += 1;
    }
  }
}
function Markdown({ content, className }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const state = { lines, i: 0, key: 0 };
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close > 0) state.i = close + 1;
  }
  const blocks = [];
  renderBlocks(state, blocks);
  return createElement("div", { className: className ? `markdown ${className}` : "markdown" }, blocks);
}

// tmp-md-check.tsx
import { jsx } from "react/jsx-runtime";
var failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " :: " + detail : ""}`);
}
var real = readFileSync(process.argv[2], "utf8");
var html = renderToStaticMarkup(/* @__PURE__ */ jsx(Markdown, { content: real }));
check("renders headings as elements", (html.match(/<h3 class="md-h">/g) ?? []).length >= 20, `${(html.match(/<h3/g) ?? []).length} h3 tags`);
check("renders the single h1 as h2", (html.match(/<h2 class="md-h">/g) ?? []).length === 1);
check("renders lists", html.includes('<ul class="md-list">'));
check("renders the block quote", html.includes('<blockquote class="md-quote">'));
check("skips front matter", !html.includes("p-hub-document-version"));
check("shows the project name", html.includes(process.env.EXPECT_NAME ?? "Project Hub"));
if (/<https?:\/\//.test(real)) {
  check("renders an autolink as an anchor", /<a href="https:\/\/[^"]+"[^>]*rel="noopener noreferrer nofollow"/.test(html));
}
check("does not escape the document as a code blob", !html.includes("&lt;h1&gt;"));
check("sub-bullet attributes render", html.includes("md-item-sub"));
var hostile = [
  "# Title",
  "",
  "<script>window.__pwned = true;</script>",
  "",
  '<img src=x onerror="window.__pwned2 = true">',
  "",
  "[click me](javascript:window.__pwned3=true)",
  "",
  "[real](https://example.com/ok)",
  "",
  "- item with <b>html</b> in it",
  "",
  "```",
  "<script>inside code fence</script>",
  "```"
].join("\n");
var hostileHtml = renderToStaticMarkup(/* @__PURE__ */ jsx(Markdown, { content: hostile }));
check("no script tag is created from content", !/<script/i.test(hostileHtml), hostileHtml.slice(0, 120));
check("script text is shown escaped, not executed", hostileHtml.includes("&lt;script&gt;"));
check("no img tag is created from content", !/<img/i.test(hostileHtml));
check("img markup is escaped rather than dropped", hostileHtml.includes("&lt;img"));
check("no real onerror attribute exists", !/<[^>]*\son\w+\s*=/i.test(hostileHtml));
check("javascript: link is not a live anchor", !/href="javascript:/i.test(hostileHtml));
check("javascript: link is shown as plain text", hostileHtml.includes("md-unsafe-link"));
check("https link still works", hostileHtml.includes('href="https://example.com/ok"'));
check("html inside a list item is escaped", hostileHtml.includes("&lt;b&gt;html&lt;/b&gt;"));
check("code fence content is escaped", hostileHtml.includes("&lt;script&gt;inside code fence&lt;/script&gt;"));
for (const input of ["", "   ", "---", "---\n---", "#", "- ", "```", ">", "| a | b |", "[x]("]) {
  try {
    renderToStaticMarkup(/* @__PURE__ */ jsx(Markdown, { content: input }));
  } catch (e) {
    check(`does not throw on ${JSON.stringify(input)}`, false, String(e));
  }
}
check("survives malformed input", true);
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `
${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
