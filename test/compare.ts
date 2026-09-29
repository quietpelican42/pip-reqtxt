/**
 * Compare this package's output with pip's recorded behavior for one case.
 * Shared by the fixture test and the live differential.
 */
import { parse, type ErrorLine, type OptionEvent, type ParsedLine } from '../src/index.ts';

export interface Case {
  id: number;
  files: Record<string, string>;
  main: string;
  env: Record<string, string>;
  constraint: boolean;
  urls: Record<string, string>;
}

interface OracleLine {
  kind: string;
  file: string;
  lineno: number;
  requirement: string | null;
  constraint: boolean;
  [k: string]: unknown;
}

export interface Expected {
  id: number;
  lines: OracleLine[];
  reqs: Record<string, unknown>[];
  error: { type: string; message: string; file: string | null; lineno: number | null } | null;
}

export const TREE = {
  dirs: ['proj', 'pyproj', 'emptydir', 'sub', 'sub/proj2', 'dirwithfile'],
  files: ['proj/setup.py', 'pyproj/pyproject.toml', 'sub/proj2/setup.py', 'pkg-1.0.tar.gz', 'x-1.0-py3-none-any.whl', 'sub/y-2.0.zip'],
};

/**
 * A stand-in for the working directory `/work`, resolving paths component by
 * component the way the kernel does (a missing directory makes `dir/..` fail).
 */
function statKind(path: string): 'dir' | 'file' | null {
  const stack: string[] = [];
  let kind: 'dir' | 'file' | null = 'dir'; // "/"
  for (const c of path.split('/')) {
    if (c === '' || c === '.') continue;
    if (kind !== 'dir') return null; // a component below a file
    if (c === '..') {
      stack.pop();
      continue;
    }
    stack.push(c);
    if (stack[0] !== 'work') return null; // only /work is modeled
    const inside = stack.slice(1).join('/');
    kind = inside === '' ? 'dir' : TREE.dirs.includes(inside) ? 'dir' : TREE.files.includes(inside) ? 'file' : null;
    if (kind === null) return null;
  }
  return kind;
}

let caseFiles: Record<string, string> = {};

const fs = {
  isDir: (p: string) => statKind(p) === 'dir',
  isFile: (p: string) => statKind(p) === 'file' || (posixNorm(p) in caseFilePaths()),
  readFile: (p: string) => caseFilePaths()[posixNorm(p)] ?? (statKind(p) === 'file' ? '' : undefined),
};

function posixNorm(p: string): string {
  const out: string[] = [];
  for (const c of p.split('/')) {
    if (c === '' || c === '.') continue;
    if (c === '..') out.pop();
    else out.push(c);
  }
  return '/' + out.join('/');
}

function caseFilePaths(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const [k, v] of Object.entries(caseFiles)) m['/work/' + k] = v;
  return m;
}

/** The option values optparse ends up with, rebuilt from the recorded events. */
function derive(events: OptionEvent[]): Record<string, unknown> {
  const list = (n: string) => events.filter((e) => e.name === n).map((e) => e.value as string);
  const flag = (n: string) => events.some((e) => e.name === n);
  const idx = list('index-url');
  const hashEvents = list('hash');
  let hashes: Record<string, string[]> | null = null;
  for (const h of hashEvents) {
    hashes ??= {};
    const i = h.indexOf(':');
    (hashes[h.slice(0, i)] ??= []).push(h.slice(i + 1));
  }
  let config: Record<string, string | string[]> | null = null;
  for (const c of list('config-settings')) {
    config ??= {};
    const i = c.indexOf('=');
    const k = c.slice(0, i);
    const v = c.slice(i + 1);
    const cur = config[k];
    config[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return {
    editables: list('editable'),
    requirements: list('requirement'),
    constraints: list('constraint'),
    index_url: idx.length ? idx[idx.length - 1] : null,
    extra_index_urls: list('extra-index-url'),
    no_index: flag('no-index'),
    find_links: list('find-links'),
    prefer_binary: flag('prefer-binary'),
    require_hashes: flag('require-hashes'),
    no_require_hashes: flag('no-require-hashes'),
    pre: flag('pre'),
    trusted_hosts: list('trusted-host'),
    features_enabled: list('use-feature'),
    hashes,
    config_settings: config,
  };
}

export function run(c: Case): ParsedLine[] {
  caseFiles = c.files;
  const enc = new TextEncoder();
  const lookup = (resolved: string): string | Uint8Array | undefined => {
    if (resolved in c.urls) return c.urls[resolved];
    if (fs.isDir(resolved)) throw new Error(`[Errno 21] Is a directory: '${resolved}'`);
    const parts = resolved.split('/');
    for (let i = 2; i < parts.length; i++) {
      if (fs.isFile(parts.slice(0, i).join('/'))) throw new Error(`[Errno 20] Not a directory: '${resolved}'`);
    }
    if (resolved.startsWith('/work/')) {
      const t = c.files[resolved.slice('/work/'.length)];
      if (t !== undefined) return enc.encode(t);
      return statKind(resolved) === 'file' ? new Uint8Array() : undefined;
    }
    return undefined;
  };
  const top = c.main in c.urls ? (c.urls[c.main] as string) : enc.encode(c.files[c.main] as string);
  return parse(top, {
    filename: c.main,
    env: c.env,
    constraint: c.constraint,
    cwd: '/work',
    fs,
    resolveInclude: (_path, info) => lookup(info.resolved),
  });
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normMessage(type: string, message: string): string {
  return type === 'SyntaxError' ? '<syntax error>' : message;
}

/** Returns the list of differences; empty means the case agrees with pip. */
export function compareCase(c: Case, e: Expected): { diffs: string[]; category: string | null } {
  const diffs: string[] = [];
  let category: string | null = null;
  const fail = (cat: string, msg: string) => {
    category ??= cat;
    diffs.push(`${cat}: ${msg}`);
  };
  let lines: ParsedLine[];
  try {
    lines = run(c);
  } catch (err) {
    return { diffs: [`crash: ${(err as Error).stack}`], category: 'crash' };
  }
  const firstErr = lines.findIndex((l) => l.kind === 'error');
  const upto = firstErr < 0 ? lines : lines.slice(0, firstErr + 1);
  const err = firstErr < 0 ? null : (upto[upto.length - 1] as ErrorLine);
  const normal = upto.filter((l) => l.kind !== 'error');

  if ((err === null) !== (e.error === null)) {
    fail('accept-reject', `js ${err ? `error ${err.errorType}: ${err.message}` : 'accepts'}; pip ${e.error ? `error ${e.error.type}: ${e.error.message}` : 'accepts'}`);
  } else if (err && e.error) {
    if (err.errorType !== e.error.type) fail('error-type', `js ${err.errorType} pip ${e.error.type}`);
    const located = e.error.file === null ? err.lineno === 0 : err.file === e.error.file && err.lineno === e.error.lineno;
    if (!located) {
      fail('error-line', `js ${err.file}:${err.lineno} pip ${e.error.file}:${e.error.lineno}`);
    }
    if (normMessage(err.errorType, err.message) !== normMessage(e.error.type, e.error.message)) {
      fail('error-message', `js ${JSON.stringify(err.message)} pip ${JSON.stringify(e.error.message)}`);
    }
  }

  // line classification and option values
  let recorded = e.lines;
  if (e.error && recorded.length === normal.length + 1) {
    const last = recorded[recorded.length - 1] as OracleLine;
    if (last.file === e.error.file && last.lineno === e.error.lineno) recorded = recorded.slice(0, -1);
  }
  if (recorded.length !== normal.length) {
    fail('line-count', `js ${normal.length} pip ${recorded.length}`);
  } else {
    normal.forEach((l, i) => {
      const o = recorded[i] as OracleLine;
      if (l.kind !== o.kind) return fail('classification', `line ${i}: js ${l.kind} pip ${o.kind}`);
      if (l.file !== o.file || l.lineno !== o.lineno) fail('lineno', `line ${i}: js ${l.file}:${l.lineno} pip ${o.file}:${o.lineno}`);
      const d = derive(l.kind === 'requirement' || l.kind === 'option' || l.kind === 'include' ? l.options : []);
      for (const k of Object.keys(d)) {
        if (!eq(d[k], o[k])) fail('option-values', `line ${i} ${k}: js ${JSON.stringify(d[k])} pip ${JSON.stringify(o[k])}`);
      }
      if (l.kind === 'requirement') {
        if (l.requirement !== o.requirement) fail('requirement-text', `js ${JSON.stringify(l.requirement)} pip ${JSON.stringify(o.requirement)}`);
        if (l.constraint !== o.constraint) fail('constraint-flag', `line ${i}`);
      }
    });
  }

  // requirement fields
  const reqs = normal.filter((l) => l.kind === 'requirement');
  if (reqs.length !== e.reqs.length) {
    fail('req-count', `js ${reqs.length} pip ${e.reqs.length}`);
  } else {
    reqs.forEach((l, i) => {
      if (l.kind !== 'requirement') return;
      const o = e.reqs[i] as Record<string, unknown>;
      const got: Record<string, unknown> = {
        file: l.file,
        lineno: l.lineno,
        requirement: l.requirement,
        editable: l.editable,
        constraint: l.constraint,
        hashes: l.hashes,
        config_settings: l.configSettings,
        name: l.pep508.name,
        normalized: l.pep508.normalizedName,
        extras: l.pep508.extras,
        specifier: l.pep508.specifier,
        text: l.pep508.text,
        url: l.pep508.url,
        marker: l.pep508.marker,
      };
      for (const k of Object.keys(got)) {
        if (!eq(got[k], o[k])) fail(`field-${k}`, `req ${i}: js ${JSON.stringify(got[k])} pip ${JSON.stringify(o[k])}`);
      }
    });
  }
  return { diffs, category };
}
