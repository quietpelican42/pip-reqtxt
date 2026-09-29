/**
 * Agreement of the other npm requirements parsers with pip.
 *
 *   npm install --prefix bench/.incumbents pip-requirements-js@1.0.3 pip-parse@1.1.1
 *   node bench/incumbents.mjs                       # recorded fixture, no Python needed
 *   node bench/incumbents.mjs cases.json expected.json   # your own run of scripts/oracle.py
 *
 * A file counts as agreeing when the parser accepts or rejects it like pip and,
 * for accepted files, finds as many requirements as pip does. Files with -r/-c
 * lines are left out (the other parsers cannot follow includes).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';

const require = createRequire(new URL('./.incumbents/', import.meta.url));
let js;
let pipParse;
try {
  js = require('pip-requirements-js');
  pipParse = require('pip-parse');
} catch {
  console.error('Install the incumbents first: npm install --prefix bench/.incumbents pip-requirements-js@1.0.3 pip-parse@1.1.1');
  process.exit(2);
}

let cases;
let expected;
if (process.argv[2]) {
  cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  expected = JSON.parse(readFileSync(process.argv[3], 'utf8'));
} else {
  const f = JSON.parse(gunzipSync(readFileSync(new URL('../test/fixtures/differential.json.gz', import.meta.url))).toString('utf8'));
  ({ cases, expected } = f);
}

const INC = /^\s*(-r|-c|--requirement|--constraint)\b/m;
const count = (r) => r.filter((x) => x.type === 'ProjectName' || x.type === 'ProjectURL').length;
const impls = {
  'pip-requirements-js (strict)': (t) => count(js.parsePipRequirementsFile(t)),
  'pip-requirements-js (loose)': (t) => count(js.parsePipRequirementsFileLoosely(t)),
  'pip-parse': (t) => {
    let n = 0;
    for (const x of pipParse.parseFile(t)) {
      if (x.type === 'Requirement') {
        if (JSON.stringify(x).includes('--hash')) return -1; // --hash absorbed into the version string
        n++;
      } else if (x.type === 'CommandLineFlag' && (x.flag === '-e' || x.flag === '--editable')) n++;
    }
    return n;
  },
};

const corpus = [];
cases.forEach((c, i) => {
  const t = c.files['main.txt'];
  if (t === undefined || c.constraint || INC.test(t)) return;
  corpus.push({ text: t, ok: expected[i].error === null, n: expected[i].reqs.length });
});
const accepted = corpus.filter((c) => c.ok).length;
console.log(`files: ${corpus.length}, accepted by pip: ${accepted}`);
for (const [name, fn] of Object.entries(impls)) {
  let all = 0;
  let acc = 0;
  for (const c of corpus) {
    let ok = true;
    let n = 0;
    try {
      n = fn(c.text);
    } catch {
      ok = false;
    }
    if (ok === c.ok && (!ok || n === c.n)) {
      all++;
      if (c.ok) acc++;
    }
  }
  console.log(`${name}: all ${all}/${corpus.length} (${((100 * all) / corpus.length).toFixed(1)}%); pip-accepted ${acc}/${accepted} (${((100 * acc) / accepted).toFixed(1)}%)`);
}
