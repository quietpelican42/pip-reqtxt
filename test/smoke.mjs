/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { parse, decodeRequirementsFile, OPTION_NAMES } = await import('../dist/index.js');

test('parses a requirement with extras, specifier and marker', () => {
  const [l] = parse('Requests[socks] >= 2.0 , <3 ; python_version >= "3.8" # pinned\n');
  assert.equal(l.kind, 'requirement');
  assert.equal(l.pep508.name, 'Requests');
  assert.equal(l.pep508.normalizedName, 'requests');
  assert.deepEqual(l.pep508.extras, ['socks']);
  assert.equal(l.pep508.specifier, '<3,>=2.0');
  assert.equal(l.pep508.marker, 'python_version >= "3.8"');
});

test('joins continuations and records hashes', () => {
  const lines = parse('foo==1.0 \\\n  --hash=sha256:aa \\\n  --hash=sha256:bb\nbar\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].hashes, { sha256: ['aa', 'bb'] });
  assert.equal(lines[1].lineno, 4);
});

test('reports pip errors with the pip message and line', () => {
  const lines = parse('ok\nfoo --bogus\n');
  assert.equal(lines[1].kind, 'error');
  assert.equal(lines[1].lineno, 2);
  assert.equal(lines[1].message, 'Invalid requirement: foo --bogus\npip: error: no such option: --bogus\n');
});

test('follows includes through the resolver and detects cycles', () => {
  const files = { '/w/a.txt': '-r b.txt\nx\n', '/w/b.txt': 'y\n' };
  const lines = parse('-r a.txt', { filename: 'main.txt', cwd: '/w', resolveInclude: (_p, i) => files[i.resolved] });
  assert.deepEqual(lines.map((l) => l.kind), ['include', 'include', 'requirement', 'requirement']);
  const cyc = parse('-r a.txt', { filename: 'main.txt', cwd: '/w', resolveInclude: () => '-r a.txt' });
  assert.ok(cyc.some((l) => l.kind === 'error' && /recursively references itself/.test(l.message)));
});

test('decodes bytes like pip and knows the option set', () => {
  assert.equal(decodeRequirementsFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a');
  assert.ok(OPTION_NAMES.includes('index-url'));
});
