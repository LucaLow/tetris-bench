import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactDigest, verifyRecording, assertMergeCompatible, assertOfficialPublishable, counterbalancedJobs } from './runner-integrity.ts';
import { createGame, RULESET } from '../../lib/tetris-bench/engine.ts';
import type { Brain, GameResult, TournamentIndex } from '../../lib/tetris-bench/contract.ts';

function fixture(): GameResult {
  return { id: 'test-recording', brain: 'a', seed: 'seed-01', mode: 'IQ', score: 0, lines: 0, pieces: 0, ticks: 0, outcome: 'tick-cap', metrics: { p50Ms: null, p95Ms: null, costUsd: 0, calibrationError: null, calls: 0, misses: 0, invalid: 0, stale: 0, errors: 0 }, frames: [{ tick: 0, elapsedMs: 0, event: 'start', state: createGame('seed-01') }] };
}
function summary(game: GameResult, bytes = JSON.stringify(game)) {
  const { frames, ...rest } = game; void frames;
  return { ...rest, artifactSha256: artifactDigest(bytes) };
}

test('recording digest binds exact bytes and summary to replay identity and final state', () => {
  const game = fixture(), bytes = JSON.stringify(game), index = summary(game);
  assert.deepEqual(verifyRecording(bytes, index, RULESET), game);
  assert.throws(() => verifyRecording(bytes + ' ', index, RULESET), /digest mismatch/);
  assert.throws(() => verifyRecording(bytes, { ...index, artifactSha256: undefined }, RULESET), /digest mismatch/);
  assert.throws(() => verifyRecording(bytes, { ...index, brain: 'other' }, RULESET), /summary mismatch/);
  const edited = { ...game, score: 500 }, alteredBytes = JSON.stringify(edited);
  assert.throws(() => verifyRecording(alteredBytes, summary(edited), RULESET), /final state mismatch/);
  assert.throws(() => verifyRecording(bytes, index, 'different-ruleset'), /protocol or seed mismatch/);
  const wrongSeed = structuredClone(game); wrongSeed.frames[0].state.seed = 'other';
  assert.throws(() => verifyRecording(JSON.stringify(wrongSeed), summary(wrongSeed), RULESET), /protocol or seed mismatch/);
});

test('official publication rejects single-brain and any-mode provider failure, but accepts deadline misses', () => {
  assert.throws(() => assertOfficialPublishable(true, ['a'], [fixture()]), /at least two/);
  assert.doesNotThrow(() => assertOfficialPublishable(false, ['a'], [fixture()]));
  for (const mode of ['IQ', 'Blitz'] as const) {
    const game = fixture(); game.mode = mode; game.metrics.errors = 1;
    assert.throws(() => assertOfficialPublishable(true, ['a', 'b'], [game]), /provider failure/);
    game.metrics.errors = 0; game.outcome = 'adapter-failure';
    assert.throws(() => assertOfficialPublishable(true, ['a', 'b'], [game]), /provider failure/);
    game.outcome = 'tick-cap'; game.metrics.misses = 100; game.metrics.timedOutCalls = 100;
    assert.doesNotThrow(() => assertOfficialPublishable(true, ['a', 'b'], [game]));
    game.frames[0].decision = { failure: 'provider-error', status: 'invalid', called: true, stateHash: 'test', latencyMs: 1, budgetMs: 100 };
    assert.throws(() => assertOfficialPublishable(true, ['a', 'b'], [game]), /provider failure/);
  }
});

test('merge requires matching runtime, platform, source, concurrency and frozen protocol', () => {
  const current = { ruleset: RULESET, official: true, seeds: ['seed-01'], maxPieces: 500, maxTicks: 10000, provenance: { hardware: { cpu: 'test-cpu', cores: 8 }, runtime: 'v24', platform: 'darwin/arm64', sourceHashes: { a: 'sha-a', b: 'sha-b' }, concurrency: 1 } };
  const previous: TournamentIndex = { ...structuredClone(current), generatedAt: '2026-09-20T00:00:00Z', rating: 'Bradley–Terry IQ / seed bootstrap', leaderboard: [], runs: [], matches: [] };
  assert.doesNotThrow(() => assertMergeCompatible(previous, { ...current, provenance: { ...current.provenance, sourceHashes: { b: 'sha-b', a: 'sha-a' } } }));
  for (const change of [{ hardware: { cpu: 'other-cpu', cores: 8 } }, { hardware: { cpu: 'test-cpu', cores: 16 } }, { runtime: 'v25' }, { platform: 'linux/x64' }, { concurrency: 2 }, { sourceHashes: { a: 'different', b: 'sha-b' } }]) {
    assert.throws(() => assertMergeCompatible(previous, { ...current, provenance: { ...current.provenance, ...change } }), /source or timing/);
  }
  assert.throws(() => assertMergeCompatible(previous, { ...current, seeds: ['seed-02'] }), /protocol/);
  assert.throws(() => assertMergeCompatible(previous, { ...current, maxPieces: 2 }), /protocol/);
});

test('jobs interleave every brain within each seed and rotate positions deterministically', () => {
  const brains = ['c', 'a', 'b'].map(slug => ({ slug } as Brain));
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
});
