#!/usr/bin/env node
/**
 * Re-copies stenographer's truth format v2 spec (spec/truth-format: the
 * README, the JSON Schema and the golden fixtures) into
 * test/fixtures/truth-format/, keeping the fixtures' directory layout, and
 * records where they came from in test/fixtures/truth-format/SOURCE.
 *
 *   node scripts/sync-truth-fixtures.mjs ../stenographer
 *   STENOGRAPHER_DIR=../stenographer npm run sync:truth-fixtures
 *
 * The fixtures are the contract: review the diff, then run
 * `npx vitest run src/truth/conformance.test.ts`. SOURCE lists every copied
 * file with its sha256, and the conformance test refuses files that differ
 * from it, so fixtures are only ever changed by re-running this script.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? process.env.STENOGRAPHER_DIR;
if (!source) {
  console.error('usage: node scripts/sync-truth-fixtures.mjs <stenographer checkout>  (or set STENOGRAPHER_DIR)');
  process.exit(2);
}

const checkout = resolve(source);
const spec = join(checkout, 'spec', 'truth-format');
for (const required of ['README.md', 'wiki-line.v2.schema.json', 'fixtures']) {
  if (!existsSync(join(spec, required))) {
    console.error(`${spec} has no ${required}: is ${checkout} a stenographer checkout with the truth format v2 spec?`);
    process.exit(1);
  }
}

const dest = join(repo, 'test', 'fixtures', 'truth-format');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(spec, 'README.md'), join(dest, 'README.md'));
cpSync(join(spec, 'wiki-line.v2.schema.json'), join(dest, 'wiki-line.v2.schema.json'));
// fixtures/{signers.json, valid/, invalid/, v1/} land directly under dest
cpSync(join(spec, 'fixtures'), dest, { recursive: true });

/** git output in the stenographer checkout, or null when git can't answer. */
function git(...args) {
  try {
    // --no-optional-locks: never touch the other checkout's index
    return execFileSync('git', ['--no-optional-locks', '-C', checkout, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const commit = git('rev-parse', 'HEAD') ?? 'unknown';
const specCommit = git('log', '-1', '--format=%H', '--', 'spec/truth-format') || 'unknown';
const status = git('status', '--porcelain', '--', 'spec/truth-format');
const dirty = status === null ? 'unknown' : status.length > 0 ? 'yes' : 'no';

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(dest, join(dir, e.name)).split(sep).join('/')],
  );
}
const files = walk(dest).sort();
const sha256 = (path) => createHash('sha256').update(readFileSync(join(dest, path))).digest('hex');

writeFileSync(
  join(dest, 'SOURCE'),
  [
    '# Copied by scripts/sync-truth-fixtures.mjs. Do not edit these files by hand: re-run the script.',
    'repository: https://github.com/johnnyclem/stenographer',
    'path: spec/truth-format',
    `commit: ${commit}`,
    `spec-last-changed: ${specCommit}`,
    `uncommitted-changes: ${dirty}`,
    'files:',
    ...files.map((f) => `  ${sha256(f)}  ${f}`),
    '',
  ].join('\n'),
);

console.log(`copied ${files.length} files from ${spec} (commit ${commit}${dirty === 'yes' ? ', with uncommitted changes' : ''}) to ${relative(repo, dest)}`);
