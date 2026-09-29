import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { compareCase, type Case, type Expected } from './compare.ts';

interface Fixture {
  pip: string;
  packaging: string;
  cases: Case[];
  expected: Expected[];
}

const fixture = JSON.parse(
  gunzipSync(readFileSync(new URL('./fixtures/differential.json.gz', import.meta.url))).toString('utf8'),
) as Fixture;

test(`recorded pip ${fixture.pip} behavior (packaging ${fixture.packaging}): ${fixture.cases.length} cases`, () => {
  const failures: string[] = [];
  let accepted = 0;
  fixture.cases.forEach((c, i) => {
    const e = fixture.expected[i] as Expected;
    if (e.error === null) accepted++;
    const r = compareCase(c, e);
    if (r.diffs.length > 0) failures.push(`case ${c.id}: ${JSON.stringify(c.files[c.main] ?? c.urls[c.main])}\n  ${r.diffs.join('\n  ')}`);
  });
  assert.ok(accepted >= 500, `fixture should hold many accepted files, has ${accepted}`);
  assert.equal(failures.length, 0, `${failures.length} disagreements with pip:\n${failures.slice(0, 5).join('\n')}`);
});
