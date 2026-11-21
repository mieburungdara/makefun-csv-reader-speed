// The driver the harness runs (node /bot/main.ts, node22): it reads every case from /input/cases.json and writes
// every case's answer to /output/answers.json. The cases are read as bytes and the answers written as bytes: solve.js's
// emitAnswers takes the file's own bytes and returns the answers' bytes, so neither file is ever turned into a string
// and the answer never passes through a value tree. Where solve.js offers no byte path, the driver falls back to the
// reference shape: the cases are parsed, answered one by one with run(), and written as JSON.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const solve = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  emitAnswers?: (bytes: Buffer) => Buffer;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const bytes = readFileSync(join(INPUT_DIR, 'cases.json'));

if (typeof solve.emitAnswers === 'function') {
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), solve.emitAnswers(bytes));
} else {
  const cases = JSON.parse(bytes.toString('utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(solve.run(c.input));
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
}
