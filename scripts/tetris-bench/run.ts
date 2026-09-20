import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { builtInBrains, jevBrain, openRouterBrain } from '../../lib/tetris-bench/adapters.ts';
import { runGame, percentile } from '../../lib/tetris-bench/harness.ts';
import { OFFICIAL_SEEDS, rateField } from '../../lib/tetris-bench/rating.ts';
import { RULESET, MAX_PIECES, MAX_TICKS } from '../../lib/tetris-bench/engine.ts';
import type { Brain, GameResult, TournamentIndex, Metrics } from '../../lib/tetris-bench/contract.ts';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Tetris Bench: node scripts/tetris-bench/run.ts [--official] [--remote] [--brains slug,slug] [--concurrency 1] [--out public/tetris-bench] [--merge] [--max-pieces N] [--max-ticks N]\nDefault: quick three-seed local exhibition. Official: five frozen seeds, 500 pieces, 10000 ticks. Parallel games use isolated Node processes. Remote brains require OPENROUTER_API_KEY.'); process.exit(0); }
const booleanFlags = new Set(['--official', '--remote', '--merge']);
const valueFlags = new Set(['--brains', '--concurrency', '--out', '--max-pieces', '--max-ticks', '--game']);
for (let i = 0; i < args.length; i++) { if (booleanFlags.has(args[i])) continue; if (!valueFlags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${args[i]}`); i++; }

const value = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const officialRequested = args.includes('--official');
const maxPieces = Number(value('--max-pieces', String(MAX_PIECES))), maxTicks = Number(value('--max-ticks', String(MAX_TICKS)));
const concurrency = Number(value('--concurrency', '1'));
for (const [name, n] of Object.entries({ maxPieces, maxTicks, concurrency })) if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
if (concurrency > 16) throw new Error('Concurrency cannot exceed 16');
const official = officialRequested && maxPieces === MAX_PIECES && maxTicks === MAX_TICKS;
if (officialRequested && !official) throw new Error('Official runs cannot override the frozen game caps');
const seeds = OFFICIAL_SEEDS.slice(0, officialRequested ? 5 : 3);
const available: Brain[] = [...builtInBrains];
if (args.includes('--remote') || value('--brains', '').split(',').some(s => ['jev', 'llm-classifier'].includes(s))) available.push(jevBrain(), openRouterBrain());
const selected = value('--brains', '').split(',').filter(Boolean);
const brains = selected.length ? available.filter(b => selected.includes(b.slug)) : available;
if (!brains.length || selected.some(s => !brains.some(b => b.slug === s))) throw new Error('Unknown or unavailable brain');
const sourceHashes: Record<string, string> = {};
for (const name of ['engine', 'contract', 'harness', 'adapters', 'rating']) sourceHashes[`lib/tetris-bench/${name}.ts`] = createHash('sha256').update(await readFile(new URL(`../../lib/tetris-bench/${name}.ts`, import.meta.url))).digest('hex');
sourceHashes['scripts/tetris-bench/run.ts'] = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const out = resolve(value('--out', 'public/tetris-bench'));
let previous: TournamentIndex | undefined;
if (args.includes('--merge')) {
  previous = JSON.parse(await readFile(resolve(out, 'index.json'), 'utf8')) as TournamentIndex;
  if (previous.ruleset !== RULESET || previous.official !== official || previous.maxPieces !== maxPieces || previous.maxTicks !== maxTicks || JSON.stringify(previous.seeds) !== JSON.stringify(seeds)) throw new Error('Cannot merge different protocols');
}
await mkdir(resolve(out, 'runs'), { recursive: true });
if (args.includes('--game')) {
  const [slug, seed, mode] = value('--game', '').split(',');
  const brain = brains.find(b => b.slug === slug);
  if (!brain || !seeds.includes(seed) || (mode !== 'IQ' && mode !== 'Blitz')) throw new Error('Invalid worker game');
  const game = await runGame(brain, seed, mode, { maxPieces, maxTicks });
  await writeFile(resolve(out, 'runs', `${game.id}.json`), JSON.stringify(game));
  process.exit(0);
}
const games: GameResult[] = [];
const jobs = brains.flatMap(brain => seeds.flatMap(seed => (['IQ', 'Blitz'] as const).map(mode => ({ brain, seed, mode }))));
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const { brain, seed, mode } = jobs[cursor++];
    let result: GameResult;
    if (concurrency > 1) {
      const childArgs = [fileURLToPath(import.meta.url), '--brains', brain.slug, '--game', `${brain.slug},${seed},${mode}`, '--out', out, '--max-pieces', String(maxPieces), '--max-ticks', String(maxTicks), ...(official ? ['--official'] : [])];
      await new Promise<void>((resolveJob, reject) => execFile(process.execPath, childArgs, { maxBuffer: 1_000_000 }, error => error ? reject(new Error('Isolated game worker failed')) : resolveJob()));
      result = JSON.parse(await readFile(resolve(out, 'runs', `${brain.slug}-${seed}-${mode.toLowerCase()}.json`), 'utf8')) as GameResult;
    } else result = await runGame(brain, seed, mode, { maxPieces, maxTicks });
    games.push(result);
    await writeFile(resolve(out, 'runs', `${result.id}.json`), JSON.stringify(result));
    console.log(`${result.id}: ${result.score} points, ${result.pieces} pieces, ${result.metrics.misses} misses`);
  }
}));
if (previous) {
  for (const oldBrain of previous.leaderboard) if (!brains.some(b => b.slug === oldBrain.slug)) {
    brains.push({ ...oldBrain, decide: () => null });
    for (const old of previous.runs.filter(g => g.brain === oldBrain.slug)) games.push(JSON.parse(await readFile(resolve(out, 'runs', `${old.id}.json`), 'utf8')) as GameResult);
  }
}
for (const [path, expected] of Object.entries(sourceHashes)) {
  const actual = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex');
  if (actual !== expected) throw new Error('Source changed during the run. Results must be regenerated before publication.');
}
const { ratings, matches } = rateField(brains.map(b => b.slug), seeds, games);
const aggregate = (items: GameResult[]): Metrics => {
  const latencies = items.flatMap(g => g.frames.flatMap(f => f.decision?.called && f.decision.status !== 'miss' ? [f.decision.latencyMs] : []));
  const calibration = items.map(g => g.metrics.calibrationError).filter((n): n is number => n !== null);
  return { p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), costUsd: items.every(g => g.metrics.costUsd !== null) ? items.reduce((s,g) => s + (g.metrics.costUsd ?? 0),0) / items.length : null, calibrationError: calibration.length ? calibration.reduce((a,b) => a+b,0) / calibration.length : null, calls: items.reduce((s,g) => s+g.metrics.calls,0), misses: items.reduce((s,g) => s+g.metrics.misses,0), invalid: items.reduce((s,g) => s+g.metrics.invalid,0), stale: items.reduce((s,g) => s+g.metrics.stale,0) };
};
let sourceCommit: string | null = null;
let sourceDirty = true;
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); sourceDirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(); } catch { /* standalone archive */ }
const index: TournamentIndex = { ruleset: RULESET, generatedAt: new Date().toISOString(), official, seeds, maxPieces, maxTicks, rating: 'Elo 1500 / K32', provenance: { runtime: process.version, platform: `${process.platform}/${process.arch}`, sourceCommit, sourceDirty, sourceHashes, concurrency, ...(previous ? { previousBatches: [previous.provenance] } : {}) }, leaderboard: brains.map(b => {
  const own = games.filter(g => g.brain === b.slug), points = matches.filter(m => m.a === b.slug || m.b === b.slug).map(m => m.a === b.slug ? m.point : 1-m.point);
  return { slug: b.slug, name: b.name, description: b.description, kind: b.kind, ...(b.model ? { model: b.model } : {}), cr: Math.round(ratings[b.slug]), games: own.length, wins: points.filter(p => p > .5).length, draws: points.filter(p => p === .5).length, losses: points.filter(p => p < .5).length, meanScore: own.reduce((s,g) => s+g.score,0) / own.length, metrics: aggregate(own) };
}).sort((a,b) => b.cr-a.cr || a.slug.localeCompare(b.slug)), runs: games.sort((a,b) => a.id.localeCompare(b.id)).map(({ frames: _frames, ...game }) => game), matches };
await writeFile(resolve(out, 'index.json'), JSON.stringify(index, null, 2));
console.log(`Wrote ${games.length} games and ${matches.length} matches to ${out} (${official ? 'official' : 'exhibition'})`);
