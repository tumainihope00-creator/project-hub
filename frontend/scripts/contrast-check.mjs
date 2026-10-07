#!/usr/bin/env node
/**
 * WCAG AA contrast verification for every theme in src/styles/tokens.css.
 *
 * Parses the stylesheet directly (single source of truth — themes are never
 * duplicated in JS), computes contrast for every text/background pair the UI
 * actually renders, and fails the process if any pair is below its threshold.
 *
 *   node scripts/contrast-check.mjs
 *
 * Thresholds: 4.5 for normal text, 3.0 for large text (>=24px or >=18.66px
 * bold — used for KPI numerals and decorative borders).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'styles', 'tokens.css'), 'utf8');

// --- parse each [data-theme="…"] block --------------------------------------
const themes = {};
const blockRe = /:root\[data-theme='([a-z-]+)'\]\s*\{([^}]*)\}/g;
let m;
while ((m = blockRe.exec(css)) !== null) {
  const vars = {};
  const declRe = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let d;
  while ((d = declRe.exec(m[2])) !== null) vars[`--${d[1]}`] = d[2].trim();
  themes[m[1]] = vars;
}

const hexesOf = (value) => (value.match(/#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}/g) ?? []);

// --- colour maths ------------------------------------------------------------
function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --- pairs actually rendered by the UI --------------------------------------
const TEXT = 4.5;
const LARGE = 3.0;

function pairsFor(vars) {
  const g = (n) => vars[n];
  const pairList = [
    ['text / bg', g('--text'), g('--bg'), TEXT],
    ['text / surface', g('--text'), g('--surface'), TEXT],
    ['muted / bg', g('--text-muted'), g('--bg'), TEXT],
    ['muted / surface', g('--text-muted'), g('--surface'), TEXT],
    ['dim / bg', g('--text-dim'), g('--bg'), TEXT],
    ['dim / surface', g('--text-dim'), g('--surface'), TEXT],
    ['accent(link) / bg', g('--accent'), g('--bg'), TEXT],
    ['accent(link) / surface', g('--accent'), g('--surface'), TEXT],
    ['accent-contrast / accent (primary btn)', g('--accent-contrast'), g('--accent'), TEXT],
    ['success / bg', g('--success'), g('--bg'), TEXT],
    ['warning / bg', g('--warning'), g('--bg'), TEXT],
    ['danger / bg', g('--danger'), g('--bg'), TEXT],
    ['info / bg', g('--info'), g('--bg'), TEXT],
    ['success / surface', g('--success'), g('--surface'), TEXT],
    ['warning / surface', g('--warning'), g('--surface'), TEXT],
    ['danger / surface', g('--danger'), g('--surface'), TEXT],
    ['info / surface', g('--info'), g('--surface'), TEXT],
    ['success / success-soft (chips)', g('--success'), g('--success-soft'), TEXT],
    ['warning / warning-soft', g('--warning'), g('--warning-soft'), TEXT],
    ['danger / danger-soft', g('--danger'), g('--danger-soft'), TEXT],
    ['info / info-soft', g('--info'), g('--info-soft'), TEXT],
    ['sidebar text / sidebar-bg', g('--sidebar-text'), g('--sidebar-bg'), TEXT],
    ['sidebar muted / sidebar-bg', g('--sidebar-muted'), g('--sidebar-bg'), TEXT],
    ['input text / surface-2 (field bg)', g('--text'), g('--surface-2'), TEXT],
    ['input text / bg (toolbar inputs)', g('--text'), g('--bg'), TEXT],
    ['muted / surface-2', g('--text-muted'), g('--surface-2'), TEXT]
  ];
  for (const stop of hexesOf(g('--sidebar-active-gradient'))) {
    pairList.push([`sidebar active text / gradient ${stop}`, g('--sidebar-active-text'), stop, TEXT]);
  }
  for (const k of [1, 2, 3, 4, 5, 6]) {
    pairList.push([`white / kpi-${k} from`, '#ffffff', g(`--kpi-${k}-from`), TEXT]);
    pairList.push([`white / kpi-${k} to`, '#ffffff', g(`--kpi-${k}-to`), TEXT]);
  }
  for (const name of ['gray', 'slate', 'blue', 'cyan', 'purple', 'yellow', 'orange', 'pink', 'red', 'green']) {
    pairList.push([`st-${name} / st-${name}-soft (badge)`, g(`--st-${name}`), g(`--st-${name}-soft`), TEXT]);
    pairList.push([`st-${name} / bg (inline colour)`, g(`--st-${name}`), g('--bg'), TEXT]);
    pairList.push([`st-${name} / surface`, g(`--st-${name}`), g('--surface'), TEXT]);
  }
  // Large text / non-text pairs
  pairList.push(['border-input / bg (control edge, 3:1)', g('--border-input'), g('--bg'), LARGE]);
  pairList.push(['border-input / surface (3:1)', g('--border-input'), g('--surface'), LARGE]);
  pairList.push(['border-input / surface-2 (3:1)', g('--border-input'), g('--surface-2'), LARGE]);
  pairList.push(['accent focus ring / surface (3:1)', g('--accent'), g('--surface'), LARGE]);
  return pairList;
}

let failures = 0;
let checked = 0;
const rows = [];

for (const [theme, vars] of Object.entries(themes)) {
  const themeFails = [];
  for (const [label, fg, bg, min] of pairsFor(vars)) {
    if (!fg || !bg) {
      themeFails.push(`${label}: token missing`);
      failures++;
      continue;
    }
    if (!fg.startsWith('#') || !bg.startsWith('#')) {
      themeFails.push(`${label}: not a hex (fg=${fg} bg=${bg})`);
      failures++;
      continue;
    }
    checked++;
    const ratio = contrast(fg, bg);
    if (ratio < min) {
      themeFails.push(`${label}: ${ratio.toFixed(2)} < ${min} (${fg} on ${bg})`);
      failures++;
    }
  }
  rows.push({ theme, checked: pairsFor(vars).length, fails: themeFails });
}

for (const r of rows) {
  const status = r.fails.length === 0 ? 'PASS' : `FAIL (${r.fails.length})`;
  console.log(`${r.theme.padEnd(15)} ${status}`);
  for (const f of r.fails) console.log(`    ✗ ${f}`);
}
console.log(`\n${checked} pairs checked across ${Object.keys(themes).length} themes — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
