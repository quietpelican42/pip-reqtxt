/**
 * Helpers that reproduce the behavior of the Python standard-library
 * functions pip relies on (str.strip, str.splitlines, repr, posixpath,
 * urllib.parse, shlex). JavaScript differs from Python in each of these in
 * ways that change which requirements files are accepted.
 */

/** Characters for which Python's str.isspace() is true, as a regex class body. */
export const PY_WS =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

const WS_ONLY = new RegExp(`^[${PY_WS}]*`);
const WS_END = new RegExp(`[${PY_WS}]*$`);

/** str.strip() with no argument. */
export function pyStrip(s: string): string {
  return s.replace(WS_ONLY, '').replace(WS_END, '');
}

/** str.strip(chars) for a set of literal characters. */
export function pyStripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a] as string)) a++;
  while (b > a && chars.includes(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

/** str.splitlines(): splits on \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029. */
export function pySplitLines(s: string): string[] {
  const out: string[] = [];
  const re = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g;
  let last = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    out.push(s.slice(last, m.index));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** Number of code points in s.slice(0, index). */
export function codePointCount(s: string, endIndex: number): number {
  let n = 0;
  for (let i = 0; i < endIndex; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < endIndex) i++;
    n++;
  }
  return n;
}

/** Compare two strings by code point, as Python does. */
export function pyCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = (x.value as string).codePointAt(0) as number;
    const cy = (y.value as string).codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

const NONPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** repr() of a str. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === ' ') out += ' ';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp < 0x7f) out += ch;
    else if (NONPRINTABLE.test(ch)) {
      if (cp <= 0xff) out += '\\x' + cp.toString(16).padStart(2, '0');
      else if (cp <= 0xffff) out += '\\u' + cp.toString(16).padStart(4, '0');
      else out += '\\U' + cp.toString(16).padStart(8, '0');
    } else out += ch;
  }
  return out + quote;
}

/** rich.markup.escape(), used by pip for diagnostic messages. */
export function richEscape(markup: string): string {
  let out = markup.replace(
    /(\\*)(\[[a-z#/@][^[]*?])/g,
    (_m, backslashes: string, text: string) => `${backslashes}${backslashes}\\${text}`,
  );
  if (out.endsWith('\\') && !out.endsWith('\\\\')) out += '\\';
  return out;
}

// ---- posixpath -----------------------------------------------------------

export function posixNormpath(path: string): string {
  if (path === '') return '.';
  let initial = '';
  if (path.startsWith('/')) initial = path.startsWith('//') && !path.startsWith('///') ? '//' : '/';
  const comps = path.split('/');
  const out: string[] = [];
  for (const comp of comps) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initial && out.length === 0) || out[out.length - 1] === '..') {
      out.push(comp);
    } else if (out.length > 0) {
      out.pop();
    }
  }
  return initial + out.join('/') || '.';
}

export function posixJoin(a: string, b: string): string {
  if (b.startsWith('/')) return b;
  if (a === '' || a.endsWith('/')) return a + b;
  return a + '/' + b;
}

export function posixAbspath(path: string, cwd: string): string {
  return posixNormpath(path.startsWith('/') ? path : posixJoin(cwd, path));
}

export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/') + 1;
  let head = p.slice(0, i);
  if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
  return head;
}

export function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function posixSplitext(p: string): [string, string] {
  const sepIndex = p.lastIndexOf('/');
  const dotIndex = p.lastIndexOf('.');
  if (dotIndex > sepIndex) {
    let f = sepIndex + 1;
    while (f < dotIndex) {
      if (p[f] !== '.') return [p.slice(0, dotIndex), p.slice(dotIndex)];
      f++;
    }
  }
  return [p, ''];
}

// ---- urllib.parse --------------------------------------------------------

const QUOTE_SAFE = /[A-Za-z0-9_.\-~]/;

/** urllib.parse.quote(s, safe='/') */
export function pyQuote(s: string, safe = '/'): string {
  let out = '';
  for (const ch of s) {
    if (QUOTE_SAFE.test(ch) || safe.includes(ch)) out += ch;
    else
      for (const b of new TextEncoder().encode(ch))
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** urllib.parse.unquote(s) */
export function pyUnquote(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  });
}

export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

export class PyValueError extends Error {
  readonly pyType = 'ValueError';
}

function isIPv4(s: string): boolean {
  const parts = s.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^[0-9]{1,3}$/.test(p) && (p.length === 1 || p[0] !== '0') && Number(p) <= 255)
  );
}

function isIPv6(s: string): boolean {
  let addr = s;
  const pct = addr.indexOf('%');
  if (pct >= 0) {
    const scope = addr.slice(pct + 1);
    addr = addr.slice(0, pct);
    if (scope === '' || /[%/]/.test(scope)) return false;
  }
  if (addr === '') return false;
  let groupsNeeded = 8;
  let tail = addr;
  const lastColon = addr.lastIndexOf(':');
  if (lastColon >= 0 && addr.slice(lastColon + 1).includes('.')) {
    if (!isIPv4(addr.slice(lastColon + 1))) return false;
    tail = addr.slice(0, lastColon + 1) + '0:0';
  }
  const dbl = tail.split('::');
  if (dbl.length > 2) return false;
  const hexGroup = /^[0-9a-fA-F]{1,4}$/;
  if (dbl.length === 1) {
    const g = tail.split(':');
    return g.length === groupsNeeded && g.every((x) => hexGroup.test(x));
  }
  const left = dbl[0] === '' ? [] : (dbl[0] as string).split(':');
  const right = dbl[1] === '' ? [] : (dbl[1] as string).split(':');
  groupsNeeded = 8;
  return (
    left.length + right.length <= groupsNeeded - 1 &&
    left.every((x) => hexGroup.test(x)) &&
    right.every((x) => hexGroup.test(x))
  );
}

function checkBracketedHost(host: string): void {
  if (host.startsWith('v') || host.startsWith('V')) {
    if (!/^[vV][a-fA-F0-9]+\..+$/s.test(host)) throw new PyValueError('IPvFuture address is invalid');
  } else if (isIPv4(host)) {
    throw new PyValueError('An IPv4 address cannot be in brackets');
  } else if (!isIPv6(host)) {
    throw new PyValueError(`${pyRepr(host)} does not appear to be an IPv4 or IPv6 address`);
  }
}

function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

function checkBracketedNetloc(netloc: string): void {
  const at = netloc.lastIndexOf('@');
  const hostAndPort = at < 0 ? netloc : netloc.slice(at + 1);
  const [before, hasOpen, bracketed] = partition(hostAndPort, '[');
  let hostname: string;
  if (hasOpen) {
    if (before) throw new PyValueError('Invalid IPv6 URL');
    const [h, , port] = partition(bracketed, ']');
    hostname = h;
    if (port && !port.startsWith(':')) throw new PyValueError('Invalid IPv6 URL');
  } else {
    hostname = partition(hostAndPort, ':')[0];
  }
  checkBracketedHost(hostname);
}

function checkNetloc(netloc: string): void {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, '');
  const n2 = n.normalize('NFKC');
  if (n === n2) return;
  for (const c of '/?#@:') {
    if (n2.includes(c)) {
      throw new PyValueError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
    }
  }
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;

interface RawSplit {
  scheme: string | null;
  netloc: string | null;
  path: string;
  query: string | null;
  fragment: string | null;
}

/** urllib.parse._urlsplit (Python 3.14): absent components are null. */
function rawUrlsplit(input: string): RawSplit {
  // eslint-disable-next-line no-control-regex
  let url = input.replace(/^[\x00-\x20]+/, '');
  url = url.replace(/[\t\r\n]/g, '');
  let scheme: string | null = null;
  let netloc: string | null = null;
  let query: string | null = null;
  let fragment: string | null = null;
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') {
      const w = url.indexOf(c, 2);
      if (w >= 0) delim = Math.min(delim, w);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    const lb = netloc.includes('[');
    const rb = netloc.includes(']');
    if (lb !== rb) throw new PyValueError('Invalid IPv6 URL');
    if (lb && rb) checkBracketedNetloc(netloc);
  }
  const h = url.indexOf('#');
  if (h >= 0) {
    fragment = url.slice(h + 1);
    url = url.slice(0, h);
  }
  const q = url.indexOf('?');
  if (q >= 0) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  checkNetloc(netloc ?? '');
  return { scheme, netloc, path: url, query, fragment };
}

/** urllib.parse.urlsplit (Python 3.14). */
export function pyUrlsplit(input: string): SplitResult {
  const r = rawUrlsplit(input);
  return { scheme: r.scheme ?? '', netloc: r.netloc ?? '', path: r.path, query: r.query ?? '', fragment: r.fragment ?? '' };
}

function rawUnsplit(scheme: string | null, netloc: string | null, path: string, query: string | null, fragment: string | null): string {
  let url = path;
  if (netloc !== null) {
    if (url && url[0] !== '/') url = '/' + url;
    url = '//' + netloc + url;
  } else if (url.startsWith('//')) url = '//' + url;
  if (scheme) url = scheme + ':' + url;
  if (query !== null) url += '?' + query;
  if (fragment !== null) url += '#' + fragment;
  return url;
}

const USES_RELATIVE = ['', 'ftp', 'http', 'gopher', 'nntp', 'imap', 'wais', 'file', 'https', 'shttp', 'mms', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'sftp', 'svn', 'svn+ssh', 'ws', 'wss'];
const USES_NETLOC = ['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https', 'shttp', 'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh', 'ws', 'wss', 'itms-services'];

/** urllib.parse.urljoin (Python 3.14). */
export function pyUrljoin(base: string, url: string): string {
  if (!base) return url;
  if (!url) return base;
  const b = rawUrlsplit(base);
  const u = rawUrlsplit(url);
  const bscheme = b.scheme;
  let scheme = u.scheme;
  if (scheme === null) scheme = bscheme;
  if (scheme !== bscheme || (scheme && !USES_RELATIVE.includes(scheme))) return url;
  let netloc = u.netloc;
  if (!scheme || USES_NETLOC.includes(scheme)) {
    if (netloc) return rawUnsplit(scheme, netloc, u.path, u.query, u.fragment);
    netloc = b.netloc;
  }
  let path = u.path;
  if (!path) {
    path = b.path;
    let query = u.query;
    let fragment = u.fragment;
    if (query === null) {
      query = b.query;
      if (fragment === null) fragment = b.fragment;
    }
    return rawUnsplit(scheme, netloc, path, query, fragment);
  }
  const baseParts = b.path.split('/');
  if (baseParts[baseParts.length - 1] !== '') baseParts.pop();
  let segments: string[];
  if (path.startsWith('/')) segments = path.split('/');
  else {
    segments = [...baseParts, ...path.split('/')];
    const mid = segments.slice(1, -1).filter((x) => x !== '');
    segments = [segments[0] as string, ...mid, segments[segments.length - 1] as string];
  }
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '..') resolved.pop();
    else if (seg === '.') continue;
    else resolved.push(seg);
  }
  const last = segments[segments.length - 1];
  if (last === '.' || last === '..') resolved.push('');
  return rawUnsplit(scheme, netloc, resolved.join('/') || '/', u.query, u.fragment);
}
