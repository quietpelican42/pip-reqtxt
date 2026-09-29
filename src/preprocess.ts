/*
 * Derived in part from pip (https://github.com/pypa/pip), Copyright (c) The
 * pip developers, MIT License. See LICENSE-pip.
 *
 * pip.req.req_file.preprocess: split, join continuations, strip comments,
 * expand ${VAR}. Each logical line keeps the physical lines it came from.
 */
import { PY_WS, pySplitLines, pyStrip, pyStripChars } from './pyish.ts';

const COMMENT_START = new RegExp(`^[${PY_WS}]*#`);
const COMMENT_SUB = new RegExp(`(^|[${PY_WS}]+)#.*$`);
const ENV_VAR = /\$\{([A-Z0-9_]+)\}/g;

/** One logical line as pip's parser sees it. */
export interface LogicalLine {
  /** First physical line, 1-based. */
  lineno: number;
  /** Last physical line the logical line spans. */
  endLineno: number;
  /** The physical source lines, joined with `\n`. */
  raw: string;
  /** The text handed to the option parser, after joining, comment removal and expansion. */
  text: string;
}

export type Env = Record<string, string | undefined>;

export function preprocess(content: string, env: Env): LogicalLine[] {
  const physical = pySplitLines(content);
  interface Joined {
    lineno: number;
    endLineno: number;
    text: string;
  }
  // join_lines
  const joined: Joined[] = [];
  let primary = 0;
  let parts: string[] = [];
  physical.forEach((line0, idx) => {
    const lineno = idx + 1;
    let line = line0;
    const isComment = COMMENT_START.test(line);
    if (!line.endsWith('\\') || isComment) {
      if (isComment) line = ' ' + line;
      if (parts.length > 0) {
        parts.push(line);
        joined.push({ lineno: primary, endLineno: lineno, text: parts.join('') });
        parts = [];
      } else joined.push({ lineno, endLineno: lineno, text: line });
    } else {
      if (parts.length === 0) primary = lineno;
      parts.push(pyStripChars(line, '\\'));
    }
  });
  if (parts.length > 0) {
    joined.push({ lineno: primary, endLineno: physical.length, text: parts.join('') });
  }
  const out: LogicalLine[] = [];
  for (const j of joined) {
    // ignore_comments
    let text = pyStrip(j.text.replace(COMMENT_SUB, ''));
    if (!text) continue;
    // expand_env_variables
    for (const m of text.matchAll(ENV_VAR)) {
      const value = env[m[1] as string];
      if (!value) continue;
      text = text.split(m[0]).join(value);
    }
    out.push({
      lineno: j.lineno,
      endLineno: j.endLineno,
      raw: physical.slice(j.lineno - 1, j.endLineno).join('\n'),
      text,
    });
  }
  return out;
}
