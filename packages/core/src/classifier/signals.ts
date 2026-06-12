// Structural-signal detectors — the single, shared implementation of the
// Layer-1 structural regexes. Both `dimensions.ts` (complexity scoring) and
// `taskdetect.ts` (task_type detection) consume THESE functions so the two
// paths can never drift apart with two copies of the same regex (task spec:
// "structural-signal functions share one implementation with dimensions"). Pure: same input => same output,
// zero I/O, no clock, no randomness (CLAUDE.md principle 4). Each detector
// returns a [0,1] signal — 1 when the structure is present, 0 otherwise.

// Fenced ```…``` block, or an indented/monospace run of >=40 chars. Short inline
// `code` (<40 chars) does NOT trigger.
export function detectCodeBlock(text: string): number {
  const fence = /```[\s\S]*?```/m.exec(text);
  if (fence && fence[0].replace(/```/g, "").trim().length >= 40) return 1;
  const inline = /`[^`]{40,}`/.test(text);
  return inline ? 1 : 0;
}

// http(s):// URL or a bare host like example.com/path. Trailing sentence
// punctuation is not consumed by the host pattern.
export function detectUrl(text: string): number {
  if (/https?:\/\/[^\s)<>"']+/i.test(text)) return 1;
  if (/\b[a-z0-9-]+(\.[a-z0-9-]+)+\/[^\s)<>"']*/i.test(text)) return 1;
  return 0;
}

// File paths: a/b/c.ts, ./src/x, src/app/main.ts, C:\dir\file.
export function detectFilePath(text: string): number {
  if (/(^|\s)\.{0,2}\/?[\w.-]+(\/[\w.-]+)+\.[A-Za-z0-9]+/.test(text)) return 1;
  if (/[A-Za-z]:\\[\w\\.-]+/.test(text)) return 1;
  return 0;
}

// Stack traces across languages: JS "at fn (file:line)", Python "Traceback".
export function detectStackTrace(text: string): number {
  if (/Traceback \(most recent call last\)/.test(text)) return 1;
  if (/\bat\s+[\w.$<>]+\s*\([^)]*:\d+(:\d+)?\)/.test(text)) return 1;
  if (/\b\w+Error:\s/.test(text) && /\n\s+at\s/.test(text)) return 1;
  return 0;
}

// Math notation: LaTeX delimiters or common math symbols.
export function detectMathNotation(text: string): number {
  if (/\$\$?[^$]+\$\$?/.test(text)) return 1;
  if (/\\(frac|sum|int|sqrt|alpha|beta|theta)\b/.test(text)) return 1;
  if (/[∑∫√≤≥≠∈∀∃∂∇π]/.test(text)) return 1;
  return 0;
}

// Markdown-ish table: a row of pipes plus a separator line.
export function detectTable(text: string): number {
  return /\|[^\n]*\|/.test(text) && /\|\s*-{3,}/.test(text) ? 1 : 0;
}

// Min-max normalize a non-negative count into [0,1] with the given saturation.
export function normalize(value: number, saturateAt: number): number {
  if (value <= 0) return 0;
  return Math.min(1, value / saturateAt);
}

// Length signal normalized over characters (a long message tilts complexity up).
export function lengthSignal(text: string): number {
  return normalize(text.trim().length, 2000);
}

// Fraction of LETTERS (\p{L}) that are NOT Latin script, in [0,1]; 0 when there are
// no letters. Digits, punctuation and whitespace are ignored so they never skew the
// ratio. Layer-1 has an English keyword layer plus an international keyword layer
// (currently seeded with Simplified/Traditional Chinese, extendable for Japanese/
// Korean/Vietnamese/etc.), so a
// non-covered non-Latin prompt is unscoreable by keywords — the engine's
// language-coverage guard uses this to force `uncertain` and escalate to the
// (multilingual) Layer-2 eval. Pure: same input => same output, zero I/O.
const LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
export function nonLatinRatio(text: string): number {
  let letters = 0;
  let nonLatin = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters += 1;
    if (!LATIN_LETTER.test(ch)) nonLatin += 1;
  }
  return letters === 0 ? 0 : nonLatin / letters;
}
