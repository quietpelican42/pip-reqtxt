/**
 * Live differential: generates fresh cases, runs them through the installed
 * pip, and compares. Skips (loudly) without a Python that has pip >= 26.
 *
 *   PIP_REQTXT_PYTHON=/path/to/python   interpreter with pip 26.x (default: python3)
 *   PIP_REQTXT_LIVE_COUNT=3000          cases per run
 *   PIP_REQTXT_LIVE_SEED=1              generator seed (default: today's date)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareCase, type Case, type Expected } from './compare.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.PIP_REQTXT_PYTHON ?? 'python3';

function probe(): string | null {
  const r = spawnSync(python, ['-c', 'import pip; print(pip.__version__)'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return `could not run "${python}" with pip importable`;
  const major = Number((r.stdout ?? '').trim().split('.')[0]);
  if (!(major >= 26)) return `pip ${(r.stdout ?? '').trim()} found; the parser targets pip 26.x`;
  return null;
}

const why = probe();
if (why !== null) {
  console.warn(
    `\n*** SKIPPING live pip differential: ${why}. Set PIP_REQTXT_PYTHON to a Python with pip 26.x ` +
      `(for example a venv: python3 -m venv .venv && .venv/bin/pip install "pip>=26"). ***\n`,
  );
}

test('live differential against the installed pip', { skip: why ?? false, timeout: 900_000 }, () => {
  const count = process.env.PIP_REQTXT_LIVE_COUNT ?? '3000';
  const d = new Date();
  const seed = process.env.PIP_REQTXT_LIVE_SEED ?? String(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
  const dir = `${root}.work-live`;
  mkdirSync(dir, { recursive: true });
  const run = (script: string, ...args: string[]) => {
    const r = spawnSync(python, [`${root}scripts/${script}`, ...args], { encoding: 'utf8', timeout: 600_000 });
    assert.equal(r.status, 0, `${script} failed: ${r.stderr}`);
  };
  run('gen_cases.py', `${dir}/cases.json`, '--seed', seed, '--count', count);
  run('gen_cases.py', `${dir}/fuzz.json`, '--seed', seed, '--count', String(Math.floor(Number(count) / 3)), '--fuzz');
  for (const name of ['cases', 'fuzz']) {
    run('oracle.py', `${dir}/${name}.json`, `${dir}/${name}.expected.json`, '--work', `${dir}/work-${name}`);
    const cases = JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8')) as Case[];
    const expected = JSON.parse(readFileSync(`${dir}/${name}.expected.json`, 'utf8')) as Expected[];
    const failures: string[] = [];
    cases.forEach((c, i) => {
      const r = compareCase(c, expected[i] as Expected);
      if (r.diffs.length > 0) failures.push(`seed ${seed} ${name} #${c.id}: ${JSON.stringify(c.files[c.main] ?? c.urls[c.main])}\n  ${r.diffs.join('\n  ')}`);
    });
    assert.equal(failures.length, 0, `${failures.length}/${cases.length} disagreements with pip:\n${failures.slice(0, 5).join('\n')}`);
  }
});
