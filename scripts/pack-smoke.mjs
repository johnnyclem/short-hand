#!/usr/bin/env node
/**
 * Pack-and-install smoke test for @shorthand/core (`npm run smoke:pack`,
 * after `npm run build`).
 *
 * 1. `npm pack` the repo and check the tarball: no tests, every "exports"
 *    target present, every source map's sources present, zero runtime
 *    dependencies, the release metadata (engines, publishConfig).
 * 2. Install the tarball into a fresh project with nothing else in it.
 * 3. Import every subpath export at runtime (test/smoke/runtime.mjs).
 * 4. Typecheck a consumer (test/smoke/consumer.ts) with skipLibCheck off
 *    under moduleResolution Node16 (with Node's types) and Bundler (DOM
 *    lib, no Node types), using this repo's TypeScript.
 *
 * Nothing here touches the network: the tarball has no dependencies, and
 * TypeScript and @types/node come from this repo's node_modules.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function fail(message) {
  console.error(`pack-smoke: ${message}`);
  process.exit(1);
}

if (!existsSync(join(repo, 'dist', 'index.js'))) fail('dist/ is missing: run `npm run build` first');

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'shorthand-pack-smoke-'));

try {
  // 1. Pack and check the file list.
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', work], repo));
  const files = new Set(packed.files.map((f) => f.path));
  const tarball = join(work, packed.filename);
  console.log(`packed ${packed.name}@${packed.version}: ${files.size} files, ${packed.size} bytes`);

  const tests = [...files].filter((f) => /\.test\.|(^|\/)test\//.test(f));
  if (tests.length) fail(`tarball contains test files: ${tests.join(', ')}`);
  for (const required of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'MIGRATION.md']) {
    if (!files.has(required)) fail(`tarball lacks ${required}`);
  }
  for (const [sub, target] of Object.entries(pkg.exports)) {
    const targets = typeof target === 'string' ? [target] : Object.values(target);
    for (const t of targets) {
      if (!files.has(posix.normalize(t))) fail(`exports["${sub}"] points at ${t}, which is not in the tarball`);
    }
  }
  if (Object.keys(pkg.dependencies ?? {}).length) fail('runtime dependencies must stay at zero');
  if (pkg.engines?.node !== '>=22') fail(`engines.node is ${pkg.engines?.node}, expected >=22`);
  if (pkg.publishConfig?.access !== 'public') fail('publishConfig.access must be public');

  // 2. Install into a fresh project.
  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'shorthand-smoke-consumer', private: true, type: 'module' }, null, 2),
  );
  run(npm, ['install', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error', tarball], consumer);
  const installed = join(consumer, 'node_modules', ...pkg.name.split('/'));

  // Source maps must resolve inside the installed package.
  let maps = 0;
  for (const f of files) {
    if (!f.endsWith('.map')) continue;
    maps++;
    const map = JSON.parse(readFileSync(join(installed, f), 'utf8'));
    for (const source of map.sources) {
      const target = posix.normalize(posix.join(posix.dirname(f), map.sourceRoot || '', source));
      if (!files.has(target)) fail(`${f} points at ${source}, which is not in the tarball`);
    }
  }
  console.log(`ok ${maps} source maps resolve inside the package`);

  // 3. Runtime: every subpath through Node's resolution.
  copyFileSync(join(repo, 'test', 'smoke', 'runtime.mjs'), join(consumer, 'runtime.mjs'));
  process.stdout.write(run(process.execPath, ['runtime.mjs'], consumer));

  // 4. Types: Node16 and Bundler consumers, skipLibCheck off.
  copyFileSync(join(repo, 'test', 'smoke', 'consumer.ts'), join(consumer, 'consumer.ts'));
  const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  const common = { target: 'ES2022', strict: true, noEmit: true, skipLibCheck: false, isolatedModules: true };
  const configs = {
    node16: { ...common, module: 'Node16', moduleResolution: 'Node16', lib: ['ES2022'], types: ['node'], typeRoots: [join(repo, 'node_modules', '@types')] },
    bundler: { ...common, module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], types: [] },
  };
  for (const [name, compilerOptions] of Object.entries(configs)) {
    const config = `tsconfig.${name}.json`;
    writeFileSync(join(consumer, config), JSON.stringify({ compilerOptions, files: ['consumer.ts'] }, null, 2));
    try {
      run(process.execPath, [tsc, '-p', config], consumer);
    } catch (err) {
      process.stdout.write(err.stdout ?? '');
      fail(`consumer does not typecheck under moduleResolution ${compilerOptions.moduleResolution}`);
    }
    console.log(`ok consumer typechecks under moduleResolution ${compilerOptions.moduleResolution}`);
  }

  console.log(`pack-smoke: ${packed.name}@${packed.version} OK`);
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
