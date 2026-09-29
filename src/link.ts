/*
 * Derived in part from pip (https://github.com/pypa/pip), Copyright (c) The
 * pip developers, MIT License. See LICENSE-pip.
 *
 * pip's Link (the parts a requirements line touches), VCS scheme table and
 * local-path helpers.
 */
import { PipError } from './errors.ts';
import {
  pyQuote,
  pyRepr,
  pyUnquote,
  pyUrlsplit,
  posixAbspath,
  posixBasename,
  posixNormpath,
  posixSplitext,
  richEscape,
  type SplitResult,
} from './pyish.ts';

/** What pip asks the filesystem about while classifying a line. */
export interface FileSystem {
  /** An absolute path. Lexically normalized, except that an `-e` target containing `..` is passed as written. */
  isDir(path: string): boolean;
  isFile(path: string): boolean;
  /** File contents as text, used only to word the hint on an invalid path-like requirement. */
  readFile?(path: string): string | undefined;
}

export interface PathContext {
  cwd: string;
  fs: FileSystem;
}

export const VCS_NAMES = ['bzr', 'git', 'hg', 'svn'];
export const VCS_SCHEMES = [
  'bzr+http', 'bzr+https', 'bzr+ssh', 'bzr+sftp', 'bzr+ftp', 'bzr+lp', 'bzr+file',
  'git+http', 'git+https', 'git+ssh', 'git+git', 'git+file',
  'hg+file', 'hg+http', 'hg+https', 'hg+ssh', 'hg+static-http',
  'svn+ssh', 'svn+http', 'svn+https', 'svn+svn', 'svn+file',
];

const ARCHIVE_EXTENSIONS = [
  '.zip', '.whl', '.tar.bz2', '.tbz', '.tar.gz', '.tgz', '.tar',
  '.tar.xz', '.txz', '.tlz', '.tar.lz', '.tar.lzma',
];

/** pip.utils.misc.splitext: like os.path.splitext but keeps `.tar`. */
export function pipSplitext(path: string): [string, string] {
  let [base, ext] = posixSplitext(path);
  if (base.toLowerCase().endsWith('.tar')) {
    ext = base.slice(-4) + ext;
    base = base.slice(0, -4);
  }
  return [base, ext];
}

export function isArchiveFile(name: string): boolean {
  return ARCHIVE_EXTENSIONS.includes(pipSplitext(name)[1].toLowerCase());
}

export function isUrl(name: string): boolean {
  const scheme = pyUrlsplit(name).scheme;
  if (!scheme) return false;
  return ['http', 'https', 'file', 'ftp', ...VCS_SCHEMES].includes(scheme);
}

/** pip.utils.urls.path_to_url. */
export function pathToUrl(path: string, ctx: PathContext): string {
  const p = posixNormpath(posixAbspath(path, ctx.cwd));
  // pathname2url puts an empty authority in front of the root; urljoin("file://", ...) then
  // keeps a two-slash root as it is, which yields four slashes after "file:".
  const root = p.startsWith('//') && !p.startsWith('///') ? '//' : '/';
  return 'file://' + root + pyQuote(p.slice(root.length));
}

const EGG_RE = /[#&]egg=([^&]*)/;
// Python's re.IGNORECASE also lets U+0130, U+0131, U+017F and U+212A stand in for ASCII letters.
const AL = 'A-Za-z\\u0130\\u0131\\u017f\\u212a';
const PROJECT_NAME_RE = new RegExp(`^(?:[${AL}0-9]|[${AL}0-9][${AL}0-9._-]*[${AL}0-9])$`);

function splitAuthFromNetloc(netloc: string): string {
  const i = netloc.lastIndexOf('@');
  return i < 0 ? netloc : netloc.slice(i + 1);
}

function toPathComponent(name: string): string {
  const b = posixBasename(name);
  return b === '' || b === '.' || b === '..' ? '' : b;
}

/** pip.models.link.Link, reduced to what requirement-line handling reads. */
export class Link {
  readonly url: string;
  readonly split: SplitResult;
  readonly path: string;
  readonly eggFragment: string | null;

  constructor(url: string, ctx: PathContext) {
    let u = url;
    if (u.startsWith('\\\\')) u = pathToUrl(u, ctx);
    this.url = u;
    this.split = pyUrlsplit(u);
    this.path = pyUnquote(this.split.path);
    const m = EGG_RE.exec(u);
    if (m === null) this.eggFragment = null;
    else {
      const fragment = m[1] as string;
      if (!PROJECT_NAME_RE.test(fragment)) throw invalidEggFragment(fragment);
      this.eggFragment = fragment;
    }
  }

  get scheme(): string {
    return this.split.scheme;
  }
  get netloc(): string {
    return this.split.netloc;
  }
  get filename(): string {
    const name = toPathComponent(posixBasename(this.path.replace(/\/+$/, '')));
    if (name) return name;
    return toPathComponent(splitAuthFromNetloc(this.netloc));
  }
  get ext(): string {
    return pipSplitext(posixBasename(this.path.replace(/\/+$/, '')))[1];
  }
  get isFile(): boolean {
    return this.scheme === 'file';
  }
  get isWheel(): boolean {
    return this.ext === '.whl';
  }
  get isVcs(): boolean {
    return VCS_SCHEMES.includes(this.scheme);
  }

  /** Link.file_path; raises what pip.utils.urls.url_to_path raises on POSIX. */
  checkFilePath(): void {
    if (!this.url.startsWith('file:')) {
      throw new PipError(
        'AssertionError',
        `You can only turn file: urls into filenames (not ${pyRepr(this.url)})`,
      );
    }
    const netloc = this.split.netloc;
    if (netloc && netloc !== 'localhost') {
      throw new PipError(
        'ValueError',
        `non-local file URIs are not supported on this platform: ${pyRepr(this.url)}`,
      );
    }
    // url2pathname('file:' + path): a path that starts with // has an authority
    const authority = pyUrlsplit('file:' + this.split.path).netloc;
    if (authority && authority !== 'localhost') {
      throw new PipError('URLError', '<urlopen error file:// scheme is supported only on localhost>');
    }
  }
}

function invalidEggFragment(fragment: string): PipError {
  return new PipError('InvalidEggFragment', `The '${richEscape(fragment)}' egg fragment is invalid`);
}
