import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, type ErrorLine, type IncludeLine, type OptionLine, type RequirementLine } from '../src/index.ts';

const req = (text: string, o = {}): RequirementLine => {
  const l = parse(text, o)[0];
  assert.equal(l?.kind, 'requirement', JSON.stringify(l));
  return l as RequirementLine;
};
const err = (text: string, o = {}): ErrorLine => {
  const l = parse(text, o).find((x) => x.kind === 'error');
  assert.ok(l, `expected an error for ${JSON.stringify(text)}`);
  return l as ErrorLine;
};

test('a requirement line carries the PEP 508 parse', () => {
  const l = req('Requests[socks, security] >= 2.0 , <3,>=2.0.0 ; python_version >= "3.8" and os_name == \'posix\'  # pinned\n');
  assert.deepEqual(l.pep508, {
    name: 'Requests',
    normalizedName: 'requests',
    extras: ['security', 'socks'],
    specifier: '<3,>=2.0',
    url: null,
    marker: 'python_version >= "3.8" and os_name == "posix"',
    text: 'Requests[security,socks]<3,>=2.0',
  });
  assert.equal(l.lineno, 1);
  assert.equal(l.file, 'requirements.txt');
  assert.equal(l.constraint, false);
});

test('specifier sets are validated, sorted and de-duplicated like packaging', () => {
  assert.equal(req('a ==1.0, ==1.0.0, >=1').pep508.specifier, '==1.0,>=1');
  assert.equal(req('a===Anything-Goes').pep508.specifier, '===Anything-Goes');
  assert.equal(req('a (>=1,<2)').pep508.specifier, '<2,>=1');
  assert.match(err('a ~=1').message, /^Invalid requirement: 'a ~=1': Expected semicolon/);
  assert.equal(err('a===1,2').errorType, 'InvalidSpecifier');
  assert.equal(err('a===1,2').message, "Invalid specifier: '2'");
});

test('extra names in markers are normalized, other values are kept', () => {
  assert.equal(req('a; extra == "Foo_Bar"').pep508.marker, 'extra == "foo-bar"');
  assert.equal(req('a; "Foo_Bar" == extra').pep508.marker, '"foo-bar" == extra');
  assert.equal(req('a; os.name == "posix" or (sys.platform == "linux")').pep508.marker, 'os_name == "posix" or sys_platform == "linux"');
});

test('direct references keep the raw URL and split the marker', () => {
  const l = req('pkg @ https://example.com/pkg-1.0-py3-none-any.whl ; python_version < "3.12"');
  assert.equal(l.pep508.name, 'pkg');
  assert.equal(l.pep508.url, 'https://example.com/pkg-1.0-py3-none-any.whl');
  assert.equal(l.pep508.marker, 'python_version < "3.12"');
});

test('bare URLs take their name from a wheel file name or an egg fragment', () => {
  assert.equal(req('https://example.com/Foo_Bar-1.0.post1-py3-none-any.whl').pep508.text, 'foo-bar==1.0.post1');
  const g = req('git+https://github.com/x/y.git@v1#egg=y');
  assert.equal(g.pep508.name, 'y');
  assert.equal(g.pep508.url, 'git+https://github.com/x/y.git@v1#egg=y');
  const u = req('https://example.com/pkg-1.0.tar.gz');
  assert.equal(u.pep508.name, null);
  assert.equal(u.pep508.url, 'https://example.com/pkg-1.0.tar.gz');
});

test('backslash joins lines and the joined line keeps the first line number', () => {
  const lines = parse('foo \\\n  >=1.0, \\\n  <2 # c\nbar\n');
  assert.equal(lines.length, 2);
  const [a, b] = lines as RequirementLine[];
  assert.equal(a?.lineno, 1);
  assert.equal(a?.endLineno, 3);
  assert.equal(a?.raw, 'foo \\\n  >=1.0, \\\n  <2 # c');
  assert.equal(a?.pep508.specifier, '<2,>=1.0');
  assert.equal(b?.lineno, 4);
});

test('a comment that ends in a backslash swallows the next line, as in pip', () => {
  const lines = parse('foo # note \\\nbar\nbaz\n');
  assert.equal(lines.length, 2);
  assert.equal((lines[0] as RequirementLine).pep508.name, 'foo');
  assert.equal((lines[1] as RequirementLine).lineno, 3);
});

test('a comment line inside a continuation ends it', () => {
  const lines = parse('foo \\\n# comment\nbar');
  assert.deepEqual(lines.map((l) => [l.kind, l.lineno]), [['requirement', 1], ['requirement', 3]]);
});

test('# starts a comment only at line start or after whitespace', () => {
  assert.equal(req('https://example.com/p.zip#egg=foo # c').pep508.name, 'foo');
  assert.equal(err('foo#bar').errorType, 'InstallationError');
  assert.equal(parse('   # only a comment\n\n   \n').length, 0);
});

test('${VAR} expands for uppercase, digit and underscore names only', () => {
  const env = { TOKEN_1: 'secret', empty: 'x', EMPTY: '' };
  assert.equal(req('https://${TOKEN_1}@host.example/p.zip', { env }).pep508.url, 'https://secret@host.example/p.zip');
  assert.equal(req('pkg==$TOKEN_1'.replace('==$TOKEN_1', ''), { env }).pep508.name, 'pkg');
  assert.match(err('pkg==${empty}', { env }).message, /^Invalid requirement: 'pkg==\$\{empty\}'/);
  assert.match(err('pkg==${EMPTY}', { env }).message, /'pkg==\$\{EMPTY\}'/);
  assert.match(err('pkg==$TOKEN_1', { env }).message, /'pkg==\$TOKEN_1'/);
  assert.equal(req('${TOKEN_1}', { env: { TOKEN_1: 'requests>=2' } }).pep508.name, 'requests');
});

test('line breaks follow str.splitlines and errors count lines the same way', () => {
  const lines = parse('a\r\nb\rc\u2028d\x0be\x85f\n');
  assert.deepEqual(lines.map((l) => l.lineno), [1, 2, 3, 4, 5, 6]);
  const e = err('ok\n\nbad line here\n');
  assert.equal(e.lineno, 3);
  assert.equal(e.file, 'requirements.txt');
});

test('bytes get pip decoding: BOM stripped, coding comment honored; strings are taken as decoded text', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('foo==1\n')]);
  assert.equal(parse(bom)[0]?.kind, 'requirement');
  assert.equal(parse('\ufefffoo==1\n')[0]?.kind, 'error');
  const latin = new Uint8Array([...new TextEncoder().encode('# -*- coding: latin-1 -*-\n'), 0x66, 0x6f, 0x6f, 0x20, 0xe9, 0x0a]);
  const e = parse(latin)[0] as ErrorLine;
  assert.equal(e.kind, 'error');
  assert.match(e.message, /^Invalid requirement: 'foo \u00e9'/);
  assert.equal(e.lineno, 2);
  assert.equal((parse(new Uint8Array([0xff, 0xfe, 0x66, 0x00]))[0] as RequirementLine).pep508.name, 'f');
});

test('hashes and config settings attach to the requirement', () => {
  const l = req('foo==1.0 --hash=sha256:aa --hash sha256:bb --hash=sha512:cc -C a=1 --config-settings=a=2 -Cb=3');
  assert.deepEqual(l.hashes, { sha256: ['aa', 'bb'], sha512: ['cc'] });
  assert.deepEqual(l.configSettings, { a: ['1', '2'], b: '3' });
  assert.equal(l.requirement, 'foo==1.0');
  assert.equal(err('foo --hash=md5:aa').message, 'Invalid requirement: foo --hash=md5:aa\npip: error: Allowed hash algorithms for --hash are sha256, sha384, sha512.\n');
  assert.match(err('foo --hash=sha256').message, /must be a hash name followed by a value/);
  assert.match(err('foo -C novalue').message, /must be of the form KEY=VAL/);
});

test('options that pip ignores on a requirement line are still validated and listed', () => {
  const l = req('foo --pre --trusted-host h');
  assert.deepEqual(l.options.map((o) => o.name), ['pre', 'trusted-host']);
  assert.match(err('foo --bogus').message, /no such option: --bogus/);
  assert.match(err('foo --global-option=--x').message, /no such option: --global-option/);
});

test('option lines report each option in order', () => {
  const l = parse('-i https://a/simple --extra-index-url=https://b --no-index -f ./w --pre --prefer-binary')[0] as OptionLine;
  assert.equal(l.kind, 'option');
  assert.deepEqual(l.options, [
    { name: 'index-url', value: 'https://a/simple' },
    { name: 'extra-index-url', value: 'https://b' },
    { name: 'no-index', value: true },
    { name: 'find-links', value: './w' },
    { name: 'pre', value: true },
    { name: 'prefer-binary', value: true },
  ]);
});

test('optparse abbreviations, clusters and messages', () => {
  assert.deepEqual((parse('--ind https://x')[0] as OptionLine).options, [{ name: 'index-url', value: 'https://x' }]);
  assert.deepEqual((parse('-ihttps://x')[0] as OptionLine).options, [{ name: 'index-url', value: 'https://x' }]);
  assert.equal(err('--no x').message, 'Invalid requirement: --no x\npip: error: ambiguous option: --no (--no-binary, --no-index, --no-require-hashes?)\n');
  assert.equal(err('--index-url').message, 'Invalid requirement: --index-url\npip: error: --index-url option requires 1 argument\n');
  assert.equal(err('--pre=1').message, 'Invalid requirement: --pre=1\npip: error: --pre option does not take a value\n');
  assert.match(err('--use-feature=nope').message, /invalid choice: 'nope' \(choose from 'fast-deps'/);
  assert.equal(err('--no-binary -x').errorType, 'CommandError');
  assert.equal(err('--index-url "unclosed').message, 'Invalid requirement: --index-url "unclosed\nCould not split options: --index-url "unclosed');
  assert.equal(err('--bogus', { prog: 'x' }).message, 'Invalid requirement: --bogus\nx: error: no such option: --bogus\n');
});

test('a --hash with no requirement is reported as ignored', () => {
  const l = parse('--hash=sha256:aa')[0] as OptionLine;
  assert.equal(l.kind, 'option');
  assert.deepEqual(l.warnings, ['requirements.txt line 1 has --hash but no requirement, and will be ignored.']);
});

test('editable requirements: VCS URLs, direct references and paths', () => {
  const vcs = req('-e git+ssh://git@github.com/x/y.git@main#egg=y&subdirectory=z');
  assert.equal(vcs.editable, true);
  assert.equal(vcs.pep508.name, 'y');
  assert.equal(req('--editable=git://x/y.git#egg=y').pep508.url, 'git+git://x/y.git#egg=y');
  // an unquoted `name @ url` is cut at the first space, as in pip
  assert.match(err('-e pkg[extra] @ file:///abs/pkg').message, /^pkg\[extra\] is not a valid editable requirement/);
  const quoted = req('-e "pkg[extra] @ file:///abs/pkg ; python_version > \'3\'"');
  assert.equal(quoted.pep508.marker, 'python_version > "3"');
  assert.deepEqual(quoted.pep508.extras, ['extra']);
  assert.equal(err('-e ./missing').message.startsWith('./missing is not a valid editable requirement.'), true);
  assert.equal(err('-e git+https://x/y.git').message, "Could not detect requirement name for 'git+https://x/y.git', please specify one with your_package_name @ URL");
  assert.equal(err('-e ./x', { constraint: true }).message, 'Editable requirements are not allowed as constraints');
  const fs = { isDir: (p: string) => p === '/w/proj', isFile: (p: string) => p === '/w/proj/setup.py' };
  const local = req('-e ./proj[a,b]', { cwd: '/w', fs });
  assert.equal(local.pep508.url, 'file:///w/proj');
  assert.deepEqual(local.pep508.extras, ['a', 'b']);
});

test('paths and archives use the filesystem view you give them', () => {
  const fs = { isDir: (p: string) => ['/w/proj', '/w/empty'].includes(p), isFile: (p: string) => p === '/w/proj/setup.py' || p === '/w/a-1.0.tar.gz' };
  assert.equal(req('./proj', { cwd: '/w', fs }).pep508.url, 'file:///w/proj');
  assert.equal(err('./empty', { cwd: '/w', fs }).message, "Directory './empty' is not installable. Neither 'setup.py' nor 'pyproject.toml' found.");
  assert.equal(req('a-1.0.tar.gz', { cwd: '/w', fs }).pep508.url, 'file:///w/a-1.0.tar.gz');
  const missing = req('nothere-1.0.tar.gz', { cwd: '/w', fs });
  assert.equal(missing.pep508.url, 'file:///w/nothere-1.0.tar.gz');
  assert.deepEqual(missing.warnings, ["Requirement 'nothere-1.0.tar.gz' looks like a filename, but the file does not exist"]);
  assert.match(err('./nothing').message, /Hint: It looks like a path\. File '\.\/nothing' does not exist\.$/);
});

test('includes are followed through the resolver, inlined, with cycle detection', () => {
  const files: Record<string, string> = {
    '/w/main.txt': '-r sub/inc.txt\n-c cons.txt\nmain-pkg\n',
    '/w/sub/inc.txt': 'inc-pkg\n-r ../other.txt\n',
    '/w/other.txt': 'other-pkg\n',
    '/w/cons.txt': 'cons-pkg==1\n',
  };
  const seen: string[] = [];
  const lines = parse(files['/w/main.txt'] as string, {
    filename: 'main.txt',
    cwd: '/w',
    resolveInclude: (path, info) => {
      seen.push(`${path} -> ${info.resolved} from ${info.from} constraint=${info.constraint}`);
      return files[info.resolved];
    },
  });
  assert.deepEqual(
    lines.map((l) => `${l.kind}:${l.file}:${l.lineno}`),
    [
      'include:main.txt:1',
      'requirement:/w/sub/inc.txt:1',
      'include:/w/sub/inc.txt:2',
      'requirement:/w/other.txt:1',
      'include:main.txt:2',
      'requirement:/w/cons.txt:1',
      'requirement:main.txt:3',
    ],
  );
  assert.equal((lines[0] as IncludeLine).resolved, '/w/sub/inc.txt');
  assert.equal((lines[5] as RequirementLine).constraint, true);
  assert.equal((lines[6] as RequirementLine).constraint, false);
  assert.deepEqual(seen, [
    'sub/inc.txt -> /w/sub/inc.txt from main.txt constraint=false',
    '../other.txt -> /w/other.txt from /w/sub/inc.txt constraint=false',
    'cons.txt -> /w/cons.txt from main.txt constraint=true',
  ]);

  const cyc = parse('-r a.txt', {
    filename: 'main.txt',
    cwd: '/w',
    resolveInclude: (_p, i) => (i.resolved === '/w/a.txt' ? '-r b.txt' : i.resolved === '/w/b.txt' ? '-r a.txt' : undefined),
  });
  const e = cyc.find((l) => l.kind === 'error') as ErrorLine;
  assert.equal(e.message, '/w/a.txt recursively references itself in /w/b.txt and again in /w/main.txt'.replace('and again in /w/main.txt', 'and again in main.txt'));
  assert.equal(e.file, '/w/b.txt');
  assert.equal(e.lineno, 1);
  const missing = parse('-r nope.txt', { cwd: '/w', resolveInclude: () => undefined });
  assert.equal((missing[1] as ErrorLine).message, "Could not open requirements file: [Errno 2] No such file or directory: '/w/nope.txt'");
  const noResolver = parse('-r nope.txt');
  assert.deepEqual(noResolver.map((l) => l.kind), ['include']);
});

test('a requirements file can be an http URL; includes join as URLs', () => {
  const seen: string[] = [];
  parse('-r ../shared.txt', {
    filename: 'https://example.com/a/b/reqs.txt',
    resolveInclude: (_p, i) => {
      seen.push(i.resolved);
      return 'x';
    },
  });
  assert.deepEqual(seen, ['https://example.com/a/shared.txt']);
});

test('nothing throws on malformed input', () => {
  const junk = ['\0', '\\', '-', '--', '-e', '"', "'", '${', '[', 'a @', ';', 'a;', '\ud800', '-r', '-r \\', '\u2028\u2028', 'http://[', '\\\n\\\n\\'];
  for (const j of junk) assert.doesNotThrow(() => parse(j), JSON.stringify(j));
});

test('a path with a two-slash root gets a four-slash file URL and pip then rejects the authority', () => {
  const e = err('//host.example/x-1.0-py3-none-any.whl');
  assert.equal(e.errorType, 'URLError');
  assert.equal(e.message, '<urlopen error file:// scheme is supported only on localhost>');
  assert.equal(req('/abs/dir/x-1.0-py3-none-any.whl').pep508.url, 'file:///abs/dir/x-1.0-py3-none-any.whl');
});

test('an invalid specifier in an editable target falls back to pip syntax like any ValueError', () => {
  assert.match(err('A1 === 1.0c1,,=1! -e ./proj').message, /^A1 === 1\.0c1,,=1! is not a valid editable requirement/);
  assert.match(err('-e a===1,2').message, /^a===1,2 is not a valid editable requirement/);
});

test('a marker string that decodes to a line break makes pip fail when it re-parses an editable line', () => {
  const e = err('pkg @ git+https://example.com/p.git ; os_name == "\\n" -e ./x');
  assert.equal(e.errorType, 'SyntaxError');
  assert.equal(e.message, 'unterminated string literal (detected at line 1) (<unknown>, line 1)');
  // without -e the same marker is fine
  assert.equal(req('pkg @ git+https://example.com/p.git ; os_name == "\\n"').pep508.marker, 'os_name == "\n"');
});
