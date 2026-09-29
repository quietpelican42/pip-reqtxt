/**
 * Read a requirements file and everything it includes from disk.
 *
 *   node examples/read-file.ts path/to/requirements.txt
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../src/index.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node examples/read-file.ts <requirements.txt>');
  process.exit(2);
}

const lines = parse(readFileSync(file), {
  filename: file,
  cwd: process.cwd(),
  env: process.env,
  fs: {
    isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
    isFile: (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
    readFile: (p) => readFileSync(p, 'utf8'),
  },
  resolveInclude: (_path, info) => readFileSync(resolve(info.resolved)),
});

for (const l of lines) {
  if (l.kind === 'requirement') console.log(`${l.file}:${l.lineno}  ${l.pep508.text ?? l.pep508.url}${l.editable ? '  (editable)' : ''}`);
  else if (l.kind === 'error') console.log(`${l.file}:${l.lineno}  error: ${l.message.split('\n')[0]}`);
}
process.exitCode = lines.some((l) => l.kind === 'error') ? 1 : 0;
