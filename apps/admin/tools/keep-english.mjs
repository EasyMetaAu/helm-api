#!/usr/bin/env node
// Force a small set of technical enum labels to stay in English across every
// locale. These are the `decided_by` values (rules / eval / fallback) — the
// literal strings the gateway records in the API and logs. The UI legend
// explains them in the user's language, but the badge label itself must match
// the raw value shown in the request table (and in logs), so it is NEVER
// localized. Run automatically at the end of i18n:translate so a full sync stays
// self-consistent (run from apps/admin: `node tools/keep-english.mjs`).
import fs from 'node:fs';
import path from 'node:path';

const KEEP = ['rules', 'eval', 'fallback'];
const dir = path.resolve(process.cwd(), 'src/locales');
const targets = ['zh-hans', 'zh-hant', 'ja', 'ko'];

const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
let changed = 0;
for (const locale of targets) {
  const file = path.join(dir, `${locale}.json`);
  const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
  let touched = false;
  for (const key of KEEP) {
    const englishValue = en[key] ?? key;
    if (dict[key] !== englishValue) {
      dict[key] = englishValue;
      touched = true;
      changed++;
    }
  }
  if (touched) fs.writeFileSync(file, `${JSON.stringify(dict, null, 2)}\n`);
}
console.log(
  `keep-english: forced [${KEEP.join(', ')}] to English — ${changed} replacement(s) across ${targets.length} locales`,
);
