/**
 * node scripts/diff.ts cases.json expected.json [maxShown]
 * Runs every case and prints agreement counts and the first mismatches per category.
 */
import { readFileSync } from 'node:fs';
import { compareCase, type Case, type Expected } from '../test/compare.ts';

const [casesPath, expectedPath, shown = '3'] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesPath as string, 'utf8')) as Case[];
const expected = JSON.parse(readFileSync(expectedPath as string, 'utf8')) as Expected[];
let ok = 0;
let accepted = 0;
let acceptedOk = 0;
const cats = new Map<string, { n: number; examples: string[] }>();
cases.forEach((c, i) => {
  const e = expected[i] as Expected;
  const r = compareCase(c, e);
  if (e.error === null) accepted++;
  if (r.diffs.length === 0) {
    ok++;
    if (e.error === null) acceptedOk++;
    return;
  }
  const cat = r.category as string;
  const slot = cats.get(cat) ?? { n: 0, examples: [] };
  slot.n++;
  if (slot.examples.length < Number(shown)) {
    slot.examples.push(`#${c.id} main=${JSON.stringify(c.files[c.main] ?? c.urls[c.main])}\n     ${r.diffs.slice(0, 3).join('\n     ')}`);
  }
  cats.set(cat, slot);
});
console.log(`agree ${ok}/${cases.length} (${((100 * ok) / cases.length).toFixed(2)}%); pip-accepted ${acceptedOk}/${accepted}`);
for (const [cat, s] of [...cats].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`\n${cat}: ${s.n}`);
  for (const ex of s.examples) console.log('  ' + ex);
}
