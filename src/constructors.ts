/*
 * Derived in part from pip (https://github.com/pypa/pip), Copyright (c) The
 * pip developers, MIT License. See LICENSE-pip.
 *
 * pip.req.constructors: how one requirement line (or `-e` target) becomes a
 * requirement, a link, extras and markers.
 */
import { PipError, toPipError } from './errors.ts';
import {
  Link,
  VCS_NAMES,
  VCS_SCHEMES,
  isArchiveFile,
  isUrl,
  pathToUrl,
  type PathContext,
} from './link.ts';
import {
  InvalidMarker,
  InvalidRequirement,
  InvalidSpecifier,
  Marker,
  parseMarkerText,
  parseRequirementText,
  parseWheelFilename,
  type ParsedDependency,
} from './packaging.ts';
import { posixAbspath, posixJoin, posixNormpath, pyRepr, pyStrip } from './pyish.ts';

const OPERATORS = ['~=', '==', '!=', '<=', '>=', '<', '>', '==='];

export interface RequirementParts {
  req: ParsedDependency | null;
  link: Link | null;
  markers: string | null;
  extras: string[];
}

function getRequirement(text: string): ParsedDependency {
  return parseRequirementText(text);
}

function stripExtras(path: string): [string, string[]] {
  const m = /^([^\n]+)(\[[^\]]+\])$/.exec(path);
  if (!m) return [path, []];
  const noExtras = (m[1] as string).replace(/[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, '');
  const extras = getRequirement('placeholder' + (m[2] as string).toLowerCase()).extras;
  return [noExtras, extras];
}

function looksLikePath(name: string): boolean {
  return name.includes('/') || name.startsWith('.');
}

function isInstallableDir(path: string, ctx: PathContext): boolean {
  if (!ctx.fs.isDir(path)) return false;
  return ctx.fs.isFile(posixJoin(path, 'pyproject.toml')) || ctx.fs.isFile(posixJoin(path, 'setup.py'));
}

function getUrlFromPath(path: string, name: string, ctx: PathContext, warnings: string[]): string | null {
  if (looksLikePath(name) && ctx.fs.isDir(path)) {
    if (isInstallableDir(path, ctx)) return pathToUrl(path, ctx);
    throw new PipError(
      'InstallationError',
      `Directory ${pyRepr(name)} is not installable. Neither 'setup.py' nor 'pyproject.toml' found.`,
    );
  }
  if (!isArchiveFile(path)) return null;
  if (ctx.fs.isFile(path)) return pathToUrl(path, ctx);
  const at = name.indexOf('@');
  if (at >= 0 && !looksLikePath(name.slice(0, at))) return null;
  warnings.push(`Requirement ${pyRepr(name)} looks like a filename, but the file does not exist`);
  return pathToUrl(path, ctx);
}

/** pip.req.constructors.check_first_requirement_in_file */
function checkFirstRequirementInFile(content: string): void {
  const raw = content.replace(/\r\n?/g, '\n').split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const lines = raw.map((l) => pyStrip(l)).filter((l) => l && !l.startsWith('#'));
  let idx = 0;
  if (idx >= lines.length) return;
  let line = lines[idx++] as string;
  const c = line.indexOf(' #');
  if (c >= 0) line = line.slice(0, c);
  if (line.endsWith('\\')) line = pyStrip(line.slice(0, -2)) + (lines[idx++] ?? '');
  getRequirement(line);
}

function deduceHelpfulMsg(req: string, ctx: PathContext): string {
  const abs = posixAbspath(req, ctx.cwd);
  if (!ctx.fs.isDir(abs) && !ctx.fs.isFile(abs)) return ` File '${req}' does not exist.`;
  let msg = ' The path does exist. ';
  if (ctx.fs.isDir(abs)) throw new PipError('IsADirectoryError', `[Errno 21] Is a directory: ${pyRepr(req)}`);
  try {
    checkFirstRequirementInFile(ctx.fs.readFile?.(abs) ?? '');
  } catch (e) {
    if (e instanceof InvalidRequirement) return msg;
    throw toPipError(e);
  }
  msg +=
    `The argument you provided (${req}) appears to be a requirements file. If that is the case, ` +
    `use the '-r' flag to install the packages specified within it.`;
  return msg;
}

/** pip.req.constructors.parse_req_from_line */
export function parseReqFromLine(
  nameIn: string,
  lineSource: string | null,
  ctx: PathContext,
  warnings: string[],
): RequirementParts {
  let name = nameIn;
  const markerSep = isUrl(name) ? '; ' : ';';
  let markers: Marker | null = null;
  const sepAt = name.indexOf(markerSep);
  if (sepAt >= 0) {
    const markersAsString = pyStrip(name.slice(sepAt + markerSep.length));
    name = name.slice(0, sepAt);
    if (markersAsString) {
      try {
        markers = parseMarkerText(markersAsString);
      } catch (e) {
        if (!(e instanceof InvalidMarker)) throw toPipError(e);
        throw new PipError('InstallationError', `Invalid requirement: ${pyRepr(pyStrip(name))}: ${e.message}`);
      }
    }
  }
  name = pyStrip(name);
  const path = posixNormpath(posixAbspath(name, ctx.cwd));
  let link: Link | null = null;
  let extras: string[] = [];
  if (isUrl(name)) {
    link = new Link(name, ctx);
  } else {
    let p: string;
    [p, extras] = stripExtras(path);
    const url = getUrlFromPath(p, name, ctx, warnings);
    if (url !== null) link = new Link(url, ctx);
  }
  let reqAsString: string | null;
  if (link) {
    if (link.scheme === 'file' && /\.\.\//.test(link.url)) {
      link = new Link(pathToUrl(posixNormpath(posixAbspath(link.path, ctx.cwd)), ctx), ctx);
    }
    if (link.isWheel) {
      try {
        const wheel = parseWheelFilename(link.filename);
        reqAsString = `${wheel.name}==${wheel.version}`;
      } catch (e) {
        throw toPipError(e);
      }
    } else reqAsString = link.eggFragment;
  } else reqAsString = name;

  let req: ParsedDependency | null = null;
  if (reqAsString !== null) {
    try {
      req = getRequirement(reqAsString);
    } catch (e) {
      if (!(e instanceof InvalidRequirement)) throw toPipError(e);
      let addMsg = '';
      if (reqAsString.includes('/')) addMsg = 'It looks like a path.' + deduceHelpfulMsg(reqAsString, ctx);
      else if (reqAsString.includes('=') && !OPERATORS.some((op) => reqAsString!.includes(op))) {
        addMsg = '= is not a valid operator. Did you mean == ?';
      }
      const base = `Invalid requirement: ${pyRepr(reqAsString)}: ${e.message}`;
      let msg = lineSource ? `${base} (from ${lineSource})` : base;
      if (addMsg) msg += `\nHint: ${addMsg}`;
      throw new PipError('InstallationError', msg);
    }
  }
  return { req, link, markers: markers === null ? null : markers.toString(), extras };
}

function parseDirectUrlEditable(editableReq: string): [string, string, string[]] | null {
  let req: ParsedDependency;
  try {
    req = getRequirement(editableReq);
  } catch (e) {
    // pip catches ValueError here, which covers InvalidRequirement and InvalidSpecifier
    if (e instanceof InvalidRequirement || e instanceof InvalidSpecifier) return null;
    throw toPipError(e);
  }
  if (!req.url) return null;
  const name = req.marker ? `${req.name} ; ${req.marker}` : req.name;
  return [name, req.url, req.extras];
}

function parsePipSyntaxEditable(editableReq: string, ctx: PathContext): [string | null, string, string[]] {
  let url = editableReq;
  const [urlNoExtrasIn, extras] = stripExtras(url);
  let urlNoExtras = urlNoExtrasIn;
  if (urlNoExtras !== '' && ctx.fs.isDir(fsPathOf(urlNoExtras, ctx))) urlNoExtras = pathToUrl(urlNoExtras, ctx);
  if (urlNoExtras.toLowerCase().startsWith('file:')) {
    return [new Link(urlNoExtras, ctx).eggFragment, urlNoExtras, extras];
  }
  for (const vc of VCS_NAMES) {
    if (url.toLowerCase().startsWith(`${vc}:`)) {
      url = `${vc}+${url}`;
      break;
    }
  }
  return [new Link(url, ctx).eggFragment, url, []];
}

/**
 * The path pip hands to os.path.isdir for an `-e` target. It is not normalized,
 * which only matters for `..` (a missing directory before it makes the path
 * unresolvable), so other paths are normalized for the caller's convenience.
 */
function fsPathOf(raw: string, ctx: PathContext): string {
  const abs = raw.startsWith('/') ? raw : posixJoin(ctx.cwd, raw);
  return abs.split('/').includes('..') ? abs : posixNormpath(abs);
}

/** pip.req.constructors.parse_req_from_editable */
export function parseReqFromEditable(editableReq: string, ctx: PathContext): RequirementParts {
  const direct = parseDirectUrlEditable(editableReq);
  const [packageName, url, extrasOverride] = direct ?? parsePipSyntaxEditable(editableReq, ctx);
  const link0 = new Link(url, ctx);
  if (!link0.isVcs && !link0.url.startsWith('file:')) {
    throw new PipError(
      'InstallationError',
      `${editableReq} is not a valid editable requirement. It should either be a path to a local project or a VCS URL (beginning with ${VCS_SCHEMES.join(', ')}).`,
    );
  }
  if (!packageName && !link0.url.startsWith('file:')) {
    throw new PipError(
      'InstallationError',
      `Could not detect requirement name for '${editableReq}', please specify one with your_package_name @ URL`,
    );
  }
  let req: ParsedDependency | null = null;
  if (packageName) {
    try {
      req = getRequirement(packageName);
    } catch (e) {
      if (!(e instanceof InvalidRequirement)) throw toPipError(e);
      throw new PipError('InstallationError', `Invalid requirement: ${pyRepr(packageName)}: ${e.message}`);
    }
  }
  return { req, link: new Link(url, ctx), markers: null, extras: extrasOverride };
}

export interface InstallInfo {
  req: ParsedDependency | null;
  url: string | null;
  extras: string[];
  marker: string | null;
}

/** The parts of InstallRequirement.__init__ that can raise or change the result. */
export function finishInstallRequirement(parts: RequirementParts, ctx: PathContext): InstallInfo {
  let link = parts.link;
  if (link === null && parts.req && parts.req.url) link = new Link(parts.req.url, ctx);
  if (link && link.isFile) link.checkFilePath();
  const extras = parts.extras.length > 0 ? parts.extras : parts.req ? parts.req.extras : [];
  const marker = parts.markers ?? (parts.req ? parts.req.marker : null);
  return { req: parts.req, url: link ? link.url : null, extras: [...extras].sort(), marker };
}

