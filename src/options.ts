/**
 * The option parser pip builds for each requirements-file line: an
 * optparse.OptionParser holding pip's SUPPORTED_OPTIONS and
 * SUPPORTED_OPTIONS_REQ, including optparse's unambiguous-prefix matching of
 * long options, short-option clusters and its error messages.
 */
import { pyRepr } from './pyish.ts';

export type OptionValue = string | true;

/** One option occurrence, in the order it appeared on the line. */
export interface OptionEvent {
  /** Canonical long name without the leading dashes, e.g. `index-url`. */
  name: string;
  /** The value, or `true` for a flag. */
  value: OptionValue;
}

/** Error whose message pip wraps as `Invalid requirement: <line>\n<msg>`. */
export class OptionParsingError extends Error {
  readonly msg: string;
  constructor(msg: string) {
    super(msg);
    this.msg = msg;
  }
}

/** pip.exceptions.CommandError raised from an option callback. */
export class OptionCommandError extends Error {}

interface OptionDef {
  short: string[];
  long: string[];
  name: string;
  kind: 'flag' | 'string' | 'choice';
  dest: string;
  callback?: 'no-binary' | 'all-releases' | 'hash' | 'config-settings';
  choices?: string[];
}

const USE_FEATURE_CHOICES = [
  'fast-deps',
  'inprocess-build-deps',
  'venv-isolation',
  'truststore',
  'no-binary-enable-wheel-cache',
  'build-constraint',
];

export const STRONG_HASHES = ['sha256', 'sha384', 'sha512'];

const OPTIONS: OptionDef[] = [
  { short: ['-i'], long: ['--index-url', '--pypi-url'], name: 'index-url', kind: 'string', dest: 'index_url' },
  { short: [], long: ['--extra-index-url'], name: 'extra-index-url', kind: 'string', dest: 'extra_index_urls' },
  { short: [], long: ['--no-index'], name: 'no-index', kind: 'flag', dest: 'no_index' },
  { short: ['-c'], long: ['--constraint'], name: 'constraint', kind: 'string', dest: 'constraints' },
  { short: ['-r'], long: ['--requirement'], name: 'requirement', kind: 'string', dest: 'requirements' },
  { short: ['-e'], long: ['--editable'], name: 'editable', kind: 'string', dest: 'editables' },
  { short: ['-f'], long: ['--find-links'], name: 'find-links', kind: 'string', dest: 'find_links' },
  { short: [], long: ['--no-binary'], name: 'no-binary', kind: 'string', dest: 'format_control', callback: 'no-binary' },
  { short: [], long: ['--only-binary'], name: 'only-binary', kind: 'string', dest: 'format_control', callback: 'no-binary' },
  { short: [], long: ['--prefer-binary'], name: 'prefer-binary', kind: 'flag', dest: 'prefer_binary' },
  { short: [], long: ['--require-hashes'], name: 'require-hashes', kind: 'flag', dest: 'require_hashes' },
  { short: [], long: ['--no-require-hashes'], name: 'no-require-hashes', kind: 'flag', dest: 'no_require_hashes' },
  { short: [], long: ['--pre'], name: 'pre', kind: 'flag', dest: 'pre' },
  { short: [], long: ['--all-releases'], name: 'all-releases', kind: 'string', dest: 'release_control', callback: 'all-releases' },
  { short: [], long: ['--only-final'], name: 'only-final', kind: 'string', dest: 'release_control', callback: 'all-releases' },
  { short: [], long: ['--trusted-host'], name: 'trusted-host', kind: 'string', dest: 'trusted_hosts' },
  {
    short: [],
    long: ['--use-feature'],
    name: 'use-feature',
    kind: 'choice',
    dest: 'features_enabled',
    choices: USE_FEATURE_CHOICES,
  },
  { short: [], long: ['--hash'], name: 'hash', kind: 'string', dest: 'hashes', callback: 'hash' },
  {
    short: ['-C'],
    long: ['--config-settings'],
    name: 'config-settings',
    kind: 'string',
    dest: 'config_settings',
    callback: 'config-settings',
  },
];

/** Every accepted flag name (long form, no dashes), in pip's order. */
export const OPTION_NAMES: readonly string[] = OPTIONS.map((o) => o.name);

const LONG = new Map<string, OptionDef>();
const SHORT = new Map<string, OptionDef>();
for (const o of OPTIONS) {
  for (const l of o.long) LONG.set(l, o);
  for (const s of o.short) SHORT.set(s, o);
}

export interface ParsedOptions {
  events: OptionEvent[];
  requirements: string[];
  constraints: string[];
  editables: string[];
  hashes: Record<string, string[]> | null;
  configSettings: Record<string, string | string[]> | null;
}

function parserError(prog: string, msg: string): never {
  // pip replaces parser.exit with a function whose second parameter receives
  // optparse's formatted "<prog>: error: <msg>\n" text.
  throw new OptionParsingError(`${prog}: error: ${msg}\n`);
}

function matchLong(prog: string, opt: string): string {
  if (LONG.has(opt)) return opt;
  const possibilities = [...LONG.keys()].filter((w) => w.startsWith(opt));
  if (possibilities.length === 1) return possibilities[0] as string;
  if (possibilities.length === 0) return parserError(prog, `no such option: ${opt}`);
  possibilities.sort();
  return parserError(prog, `ambiguous option: ${opt} (${possibilities.join(', ')}?)`);
}

function process(
  prog: string,
  def: OptionDef,
  opt: string,
  value: string | null,
  out: ParsedOptions,
): void {
  if (def.kind === 'choice') {
    const choices = def.choices as string[];
    if (!choices.includes(value as string)) {
      parserError(
        prog,
        `option ${opt}: invalid choice: ${pyRepr(value as string)} (choose from ${choices.map(pyRepr).join(', ')})`,
      );
    }
  }
  if (def.kind === 'flag') {
    out.events.push({ name: def.name, value: true });
    return;
  }
  const v = value as string;
  out.events.push({ name: def.name, value: v });
  switch (def.callback) {
    case 'no-binary':
    case 'all-releases':
      if (v.startsWith('-')) {
        throw new OptionCommandError(
          def.callback === 'no-binary'
            ? '--no-binary / --only-binary option requires 1 argument.'
            : '--all-releases / --only-final option requires 1 argument.',
        );
      }
      return;
    case 'hash': {
      const idx = v.indexOf(':');
      if (idx < 0) {
        parserError(
          prog,
          `Arguments to ${opt} must be a hash name followed by a value, like --hash=sha256:abcde...`,
        );
      }
      const algo = v.slice(0, idx);
      const digest = v.slice(idx + 1);
      if (!STRONG_HASHES.includes(algo)) {
        parserError(prog, `Allowed hash algorithms for ${opt} are ${STRONG_HASHES.join(', ')}.`);
      }
      out.hashes ??= {};
      (out.hashes[algo] ??= []).push(digest);
      return;
    }
    case 'config-settings': {
      const idx = v.indexOf('=');
      if (idx < 0) parserError(prog, `Arguments to ${opt} must be of the form KEY=VAL`);
      const key = v.slice(0, idx);
      const val = v.slice(idx + 1);
      out.configSettings ??= Object.create(null) as Record<string, string | string[]>;
      const cur = out.configSettings[key];
      if (cur === undefined) out.configSettings[key] = val;
      else if (Array.isArray(cur)) cur.push(val);
      else out.configSettings[key] = [cur, val];
      return;
    }
    default:
  }
  if (def.dest === 'requirements') out.requirements.push(v);
  else if (def.dest === 'constraints') out.constraints.push(v);
  else if (def.dest === 'editables') out.editables.push(v);
}

/** optparse's parse_args over the shlex-split option tokens of one line. */
export function parseOptionTokens(prog: string, args: string[]): ParsedOptions {
  const out: ParsedOptions = {
    events: [],
    requirements: [],
    constraints: [],
    editables: [],
    hashes: null,
    configSettings: null,
  };
  const rargs = args.slice();
  while (rargs.length > 0) {
    const arg = rargs[0] as string;
    if (arg === '--') {
      rargs.shift();
      return out;
    } else if (arg.startsWith('--')) {
      rargs.shift();
      let opt = arg;
      let hadExplicit = false;
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        opt = arg.slice(0, eq);
        rargs.unshift(arg.slice(eq + 1));
        hadExplicit = true;
      }
      opt = matchLong(prog, opt);
      const def = LONG.get(opt) as OptionDef;
      let value: string | null = null;
      if (def.kind !== 'flag') {
        if (rargs.length < 1) parserError(prog, `${opt} option requires 1 argument`);
        value = rargs.shift() as string;
      } else if (hadExplicit) {
        parserError(prog, `${opt} option does not take a value`);
      }
      process(prog, def, opt, value, out);
    } else if (arg.startsWith('-') && arg.length > 1) {
      rargs.shift();
      const chars = Array.from(arg.slice(1));
      let stop = false;
      let consumed = 0;
      for (const ch of chars) {
        const opt = '-' + ch;
        const def = SHORT.get(opt);
        consumed += ch.length;
        if (!def) return parserError(prog, `no such option: ${opt}`);
        let value: string | null = null;
        if (def.kind !== 'flag') {
          const rest = arg.slice(1 + consumed);
          if (rest.length > 0) {
            rargs.unshift(rest);
            stop = true;
          }
          if (rargs.length < 1) parserError(prog, `${opt} option requires 1 argument`);
          value = rargs.shift() as string;
        }
        process(prog, def, opt, value, out);
        if (stop) break;
      }
    } else {
      // interspersed positional argument: optparse collects and pip drops it
      rargs.shift();
    }
  }
  return out;
}
