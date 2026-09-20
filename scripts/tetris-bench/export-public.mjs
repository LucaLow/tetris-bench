/**
 * Export the auditable harness to a standalone directory: engine, contract,
 * features, harness, recording, adapters, model registry, rating, runner,
 * probe and their tests, plus the rules, changelog and README. Never the
 * website code, the site-only modules, the published results or any env.
 *
 *   node scripts/tetris-bench/export-public.mjs <directory> [--force]
 *
 * The directory must not exist unless --force is given, in which case the
 * exported files are written over it (other files there are left alone).
 */
import { cp, mkdir, writeFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';

const HARNESS_VERSION = '3.0.0';
const LIB_FILES = ['engine.ts', 'contract.ts', 'features.ts', 'harness.ts', 'recording.ts', 'adapters.ts', 'models.ts', 'rating.ts'];
const SCRIPT_FILES = [
  'run.ts', 'runner-integrity.ts', 'probe.ts', 'archive-old-recordings.mjs', 'export-public.mjs',
  'engine.test.ts', 'harness.test.ts', 'recording.test.ts', 'adapters.test.ts', 'rating.test.ts', 'runner.test.ts',
];
const DOC_FILES = ['docs/tetris-bench-rules.md', 'docs/tetris-bench-changelog.md'];
const README_SOURCE = 'docs/tetris-bench-readme.md';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const destination = argv.find(argument => !argument.startsWith('--'));
if (!destination) throw new Error('Usage: node scripts/tetris-bench/export-public.mjs <new-directory> [--force]');
const root = path.resolve(destination);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

if (!force && (await exists(root))) throw new Error('Destination must not exist (pass --force to write over it)');

async function copyInto(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
}

for (const file of LIB_FILES) await copyInto(path.join('lib/tetris-bench', file), path.join(root, 'lib/tetris-bench', file));
for (const file of SCRIPT_FILES) await copyInto(path.join('scripts/tetris-bench', file), path.join(root, 'scripts/tetris-bench', file));
for (const file of DOC_FILES) await copyInto(file, path.join(root, file));

const readme = await readFile(README_SOURCE, 'utf8');
await writeFile(path.join(root, 'README.md'), readme.endsWith('\n') ? readme : readme + '\n');

await writeFile(path.join(root, 'package.json'), JSON.stringify({
  name: 'tetris-bench',
  version: HARNESS_VERSION,
  private: true,
  type: 'module',
  engines: { node: '>=24' },
  scripts: {
    test: 'node --test scripts/tetris-bench/*.test.ts',
    'bench:run': 'node scripts/tetris-bench/run.ts',
    'bench:probe': 'node scripts/tetris-bench/probe.ts',
  },
}, null, 2) + '\n');
await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.env*\npublic/tetris-bench/\n');
await mkdir(path.join(root, '.github/workflows'), { recursive: true });
await writeFile(path.join(root, '.github/workflows/check.yml'), `name: Harness checks
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm test
`);
console.log(root);
