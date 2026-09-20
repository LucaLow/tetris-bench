/**
 * One-off migration to Tetris Bench v3: withdraw the v2 index and remove the
 * v1/v2 recording files from the public tree.
 *
 *   node scripts/tetris-bench/archive-old-recordings.mjs [--dir public/tetris-bench]
 *
 * - `index.json` (a v2 index) becomes `archive-v2.json` with `withdrawn: true`
 *   and a note; a v3 index is left where it is.
 * - `archive-v1.json` is kept.
 * - every file under `runs/` that is not a v3 recording is deleted; the old
 *   files remain in git history (v1 at ffb8afd, v2 at 9bc56f8).
 * Prints what it moved and removed.
 */
import { readFile, writeFile, unlink, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const INDEX_FORMAT_V3 = 'tetris-bench-index@3';
const V3_RECORDING = /^v3-[0-9]{17}-[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/;
const WITHDRAWAL_NOTE =
  'Withdrawn on 2026-09-20 with the move to tetris-bench@3: v2 credited T-spins on hard drops, exposed duplicate candidates, ' +
  'ended an IQ game on a single timeout, only asked slow brains every other Blitz tick, capped Blitz at 100 ms so every hosted model ' +
  'scored zero, and its prompt steered every LLM to the deepest drop. The v2 recording files were removed from the site and remain in git history at commit 9bc56f8 (v1 at ffb8afd).';

function parseDirectory(argv) {
  let directory = 'public/tetris-bench';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      const value = argv[i + 1];
      if (!value) throw new Error('--dir needs a value');
      directory = value;
      i++;
      continue;
    }
    throw new Error(`Unknown option: ${argv[i]}`);
  }
  return path.resolve(directory);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function archiveIndex(directory) {
  const indexPath = path.join(directory, 'index.json');
  const archivePath = path.join(directory, 'archive-v2.json');
  if (!(await exists(indexPath))) {
    console.log('no index.json to archive');
    return;
  }
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  if (index.format === INDEX_FORMAT_V3) {
    console.log('index.json is already a v3 index; left in place');
    return;
  }
  if (await exists(archivePath)) throw new Error(`${archivePath} already exists; refusing to overwrite it`);
  const archived = { ...index, withdrawn: true, note: WITHDRAWAL_NOTE };
  await writeFile(archivePath, JSON.stringify(archived, null, 2) + '\n');
  await unlink(indexPath);
  console.log(`moved index.json (${String(index.ruleset)}) to archive-v2.json with withdrawn: true`);
}

async function removeOldRecordings(directory) {
  const runs = path.join(directory, 'runs');
  if (!(await exists(runs))) {
    console.log('no runs directory');
    return [];
  }
  const removed = [];
  for (const file of (await readdir(runs)).sort()) {
    if (V3_RECORDING.test(file)) continue;
    await unlink(path.join(runs, file));
    removed.push(file);
    console.log(`removed runs/${file}`);
  }
  console.log(`removed ${removed.length} pre-v3 recording files`);
  return removed;
}

async function main() {
  const directory = parseDirectory(process.argv.slice(2));
  await archiveIndex(directory);
  if (await exists(path.join(directory, 'archive-v1.json'))) console.log('kept archive-v1.json');
  await removeOldRecordings(directory);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
