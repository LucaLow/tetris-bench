import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INDEX_FORMAT,
  aggregateMetrics,
  artifactDigest,
  assertIqCoverage,
  assertMergeCompatible,
  assertOfficialPublishable,
  assertQuickRunAllowed,
  costPer100Decisions,
  counterbalancedJobs,
  distilGame,
  orphanRecordingFiles,
  parseRunArgs,
  protocolOf,
  recordingId,
  spendOf,
  verifyRecording,
} from './runner-integrity.ts';
import type { GameRecord, Protocol } from './runner-integrity.ts';
import { builtInBrains } from '../../lib/tetris-bench/adapters.ts';
import { runGame } from '../../lib/tetris-bench/harness.ts';
import { summaryOf, toRecording } from '../../lib/tetris-bench/recording.ts';
import type { Recording } from '../../lib/tetris-bench/recording.ts';
import { MAX_PIECES, MAX_TICKS, RULESET } from '../../lib/tetris-bench/engine.ts';
import { QUICK_SEEDS } from '../../lib/tetris-bench/rating.ts';
import type { GameResult, Metrics, RunSummary, TournamentIndex } from '../../lib/tetris-bench/contract.ts';

const run = promisify(execFile);
const RUN_SCRIPT = fileURLToPath(new URL('./run.ts', import.meta.url));
const ARCHIVE_SCRIPT = fileURLToPath(new URL('./archive-old-recordings.mjs', import.meta.url));

const greedy = builtInBrains.find(brain => brain.slug === 'greedy')!;

async function playedRecording(): Promise<{ game: GameResult; recording: Recording; bytes: string; summary: RunSummary }> {
  const game = await runGame(greedy, 'seed-01', 'IQ', { maxPieces: 12, maxTicks: 40 });
  game.id = 'test-recording';
  const recording = toRecording(game);
  const bytes = JSON.stringify(recording);
  return { game, recording, bytes, summary: { ...summaryOf(recording), artifactSha256: artifactDigest(bytes) } };
}

function summaryFor(recording: Recording, bytes: string): RunSummary {
  return { ...summaryOf(recording), artifactSha256: artifactDigest(bytes) };
}

function emptyMetrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    calls: 0, completedCalls: 0, timedOutCalls: 0, errors: 0, invalid: 0, stale: 0, unreachable: 0, accepted: 0, lateAccepted: 0,
    lockedByGravity: 0, holds: 0, p50Ms: null, p95Ms: null, costUsd: 0, unpricedCalls: 0, calibrationError: null, calibrationCount: 0,
    preparationP50Ms: null, preparationP95Ms: null, retries: 0, maxLevel: 1,
    ...overrides,
  };
}

function record(id: string, metrics: Partial<Metrics>, latencies: number[] = [], preparations: number[] = []): GameRecord {
  const summary: RunSummary = {
    id, ruleset: RULESET, format: 'tetris-bench-recording@1', brain: 'x', seed: 'seed-01', mode: 'IQ', score: 0, lines: 0, pieces: 0, ticks: 0,
    outcome: 'piece-cap', startedAt: '2026-09-20T00:00:00.000Z', metrics: emptyMetrics(metrics), artifactSha256: 'abc',
  };
  return { summary, latencies, preparations };
}

// ---------------------------------------------------------------------------
// verifyRecording
// ---------------------------------------------------------------------------

test('recording digest binds exact bytes, summary and a re-simulated trajectory', async () => {
  const { game, recording, bytes, summary } = await playedRecording();
  const verified = verifyRecording(bytes, summary, RULESET);
  assert.equal(verified.frames.length, game.frames.length);
  assert.equal(verified.score, game.score);
  assert.throws(() => verifyRecording(bytes + ' ', summary, RULESET), /digest mismatch/);
  assert.throws(() => verifyRecording(bytes, { ...summary, artifactSha256: '' }, RULESET), /digest mismatch/);
  assert.throws(() => verifyRecording(bytes, { ...summary, brain: 'other' }, RULESET), /summary mismatch/);
  assert.throws(() => verifyRecording(bytes, summary, 'different-ruleset'), /ruleset mismatch/);

  const wrongFormat = { ...recording, format: 'tetris-bench-recording@0' };
  const wrongFormatBytes = JSON.stringify(wrongFormat);
  assert.throws(() => verifyRecording(wrongFormatBytes, summaryFor(recording, wrongFormatBytes), RULESET), /format mismatch/);

  // A forged intermediate event is caught by re-simulation even with a fresh digest.
  const forged = structuredClone(recording);
  forged.events[3].x = (forged.events[3].x ?? 0) === 0 ? 5 : 0;
  const forgedBytes = JSON.stringify(forged);
  assert.throws(() => verifyRecording(forgedBytes, summaryFor(forged, forgedBytes), RULESET), /re-simulation failed.*integrity/);

  // A forged total is caught too.
  const edited = { ...recording, score: recording.score + 500 };
  const editedBytes = JSON.stringify(edited);
  assert.throws(() => verifyRecording(editedBytes, summaryFor(edited, editedBytes), RULESET), /re-simulation failed/);

  // Counters must agree with the events.
  const miscounted = structuredClone(recording);
  miscounted.metrics = { ...miscounted.metrics, accepted: miscounted.metrics.accepted + 1 };
  const miscountedBytes = JSON.stringify(miscounted);
  assert.throws(() => verifyRecording(miscountedBytes, summaryFor(miscounted, miscountedBytes), RULESET), /metrics mismatch.*accepted/);
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('official publication rejects single-brain fields and adapter failures, but accepts recovered errors', () => {
  const ok = { id: 'a', outcome: 'piece-cap' as const };
  assert.throws(() => assertOfficialPublishable(true, ['a'], [ok]), /at least two/);
  assert.doesNotThrow(() => assertOfficialPublishable(false, ['a'], [ok]));
  assert.doesNotThrow(() => assertOfficialPublishable(true, ['a', 'b'], [ok, { id: 'b', outcome: 'top-out' }]));
  assert.throws(() => assertOfficialPublishable(true, ['a', 'b'], [ok, { id: 'v3-x', outcome: 'adapter-failure' }]), /adapter failure in v3-x/);
});

test('merge requires the same protocol: format, ruleset, official, caps, timeout, seeds and protocol hashes', () => {
  const protocol: Protocol = {
    ruleset: RULESET, official: true, maxPieces: MAX_PIECES, maxTicks: MAX_TICKS, iqTimeoutMs: 20_000, seeds: ['seed-01', 'seed-02'],
    protocolHashes: { 'lib/tetris-bench/engine.ts': 'sha-a', 'lib/tetris-bench/rating.ts': 'sha-b' },
  };
  const previous: TournamentIndex = {
    format: INDEX_FORMAT, ruleset: RULESET, generatedAt: '2026-09-20T00:00:00Z', official: true, seeds: ['seed-01', 'seed-02'],
    maxPieces: MAX_PIECES, maxTicks: MAX_TICKS, iqTimeoutMs: 20_000,
    provenance: {
      hardware: { cpu: 'test', cores: 1 }, runtime: 'v24', platform: 'darwin/arm64', sourceCommit: null, sourceTree: null, sourceDirty: false,
      protocolHashes: { 'lib/tetris-bench/rating.ts': 'sha-b', 'lib/tetris-bench/engine.ts': 'sha-a' },
      adapterHashes: { 'lib/tetris-bench/adapters.ts': 'old' }, iqConcurrency: 4, blitzConcurrency: 1, batches: [],
    },
    brains: [], headToHead: [], ties: [], runs: [],
  };
  assert.doesNotThrow(() => assertMergeCompatible(previous, protocol));
  assert.deepEqual(protocolOf(previous).seeds, ['seed-01', 'seed-02']);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, seeds: ['seed-02'] }), /different protocols: seeds/);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, maxPieces: 2 }), /different protocols: maxPieces/);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, maxTicks: 2 }), /different protocols: maxTicks/);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, official: false }), /different protocols: official/);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, iqTimeoutMs: 1 }), /different protocols: iqTimeoutMs/);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, ruleset: 'tetris-bench@2' }), /different protocols: ruleset/);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, protocolHashes: { ...protocol.protocolHashes, 'lib/tetris-bench/engine.ts': 'x' } }), /engine\.ts changed/);
  assert.throws(() => assertMergeCompatible(previous, { ...protocol, protocolHashes: { ...protocol.protocolHashes, 'lib/tetris-bench/features.ts': 'x' } }), /features\.ts changed/);
  const v2 = { ...previous, format: 'tetris-bench-index@2' } as unknown as TournamentIndex;
  assert.throws(() => assertMergeCompatible(v2, protocol), /not tetris-bench-index@3/);
});

test('jobs interleave every brain within each seed and rotate positions deterministically', () => {
  const brains = ['c', 'a', 'b'].map(slug => ({ slug }));
  const seeds = ['s1', 's2', 's3'];
  const jobs = counterbalancedJobs(brains, seeds);
  assert.equal(jobs.length, 18);
  assert.deepEqual(jobs, counterbalancedJobs([...brains].reverse(), seeds));
  assert.deepEqual(jobs.map(job => `${job.seed}/${job.mode}/${job.brain.slug}`), [
    's1/IQ/a', 's1/IQ/b', 's1/IQ/c', 's1/Blitz/a', 's1/Blitz/b', 's1/Blitz/c',
    's2/Blitz/b', 's2/Blitz/c', 's2/Blitz/a', 's2/IQ/b', 's2/IQ/c', 's2/IQ/a',
    's3/IQ/c', 's3/IQ/a', 's3/IQ/b', 's3/Blitz/c', 's3/Blitz/a', 's3/Blitz/b',
  ]);
  assert.equal(new Set(jobs.map(job => `${job.seed}/${job.mode}/${job.brain.slug}`)).size, 18);
  const blitzOnly = counterbalancedJobs(brains, seeds, ['Blitz']);
  assert.equal(blitzOnly.length, 9);
  assert.ok(blitzOnly.every(job => job.mode === 'Blitz'));
});

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

test('command line: defaults, caps, concurrency, modes, spend, worker game', () => {
  const now = new Date('2026-09-20T12:34:56.789Z');
  const defaults = parseRunArgs([], now);
  assert.deepEqual(defaults, {
    help: false, official: false, merge: false, brains: null, modes: ['IQ', 'Blitz'], concurrency: 1, blitzConcurrency: 1,
    out: 'public/tetris-bench', outExplicit: false, maxPieces: MAX_PIECES, maxTicks: MAX_TICKS, batchId: '20260920123456789', maxSpendUsd: null, game: null,
  });
  // Blitz-only batches need IQ coverage from a previous index for every brain, else nothing is played.
  assert.throws(() => assertIqCoverage(['greedy', 'jev'], ['Blitz'], new Map([['greedy', 3]]), 3), /jev has no IQ games/);
  assert.doesNotThrow(() => assertIqCoverage(['greedy', 'jev'], ['Blitz'], new Map([['greedy', 3], ['jev', 3]]), 3));
  assert.doesNotThrow(() => assertIqCoverage(['greedy', 'jev'], ['IQ', 'Blitz'], new Map(), 3));
  assert.throws(() => assertIqCoverage(['greedy'], ['Blitz'], new Map([['greedy', 2]]), 3), /greedy has no IQ games/);
  // A quick run never replaces an official index by accident; explicit --out, --merge and --official are allowed through.
  assert.throws(() => assertQuickRunAllowed({ official: false, merge: false, outExplicit: false }, { official: true }, 'public/tetris-bench'), /Refusing to replace the official index/);
  assert.doesNotThrow(() => assertQuickRunAllowed({ official: false, merge: false, outExplicit: false }, { official: false }, 'x'));
  assert.doesNotThrow(() => assertQuickRunAllowed({ official: false, merge: false, outExplicit: false }, null, 'x'));
  assert.doesNotThrow(() => assertQuickRunAllowed({ official: false, merge: false, outExplicit: true }, { official: true }, 'x'));
  assert.doesNotThrow(() => assertQuickRunAllowed({ official: true, merge: false, outExplicit: false }, { official: true }, 'x'));
  assert.doesNotThrow(() => assertQuickRunAllowed({ official: false, merge: true, outExplicit: false }, { official: true }, 'x'));
  const full = parseRunArgs(['--official', '--brains', 'greedy,jev', '--modes', 'Blitz', '--concurrency', '4', '--blitz-concurrency', '2', '--out', 'x', '--merge', '--batch-id', '20260101000000000', '--max-spend-usd', '2.5'], now);
  assert.equal(full.official, true);
  assert.equal(full.outExplicit, true);
  assert.deepEqual(full.brains, ['greedy', 'jev']);
  assert.deepEqual(full.modes, ['Blitz']);
  assert.equal(full.concurrency, 4);
  assert.equal(full.blitzConcurrency, 2);
  assert.equal(full.merge, true);
  assert.equal(full.batchId, '20260101000000000');
  assert.equal(full.maxSpendUsd, 2.5);
  assert.equal(parseRunArgs(['--concurrency', '3'], now).blitzConcurrency, 3);
  assert.deepEqual(parseRunArgs(['--game', 'greedy,seed-02,Blitz'], now).game, { slug: 'greedy', seed: 'seed-02', mode: 'Blitz' });
  assert.equal(parseRunArgs(['--max-pieces', '5', '--max-ticks', '20'], now).maxPieces, 5);
  assert.equal(parseRunArgs(['--official', '--max-pieces', String(MAX_PIECES)], now).maxPieces, MAX_PIECES);
});

test('command line: repeated, unknown and malformed options are rejected', () => {
  assert.throws(() => parseRunArgs(['--max-pieces', '5', '--max-pieces', '6']), /Repeated option: --max-pieces/);
  assert.throws(() => parseRunArgs(['--official', '--official']), /Repeated option: --official/);
  assert.throws(() => parseRunArgs(['--seeds', 'x']), /Unknown option: --seeds/);
  assert.throws(() => parseRunArgs(['--brains']), /needs a value/);
  assert.throws(() => parseRunArgs(['--brains', '--official']), /needs a value/);
  assert.throws(() => parseRunArgs(['--max-pieces', String(MAX_PIECES + 1)]), /between 1 and 500/);
  assert.throws(() => parseRunArgs(['--max-ticks', String(MAX_TICKS + 1)]), /between 1 and 10000/);
  assert.throws(() => parseRunArgs(['--max-pieces', '1e1']), /whole number/);
  assert.throws(() => parseRunArgs(['--max-pieces', '0']), /between/);
  assert.throws(() => parseRunArgs(['--official', '--max-pieces', '5']), /frozen game caps/);
  assert.throws(() => parseRunArgs(['--concurrency', '17']), /between 1 and 16/);
  assert.throws(() => parseRunArgs(['--concurrency', '0']), /between 1 and 16/);
  assert.throws(() => parseRunArgs(['--modes', 'IQ,Turbo']), /Unknown mode/);
  assert.throws(() => parseRunArgs(['--modes', 'IQ,IQ']), /lists an entry twice/);
  assert.throws(() => parseRunArgs(['--modes', '']), /needs at least one entry/);
  assert.throws(() => parseRunArgs(['--brains', 'greedy,greedy']), /lists an entry twice/);
  assert.throws(() => parseRunArgs(['--brains', '../x']), /Invalid brain slug/);
  assert.throws(() => parseRunArgs(['--batch-id', '123']), /Invalid batch id/);
  assert.throws(() => parseRunArgs(['--max-spend-usd', '-1']), /positive number/);
  assert.throws(() => parseRunArgs(['--max-spend-usd', 'lots']), /positive number/);
  assert.throws(() => parseRunArgs(['--game', 'greedy,seed-01']), /slug,seed,mode/);
  assert.throws(() => parseRunArgs(['--game', 'greedy,seed-01,Fast']), /Unknown mode/);
});

test('recording ids and orphan detection', () => {
  assert.equal(recordingId('20260101000000000', 'gpt-4o-mini', 'seed-07', 'Blitz'), 'v3-20260101000000000-gpt-4o-mini-seed-07-blitz');
  const kept = new Set(['v3-20260101000000000-greedy-seed-01-iq']);
  const files = [
    'v3-20260101000000000-greedy-seed-01-iq.json',
    'v3-20260101000000000-greedy-seed-02-iq.json',
    'v3-20260101000000001-search-seed-01-blitz.json',
    'greedy-seed-01-iq.json',
    'notes.txt',
    '.DS_Store',
  ];
  assert.deepEqual(orphanRecordingFiles(files, kept), ['v3-20260101000000000-greedy-seed-02-iq.json', 'v3-20260101000000001-search-seed-01-blitz.json']);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('metrics aggregate by summing counters, pooling latencies and weighting calibration by count', () => {
  const a = record('a', { calls: 10, completedCalls: 9, accepted: 8, holds: 1, costUsd: 0.5, unpricedCalls: 1, calibrationError: 0.2, calibrationCount: 4, retries: 1, maxLevel: 3 }, [10, 20, 30], [1, 2]);
  const b = record('b', { calls: 5, completedCalls: 5, accepted: 5, costUsd: 0.25, calibrationError: 0.4, calibrationCount: 1, maxLevel: 2 }, [40, 50], [3]);
  const metrics = aggregateMetrics([a, b]);
  assert.equal(metrics.calls, 15);
  assert.equal(metrics.completedCalls, 14);
  assert.equal(metrics.accepted, 13);
  assert.equal(metrics.holds, 1);
  assert.equal(metrics.costUsd, 0.75);
  assert.equal(metrics.unpricedCalls, 1);
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.maxLevel, 3);
  assert.equal(metrics.calibrationCount, 5);
  assert.ok(Math.abs((metrics.calibrationError ?? 0) - (0.2 * 4 + 0.4) / 5) < 1e-12);
  assert.equal(metrics.p50Ms, 30);
  assert.equal(metrics.p95Ms, 50);
  assert.equal(metrics.preparationP50Ms, 2);
  const none = aggregateMetrics([]);
  assert.equal(none.p50Ms, null);
  assert.equal(none.calibrationError, null);
  assert.equal(none.calls, 0);
});

test('cost per 100 decisions and the spend estimate price unpriced calls at the known mean', () => {
  const priced = record('a', { calls: 40, costUsd: 0.2, unpricedCalls: 0 });
  const partly = record('b', { calls: 20, costUsd: 0.05, unpricedCalls: 10 });
  assert.ok(Math.abs((costPer100Decisions([priced, partly]) ?? 0) - (0.25 / 50) * 100) < 1e-12);
  assert.equal(costPer100Decisions([record('c', { calls: 5, costUsd: 0, unpricedCalls: 5 })]), null);
  assert.equal(costPer100Decisions([]), null);
  const spend = spendOf([priced, partly]);
  assert.equal(spend.known, 0.25);
  assert.equal(spend.unpricedCalls, 10);
  assert.ok(Math.abs(spend.estimated - (0.25 + 10 * (0.25 / 50))) < 1e-12);
  assert.deepEqual(spendOf([record('c', { calls: 5, costUsd: 0, unpricedCalls: 5 })]), { known: 0, unpricedCalls: 5, estimated: 0 });
});

test('distilGame keeps completed-call latencies and every preparation time', async () => {
  const { game, summary } = await playedRecording();
  const distilled = distilGame(game, summary);
  assert.equal(distilled.summary, summary);
  assert.equal(distilled.latencies.length, game.metrics.completedCalls);
  assert.equal(distilled.preparations.length, game.frames.length - 1);
});

// ---------------------------------------------------------------------------
// Integration: the runner as a process
// ---------------------------------------------------------------------------

async function runner(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [RUN_SCRIPT, ...args], { maxBuffer: 4_000_000 });
}

async function runnerFails(args: string[]): Promise<string> {
  try {
    await runner(args);
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1);
    return failure.stderr ?? '';
  }
  assert.fail(`expected the runner to fail: ${args.join(' ')}`);
}

async function readIndex(dir: string): Promise<TournamentIndex> {
  return JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as TournamentIndex;
}

async function verifyEveryRun(dir: string, index: TournamentIndex): Promise<void> {
  for (const summary of index.runs) {
    const bytes = await readFile(join(dir, 'runs', `${summary.id}.json`));
    const game = verifyRecording(bytes, summary, RULESET);
    assert.equal(game.brain, summary.brain);
  }
}

const QUICK = ['--max-pieces', '8', '--max-ticks', '30'];

test('integration: quick built-in field with worker processes, then merges that replace, add and prune', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-bench-runner-'));
  const first = await runner(['--out', dir, '--brains', 'greedy,random-legal', '--concurrency', '2', '--batch-id', '20260101000000001', ...QUICK]);
  assert.match(first.stdout, /Wrote 12 games for 2 brains/);
  assert.match(first.stdout, /v3-20260101000000001-greedy-seed-01-iq: \d+ pts, \d+ pieces, level \d+, piece-cap; placement 8/);

  const index = await readIndex(dir);
  assert.equal(index.format, INDEX_FORMAT);
  assert.equal(index.ruleset, RULESET);
  assert.equal(index.official, false);
  assert.deepEqual(index.seeds, QUICK_SEEDS);
  assert.equal(index.maxPieces, 8);
  assert.equal(index.maxTicks, 30);
  assert.equal(index.iqTimeoutMs, 20_000);
  assert.equal(index.provenance.iqConcurrency, 2);
  assert.equal(index.provenance.blitzConcurrency, 2);
  assert.deepEqual(Object.keys(index.provenance.protocolHashes).sort(), ['contract', 'engine', 'features', 'harness', 'rating', 'recording'].map(name => `lib/tetris-bench/${name}.ts`).sort());
  assert.ok('lib/tetris-bench/adapters.ts' in index.provenance.adapterHashes);
  assert.equal(index.provenance.batches.length, 1);
  assert.deepEqual(index.provenance.batches[0].brains, ['greedy', 'random-legal']);
  assert.deepEqual(index.provenance.batches[0].modes, ['IQ', 'Blitz']);
  assert.equal(typeof index.provenance.sourceDirty, 'boolean');
  assert.deepEqual(index.brains.map(brain => [brain.slug, brain.rank]), [['greedy', 1], ['random-legal', 2]]);
  const top = index.brains[0];
  assert.equal(top.kind, 'heuristic');
  assert.equal(top.adapterVersion, '3.0.0');
  assert.equal(top.iq.perSeed.length, 3);
  assert.equal(top.iq.interval, null);
  assert.ok(top.blitz && top.blitz.perSeed.length === 3);
  assert.equal(top.iqMetrics.calls, 24);
  assert.ok(top.blitzMetrics && top.blitzMetrics.calls === 24);
  assert.equal(top.costPer100Decisions, null);
  assert.equal(top.unpricedCalls, 0);
  assert.equal(top.elo.interval, null);
  assert.equal(index.headToHead.length, 1);
  assert.equal(index.headToHead[0].a, 'greedy');
  assert.deepEqual(index.ties, []);
  assert.equal(index.runs.length, 12);
  assert.deepEqual(index.runs.map(run => run.id), [...index.runs.map(run => run.id)].sort());
  assert.ok(index.runs.every(run => run.format === 'tetris-bench-recording@1' && run.id.startsWith('v3-20260101000000001-')));
  await verifyEveryRun(dir, index);
  assert.equal((await readdir(join(dir, 'runs'))).length, 12);

  // Merge: re-run greedy in a new batch; random-legal is retained, greedy's old files are pruned.
  const second = await runner(['--out', dir, '--brains', 'greedy', '--merge', '--batch-id', '20260101000000002', ...QUICK]);
  assert.match(second.stdout, /retained random-legal: 6 recordings re-simulated/);
  assert.equal((second.stdout.match(/shelved orphan recording runs\/v3-20260101000000001-greedy-/g) ?? []).length, 6);
  assert.equal((await readdir(join(dir, 'partial'))).filter(file => file.startsWith('v3-20260101000000001-greedy-')).length, 6, 'replaced recordings are shelved, not deleted');
  const merged = await readIndex(dir);
  assert.equal(merged.runs.length, 12);
  assert.equal(merged.runs.filter(run => run.brain === 'greedy' && run.id.startsWith('v3-20260101000000002-')).length, 6);
  assert.equal(merged.runs.filter(run => run.brain === 'random-legal' && run.id.startsWith('v3-20260101000000001-')).length, 6);
  assert.equal(merged.provenance.batches.length, 2);
  assert.deepEqual(merged.provenance.batches.map(batch => batch.batchId), ['20260101000000001', '20260101000000002']);
  await verifyEveryRun(dir, merged);
  const files = await readdir(join(dir, 'runs'));
  assert.equal(files.length, 12);
  assert.ok(files.every(file => merged.runs.some(run => `${run.id}.json` === file)));

  // Merge: add a third brain in IQ only; it gets blitz: null and the rating still works.
  const third = await runner(['--out', dir, '--brains', 'dellacherie', '--modes', 'IQ', '--merge', '--batch-id', '20260101000000003', ...QUICK]);
  assert.match(third.stdout, /Wrote 15 games for 3 brains/);
  const widened = await readIndex(dir);
  const added = widened.brains.find(brain => brain.slug === 'dellacherie')!;
  assert.equal(added.blitz, null);
  assert.equal(added.blitzMetrics, null);
  assert.equal(added.iq.perSeed.length, 3);
  assert.equal(widened.headToHead.length, 3);
  assert.deepEqual(widened.provenance.batches[2].modes, ['IQ']);
  await verifyEveryRun(dir, widened);

  // Merge refuses a different protocol.
  const refused = await runnerFails(['--out', dir, '--brains', 'greedy', '--merge', '--batch-id', '20260101000000004', '--max-pieces', '9', '--max-ticks', '30']);
  assert.match(refused, /Cannot merge different protocols: maxPieces/);
  assert.equal((await readIndex(dir)).runs.length, 15);
});

test('integration: the worker path plays one game, writes only its recording and skips the gates', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-bench-worker-'));
  await runner(['--out', dir, '--game', 'greedy,seed-02,Blitz', '--batch-id', '20260101000000009', '--official']);
  const id = 'v3-20260101000000009-greedy-seed-02-blitz';
  const files = await readdir(join(dir, 'runs'));
  assert.deepEqual(files, [`${id}.json`]);
  await assert.rejects(access(join(dir, 'index.json')));
  const bytes = await readFile(join(dir, 'runs', `${id}.json`));
  const recording = JSON.parse(bytes.toString('utf8')) as Recording;
  const summary = { ...summaryOf(recording), artifactSha256: artifactDigest(bytes) };
  const game = verifyRecording(bytes, summary, RULESET);
  assert.equal(game.id, id);
  assert.equal(game.mode, 'Blitz');
  assert.equal(game.seed, 'seed-02');
  assert.ok(game.pieces > 0);
  const badSeed = await runnerFails(['--out', dir, '--game', 'greedy,seed-09,IQ', '--batch-id', '20260101000000009']);
  assert.match(badSeed, /Invalid worker seed/);
});

test('integration: a failing worker surfaces its exit code and stderr, and no index is written', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-bench-fail-'));
  // A directory where the worker must write its recording makes that one game fail with EISDIR.
  await mkdir(join(dir, 'runs', 'v3-20260101000000005-greedy-seed-01-iq.json'), { recursive: true });
  const stderr = await runnerFails(['--out', dir, '--brains', 'greedy,random-legal', '--concurrency', '2', '--batch-id', '20260101000000005', ...QUICK]);
  assert.match(stderr, /Worker for v3-20260101000000005-greedy-seed-01-iq failed \(exit 1\)/);
  assert.match(stderr, /EISDIR/);
  await assert.rejects(access(join(dir, 'index.json')));
});

test('integration: the command line rejects bad caps, repeated flags, unknown brains and hosted brains without a key', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-bench-args-'));
  assert.match(await runnerFails(['--out', dir, '--max-pieces', String(MAX_PIECES + 1)]), /--max-pieces must be between 1 and 500/);
  assert.match(await runnerFails(['--out', dir, '--max-ticks', '5', '--max-ticks', '6']), /Repeated option: --max-ticks/);
  assert.match(await runnerFails(['--out', dir, '--official', '--max-ticks', '5']), /frozen game caps/);
  assert.match(await runnerFails(['--out', dir, '--brains', 'nope']), /Unknown brain: nope/);
  assert.match(await runnerFails(['--out', dir, '--brains', 'greedy', '--official', ...[]]), /at least two brains/);
  assert.match(await runnerFails(['--out', dir, '--brains', 'greedy', '--merge', ...QUICK]), /no index\.json/);
  const { stdout } = await runner(['--help']);
  assert.match(stdout, /--max-spend-usd/);
  await assert.rejects(access(join(dir, 'index.json')));
  try {
    await run(process.execPath, [RUN_SCRIPT, '--out', dir, '--brains', 'gpt-4o-mini', ...QUICK], { env: { ...process.env, OPENROUTER_API_KEY: '' } });
    assert.fail('hosted brain should need a key');
  } catch (error) {
    assert.match((error as { stderr?: string }).stderr ?? '', /requires OPENROUTER_API_KEY/);
  }
});

test('archive script withdraws a v2 index, keeps archive-v1.json and removes pre-v3 recordings', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-bench-archive-'));
  await mkdir(join(dir, 'runs'));
  await writeFile(join(dir, 'index.json'), JSON.stringify({ ruleset: 'tetris-bench@2', leaderboard: [], runs: [] }));
  await writeFile(join(dir, 'archive-v1.json'), JSON.stringify({ ruleset: 'tetris-bench@1' }));
  await writeFile(join(dir, 'runs', 'greedy-seed-01-iq.json'), '{}');
  await writeFile(join(dir, 'runs', 'v2-20260920135834203-greedy-seed-01-iq.json'), '{}');
  await writeFile(join(dir, 'runs', 'v3-20260101000000001-greedy-seed-01-iq.json'), '{}');
  const { stdout } = await run(process.execPath, [ARCHIVE_SCRIPT, '--dir', dir]);
  assert.match(stdout, /moved index\.json \(tetris-bench@2\) to archive-v2\.json/);
  assert.match(stdout, /kept archive-v1\.json/);
  assert.match(stdout, /removed 2 pre-v3 recording files/);
  await assert.rejects(access(join(dir, 'index.json')));
  const archived = JSON.parse(await readFile(join(dir, 'archive-v2.json'), 'utf8')) as { withdrawn: boolean; note: string; ruleset: string };
  assert.equal(archived.withdrawn, true);
  assert.equal(archived.ruleset, 'tetris-bench@2');
  assert.match(archived.note, /9bc56f8/);
  assert.deepEqual(await readdir(join(dir, 'runs')), ['v3-20260101000000001-greedy-seed-01-iq.json']);
  // A second run is a no-op that refuses nothing.
  const again = await run(process.execPath, [ARCHIVE_SCRIPT, '--dir', dir]);
  assert.match(again.stdout, /no index\.json to archive/);
});
