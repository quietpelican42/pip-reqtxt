/*
 * Derived in part from pip (https://github.com/pypa/pip), Copyright (c) The
 * pip developers, MIT License. See LICENSE-pip.
 */
import { PipError, toPipError, type PipErrorType } from './errors.ts';
import { finishInstallRequirement, parseReqFromEditable, parseReqFromLine } from './constructors.ts';
import type { FileSystem, PathContext } from './link.ts';
import { parseOptionTokens, type OptionEvent, type ParsedOptions } from './options.ts';
import { preprocess, type Env } from './preprocess.ts';
import { posixAbspath, posixDirname, posixJoin, pyRepr, pyUrljoin } from './pyish.ts';
import { shlexSplit } from './shlex.ts';

/** The PEP 508 side of a requirement line, as packaging and pip read it. */
export interface Pep508 {
  /** Name as written; null for a bare URL or path with no `#egg=`. */
  name: string | null;
  /** PEP 503 normalized name; null with `name`. */
  normalizedName: string | null;
  extras: string[];
  /** `str(SpecifierSet)`; empty when there is none. */
  specifier: string;
  /** The URL or path-derived `file:` URL the line points at, or null for a plain name. */
  url: string | null;
  /** Marker text as `str(Marker)` prints it, or null. */
  marker: string | null;
  /** `str(Requirement)` of the parsed name part, or null with `name`. */
  text: string | null;
}

interface LineBase {
  /** The file the line came from, as pip names it. */
  file: string;
  /** First physical line, 1-based, counted the way pip counts. */
  lineno: number;
  /** Last physical line of a `\` continuation. */
  endLineno: number;
  /** The physical source line(s), joined with `\n`. */
  raw: string;
  /** The logical line after joining, comment removal and `${VAR}` expansion. */
  text: string;
}

export interface RequirementLine extends LineBase {
  kind: 'requirement';
  /** The string pip hands to its requirement constructor (the line without options, or the `-e` target). */
  requirement: string;
  editable: boolean;
  /** True inside a `-c` file. */
  constraint: boolean;
  pep508: Pep508;
  /** `--hash` values by algorithm, in order; empty for none. Ignored by pip on editable lines. */
  hashes: Record<string, string[]>;
  /** `-C`/`--config-settings` values; a repeated key becomes an array. */
  configSettings: Record<string, string | string[]>;
  /** Every option on the line in order, including ones pip ignores on a requirement line. */
  options: OptionEvent[];
  warnings: string[];
}

export interface OptionLine extends LineBase {
  kind: 'option';
  options: OptionEvent[];
  warnings: string[];
}

export interface IncludeLine extends LineBase {
  kind: 'include';
  /** `-r` follows a requirements file, `-c` a constraints file. */
  flag: 'requirement' | 'constraint';
  /** The path as written on the line. */
  path: string;
  /** The path pip opens: joined onto the including file's directory and made absolute (URLs are joined as URLs). */
  resolved: string;
  options: OptionEvent[];
}

export interface ErrorLine extends LineBase {
  kind: 'error';
  errorType: PipErrorType;
  /** The message pip raises. */
  message: string;
}

export type ParsedLine = RequirementLine | OptionLine | IncludeLine | ErrorLine;

export interface IncludeInfo {
  /** The file containing the include line. */
  from: string;
  /** True for `-c`. */
  constraint: boolean;
  /** The path pip opens; see IncludeLine.resolved. */
  resolved: string;
  lineno: number;
}

export type IncludeResolver = (path: string, info: IncludeInfo) => string | Uint8Array | null | undefined;

export interface ParseOptions {
  /** Name of the top-level file, used in messages and include resolution. Default `requirements.txt`. */
  filename?: string;
  /** Environment for `${VAR}` expansion. Default `{}`; `process.env` is never read implicitly. */
  env?: Env;
  /** Supplies the content of `-r`/`-c` files. Without it, includes are reported but not followed. */
  resolveInclude?: IncludeResolver;
  /** Parse as a constraints file. */
  constraint?: boolean;
  /** Working directory used to make paths absolute. Default `/`. */
  cwd?: string;
  /** What exists on disk, for local paths and `-e` targets. Default: nothing exists. */
  fs?: FileSystem;
  /** The program name optparse puts in its messages. Default `pip`. */
  prog?: string;
}

const NOTHING: FileSystem = { isDir: () => false, isFile: () => false };
const SCHEME_RE = /^(?:http|http[s\u017f]|f[i\u0130\u0131]le):/i;

/** pip.req.req_file.break_args_options */
function breakArgsOptions(line: string): [string, string] {
  const tokens = line.split(' ');
  const args: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    if ((tokens[i] as string).startsWith('-')) break;
    args.push(tokens[i] as string);
  }
  return [args.join(' '), tokens.slice(i).join(' ')];
}

function lineParser(prog: string, line: string): [string, ParsedOptions] {
  const [args, optionsStr] = breakArgsOptions(line);
  let tokens: string[];
  try {
    tokens = shlexSplit(optionsStr);
  } catch {
    throw new PipError('RequirementsFileParseError', `Invalid requirement: ${line}\nCould not split options: ${optionsStr}`);
  }
  try {
    return [args, parseOptionTokens(prog, tokens)];
  } catch (e) {
    const err = toPipError(e);
    if (err.errorType === 'RequirementsFileParseError') {
      throw new PipError('RequirementsFileParseError', `Invalid requirement: ${line}\n${err.message}`);
    }
    throw err;
  }
}

function normalizeCodecName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^_+|_+$/g, '');
}

const LATIN1 = new Set(['latin_1', 'latin1', 'iso8859_1', 'iso_8859_1', '8859', 'cp819', 'l1', 'latin', 'iso_ir_100', 'ibm819', 'iso8859']);
const ASCII = new Set(['ascii', 'us_ascii', '646', 'ansi_x3.4_1968', 'iso646_us', 'us', 'cp367', 'ibm367', 'iso_ir_6', 'ansi_x3_4_1968']);
const UTF8 = new Set(['utf_8', 'utf8', 'u8', 'utf', 'utf8_ucs2', 'utf8_ucs4', 'cp65001']);

function decodeError(codec: string, data: Uint8Array): PipError {
  return new PipError('UnicodeDecodeError', `'${codec}' codec can't decode data in ${data.length} bytes`);
}

/** bytes.decode(name) for the codecs a requirements file is likely to declare. */
function pyDecode(name: string, data: Uint8Array): string {
  const key = normalizeCodecName(name);
  if (LATIN1.has(key)) return Array.from(data, (b) => String.fromCharCode(b)).join('');
  if (ASCII.has(key)) {
    if (data.some((b) => b > 127)) throw decodeError('ascii', data);
    return Array.from(data, (b) => String.fromCharCode(b)).join('');
  }
  try {
    const label = UTF8.has(key) ? 'utf-8' : key.replace(/_/g, '-');
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(data);
  } catch (e) {
    if (e instanceof RangeError) throw new PipError('LookupError', `unknown encoding: ${name}`);
    throw decodeError(name, data);
  }
}

function decodeUtf16(body: Uint8Array, le: boolean): string {
  if (body.length % 2 !== 0) throw decodeError('utf-16', body);
  const units: number[] = [];
  for (let i = 0; i < body.length; i += 2) {
    units.push(le ? (body[i] as number) | ((body[i + 1] as number) << 8) : ((body[i] as number) << 8) | (body[i + 1] as number));
  }
  let out = '';
  for (let i = 0; i < units.length; i++) {
    const u = units[i] as number;
    if (u >= 0xd800 && u <= 0xdbff) {
      const n = units[i + 1];
      if (n === undefined || n < 0xdc00 || n > 0xdfff) throw decodeError('utf-16', body);
      out += String.fromCharCode(u, n);
      i++;
    } else if (u >= 0xdc00 && u <= 0xdfff) throw decodeError('utf-16', body);
    else out += String.fromCharCode(u);
  }
  return out;
}

/** Decode the bytes of a requirements file the way pip does (BOM, PEP 263 comment, UTF-8). */
export function decodeRequirementsFile(data: Uint8Array): string {
  const starts = (...b: number[]) => data.length >= b.length && b.every((x, i) => data[i] === x);
  if (starts(0xef, 0xbb, 0xbf)) return pyDecode('utf-8', data.subarray(3));
  if (starts(0xff, 0xfe, 0x00, 0x00) || starts(0x00, 0x00, 0xfe, 0xff)) {
    const le = data[0] === 0xff;
    const body = data.subarray(4);
    if (body.length % 4 !== 0) throw decodeError('utf-32', data);
    let out = '';
    for (let i = 0; i < body.length; i += 4) {
      const b = [body[i], body[i + 1], body[i + 2], body[i + 3]] as number[];
      const cp = le ? (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0 : ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw decodeError('utf-32', data);
      out += String.fromCodePoint(cp);
    }
    return out;
  }
  if (starts(0xff, 0xfe)) return decodeUtf16(data.subarray(2), true);
  if (starts(0xfe, 0xff)) return decodeUtf16(data.subarray(2), false);
  let start = 0;
  for (let n = 0; n < 2 && start <= data.length; n++) {
    let end = data.indexOf(0x0a, start);
    if (end < 0) end = data.length;
    if (data[start] === 0x23) {
      const line = Array.from(data.subarray(start, end), (b) => String.fromCharCode(b)).join('');
      const m = /coding[:=][ \t\n\r\f\v]*([-A-Za-z0-9_.]+)/.exec(line);
      if (m) return pyDecode(m[1] as string, data);
    }
    start = end + 1;
  }
  return pyDecode('utf-8', data);
}

interface State {
  prog: string;
  env: Env;
  ctx: PathContext;
  resolve: IncludeResolver | undefined;
  out: ParsedLine[];
}

function baseOf(file: string, l: { lineno: number; endLineno: number; raw: string; text: string }): LineBase {
  return { file, lineno: l.lineno, endLineno: l.endLineno, raw: l.raw, text: l.text };
}

function parseContent(content: string, file: string, constraint: boolean, chain: Map<string, string | null>, st: State): void {
  for (const l of preprocess(content, st.env)) {
    const base = baseOf(file, l);
    try {
      const [args, opts] = lineParser(st.prog, l.text);
      handleLine(base, args, opts, constraint, chain, st);
    } catch (e) {
      const err = toPipError(e);
      st.out.push({ ...base, kind: 'error', errorType: err.errorType, message: err.message });
    }
  }
}

function handleLine(base: LineBase, args: string, opts: ParsedOptions, constraint: boolean, chain: Map<string, string | null>, st: State): void {
  const editable = opts.editables.length > 0;
  const requirement = args ? args : editable ? (opts.editables[0] as string) : null;
  if (requirement === null && (opts.requirements.length > 0 || opts.constraints.length > 0)) {
    const isReq = opts.requirements.length > 0;
    const path = (isReq ? opts.requirements[0] : opts.constraints[0]) as string;
    let resolved = path;
    if (SCHEME_RE.test(base.file)) resolved = pyUrljoin(base.file, path);
    else if (!SCHEME_RE.test(path)) resolved = posixAbspath(posixJoin(posixDirname(base.file), path), st.ctx.cwd);
    st.out.push({ ...base, kind: 'include', flag: isReq ? 'requirement' : 'constraint', path, resolved, options: opts.events });
    if (chain.has(resolved)) {
      const first = chain.get(resolved);
      const tail = first !== null && first !== undefined ? ` and again in ${first}` : '';
      throw new PipError('RequirementsFileParseError', `${resolved} recursively references itself in ${base.file}${tail}`);
    }
    if (st.resolve === undefined) return;
    const nested = !isReq;
    const kind = nested ? 'constraint' : 'requirements';
    let got: string | Uint8Array | null | undefined;
    try {
      got = st.resolve(path, { from: base.file, constraint: nested, resolved, lineno: base.lineno });
    } catch (e) {
      throw new PipError('InstallationError', `Could not open ${kind} file: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (got === null || got === undefined) {
      throw new PipError('InstallationError', `Could not open ${kind} file: [Errno 2] No such file or directory: ${pyRepr(resolved)}`);
    }
    const nextChain = new Map(chain);
    nextChain.set(resolved, base.file);
    parseContent(typeof got === 'string' ? got : decodeRequirementsFile(got), resolved, nested, nextChain, st);
    return;
  }
  if (requirement !== null) {
    st.out.push(requirementLine(base, requirement, editable, constraint, opts, st));
    return;
  }
  const warnings: string[] = [];
  if (opts.hashes) warnings.push(`${base.file} line ${base.lineno} has --hash but no requirement, and will be ignored.`);
  st.out.push({ ...base, kind: 'option', options: opts.events, warnings });
}

function requirementLine(base: LineBase, requirement: string, editable: boolean, constraint: boolean, opts: ParsedOptions, st: State): RequirementLine {
  const warnings: string[] = [];
  const lineSource = `line ${base.lineno} of ${base.file}`;
  let info;
  if (editable) {
    if (constraint) throw new PipError('InstallationError', 'Editable requirements are not allowed as constraints');
    const parts = parseReqFromEditable(requirement, st.ctx);
    info = finishInstallRequirement(parts, st.ctx);
  } else {
    const parts = parseReqFromLine(requirement, lineSource, st.ctx, warnings);
    info = finishInstallRequirement(parts, st.ctx);
  }
  const req = info.req;
  const pep508: Pep508 = {
    name: req ? req.name : null,
    normalizedName: req ? req.normalizedName : null,
    extras: info.extras,
    specifier: req ? req.specifier : '',
    url: info.url,
    marker: info.marker,
    text: req ? req.text : null,
  };
  return {
    ...base,
    kind: 'requirement',
    requirement,
    editable,
    constraint,
    pep508,
    hashes: editable || !opts.hashes ? {} : Object.fromEntries(Object.entries(opts.hashes)),
    configSettings: opts.configSettings ? Object.fromEntries(Object.entries(opts.configSettings)) : {},
    options: opts.events,
    warnings,
  };
}

/**
 * Parse requirements-file text the way pip's `parse_requirements` reads it.
 * Returns every line in order, with `-r`/`-c` files inlined after their include
 * line. Unlike pip, which stops at the first error, parsing continues after an
 * error line; the first `error` entry is the one pip would raise.
 */
export function parse(text: string | Uint8Array, options: ParseOptions = {}): ParsedLine[] {
  const filename = options.filename ?? 'requirements.txt';
  const cwd = options.cwd ?? '/';
  const st: State = {
    prog: options.prog ?? 'pip',
    env: options.env ?? {},
    ctx: { cwd, fs: options.fs ?? NOTHING },
    resolve: options.resolveInclude,
    out: [],
  };
  let content: string;
  try {
    content = typeof text === 'string' ? text : decodeRequirementsFile(text);
  } catch (e) {
    const err = toPipError(e);
    return [{ file: filename, lineno: 0, endLineno: 0, raw: '', text: '', kind: 'error', errorType: err.errorType, message: err.message }];
  }
  const chain = new Map<string, string | null>([[posixAbspath(filename, cwd), null]]);
  parseContent(content, filename, options.constraint ?? false, chain, st);
  return st.out;
}

