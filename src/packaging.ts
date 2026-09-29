/*
 * Portions of this file are derived from the Python "packaging" library
 * (https://github.com/pypa/packaging), Copyright (c) Donald Stufft and
 * individual contributors, used under the BSD 2-Clause License. See
 * LICENSE-packaging.
 *
 * A port of the parsing side of packaging 26.3: dependency specifiers (PEP
 * 508), markers, version specifiers, versions and wheel file names. It reads
 * and validates the same strings packaging does and produces the same
 * normalized text; it does not compare versions.
 */
import { PY_WS, codePointCount, pyCompare, pyRepr, pyStrip } from './pyish.ts';

// ---- errors ----------------------------------------------------------------

/** packaging.requirements.InvalidRequirement */
export class InvalidRequirement extends Error {}
/** packaging.markers.InvalidMarker */
export class InvalidMarker extends Error {}
/** packaging.specifiers.InvalidSpecifier (a ValueError, not an InvalidRequirement) */
export class InvalidSpecifier extends Error {}
/** packaging.version.InvalidVersion */
export class InvalidVersion extends Error {}
/** packaging.utils.InvalidWheelFilename */
export class InvalidWheelFilename extends Error {}
/** The SyntaxError Python's ast.literal_eval raises for a malformed string literal. */
export class PySyntaxError extends Error {}

class ParserSyntaxError extends Error {
  readonly detail: string;
  constructor(message: string, source: string, span: [number, number]) {
    const start = codePointCount(source, span[0]);
    const end = codePointCount(source, span[1]);
    const marker = ' '.repeat(start) + '~'.repeat(Math.max(0, end - start)) + '^';
    super(`${message}\n    ${source}\n    ${marker}`);
    this.detail = message;
  }
}

// ---- tokenizer ---------------------------------------------------------------

const W = '[\\p{L}\\p{N}_]';
/** Python's Unicode-aware \b. */
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const S = `[${PY_WS}]`;
const NS = `[^${PY_WS}]`;

const PRE = '[-_\\.]?(?:alpha|beta|preview|pre|a|b|c|rc)[-_\\.]?[0-9]*';
const POST = '(?:-[0-9]+)|(?:[-_\\.]?(?:post|rev|r)[-_\\.]?[0-9]*)';
const DEV = '[-_\\.]?dev[-_\\.]?[0-9]*';
const RELEASE = `v?(?:[0-9]+!)?[0-9]+(?:\\.[0-9]+)*`;

/** Specifier._specifier_regex_str with re.VERBOSE removed. */
export const SPECIFIER_SRC =
  `(?:` +
  `(?:===${S}*[^${PY_WS};)]*)` +
  `|(?:(?:==|!=)${S}*${RELEASE}` +
  `(?:\\.\\*|(?:${PRE})?(?:${POST})?(?:${DEV})?(?:\\+[a-z0-9]+(?:[-_\\.][a-z0-9]+)*)?)?)` +
  `|(?:~=${S}*v?(?:[0-9]+!)?[0-9]+(?:\\.[0-9]+)+(?:${PRE})?(?:${POST})?(?:${DEV})?)` +
  `|(?:(?:<=|>=|<|>)${S}*${RELEASE}(?:${PRE})?(?:${POST})?(?:${DEV})?)` +
  `)`;

const SPECIFIER_FULL = new RegExp(`^${S}*${SPECIFIER_SRC}${S}*$`, 'i');

type RuleName =
  | 'LEFT_PARENTHESIS'
  | 'RIGHT_PARENTHESIS'
  | 'LEFT_BRACKET'
  | 'RIGHT_BRACKET'
  | 'SEMICOLON'
  | 'COMMA'
  | 'QUOTED_STRING'
  | 'OP'
  | 'BOOLOP'
  | 'IN'
  | 'NOT'
  | 'VARIABLE'
  | 'SPECIFIER'
  | 'AT'
  | 'URL'
  | 'IDENTIFIER'
  | 'VERSION_PREFIX_TRAIL'
  | 'VERSION_LOCAL_LABEL_TRAIL'
  | 'WS'
  | 'END';

const RULE_SRC: Record<RuleName, [string, string]> = {
  LEFT_PARENTHESIS: ['\\(', ''],
  RIGHT_PARENTHESIS: ['\\)', ''],
  LEFT_BRACKET: ['\\[', ''],
  RIGHT_BRACKET: ['\\]', ''],
  SEMICOLON: [';', ''],
  COMMA: [',', ''],
  QUOTED_STRING: [`(?:'[^']*'|"[^"]*")`, ''],
  OP: ['(?:===|==|~=|!=|<=|>=|<|>)', ''],
  BOOLOP: [`${B}(?:or|and)${B}`, ''],
  IN: [`${B}in${B}`, ''],
  NOT: [`${B}not${B}`, ''],
  VARIABLE: [
    `${B}(?:python_version|python_full_version|os[._]name|sys[._]platform|platform_(?:release|system)` +
      `|platform[._](?:version|machine|python_implementation)|python_implementation` +
      `|implementation_(?:name|version)|extras?|dependency_groups)${B}`,
    '',
  ],
  SPECIFIER: [SPECIFIER_SRC, 'i'],
  AT: ['@', ''],
  URL: ['[^ \\t]+', ''],
  IDENTIFIER: [`${B}[a-zA-Z0-9][a-zA-Z0-9._-]*${B}`, ''],
  VERSION_PREFIX_TRAIL: ['\\.\\*', ''],
  VERSION_LOCAL_LABEL_TRAIL: ['\\+[a-z0-9]+(?:[-_\\.][a-z0-9]+)*', ''],
  WS: ['[ \\t]+', ''],
  END: ['$', ''],
};

const RULES = new Map<RuleName, RegExp>();
for (const [name, [src, flags]] of Object.entries(RULE_SRC) as [RuleName, [string, string]][]) {
  RULES.set(name, new RegExp(src, name === 'SPECIFIER' ? `y${flags}` : `y${flags}u`));
}

interface Token {
  name: RuleName;
  text: string;
  position: number;
}

class Tokenizer {
  readonly source: string;
  next: Token | null = null;
  position = 0;
  constructor(source: string) {
    this.source = source;
  }
  consume(name: RuleName): void {
    if (this.check(name)) this.read();
  }
  check(name: RuleName, peek = false): boolean {
    const re = RULES.get(name) as RegExp;
    re.lastIndex = this.position;
    const m = re.exec(this.source);
    if (m === null) return false;
    if (!peek) this.next = { name, text: m[0], position: this.position };
    return true;
  }
  expect(name: RuleName, expected: string): Token {
    if (!this.check(name)) this.fail(`Expected ${expected}`);
    return this.read();
  }
  read(): Token {
    const t = this.next as Token;
    this.position += t.text.length;
    this.next = null;
    return t;
  }
  fail(message: string, spanStart?: number, spanEnd?: number): never {
    throw new ParserSyntaxError(message, this.source, [
      spanStart ?? this.position,
      spanEnd ?? this.position,
    ]);
  }
  enclosing(open: RuleName, close: RuleName, around: string, body: () => void): void {
    let openPos: number | null = null;
    if (this.check(open)) {
      openPos = this.position;
      this.read();
    }
    body();
    if (openPos === null) return;
    if (!this.check(close)) {
      this.fail(`Expected matching ${close} for ${open}, after ${around}`, openPos);
    }
    this.read();
  }
}

// ---- marker AST -----------------------------------------------------------------

type MarkerVar = { type: 'variable' | 'value'; value: string };
type MarkerItem = { lhs: MarkerVar; op: string; rhs: MarkerVar };
export type MarkerNode = MarkerItem | 'and' | 'or' | MarkerNode[];

function parseMarkerOp(t: Tokenizer): string {
  if (t.check('IN')) {
    t.read();
    return 'in';
  }
  if (t.check('NOT')) {
    t.read();
    t.expect('WS', "whitespace after 'not'");
    t.expect('IN', "'in' after 'not'");
    return 'not in';
  }
  if (t.check('OP')) return t.read().text;
  return t.fail('Expected marker operator, one of <=, <, !=, ==, >=, >, ~=, ===, in, not in');
}

/** ast.literal_eval of a quoted string token. */
export function literalEvalString(text: string): string {
  const body = text.slice(1, -1);
  let out = '';
  const chars = Array.from(body);
  // The tokenizer rejects a raw line break inside a single-line string before any escape is decoded.
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\\') i++;
    else if (chars[i] === '\n' || chars[i] === '\r') {
      throw new PySyntaxError('unterminated string literal (detected at line 1) (<unknown>, line 1)');
    }
  }
  // CPython hands the escape decoder the body with every non-ASCII character
  // rewritten as a 10-character \UXXXXXXXX escape; error offsets count that form.
  const offsets: number[] = [];
  let acc = 0;
  for (const c of chars) {
    offsets.push(acc);
    acc += (c.codePointAt(0) as number) < 128 ? 1 : 10;
  }
  const pyErr = (start: number, end: number, why: string): never => {
    throw new PySyntaxError(
      `(unicode error) 'unicodeescape' codec can't decode bytes in position ${start}-${end - 1}: ${why} (<unknown>, line 1)`,
    );
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const startIdx = i;
    i++;
    const n = chars[i];
    if (n === undefined) {
      throw new PySyntaxError(
        'unterminated string literal (detected at line 1); perhaps you escaped the end quote? (<unknown>, line 1)',
      );
    }
    switch (n) {
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\n': break;
      case 'x':
      case 'u':
      case 'U': {
        const len = n === 'x' ? 2 : n === 'u' ? 4 : 8;
        let j = i + 1;
        let hex = '';
        while (hex.length < len && j < chars.length && /^[0-9a-fA-F]$/.test(chars[j] as string)) hex += chars[j++];
        const startOff = offsets[startIdx] as number;
        const endOff = j < chars.length ? (offsets[j] as number) : acc;
        if (hex.length < len) {
          pyErr(startOff, endOff, `truncated \\${n === 'x' ? 'xXX' : n === 'u' ? 'uXXXX' : 'UXXXXXXXX'} escape`);
        }
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) pyErr(startOff, endOff, 'illegal Unicode character');
        out += String.fromCodePoint(cp);
        i += len;
        break;
      }
      case 'N':
        throw new PySyntaxError('\\N{...} escapes are not supported');
      default:
        if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(chars[i + 1] ?? '')) oct += chars[++i];
          out += String.fromCodePoint(parseInt(oct, 8));
        } else out += '\\' + n;
    }
  }
  return out;
}

function parseMarkerVar(t: Tokenizer): MarkerVar {
  if (t.check('VARIABLE')) {
    const v = t.read().text.replace(/\./g, '_');
    return {
      type: 'variable',
      value: v === 'platform_python_implementation' || v === 'python_implementation' ? 'platform_python_implementation' : v,
    };
  }
  if (t.check('QUOTED_STRING')) return { type: 'value', value: literalEvalString(t.read().text) };
  return t.fail('Expected a marker variable or quoted string');
}

function parseMarkerItem(t: Tokenizer): MarkerItem {
  t.consume('WS');
  const lhs = parseMarkerVar(t);
  t.consume('WS');
  const op = parseMarkerOp(t);
  t.consume('WS');
  const rhs = parseMarkerVar(t);
  t.consume('WS');
  return { lhs, op, rhs };
}

function parseMarkerAtom(t: Tokenizer): MarkerNode {
  t.consume('WS');
  let marker: MarkerNode;
  if (t.check('LEFT_PARENTHESIS', true)) {
    marker = [];
    t.enclosing('LEFT_PARENTHESIS', 'RIGHT_PARENTHESIS', 'marker expression', () => {
      t.consume('WS');
      marker = parseMarker(t);
      t.consume('WS');
    });
  } else marker = parseMarkerItem(t);
  t.consume('WS');
  return marker;
}

function parseMarker(t: Tokenizer): MarkerNode[] {
  const expr: MarkerNode[] = [parseMarkerAtom(t)];
  while (t.check('BOOLOP')) {
    const tok = t.read();
    const right = parseMarkerAtom(t);
    expr.push(tok.text as 'and' | 'or', right);
  }
  return expr;
}

function canonicalizeName(name: string): string {
  let v = name.toLowerCase().replace(/_/g, '-').replace(/\./g, '-');
  while (v.includes('--')) v = v.replace(/--/g, '-');
  return v;
}
export { canonicalizeName };

function normalizeExtras(node: MarkerNode): MarkerNode {
  if (typeof node === 'string' || Array.isArray(node)) return node;
  let { lhs, rhs } = node;
  if (lhs.type === 'variable' && lhs.value === 'extra') {
    rhs = { type: 'value', value: canonicalizeName(rhs.value) };
  } else if (rhs.type === 'variable' && rhs.value === 'extra') {
    lhs = { type: 'value', value: canonicalizeName(lhs.value) };
  }
  return { lhs, op: node.op, rhs };
}

function serializeVar(v: MarkerVar): string {
  return v.type === 'value' ? `"${v.value}"` : v.value;
}

function formatMarker(marker: MarkerNode, first = true): string {
  if (Array.isArray(marker) && marker.length === 1 && typeof marker[0] === 'object') {
    return formatMarker(marker[0] as MarkerNode, true);
  }
  if (Array.isArray(marker)) {
    const inner = marker.map((m) => formatMarker(m, false)).join(' ');
    return first ? inner : `(${inner})`;
  }
  if (typeof marker === 'string') return marker;
  return `${serializeVar(marker.lhs)} ${marker.op} ${serializeVar(marker.rhs)}`;
}

/** A parsed marker expression; `toString()` matches `str(packaging.markers.Marker)`. */
export class Marker {
  readonly nodes: MarkerNode[];
  constructor(nodes: MarkerNode[]) {
    this.nodes = nodes;
  }
  toString(): string {
    return formatMarker(this.nodes);
  }
}

function normalizeTop(nodes: MarkerNode[]): MarkerNode[] {
  return nodes.map(normalizeExtras);
}

/** Marker(text): throws InvalidMarker like packaging. */
export function parseMarkerText(text: string): Marker {
  try {
    const t = new Tokenizer(text);
    const nodes = parseMarker(t);
    t.expect('END', 'end of marker expression');
    return new Marker(normalizeTop(nodes));
  } catch (e) {
    if (e instanceof ParserSyntaxError) throw new InvalidMarker(e.message);
    throw e;
  }
}

// ---- versions -----------------------------------------------------------------

const VERSION_RE = new RegExp(
  `^${S}*v?(?:(?:([0-9]+)!)?([0-9]+(?:\\.[0-9]+)*)` +
    `([-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?([0-9]+)?)?` +
    `((?:-([0-9]+))|(?:[-_.]?(post|rev|r)[-_.]?([0-9]+)?))?` +
    `([-_.]?(dev)[-_.]?([0-9]+)?)?)(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?${S}*$`,
  'i',
);

function stripZeros(digits: string): string {
  const s = digits.replace(/^0+/, '');
  return s === '' ? '0' : s;
}

function letterVersion(letter: string | undefined, number: string | undefined): string | null {
  if (letter) {
    let l = letter.toLowerCase();
    if (l === 'alpha') l = 'a';
    else if (l === 'beta') l = 'b';
    else if (l === 'c' || l === 'pre' || l === 'preview') l = 'rc';
    else if (l === 'rev' || l === 'r') l = 'post';
    return `${l}\u0000${stripZeros(number || '0')}`;
  }
  if (number) return `post\u0000${stripZeros(number)}`;
  return null;
}

/**
 * Normalize a PEP 440 version the way `str(Version(text))` does; throws
 * InvalidVersion for text that is not a version. With `trimRelease`,
 * trailing zero release segments are dropped like `canonicalize_version`.
 */
export function normalizeVersion(text: string, trimRelease = false): string {
  const m = VERSION_RE.exec(text);
  if (!m) throw new InvalidVersion(`Invalid version: ${pyRepr(text)}`);
  const epoch = m[1] ? stripZeros(m[1]) : '0';
  let release = (m[2] as string).split('.').map(stripZeros);
  if (trimRelease) {
    let i = release.length;
    while (i > 1 && release[i - 1] === '0') i--;
    release = release.slice(0, i);
  }
  let out = release.join('.');
  if (epoch !== '0') out = `${epoch}!${out}`;
  const pre = letterVersion(m[4], m[5]);
  if (pre !== null) out += pre.replace('\u0000', '');
  const post = letterVersion(m[8], m[7] ?? m[9]);
  if (post !== null) out += `.post${post.split('\u0000')[1]}`;
  const dev = letterVersion(m[11], m[12]);
  if (dev !== null) out += `.dev${dev.split('\u0000')[1]}`;
  if (m[13] !== undefined) {
    const local = m[13]
      .split(/[._-]/)
      .map((p) => (/^[0-9]+$/.test(p) ? stripZeros(p) : p.toLowerCase()))
      .join('.');
    out += `+${local}`;
  }
  return out;
}

// ---- specifiers ------------------------------------------------------------------

function specifierParts(spec: string): [string, string] {
  const s = pyStrip(spec);
  if (s.startsWith('===')) return ['===', pyStrip(s.slice(3))];
  const two = s.slice(0, 2);
  if (['~=', '==', '!=', '<=', '>='].includes(two)) return [two, pyStrip(s.slice(2))];
  return [s.slice(0, 1), pyStrip(s.slice(1))];
}

function canonicalSpec(spec: string): string {
  const [op, version] = specifierParts(spec);
  if (op === '===' || version.endsWith('.*')) return `${op}\u0000${version}`;
  let v: string;
  try {
    v = normalizeVersion(version, op !== '~=');
  } catch {
    v = version;
  }
  return `${op}\u0000${v}`;
}

/** `str(SpecifierSet(text))`: sorted, de-duplicated, validated. Throws InvalidSpecifier. */
export function normalizeSpecifierSet(text: string): string {
  const specs: string[] = [];
  for (const piece of text.split(',')) {
    const s = pyStrip(piece);
    if (s === '') continue;
    if (!SPECIFIER_FULL.test(s)) throw new InvalidSpecifier(`Invalid specifier: ${pyRepr(s)}`);
    const [op, version] = specifierParts(s);
    specs.push(op + version);
  }
  specs.sort(pyCompare);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of specs) {
    const key = canonicalSpec(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.join(',');
}

// ---- requirements -----------------------------------------------------------------

export interface ParsedDependency {
  /** The name exactly as written. */
  name: string;
  /** PEP 503 normalized name. */
  normalizedName: string;
  /** Extras exactly as written, de-duplicated, sorted by code point. */
  extras: string[];
  /** `str(SpecifierSet)`; empty when there is none. */
  specifier: string;
  /** The direct-reference URL after `@`, or null. */
  url: string | null;
  /** Normalized marker text (`str(Marker)`), or null. */
  marker: string | null;
  /** `str(Requirement)`. */
  text: string;
}

function parseExtras(t: Tokenizer): string[] {
  if (!t.check('LEFT_BRACKET', true)) return [];
  let extras: string[] = [];
  t.enclosing('LEFT_BRACKET', 'RIGHT_BRACKET', 'extras', () => {
    t.consume('WS');
    extras = parseExtrasList(t);
    t.consume('WS');
  });
  return extras;
}

function parseExtrasList(t: Tokenizer): string[] {
  const extras: string[] = [];
  if (!t.check('IDENTIFIER')) return extras;
  extras.push(t.read().text);
  for (;;) {
    t.consume('WS');
    if (t.check('IDENTIFIER', true)) t.fail('Expected comma between extra names');
    else if (!t.check('COMMA')) break;
    t.read();
    t.consume('WS');
    extras.push(t.expect('IDENTIFIER', 'extra name after comma').text);
  }
  return extras;
}

function parseVersionMany(t: Tokenizer): string {
  let parsed = '';
  while (t.check('SPECIFIER')) {
    const spanStart = t.position;
    parsed += t.read().text;
    if (t.check('VERSION_PREFIX_TRAIL', true)) {
      t.fail('.* suffix can only be used with `==` or `!=` operators', spanStart, t.position + 1);
    }
    if (t.check('VERSION_LOCAL_LABEL_TRAIL', true)) {
      t.fail('Local version label can only be used with `==` or `!=` operators', spanStart, t.position);
    }
    t.consume('WS');
    if (!t.check('COMMA')) break;
    parsed += t.read().text;
    t.consume('WS');
  }
  return parsed;
}

function parseSpecifier(t: Tokenizer): string {
  let parsed = '';
  t.enclosing('LEFT_PARENTHESIS', 'RIGHT_PARENTHESIS', 'version specifier', () => {
    t.consume('WS');
    parsed = parseVersionMany(t);
    t.consume('WS');
  });
  return parsed;
}

function parseRequirementMarker(t: Tokenizer, spanStart: number, expected: string): MarkerNode[] {
  if (!t.check('SEMICOLON')) t.fail(`Expected ${expected} or end`, spanStart);
  t.read();
  const marker = parseMarker(t);
  t.consume('WS');
  return marker;
}

/** Requirement(text): throws InvalidRequirement or InvalidSpecifier like packaging. */
export function parseRequirementText(source: string): ParsedDependency {
  let name: string;
  let url = '';
  let specifier = '';
  let marker: MarkerNode[] | null = null;
  let extras: string[];
  try {
    const t = new Tokenizer(source);
    t.consume('WS');
    name = t.expect('IDENTIFIER', 'package name at the start of dependency specifier').text;
    t.consume('WS');
    extras = parseExtras(t);
    t.consume('WS');
    if (t.check('AT')) {
      t.read();
      t.consume('WS');
      const urlStart = t.position;
      url = t.expect('URL', 'URL after @').text;
      if (!t.check('END', true)) {
        t.expect('WS', 'whitespace after URL');
        if (!t.check('END', true)) {
          marker = parseRequirementMarker(t, urlStart, 'semicolon (after URL and whitespace)');
        }
      }
    } else {
      const specStart = t.position;
      specifier = parseSpecifier(t);
      t.consume('WS');
      if (!t.check('END', true)) {
        marker = parseRequirementMarker(
          t,
          specStart,
          specifier
            ? 'comma (within version specifier), semicolon (after version specifier)'
            : 'semicolon (after name with no version specifier)',
        );
      }
    }
    t.expect('END', 'end of dependency specifier');
  } catch (e) {
    if (e instanceof ParserSyntaxError) throw new InvalidRequirement(e.message);
    throw e;
  }
  const uniqExtras = [...new Set(extras)].sort(pyCompare);
  const spec = normalizeSpecifierSet(specifier);
  const markerText = marker === null ? null : new Marker(normalizeTop(marker)).toString();
  let text = name;
  if (uniqExtras.length > 0) text += `[${uniqExtras.join(',')}]`;
  text += spec;
  if (url) {
    text += ` @ ${url}`;
    if (markerText) text += ' ';
  }
  if (markerText) text += `; ${markerText}`;
  return {
    name,
    normalizedName: canonicalizeName(name),
    extras: uniqExtras,
    specifier: spec,
    url: url || null,
    marker: markerText,
    text,
  };
}

// ---- wheel file names ----------------------------------------------------------------

/** packaging.utils.parse_wheel_filename, reduced to the name and normalized version. */
export function parseWheelFilename(filename: string): { name: string; version: string } {
  if (!filename.endsWith('.whl')) {
    throw new InvalidWheelFilename(`Invalid wheel filename (extension must be '.whl'): ${pyRepr(filename)}`);
  }
  const stem = filename.slice(0, -4);
  const dashes = stem.split('-').length - 1;
  if (dashes !== 4 && dashes !== 5) {
    throw new InvalidWheelFilename(`Invalid wheel filename (wrong number of parts): ${pyRepr(stem)}`);
  }
  const parts: string[] = [];
  let rest = stem;
  for (let i = 0; i < dashes - 2; i++) {
    const idx = rest.indexOf('-');
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  const namePart = parts[0] as string;
  if (namePart.includes('__') || !/^[\p{L}\p{N}_.]*$/u.test(namePart)) {
    throw new InvalidWheelFilename(`Invalid project name: ${pyRepr(stem)}`);
  }
  let version: string;
  try {
    version = normalizeVersion(parts[1] as string);
  } catch {
    throw new InvalidWheelFilename(`Invalid wheel filename (invalid version): ${pyRepr(stem)}`);
  }
  if (dashes === 5 && !/^[0-9]/.test(parts[2] as string)) {
    throw new InvalidWheelFilename(`Invalid build number: ${parts[2]} in ${pyRepr(stem)}`);
  }
  return { name: canonicalizeName(namePart), version };
}
