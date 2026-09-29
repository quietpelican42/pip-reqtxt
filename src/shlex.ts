/**
 * shlex.split(s) as Python runs it: POSIX mode, whitespace_split, no comments.
 * Whitespace is space, tab, CR and LF only. Quotes are ' and ". Backslash
 * escapes any character outside quotes and only " and \ inside double quotes.
 */
export class ShlexError extends Error {}

export function shlexSplit(s: string): string[] {
  const tokens: string[] = [];
  const chars = Array.from(s);
  let i = 0;
  let state: ' ' | 'a' | "'" | '"' | '\\' = ' ';
  // state ' ': between tokens; 'a': inside a word; quote states; '\\': escape outside quotes
  let token = '';
  let escapedState: 'a' | '"' = 'a';
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  while (i <= chars.length) {
    const c = i < chars.length ? (chars[i] as string) : null;
    i++;
    if (state === ' ') {
      if (c === null) break;
      if (isWs(c)) continue;
      token = '';
      if (c === '\\') {
        escapedState = 'a';
        state = '\\';
      } else if (c === "'" || c === '"') state = c;
      else {
        token = c;
        state = 'a';
      }
    } else if (state === "'") {
      if (c === null) throw new ShlexError('No closing quotation');
      if (c === "'") state = 'a';
      else token += c;
    } else if (state === '"') {
      if (c === null) throw new ShlexError('No closing quotation');
      if (c === '"') state = 'a';
      else if (c === '\\') {
        escapedState = '"';
        state = '\\';
      } else token += c;
    } else if (state === '\\') {
      if (c === null) throw new ShlexError('No escaped character');
      if (escapedState === '"' && c !== '"' && c !== '\\') token += '\\';
      token += c;
      state = escapedState;
    } else {
      // 'a'
      if (c === null || isWs(c)) {
        tokens.push(token);
        token = '';
        state = ' ';
        if (c === null) break;
      } else if (c === '\\') {
        escapedState = 'a';
        state = '\\';
      } else if (c === "'" || c === '"') state = c;
      else token += c;
    }
  }
  return tokens;
}
