import assert from 'node:assert/strict';
import test from 'node:test';
import { runGame } from '../../lib/tetris-bench/harness.ts';
import { stateHash } from '../../lib/tetris-bench/engine.ts';
import { RECORDING_FORMAT, expandRecording, fromRecording, summaryOf, toRecording } from '../../lib/tetris-bench/recording.ts';
import type { Recording } from '../../lib/tetris-bench/recording.ts';
import { artifactDigest, verifyRecording } from './runner-integrity.ts';
import type { AgentInput, Brain, CandidateOutcome, GameResult, RunSummary } from '../../lib/tetris-bench/contract.ts';

function brain(slug: string, decide: Brain['decide'], kind: Brain['kind'] = 'heuristic'): Brain {
  return { slug, name: slug, description: 'test brain', kind, adapterVersion: '3.0.0', decide };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(handle);
      reject(new Error('aborted'));
    });
  });
}

function evaluate(candidate: CandidateOutcome): number {
  if (candidate.topOut) return -1e9;
  const f = candidate.features;
  return candidate.linesCleared * 10 - f.aggregateHeight * 0.51 - f.holes * 7.5 - f.bumpiness * 0.18;
}

function bestOf(input: AgentInput): CandidateOutcome {
  return [...input.candidates].sort((a, b) =>
    evaluate(b) - evaluate(a) || a.placement.x - b.placement.x || a.placement.rotation - b.placement.rotation)[0];
}

/** Greedy with a hold every fifth piece, a full probability distribution and hosted-style metadata. */
const holdingGreedy = brain('holding-greedy', input => {
  const ranked = [...input.candidates].sort((a, b) => evaluate(b) - evaluate(a)).slice(0, 3);
  const weights = [0.6, 0.3, 0.1].slice(0, ranked.length);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return {
    stateHash: input.stateHash,
    choice: ranked.map((c, i) => ({ ...c.placement, p: weights[i] / total })),
    noul: { hold: input.pieces % 5 === 2 && input.canHold ? 0.9 : 0.1 },
    score: { risk: 0.05 },
    costUsd: 0.002,
    meta: { promptTokens: 1200, completionTokens: 12, finishReason: 'stop', retries: 0, raw: '{"candidate":"xx"}' },
  };
}, 'llm');

const lateGreedy = brain('late-greedy', async (input, { signal }) => {
  await sleep(120, signal);
  return { stateHash: input.stateHash, choice: [{ ...bestOf(input).placement, p: 1 }] };
});

let flakyCall = 0;
const flaky = brain('flaky', async (input, { signal }) => {
  flakyCall++;
  if (flakyCall % 4 === 1) throw new Error('HTTP 500');
  if (flakyCall % 4 === 2) await sleep(300, signal);
  if (flakyCall % 4 === 3) return { stateHash: 'nope', choice: [] };
  return { stateHash: input.stateHash, choice: [{ ...bestOf(input).placement, p: 1 }], costUsd: 0.001 };
}, 'llm');

const broken = brain('broken', () => null);

async function games(): Promise<GameResult[]> {
  return [
    await runGame(holdingGreedy, 'seed-01', 'IQ', { maxPieces: 30 }),
    await runGame(holdingGreedy, 'seed-02', 'Blitz', { maxPieces: 12 }),
    await runGame(lateGreedy, 'seed-03', 'Blitz', { maxPieces: 6, gravityInterval: () => 50 }),
    await runGame(flaky, 'seed-01', 'IQ', { maxPieces: 4, iqTimeoutMs: 40 }),
    await runGame(broken, 'seed-02', 'Blitz'),
  ];
}

function frameHashes(game: GameResult): string[] {
  return game.frames.map(frame => stateHash(frame.state));
}

test('toRecording -> fromRecording reproduces every frame for IQ and Blitz games of several brains', async () => {
  for (const game of await games()) {
    const recording = toRecording(game);
    assert.equal(recording.format, RECORDING_FORMAT);
    assert.equal(recording.ruleset, 'tetris-bench@3');
    assert.equal(recording.events.length, game.frames.length - 1);
    const restored = fromRecording(JSON.parse(JSON.stringify(recording)) as Recording);
    assert.deepEqual(frameHashes(restored), frameHashes(game), game.id);
    assert.deepEqual(restored.frames.map(f => f.event), game.frames.map(f => f.event));
    assert.deepEqual(restored.frames.map(f => f.decision?.status), game.frames.map(f => f.decision?.status));
    assert.deepEqual(restored.frames.map(f => f.decision?.stateHash), game.frames.map(f => f.decision?.stateHash));
    assert.deepEqual(restored.frames.map(f => f.decision?.answer), game.frames.map(f => f.decision?.answer));
    assert.deepEqual(restored.frames.map(f => f.decision?.gravitySteps), game.frames.map(f => f.decision?.gravitySteps));
    assert.deepEqual(restored.frames.map(f => f.decision?.reason), game.frames.map(f => f.decision?.reason));
    assert.deepEqual(restored.frames.map(f => f.decision?.meta), game.frames.map(f => f.decision?.meta));
    assert.deepEqual(restored.frames.map(f => f.decision?.completed), game.frames.map(f => f.decision?.completed));
    assert.deepEqual(restored.metrics, game.metrics);
    assert.equal(restored.score, game.score);
    assert.equal(restored.outcome, game.outcome);
    for (const frame of restored.frames.slice(1)) {
      assert.equal(frame.decision!.latencyMs, Math.round(frame.decision!.latencyMs * 100) / 100, 'latencies are stored to 2 dp');
    }
  }
});

test('recordings carry holds, late placements, gravity steps and full choice distributions', async () => {
  const [iq, blitz, late] = await games();
  const iqRecording = toRecording(iq);
  assert.ok(iqRecording.events.some(e => e.e === 'hold' && e.x === undefined));
  assert.ok(iqRecording.events.some(e => e.e === 'placement' && e.d.a?.choice.length === 3));
  assert.ok(iqRecording.events.every(e => e.d.m?.raw === '{"candidate":"xx"}' || e.e === 'hold' || e.d.a === undefined || e.d.m !== undefined));
  assert.ok(iqRecording.events.every(e => e.d.u === 0.002));
  const lateRecording = toRecording(late);
  assert.ok(lateRecording.events.every(e => e.e === 'placement-late' && e.g >= 1 && e.d.yd === e.d.yq + e.g));
  assert.equal(toRecording(blitz).events.filter(e => e.e === 'hold').length, blitz.metrics.holds);
});

test('a tampered event fails re-simulation with an integrity error', async () => {
  const [iq, , late] = await games();
  const original = toRecording(iq);
  const clone = (): Recording => JSON.parse(JSON.stringify(original)) as Recording;

  const movedPlacement = clone();
  const first = movedPlacement.events.find(e => e.e === 'placement')!;
  first.x = first.x === 3 ? 4 : 3;
  assert.throws(() => expandRecording(movedPlacement), /integrity: state hash mismatch/);

  const forgedHash = clone();
  forgedHash.events[3].sh = '00000000';
  assert.throws(() => expandRecording(forgedHash), /integrity: state hash mismatch at tick 4/);

  const forgedTotals = clone();
  forgedTotals.score += 1000;
  assert.throws(() => expandRecording(forgedTotals), /integrity: final state/);

  const droppedHold = clone();
  const hold = droppedHold.events.find(e => e.e === 'hold')!;
  hold.e = 'invalid';
  assert.throws(() => fromRecording(droppedHold), /integrity/);

  const unreachablePlacement = clone();
  const placed = unreachablePlacement.events.find(e => e.e === 'placement')!;
  placed.x = 99;
  assert.throws(() => expandRecording(unreachablePlacement), /integrity: placement at tick \d+ is not reachable/);

  const lateRecording = toRecording(late);
  lateRecording.events[0].g += 1;
  assert.throws(() => expandRecording(lateRecording), /integrity/);

  const wrongSeed = clone();
  wrongSeed.seed = 'seed-02';
  assert.throws(() => expandRecording(wrongSeed), /integrity: initial state hash mismatch/);

  const wrongFormat = { ...clone(), format: 'tetris-bench-recording@0' } as unknown as Recording;
  assert.throws(() => expandRecording(wrongFormat), /integrity: unsupported format/);
});

test('summaryOf returns everything but the events, matching the index entry shape', async () => {
  const [iq] = await games();
  const recording = toRecording(iq);
  const summary = summaryOf(recording);
  assert.deepEqual(Object.keys(summary).sort(), ['brain', 'format', 'id', 'lines', 'metrics', 'mode', 'outcome', 'pieces', 'ruleset', 'score', 'seed', 'startedAt', 'ticks']);
  assert.equal(summary.format, RECORDING_FORMAT);
  assert.equal(summary.score, iq.score);
  assert.deepEqual(summary.metrics, iq.metrics);
  assert.ok(!('events' in summary));
});

test('verifyRecording accepts a faithful recording and rejects digest, summary, trajectory and counter tampering', async () => {
  const [iq] = await games();
  const recording = toRecording(iq);
  const bytes = JSON.stringify(recording);
  const summary: RunSummary = { ...summaryOf(recording), artifactSha256: artifactDigest(bytes) };
  const verified = verifyRecording(bytes, summary, 'tetris-bench@3');
  assert.equal(verified.frames.length, iq.frames.length);

  assert.throws(() => verifyRecording(bytes + ' ', summary, 'tetris-bench@3'), /digest mismatch/);
  assert.throws(() => verifyRecording(bytes, summary, 'tetris-bench@2'), /ruleset mismatch/);
  assert.throws(() => verifyRecording(bytes, { ...summary, score: summary.score + 1 }, 'tetris-bench@3'), /summary mismatch/);

  const forged = JSON.parse(bytes) as Recording;
  forged.events[2].sh = 'ffffffff';
  const forgedBytes = JSON.stringify(forged);
  assert.throws(() => verifyRecording(forgedBytes, { ...summary, artifactSha256: artifactDigest(forgedBytes) }, 'tetris-bench@3'), /re-simulation failed/);

  const miscounted = JSON.parse(bytes) as Recording;
  miscounted.metrics = { ...miscounted.metrics, holds: miscounted.metrics.holds + 1 };
  const miscountedBytes = JSON.stringify(miscounted);
  const miscountedSummary: RunSummary = { ...summaryOf(miscounted), artifactSha256: artifactDigest(miscountedBytes) };
  assert.throws(() => verifyRecording(miscountedBytes, miscountedSummary, 'tetris-bench@3'), /metrics mismatch.*holds/);
});
