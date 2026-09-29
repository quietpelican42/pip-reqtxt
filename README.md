# pip-reqtxt

Parses pip requirements and constraints files the way pip's own `parse_requirements` does, including line joining, comments, `${VAR}`, options, hashes, editables, `-r`/`-c` includes and pip's error messages with line numbers.

```ts
import { parse } from 'pip-reqtxt';

const lines = parse(readFileSync('requirements.txt'), {
  env: process.env,
  resolveInclude: (path, info) => readFileSync(info.resolved),
});
for (const l of lines) if (l.kind === 'requirement') console.log(l.lineno, l.pep508.name, l.pep508.specifier, l.hashes);
```

## Why

The npm parsers for `requirements.txt` do not agree with pip on files pip accepts. `pip-requirements-js` (about 957,000 downloads a month) says it follows pip's documentation, but its strict mode throws on `\` continuations, CRLF, `--hash`, `--index-url`, `-e` and `${VAR}`, and its loose mode drops `-e` and every option. `pip-parse` never throws, puts `--hash=...` into the version string and does not expand `${VAR}`. Renovate's `pip_requirements` extractor is a line-by-line regex that lists updatable dependencies. It does not validate lines, join continuations or read options beyond a few registry flags.

Measured: `node bench/incumbents.mjs` (2,000 recorded cases from `scripts/gen_cases.py`, half of them accepted by pip; files with `-r`/`-c` are left out). A file agrees when the parser accepts or rejects it like pip and, if accepted, finds the same number of requirements.

```
files: 1356, accepted by pip: 573
pip-requirements-js (strict): all 771/1356 (56.9%); pip-accepted 4/573 (0.7%)
pip-requirements-js (loose): all 534/1356 (39.4%); pip-accepted 53/573 (9.2%)
pip-parse: all 537/1356 (39.6%); pip-accepted 117/573 (20.4%)
```

The same check on an earlier 1,660-file research corpus (533 files accepted by pip; not shipped), which uses a milder mix of constructs:

| Parser | Version | All files | Files pip accepts |
|---|---|---|---|
| pip-requirements-js, strict | 1.0.3 | 1211/1660 (73.0%) | 89/533 (16.7%) |
| pip-requirements-js, loose | 1.0.3 | 1081/1660 (65.1%) | 198/533 (37.1%) |
| pip-parse | 1.1.1 | 964/1660 (58.1%) | 349/533 (65.5%) |
| Renovate `pip_requirements` extract | 44.119.0 | 303/1660 (18.3%) | 303/533 (56.8%) |
| pip-reqtxt | this package | 1660/1660 (100.0%) | 533/533 (100.0%) |

Renovate never rejects a file, so files pip rejects always count as disagreement for it; the last column is the fair one. Its `extract.js` was run standalone with its logger and datasource imports stubbed and the parsing code unmodified. That script embeds Renovate source and is not shipped.

No other npm package matched the name patterns `requirements-*`, `pip-*`, `*-requirements` or `pyreq*` as a requirements-file parser (checked with `npm view` and `npm search`).

pip-reqtxt reads the research corpus as bytes, the way pip reads a file, and agrees on all of it. That check counts requirement lines only; the test suite compares every field (see Compatibility).

## Installation

```sh
npm install pip-reqtxt
```

Node 20.6 or later. No runtime dependencies.

## Usage

### Read a file and its includes

`parse` takes the file as text or bytes. Pass bytes (a `Buffer`) to get pip's decoding: a UTF-8, UTF-16 or UTF-32 byte-order mark is removed and a `# -*- coding: latin-1 -*-` comment in the first two lines is honored. A string is taken as already decoded, so a leading U+FEFF stays and is rejected as pip rejects it.

`resolveInclude` receives the path as written and an info object. `info.resolved` is the path pip would open: the including file's directory joined with the path and made absolute (URLs are joined as URLs). Return the file contents as a string or `Uint8Array`. Return `undefined` or throw for a file that cannot be opened. Without `resolveInclude`, includes are listed but not followed.

```ts
const lines = parse(readFileSync('requirements.txt'), {
  filename: 'requirements.txt',
  resolveInclude: (_path, info) => readFileSync(info.resolved),
});
```

`examples/read-file.ts` is a complete script that also supplies a filesystem view. Its output on a file with a continuation, an include, an editable and one bad line:

```
requirements.txt:1  requests[socks]>=2.31
/work/base.txt:1  flask==3.0.0
requirements.txt:4  y  (editable)
requirements.txt:5  error: Invalid requirement: 'bad line here': Expected semicolon (after name with no version specifier) or end
```

### Find the first error

pip stops at the first error. `parse` keeps going so a tool can report every problem; the first `error` entry is the one pip would raise.

```ts
const firstError = lines.find((l) => l.kind === 'error');
if (firstError) console.error(`${firstError.file}:${firstError.lineno}: ${firstError.message}`);
```

### Expand `${VAR}`

pip expands `${NAME}` (uppercase letters, digits, underscore) from the process environment. The environment is an explicit option here; `process.env` is never read implicitly.

```ts
parse('--index-url https://user:${TOKEN}@example.com/simple\n', { env: { TOKEN: 's3cret' } });
```

### Local paths and `-e` targets

Whether `./proj` is a directory with a `setup.py` decides how pip reads the line. By default nothing exists. Supply `fs` to describe the disk:

```ts
import { statSync } from 'node:fs';
parse('-e ./proj\n', {
  fs: {
    isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
    isFile: (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
  },
});
```

## Reference

### `parse(text, options?)`

Returns `ParsedLine[]`. Included files appear inline, right after their `include` entry.

| Name | Type | Default | Description |
|---|---|---|---|
| `text` | `string \| Uint8Array` | | The file. Bytes are decoded like pip does. |
| `filename` | `string` | `requirements.txt` | Name of the top-level file. Used in messages, in `file` fields and to resolve includes. |
| `env` | `Record<string, string \| undefined>` | `{}` | Values for `${VAR}`. An empty value is not substituted, as in pip. |
| `resolveInclude` | `(path, info) => string \| Uint8Array \| null \| undefined` | none | Supplies included files. `info` is `{ from, constraint, resolved, lineno }`. |
| `constraint` | `boolean` | `false` | Parse as a constraints file. Sets `constraint` on requirement lines and rejects `-e`. |
| `cwd` | `string` | `/` | Working directory used to make paths absolute. |
| `fs` | `FileSystem` | nothing exists | `{ isDir(path), isFile(path), readFile?(path) }`. `readFile` only affects the wording of one error hint. |
| `prog` | `string` | `pip` | Program name that optparse puts in its messages. |

### Lines

Every entry has `file`, `lineno` (first physical line, as pip counts), `endLineno`, `raw` (physical lines joined with `\n`), `text` (the logical line after joining, comment removal and `${VAR}` expansion) and `kind`.

| `kind` | Extra fields |
|---|---|
| `requirement` | `requirement` (the string pip passes to its constructor), `editable`, `constraint`, `pep508`, `hashes` (algorithm to digests), `configSettings`, `options` (every option on the line, in order), `warnings` |
| `option` | `options`, `warnings` |
| `include` | `flag` (`requirement` or `constraint`), `path`, `resolved`, `options` |
| `error` | `errorType`, `message` |

`pep508` describes what pip builds from the line:

| Field | Description |
|---|---|
| `name` | Name as written. `null` for a URL or path that gives no name. |
| `normalizedName` | PEP 503 form of `name`. |
| `extras` | Sorted extras. For a path such as `./proj[a,b]`, the extras from the brackets. |
| `specifier` | `str(SpecifierSet)`: validated, de-duplicated, sorted, comma-joined. |
| `url` | The direct-reference URL, or the URL pip derives from a path or URL line. |
| `marker` | `str(Marker)`: normalized spelling, `extra` values normalized. |
| `text` | `str(Requirement)` for the name part. |

`errorType` is the Python exception class pip raises: `RequirementsFileParseError`, `InstallationError`, `CommandError`, `InvalidRequirement`, `InvalidSpecifier`, `InvalidEggFragment`, `InvalidWheelFilename`, `ValueError`, `AssertionError`, `SyntaxError`, `UnicodeDecodeError`, `LookupError`, `URLError` or `IsADirectoryError`. `message` is pip's message. Messages from optparse carry `pip: error: ` and end with a newline, as in pip.

### Options

The accepted set is the one pip's requirements-file parser builds: `-i/--index-url` (`--pypi-url`), `--extra-index-url`, `--no-index`, `-c/--constraint`, `-r/--requirement`, `-e/--editable`, `-f/--find-links`, `--no-binary`, `--only-binary`, `--prefer-binary`, `--require-hashes`, `--no-require-hashes`, `--pre`, `--all-releases`, `--only-final`, `--trusted-host`, `--use-feature`, and on requirement lines `--hash` and `-C/--config-settings`. Long options can be abbreviated to an unambiguous prefix and short options can be clustered, as in optparse. Anything else is an error. `--global-option` and `--install-option` are unknown options in pip 26 and are errors here.

Each entry of `options` is `{ name, value }` where `name` is the canonical long name without dashes and `value` is a string or `true`. `OPTION_NAMES` lists the names.

### `decodeRequirementsFile(bytes)`

pip's `_decode_req_file`. Returns the text or throws a `PipError`-like error for undecodable input.

## How it works

The code follows pip 26.2.1 function by function:

- `preprocess.ts`: `join_lines`, `ignore_comments`, `expand_env_variables`, with Python's `str.splitlines`, `str.strip` and whitespace class instead of JavaScript's.
- `shlex.ts`, `options.ts`: `break_args_options`, `shlex.split` and the optparse parser with pip's option table and messages.
- `constructors.ts`, `link.ts`: `parse_req_from_line`, `parse_req_from_editable`, `Link`, and the Python `urllib.parse` behavior they depend on (`pyish.ts`).
- `packaging.ts`: the tokenizer, dependency-specifier parser, marker formatting, specifier validation and version normalization of packaging 26.2, the copy vendored by pip 26.2.1.
- `parse.ts`: the recursion over includes with pip's cycle check.

Python's regex `\b`, case folding and `\s` differ from JavaScript's, so they are rebuilt from explicit classes.

The test suite compares against pip itself. `scripts/gen_cases.py` generates requirements files (continuations, comments, CRLF and other line separators, BOMs, `${VAR}`, hashes, editables, VCS URLs, wheel names, includes, cycles, invalid lines and random mutations). `scripts/oracle.py` runs each through pip's `parse_requirements` and `install_req_from_parsed_requirement` and records every parsed line, every requirement and the first error with its file and line. `test/compare.ts` compares accept/reject, line classification, option values, requirement fields, error type, message and location.

## Limitations

- `evaluateMarker` is not provided. Markers are parsed and normalized; they are not evaluated.
- Versions are validated and normalized but not compared.
- `${VAR}` and includes need the caller to supply `env` and `resolveInclude`. Includes are synchronous.
- Paths use POSIX rules. Windows paths and drive letters are not handled.
- With no `fs`, no path exists, so `./proj` reads as an invalid requirement and `-e .` as an invalid editable. pip's answer depends on the disk.
- `\N{NAME}` escapes inside quoted marker strings are not supported (pip accepts them). Other marker escapes are.
- Python's Unicode case folding of ASCII letters is reproduced for egg fragments and URL schemes but not inside the `~=` branch of the specifier grammar.
- Unicode property data (`\p{L}`, NFKC) comes from the JavaScript runtime and can differ from Python's for very new characters.
- pip lets `--use-feature` values leak from one line to the next through a shared default list. This package reports each line's own values.
- A `file://` authority equal to the machine's host name is treated as non-local; pip treats it as local.
- Checks pip performs after parsing are out of scope: hash-checking mode requirements, unnamed requirements in constraints, resolving `--index-url` and `--find-links`, and applying `--no-binary` or `--only-binary`.
- Behavior is that of pip 26.2.1 (packaging 26.2, Python 3.14.7 `urllib.parse`). Other releases can differ.

## Compatibility

Run for this README:

- Node 24.20.0 on macOS: `npx tsc --noEmit`, `npm test`, `npm run build && npm run test:dist`.
- Oracle: pip 26.2.1 with its vendored packaging 26.2, on Python 3.14.7.

The `engines` field allows Node 20.6 and later and the CI workflow runs the built package's smoke test on Node 20.6, 22 and 24; those runs have not been made here. The TypeScript suite needs Node 24 (type stripping).

Differential results against pip 26.2.1 (each seed is 10,000 generated files; the count of files pip accepts is in parentheses):

| Seed | Generator mode | Files agreeing with pip | Of files pip accepts |
|---|---|---|---|
| 801 | normal | 10000/10000 | 2420/2420 |
| 802 | normal | 10000/10000 | 2489/2489 |
| 803 | normal | 10000/10000 | 2520/2520 |
| 804 | normal | 10000/10000 | 2487/2487 |
| 805 | normal | 10000/10000 | 2530/2530 |
| 806 | normal | 10000/10000 | 2544/2544 |
| 807 | normal | 10000/10000 | 2465/2465 |
| 808 | normal | 10000/10000 | 2538/2538 |
| 901 | fuzz | 10000/10000 | 1035/1035 |
| 902 | fuzz | 10000/10000 | 1060/1060 |
| 903 | fuzz | 10000/10000 | 1053/1053 |
| 904 | fuzz | 10000/10000 | 1070/1070 |

Total: 120,000 generated files, 24,211 of them accepted by pip. Every file agrees on accept/reject, line classification, option values, requirement fields, error type, error message and error line.

Sweeps like this one were run repeatedly while the code was written, and each disagreement was traced before the next run. They found and fixed: a two-slash path root in `file:` URLs, `InvalidSpecifier` being a `ValueError` inside pip's editable fallback, a raw line break inside a marker string, Python's case folding of `[A-Z]` for egg fragments, `..` above the working directory in the oracle's output, and directory or not-a-directory errors from the include resolver. Seed 904 first reported one file that differed only in how the oracle rewrote a path above the working directory; it agrees after the fix in `scripts/oracle.py`. One remaining class of difference belongs to the machine the oracle ran on: macOS treats `ſ` as `s` in path names, so `-e ſub/proj2` resolves there and not on a case-sensitive filesystem. The generator no longer inserts that character into paths.

## Development

```sh
npm install
npx tsc --noEmit
npm test                   # unit tests, the recorded pip cases, and a live pip run if Python has pip 26.x
npm run build && npm run test:dist
```

The live run reads `PIP_REQTXT_PYTHON` (default `python3`) and skips with a warning when that interpreter cannot import pip 26 or later. `PIP_REQTXT_LIVE_COUNT` and `PIP_REQTXT_LIVE_SEED` change its size and seed (default seed is today's date).

To regenerate and inspect a run by hand:

```sh
python scripts/gen_cases.py cases.json --seed 1 --count 10000 [--fuzz]
python scripts/oracle.py cases.json expected.json
node scripts/diff.ts cases.json expected.json       # agreement and the first mismatches per category
python scripts/make_fixture.py cases.json expected.json test/fixtures/differential.json.gz 2000
```

## License

MIT, see [LICENSE](LICENSE). The parsing logic is ported from pip (MIT, [LICENSE-pip](LICENSE-pip)) and packaging (BSD-2-Clause option of its dual license, [LICENSE-packaging](LICENSE-packaging)); files derived from them keep those notices in their headers.
