import assert from 'node:assert/strict';
import test from 'node:test';
import { IQ_TIMEOUT_MS, inputFor, runGame } from '../../lib/tetris-bench/harness.ts';
import { createGame, stateHash } from '../../lib/tetris-bench/engine.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';
import type { AgentInput, Brain, CandidateOutcome, DecisionStatus, GameResult } from '../../lib/tetris-bench/contract.ts';

function brain(decide: Brain['decide'], kind: Brain['kind'] = 'heuristic', slug = 'test'): Brain {
  return { slug, name: slug, description: 'test brain', kind, adapterVersion: '3.0.0', decide };
}

function answerFirst(input: AgentInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { stateHash: input.stateHash, choice: [{ ...input.legal[0], p: 1 }], ...extra };
}

/** Sleeps; rejects on abort unless `ignoreAbort` is set. */
function sleep(ms: number, signal: AbortSignal, ignoreAbort = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(resolve, ms);
    if (!ignoreAbort) {
      signal.addEventListener('abort', () => {
        clearTimeout(handle);
        reject(new Error('aborted'));
      });
    }
  });
}

function blockFor(ms: number): void {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // Busy wait: a synchronous brain cannot yield to timers.
  }
}

function evaluate(candidate: CandidateOutcome): number {
  if (candidate.topOut) return -1e9;
  const f = candidate.features;
  return candidate.linesCleared * 10 - f.aggregateHeight * 0.51 - f.holes * 7.5 - f.bumpiness * 0.18;
}

/** A one-ply greedy policy that answers after `delayMs`; independent of the adapters module. */
function greedy(delayMs: number, kind: Brain['kind'] = 'heuristic'): Brain {
  return brain(async (input, { signal }) => {
    if (delayMs > 0) await sleep(delayMs, signal);
    const best = [...input.candidates].sort((a, b) =>
      evaluate(b) - evaluate(a) || a.placement.x - b.placement.x || a.placement.rotation - b.placement.rotation)[0];
    return { stateHash: input.stateHash, choice: [{ ...best.placement, p: 1 }] };
  }, kind, 'greedy');
}

function events(game: GameResult): DecisionStatus[] {
  return game.frames.slice(1).map(frame => frame.event as DecisionStatus);
}

const instant = brain(input => answerFirst(input));
const stale = brain(input => answerFirst(input, { stateHash: 'deadbeef' }));
const throws = brain(() => {
  throw new Error('boom');
}, 'llm');
const holdRepeat = brain(input => answerFirst(input, { noul: { hold: true } }));
const invalid = brain(() => null);
const slowRespectsAbort = (ms: number) => brain(async (input, { signal }) => {
  await sleep(ms, signal);
  return answerFirst(input);
}, 'llm');
const slowIgnoresAbort = (ms: number) => brain(async (input, { signal }) => {
  await sleep(ms, signal, true);
  return answerFirst(input);
}, 'llm');
const resolvesOnAbort = (ms: number) => brain((input, { signal }) => new Promise(resolve => {
  const handle = setTimeout(() => resolve(answerFirst(input)), ms);
  signal.addEventListener('abort', () => {
    clearTimeout(handle);
    resolve(answerFirst(input, { costUsd: 0.5 }));
  });
}), 'llm');
const syncBlocking = (ms: number) => brain(input => {
  blockFor(ms);
  return answerFirst(input);
});

test('validateAnswer: required fields decide validity, optional fields are dropped when malformed', () => {
  const input = inputFor(createGame('test'), 'IQ');
  const p = input.legal[0];
  const ok = validateAnswer({ stateHash: input.stateHash, choice: [{ ...p, p: 1 }] }, input.stateHash, input.legal);
  assert.equal(ok.status, 'ok');
  assert.equal(validateAnswer({ stateHash: 'old', choice: [{ ...p, p: 1 }] }, input.stateHash, input.legal).status, 'stale');
  for (const choice of [[], [{ ...p, p: NaN }], [{ ...p, p: 0.2 }], [{ ...p, p: 0.5 }, { ...p, p: 0.5 }], [{ x: 99, rotation: 0, p: 1 }], [{ ...p, p: 1 }, { x: 99, rotation: 0, p: 0 }]]) {
    const result = validateAnswer({ stateHash: input.stateHash, choice }, input.stateHash, input.legal);
    assert.equal(result.status, 'invalid');
    assert.ok(result.status === 'invalid' && result.reason.length > 0);
  }
  assert.equal(validateAnswer(null, input.stateHash, input.legal).status, 'invalid');
  assert.equal(validateAnswer({ choice: [{ ...p, p: 1 }] }, input.stateHash, input.legal).status, 'invalid');

  const messy = validateAnswer({
    stateHash: input.stateHash,
    choice: [{ ...p, p: 1, extra: 'dropped' }],
    noul: { hold: 'yes' },
    score: { risk: 7 },
    costUsd: '0.1',
    meta: 'nope',
    blob: 'x'.repeat(100),
  }, input.stateHash, input.legal);
  assert.equal(messy.status, 'ok');
  if (messy.status !== 'ok') return;
  assert.deepEqual(messy.ignored, ['noul', 'score', 'costUsd', 'meta']);
  assert.deepEqual(messy.answer, { stateHash: input.stateHash, choice: [{ x: p.x, rotation: p.rotation, p: 1 }] });
  assert.equal(messy.hold, false);

  const boolHold = validateAnswer({ stateHash: input.stateHash, choice: [{ ...p, p: 1 }], noul: { hold: true } }, input.stateHash, input.legal, true);
  assert.ok(boolHold.status === 'ok' && boolHold.hold === true && boolHold.answer.noul?.hold === 1);
  const halfHold = validateAnswer({ stateHash: input.stateHash, choice: [{ ...p, p: 1 }], noul: { hold: 0.5 } }, input.stateHash, input.legal, true);
  assert.ok(halfHold.status === 'ok' && halfHold.hold === false);
  const holdUnavailable = validateAnswer({ stateHash: input.stateHash, choice: [{ ...p, p: 1 }], noul: { hold: 1 } }, input.stateHash, input.legal, false);
  assert.ok(holdUnavailable.status === 'ok' && holdUnavailable.hold === false && holdUnavailable.ignored.includes('noul'));
  assert.deepEqual(holdUnavailable.status === 'ok' ? holdUnavailable.placement : null, { x: p.x, rotation: p.rotation });

  const withMeta = validateAnswer({ stateHash: input.stateHash, choice: [{ ...p, p: 1 }], costUsd: 0.01, meta: { promptTokens: 10, retries: 1, finishReason: 'stop', junk: 1 } }, input.stateHash, input.legal);
  assert.ok(withMeta.status === 'ok');
  assert.deepEqual(withMeta.status === 'ok' ? withMeta.answer.meta : null, { promptTokens: 10, retries: 1, finishReason: 'stop' });
  assert.equal(withMeta.status === 'ok' ? withMeta.answer.costUsd : null, 0.01);
});

test('argmax is by probability, then lowest x, then lowest rotation', () => {
  const input = inputFor(createGame('argmax'), 'IQ');
  const sorted = [...input.legal].sort((a, b) => a.x - b.x || a.rotation - b.rotation);
  const p = 1 / sorted.length;
  const choice = sorted.map(placement => ({ ...placement, p }));
  const result = validateAnswer({ stateHash: input.stateHash, choice }, input.stateHash, input.legal);
  assert.ok(result.status === 'ok');
  assert.deepEqual(result.status === 'ok' ? result.placement : null, sorted[0]);
});

test('inputFor discloses candidates with features and point splits; legal[i] is candidates[i].placement', () => {
  const state = createGame('test');
  state.active = { type: 'O', x: 3, y: -1, rotation: 0 };
  state.holdUsed = true;
  state.combo = 2;
  state.backToBack = true;
  const input = inputFor(state, 'IQ');
  assert.equal(input.candidates.length, 9);
  assert.equal(input.legal.length, 9);
  assert.equal(input.canHold, false);
  assert.equal(input.combo, 2);
  assert.equal(input.backToBack, true);
  assert.equal(input.features.maxHeight, 0);
  input.candidates.forEach((candidate, i) => {
    assert.equal(candidate.id, `p${i}`);
    assert.deepEqual(input.legal[i], candidate.placement);
    assert.equal(candidate.dropPoints + candidate.clearPoints, candidate.scoreDelta);
    assert.equal(candidate.clearPoints, 0);
    assert.equal(candidate.features.heights.length, 10);
    assert.equal(candidate.features.maxHeight, 2);
  });
  assert.deepEqual(input, inputFor(state, 'IQ'));
});

test('input, ordering and hashes do not disclose the hidden bag or RNG', () => {
  const a = createGame('test');
  const b = structuredClone(a);
  b.rng = 42;
  b.bag = ['I', 'T'];
  b.seed = 'secret';
  assert.deepEqual(inputFor(a, 'IQ'), inputFor(b, 'IQ'));
});

test('adapter receives a detached snapshot, a signal and the budget; mutation cannot alter the replay', async () => {
  const initial = createGame('test');
  const seen: Array<number | null> = [];
  const mutating = brain((input, ctx) => {
    assert.deepEqual(Object.keys(ctx).sort(), ['budgetMs', 'signal']);
    seen.push(ctx.budgetMs);
    input.grid[19][0] = 'I';
    input.active.y = 19;
    return null;
  });
  const game = await runGame(mutating, 'test', 'IQ', { maxTicks: 1 });
  assert.equal(stateHash(game.frames[0].state), stateHash(initial));
  assert.equal(game.frames[1].state.board[19][0], null);
  assert.deepEqual(seen, [IQ_TIMEOUT_MS]);
  const blitzBudgets: Array<number | null> = [];
  const blitz = await runGame(brain((input, ctx) => {
    blitzBudgets.push(ctx.budgetMs);
    return answerFirst(input);
  }), 'test', 'Blitz', { maxPieces: 1 });
  assert.equal(blitz.pieces, 1);
  assert.deepEqual(blitzBudgets, [null], 'Blitz has no fixed budget: the falling piece is the deadline');
  assert.ok((blitz.metrics.preparationP50Ms ?? 0) > 0);
});

test('instant brain plays IQ and Blitz identically with full metrics and progress callbacks', async () => {
  const progress: number[] = [];
  const iq = await runGame(instant, 'seed-01', 'IQ', { maxPieces: 5, onProgress: frame => progress.push(frame.tick) });
  const blitz = await runGame(instant, 'seed-01', 'Blitz', { maxPieces: 5 });
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  assert.equal(iq.outcome, 'piece-cap');
  assert.equal(iq.score, blitz.score);
  assert.equal(iq.ruleset, 'tetris-bench@3');
  assert.equal(iq.id, 'v3-test-seed-01-iq');
  assert.deepEqual(events(iq), ['placement', 'placement', 'placement', 'placement', 'placement']);
  assert.deepEqual(events(blitz), events(iq));
  const m = iq.metrics;
  assert.equal(m.calls, 5);
  assert.equal(m.completedCalls, 5);
  assert.equal(m.accepted, 5);
  assert.equal(m.lateAccepted, 0);
  assert.equal(m.unpricedCalls, 0, 'local brains are never unpriced');
  assert.equal(m.costUsd, 0);
  assert.equal(m.maxLevel, 1);
  assert.ok((m.p50Ms ?? -1) >= 0);
  const decision = iq.frames[1].decision!;
  assert.equal(decision.called, true);
  assert.equal(decision.completed, true);
  assert.equal(decision.gravitySteps, 0);
  assert.equal(decision.yAtQuestion, -1);
  assert.equal(decision.yAtDecision, -1);
  assert.equal(decision.budgetMs, IQ_TIMEOUT_MS);
  assert.equal(blitz.frames[1].decision!.budgetMs, null);
  assert.equal(decision.stateHash, stateHash(iq.frames[0].state));
});

test('IQ: one timeout then instant answers still reaches pieces > 0', async () => {
  let call = 0;
  const flaky = brain(async (input, { signal }) => {
    call++;
    if (call === 1) await sleep(500, signal);
    return answerFirst(input);
  }, 'llm');
  const game = await runGame(flaky, 'test', 'IQ', { maxPieces: 3, iqTimeoutMs: 30 });
  assert.equal(game.pieces, 3);
  assert.equal(game.outcome, 'piece-cap');
  assert.deepEqual(events(game), ['timeout', 'placement', 'placement', 'placement']);
  assert.equal(game.metrics.timedOutCalls, 1);
  assert.equal(game.metrics.completedCalls, 3);
  assert.equal(game.metrics.calls, 4);
  assert.equal(game.metrics.unpricedCalls, 4, 'hosted calls without a cost, the aborted one included');
  assert.equal(game.frames[1].decision!.completed, false);
});

test('IQ: a brain that resolves on abort completes nothing and has no latency', async () => {
  const game = await runGame(resolvesOnAbort(400), 'test', 'IQ', { iqTimeoutMs: 20, maxTicks: 3 });
  assert.equal(game.outcome, 'adapter-failure');
  assert.equal(game.metrics.completedCalls, 0);
  assert.equal(game.metrics.p50Ms, null);
  assert.equal(game.metrics.p95Ms, null);
  assert.equal(game.metrics.timedOutCalls, 3);
  assert.equal(game.metrics.calls, 3);
  assert.equal(game.metrics.costUsd, 1.5, 'a cost reported by a settled aborted call is still counted');
  assert.equal(game.metrics.unpricedCalls, 0);
  assert.equal(game.pieces, 0);
});

test('IQ: a brain that ignores abort is not waited on beyond the settle grace', async () => {
  const started = performance.now();
  const game = await runGame(slowIgnoresAbort(2000), 'test', 'IQ', { iqTimeoutMs: 20, maxTicks: 3 });
  assert.ok(performance.now() - started < 1500, 'three timeouts plus three grace periods');
  assert.equal(game.outcome, 'adapter-failure');
  assert.deepEqual(events(game), ['timeout', 'timeout', 'timeout']);
  assert.equal(game.metrics.completedCalls, 0);
  assert.equal(game.metrics.unpricedCalls, 3);
});

test('IQ: a synchronous brain that blocks past the deadline is measured but cannot act', async () => {
  const game = await runGame(syncBlocking(40), 'test', 'IQ', { iqTimeoutMs: 10, maxTicks: 1 });
  assert.deepEqual(events(game), ['timeout']);
  assert.equal(game.metrics.completedCalls, 1);
  assert.equal(game.metrics.timedOutCalls, 1);
  assert.ok((game.metrics.p50Ms ?? 0) >= 40);
  assert.equal(game.frames[1].decision!.completed, true);
  assert.equal(game.pieces, 0);
});

test('Blitz: a slow greedy brain scores the IQ greedy score minus the lost drop points, all placements late', async () => {
  const pieces = 8;
  const iq = await runGame(greedy(0), 'seed-01', 'IQ', { maxPieces: pieces });
  const blitz = await runGame(greedy(350), 'seed-01', 'Blitz', { maxPieces: pieces, gravityInterval: () => 200 });
  assert.equal(blitz.pieces, pieces);
  assert.equal(blitz.score, iq.score - 2 * pieces, 'one gravity step per piece costs exactly two drop points');
  assert.equal(blitz.lines, iq.lines);
  assert.ok(events(blitz).every(event => event === 'placement-late'));
  assert.equal(blitz.metrics.lateAccepted, pieces);
  assert.equal(blitz.metrics.accepted, pieces);
  for (const frame of blitz.frames.slice(1)) {
    assert.equal(frame.decision!.gravitySteps, 1);
    assert.equal(frame.decision!.yAtDecision, frame.decision!.yAtQuestion + 1);
  }
});

test('Blitz: a 1300 ms brain still places pieces on the real clock', async () => {
  const game = await runGame(greedy(1300), 'seed-01', 'Blitz', { maxPieces: 1 });
  assert.equal(game.pieces, 1);
  assert.deepEqual(events(game), ['placement-late']);
  assert.equal(game.frames[1].decision!.gravitySteps, 1);
  assert.ok(game.frames[1].decision!.latencyMs >= 1300);
});

test('Blitz: a synchronous brain that blocks past a gravity step is judged after the step', async () => {
  const game = await runGame(syncBlocking(60), 'seed-01', 'Blitz', { maxPieces: 1, gravityInterval: () => 25 });
  assert.equal(game.pieces, 1);
  assert.deepEqual(events(game), ['placement-late']);
  assert.ok(game.frames[1].decision!.gravitySteps >= 2);
});

test('Blitz: locked-by-gravity does not count toward adapter failure', async () => {
  let aborted = 0;
  const silent = brain((_input, { signal }) => new Promise(() => {
    signal.addEventListener('abort', () => {
      aborted++;
    });
  }), 'llm');
  const game = await runGame(silent, 'seed-01', 'Blitz', { maxTicks: 3, gravityInterval: () => 3 });
  assert.equal(game.outcome, 'tick-cap');
  assert.deepEqual(events(game), ['locked-by-gravity', 'locked-by-gravity', 'locked-by-gravity']);
  assert.equal(game.pieces, 3);
  assert.equal(game.metrics.lockedByGravity, 3);
  assert.equal(game.metrics.calls, 3);
  assert.equal(game.metrics.completedCalls, 0);
  assert.equal(game.metrics.unpricedCalls, 3);
  assert.equal(aborted, 3);
  for (const frame of game.frames.slice(1)) {
    assert.ok(frame.decision!.gravitySteps >= 15);
    assert.ok(frame.decision!.yAtDecision > frame.decision!.yAtQuestion);
  }
});

test('three invalid answers end the game as adapter-failure in both modes', async () => {
  for (const mode of ['IQ', 'Blitz'] as const) {
    const game = await runGame(invalid, 'test', mode);
    assert.equal(game.outcome, 'adapter-failure');
    assert.equal(game.metrics.calls, 3);
    assert.equal(game.metrics.invalid, 3);
    assert.equal(game.pieces, 0);
    assert.equal(game.frames[1].decision!.reason, 'answer is not an object');
  }
});

test('errors have their own bucket and are not counted as invalid', async () => {
  const game = await runGame(throws, 'test', 'IQ');
  assert.equal(game.outcome, 'adapter-failure');
  assert.deepEqual(events(game), ['error', 'error', 'error']);
  assert.equal(game.metrics.errors, 3);
  assert.equal(game.metrics.invalid, 0);
  assert.equal(game.metrics.completedCalls, 3, 'a rejection is a completed call');
  assert.equal(game.metrics.unpricedCalls, 3);
  assert.equal(game.frames[1].decision!.reason, 'boom');
});

test('stale answers never move the piece', async () => {
  const game = await runGame(stale, 'test', 'Blitz');
  assert.equal(game.metrics.stale, 3);
  assert.equal(game.outcome, 'adapter-failure');
  assert.equal(game.pieces, 0);
});

test('hold-repeat: a hold is accepted once per piece, then the placement is applied with the hold ignored', async () => {
  const game = await runGame(holdRepeat, 'test', 'IQ', { maxPieces: 2 });
  assert.deepEqual(events(game), ['hold', 'placement', 'hold', 'placement']);
  assert.equal(game.metrics.holds, 2);
  assert.equal(game.metrics.accepted, 4);
  assert.equal(game.metrics.invalid, 0);
  assert.equal(game.frames[2].decision!.reason, 'ignored: noul');
  assert.equal(game.frames[1].decision!.answer?.noul?.hold, 1);
  assert.equal(game.frames[1].state.hold, game.frames[0].state.active.type);
});

test('cost: known costs are summed and every hosted call without a cost is unpriced', async () => {
  let call = 0;
  const hosted = brain(input => {
    call++;
    return answerFirst(input, call === 2 ? {} : { costUsd: 0.1 * call, meta: { retries: 1, promptTokens: 5 } });
  }, 'llm');
  const game = await runGame(hosted, 'test', 'IQ', { maxPieces: 3 });
  assert.ok(Math.abs(game.metrics.costUsd - 0.4) < 1e-9);
  assert.equal(game.metrics.unpricedCalls, 1);
  assert.equal(game.metrics.retries, 2);
  assert.equal(game.frames[1].decision!.costUsd, 0.1);
  assert.equal(game.frames[2].decision!.costUsd, undefined);
  assert.deepEqual(game.frames[1].decision!.meta, { retries: 1, promptTokens: 5 });
  assert.equal(game.frames[1].decision!.retries, 1);
  const local = await runGame(brain(input => answerFirst(input)), 'test', 'IQ', { maxPieces: 2 });
  assert.equal(local.metrics.unpricedCalls, 0);
  assert.equal(local.metrics.costUsd, 0);
});

test('calibration: risk forecasts resolve after ten pieces or at top-out', async () => {
  const forecaster = brain(input => answerFirst(input, { score: { risk: 0.25 } }));
  const game = await runGame(forecaster, 'test', 'IQ', { maxPieces: 12 });
  assert.equal(game.metrics.calibrationCount, 3, 'forecasts at pieces 0, 1 and 2 resolve once twelve pieces are locked');
  assert.ok(Math.abs((game.metrics.calibrationError ?? 0) - 0.0625) < 1e-9);
});

test('a slow abort-respecting brain in Blitz is asked once per tick, never twice', async () => {
  // A piece lives about twenty 4 ms gravity steps; 400 ms keeps the brain from ever finishing
  // first, even on a loaded machine.
  const slow = slowRespectsAbort(400);
  let calls = 0;
  const counted = { ...slow, decide: (input: AgentInput, ctx: { signal: AbortSignal; budgetMs: number | null }) => {
    calls++;
    return slow.decide(input, ctx);
  } };
  const game = await runGame(counted, 'seed-01', 'Blitz', { maxTicks: 4, gravityInterval: () => 4 });
  assert.equal(calls, 4);
  assert.equal(game.metrics.calls, 4);
  assert.equal(game.metrics.completedCalls, 0, 'every call was aborted when its piece locked');
  assert.ok(events(game).every(event => event === 'locked-by-gravity'));
  const iq = await runGame(slowRespectsAbort(5), 'seed-01', 'IQ', { maxPieces: 2 });
  assert.equal(iq.pieces, 2);
  assert.equal(iq.metrics.completedCalls, 2);
});
