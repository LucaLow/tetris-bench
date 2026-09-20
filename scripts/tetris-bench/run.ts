import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { builtInBrains, jevBrain, openRouterBrain } from '../../lib/tetris-bench/adapters.ts';
import { runGame, percentile } from '../../lib/tetris-bench/harness.ts';
import { OFFICIAL_SEEDS, QUICK_SEEDS, rateField } from '../../lib/tetris-bench/rating.ts';
import { RULESET, MAX_PIECES, MAX_TICKS } from '../../lib/tetris-bench/engine.ts';
import { artifactDigest, verifyRecording, assertMergeCompatible, assertOfficialPublishable, counterbalancedJobs } from './runner-integrity.ts';
import type { Brain, GameResult, TournamentIndex, Metrics } from '../../lib/tetris-bench/contract.ts';
const hardware = { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length };
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Tetris Bench: node scripts/tetris-bench/run.ts [--official] [--remote] [--brains slug,slug] [--concurrency 1] [--out public/tetris-bench] [--merge] [--max-pieces N] [--max-ticks N]\nDefault: quick three-seed local exhibition. Official: thirty frozen seeds, serial execution, 500 pieces, 10000 ticks. Parallel games use isolated Node processes. Remote brains require OPENROUTER_API_KEY.'); process.exit(0); }
const booleanFlags = new Set(['--official', '--remote', '--merge']);
const valueFlags = new Set(['--brains', '--concurrency', '--out', '--max-pieces', '--max-ticks', '--game', '--batch-id']);
for (let i = 0; i < args.length; i++) { if (booleanFlags.has(args[i])) continue; if (!valueFlags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${args[i]}`); i++; }

const value = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const officialRequested = args.includes('--official');
const maxPieces = Number(value('--max-pieces', String(MAX_PIECES))), maxTicks = Number(value('--max-ticks', String(MAX_TICKS)));
const concurrency = Number(value('--concurrency', '1'));
for (const [name, n] of Object.entries({ maxPieces, maxTicks, concurrency })) if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
if (officialRequested && concurrency !== 1) throw new Error('Official timing requires serial execution');
if (concurrency > 16) throw new Error('Concurrency cannot exceed 16');
const official = officialRequested && maxPieces === MAX_PIECES && maxTicks === MAX_TICKS;
if (officialRequested && !official) throw new Error('Official runs cannot override the frozen game caps');
const seeds = officialRequested ? OFFICIAL_SEEDS : QUICK_SEEDS;
const batchId = value('--batch-id', new Date().toISOString().replace(/[^0-9]/g, ''));
if (!/^[0-9]{17}$/.test(batchId)) throw new Error('Invalid batch ID');
const available: Brain[] = [...builtInBrains];
if (args.includes('--remote') || value('--brains', '').split(',').some(s => ['jev', 'llm-classifier'].includes(s))) available.push(jevBrain(), openRouterBrain());
const selected = value('--brains', '').split(',').filter(Boolean);
const brains = selected.length ? available.filter(b => selected.includes(b.slug)) : available;
if (!brains.length || selected.some(s => !brains.some(b => b.slug === s))) throw new Error('Unknown or unavailable brain');
const sourceHashes: Record<string, string> = {};
for (const name of ['engine', 'contract', 'harness', 'adapters', 'rating']) sourceHashes[`lib/tetris-bench/${name}.ts`] = createHash('sha256').update(await readFile(new URL(`../../lib/tetris-bench/${name}.ts`, import.meta.url))).digest('hex');
for (const name of ['run', 'runner-integrity']) sourceHashes[`scripts/tetris-bench/${name}.ts`] = artifactDigest(await readFile(new URL(`./${name}.ts`, import.meta.url)));
const out = resolve(value('--out', 'public/tetris-bench'));
let previous: TournamentIndex | undefined;
const retainedGames: GameResult[] = [];
const recordingDigests = new Map<string, string>();
if (args.includes('--merge')) {
  previous = JSON.parse(await readFile(resolve(out, 'index.json'), 'utf8')) as TournamentIndex;
  assertMergeCompatible(previous, { ruleset: RULESET, official, maxPieces, maxTicks, seeds, provenance: { sourceHashes, concurrency, hardware, runtime: process.version, platform: `${process.platform}/${process.arch}` } });
  for (const b of brains) {
    const old = previous.leaderboard.find(x => x.slug === b.slug);
    if (old && old.model !== b.model) throw new Error('Cannot replace a model under the same brain identity');
  }
  for (const old of previous.runs.filter(run => !brains.some(brain => brain.slug === run.brain))) {
    if (!/^[a-zA-Z0-9_-]+$/.test(old.id) || !previous.leaderboard.some(brain => brain.slug === old.brain)) throw new Error('Invalid prior recording identity');
    const bytes = await readFile(resolve(out, 'runs', `${old.id}.json`));
    retainedGames.push(verifyRecording(bytes, old, RULESET));
    recordingDigests.set(old.id, artifactDigest(bytes));
  }
}
assertOfficialPublishable(official, [...brains.map(b => b.slug), ...(previous?.leaderboard.map(b => b.slug) ?? [])], []);
await mkdir(resolve(out, 'runs'), { recursive: true });
if (args.includes('--game')) {
  const [slug, seed, mode] = value('--game', '').split(',');
  const brain = brains.find(b => b.slug === slug);
  if (!brain || !seeds.includes(seed) || (mode !== 'IQ' && mode !== 'Blitz')) throw new Error('Invalid worker game');
  const game = await runGame(brain, seed, mode, { maxPieces, maxTicks });
  game.id = `v2-${batchId}-${brain.slug}-${seed}-${mode.toLowerCase()}`;
  await writeFile(resolve(out, 'runs', `${game.id}.json`), JSON.stringify(game));
  process.exit(0);
}
const games: GameResult[] = [];
const jobs = counterbalancedJobs(brains, seeds);
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const { brain, seed, mode } = jobs[cursor++];
    let result: GameResult;
    if (concurrency > 1) {
      const childArgs = [fileURLToPath(import.meta.url), '--brains', brain.slug, '--game', `${brain.slug},${seed},${mode}`, '--out', out, '--max-pieces', String(maxPieces), '--max-ticks', String(maxTicks), '--batch-id', batchId, ...(official ? ['--official'] : [])];
      await new Promise<void>((resolveJob, reject) => execFile(process.execPath, childArgs, { maxBuffer: 1_000_000 }, error => error ? reject(new Error('Isolated game worker failed')) : resolveJob()));
      result = JSON.parse(await readFile(resolve(out, 'runs', `v2-${batchId}-${brain.slug}-${seed}-${mode.toLowerCase()}.json`), 'utf8')) as GameResult;
    } else result = await runGame(brain, seed, mode, { maxPieces, maxTicks });
    result.id = `v2-${batchId}-${brain.slug}-${seed}-${mode.toLowerCase()}`;
    games.push(result);
    const recording = JSON.stringify(result);
    recordingDigests.set(result.id, artifactDigest(recording));
    await writeFile(resolve(out, 'runs', `${result.id}.json`), recording);
    console.log(`${result.id}: ${result.score} points, ${result.pieces} pieces, ${result.metrics.misses} misses`);
  }
}));
if (previous) {
  for (const oldBrain of previous.leaderboard) if (!brains.some(b => b.slug === oldBrain.slug)) {
    brains.push({ ...oldBrain, decide: () => null });
    games.push(...retainedGames.filter(game => game.brain === oldBrain.slug));
  }
}
for (const [path, expected] of Object.entries(sourceHashes)) {
  const actual = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex');
  if (actual !== expected) throw new Error('Source changed during the run. Results must be regenerated before publication.');
}
assertOfficialPublishable(official, brains.map(b => b.slug), games);
const { ratings, blitzRatings, intervals, matches } = rateField(brains.map(b => b.slug), seeds, games);
const aggregate = (items: GameResult[]): Metrics => {
  const latencies = items.flatMap(g => g.frames.flatMap(f => f.decision?.called && f.decision.completed === true ? [f.decision.latencyMs] : []));
  const calibrationCount = items.reduce((sum,g) => sum + (g.metrics.calibrationCount ?? 0), 0);
  const prep = items.flatMap(g => g.frames.flatMap(f => f.decision?.preparationMs !== undefined ? [f.decision.preparationMs] : []));
  return { p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), costUsd: items.every(g => g.metrics.costUsd !== null) ? items.reduce((s,g) => s + (g.metrics.costUsd ?? 0),0) / items.length : null, calibrationError: calibrationCount ? items.reduce((sum,g) => sum + (g.metrics.calibrationError ?? 0) * (g.metrics.calibrationCount ?? 0),0) / calibrationCount : null, calibrationCount, completedCalls: items.reduce((s,g) => s+(g.metrics.completedCalls ?? 0),0), timedOutCalls: items.reduce((s,g) => s+(g.metrics.timedOutCalls ?? 0),0), errors: items.reduce((s,g) => s+(g.metrics.errors ?? 0),0), preparationP50Ms: percentile(prep,.5), preparationP95Ms: percentile(prep,.95), calls: items.reduce((s,g) => s+g.metrics.calls,0), misses: items.reduce((s,g) => s+g.metrics.misses,0), invalid: items.reduce((s,g) => s+g.metrics.invalid,0), stale: items.reduce((s,g) => s+g.metrics.stale,0) };
};
let sourceCommit: string | null = null;
let sourceDirty = true;
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); sourceDirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(); } catch { /* standalone archive */ }
const index: TournamentIndex = { ruleset: RULESET, generatedAt: new Date().toISOString(), official, seeds, maxPieces, maxTicks, rating: 'Bradley–Terry IQ / seed bootstrap', provenance: { hardware, runtime: process.version, platform: `${process.platform}/${process.arch}`, sourceCommit, sourceDirty, sourceHashes, concurrency, ...(previous ? { previousBatches: [previous.provenance] } : {}) }, leaderboard: brains.map(b => {
  const own = games.filter(g => g.brain === b.slug), points = matches.filter(m => m.a === b.slug || m.b === b.slug).map(m => m.a === b.slug ? m.point : 1-m.point);
  return { slug: b.slug, name: b.name, description: b.description, kind: b.kind, ...(b.model ? { model: b.model } : {}), cr: Math.round(ratings[b.slug]), crInterval: intervals[b.slug], blitzCr: Math.round(blitzRatings[b.slug]), modeMetrics: { IQ: aggregate(own.filter(g => g.mode === 'IQ')), Blitz: aggregate(own.filter(g => g.mode === 'Blitz')) }, games: own.length, wins: points.filter(p => p > .5).length, draws: points.filter(p => p === .5).length, losses: points.filter(p => p < .5).length, meanScore: own.filter(g => g.mode === 'IQ').reduce((s,g) => s+g.score,0) / seeds.length, metrics: aggregate(own) };
}).sort((a,b) => b.cr-a.cr || a.slug.localeCompare(b.slug)), runs: games.sort((a,b) => a.id.localeCompare(b.id)).map(game => { const { frames, ...summary } = game; void frames; return { ...summary, artifactSha256: recordingDigests.get(game.id)! }; }), matches };
await writeFile(resolve(out, `.index-${batchId}.tmp`), JSON.stringify(index, null, 2));
await rename(resolve(out, `.index-${batchId}.tmp`), resolve(out, 'index.json'));
console.log(`Wrote ${games.length} games and ${matches.length} matches to ${out} (${official ? 'official' : 'exhibition'})`);
