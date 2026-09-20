import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOTSTRAP_REPLICATES,
  MIN_SEEDS_FOR_INTERVAL,
  OFFICIAL_SEEDS,
  QUICK_SEEDS,
  fit,
  matchPoint,
  quantile,
  sampleSd,
  summariseField,
  tInterval,
  tQuantile,
} from '../../lib/tetris-bench/rating.ts';
import type { RatedGame } from '../../lib/tetris-bench/rating.ts';
import type { Mode } from '../../lib/tetris-bench/contract.ts';

const seeds30 = OFFICIAL_SEEDS.slice();
const seeds3 = QUICK_SEEDS.slice();

function game(brain: string, seed: string, mode: Mode, score: number, lines = Math.round(score / 100)): RatedGame {
  return { brain, seed, mode, score, lines, pieces: 500, outcome: 'piece-cap' };
}

/** A field from a seed-major score matrix: `iq[s][i]` is brain i's IQ score on seed s. */
function field(slugs: string[], seeds: string[], iq: number[][], blitz?: number[][]): RatedGame[] {
  const games: RatedGame[] = [];
  seeds.forEach((seed, s) => {
    slugs.forEach((slug, i) => {
      games.push(game(slug, seed, 'IQ', iq[s][i]));
      if (blitz) games.push(game(slug, seed, 'Blitz', blitz[s][i]));
    });
  });
  return games;
}

/** Deterministic xorshift for the simulations. */
function rng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/** Approximately normal draws (sum of twelve uniforms). */
function gaussian(next: () => number): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += next();
  return sum - 6;
}

/**
 * Synthetic field: each brain has a true mean, each seed a shared effect, and
 * each game independent noise. Returns the seed-major IQ matrix.
 */
function syntheticMatrix(next: () => number, means: number[], seedCount: number, seedSd = 800, noiseSd = 700): number[][] {
  return Array.from({ length: seedCount }, () => {
    const seedEffect = gaussian(next) * seedSd;
    return means.map(centre => Math.round(centre + seedEffect + gaussian(next) * noiseSd));
  });
}

const close = (a: number, b: number, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('seed constants and t table', () => {
  assert.equal(OFFICIAL_SEEDS.length, 30);
  assert.equal(OFFICIAL_SEEDS[0], 'seed-01');
  assert.equal(OFFICIAL_SEEDS.at(-1), 'seed-30');
  assert.deepEqual(QUICK_SEEDS, ['seed-01', 'seed-02', 'seed-03']);
  assert.equal(tQuantile(29), 2.045);
  assert.equal(tQuantile(9), 2.262);
  assert.equal(tQuantile(41), 1.96);
  assert.throws(() => tQuantile(5), /No t quantile/);
  assert.equal(matchPoint(4, 4), 0.5);
  assert.equal(matchPoint(5, 4), 1);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  close(sampleSd([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
});

test('t-interval: mean ± t(0.975, S-1)·sd/√S for S ≥ 10, withheld below', () => {
  const values = Array.from({ length: 30 }, (_, i) => 1000 + i * 37);
  const interval = tInterval(values);
  assert.ok(interval);
  const centre = values.reduce((a, b) => a + b, 0) / 30;
  const halfWidth = 2.045 * sampleSd(values) / Math.sqrt(30);
  close(interval.lower, centre - halfWidth);
  close(interval.upper, centre + halfWidth);
  assert.equal(tInterval(values.slice(0, 9)), null);
  assert.ok(tInterval(values.slice(0, 10)));
  assert.deepEqual(tInterval(Array(10).fill(5)), { lower: 5, upper: 5 });
});

test('summary carries per-seed scores, mean lines and null intervals on quick fields', () => {
  const games = field(['a', 'b'], seeds3, [[100, 50], [200, 150], [300, 250]]);
  const summary = summariseField(['a', 'b'], seeds3, games);
  assert.equal(summary.iq.a.mean, 200);
  assert.equal(summary.iq.b.mean, 150);
  assert.equal(summary.iq.a.interval, null);
  assert.equal(summary.iq.a.meanLines, 2);
  assert.deepEqual(summary.iq.a.perSeed.map(entry => entry.seed), seeds3);
  assert.deepEqual(summary.iq.a.perSeed[0], { seed: 'seed-01', score: 100, lines: 1, pieces: 500, outcome: 'piece-cap' });
  assert.deepEqual(summary.rank, ['a', 'b']);
  assert.deepEqual(summary.ties, []);
  assert.deepEqual(summary.headToHead, [{ a: 'a', b: 'b', meanDiff: 50, interval: null, wins: 3, draws: 0, losses: 0 }]);
  assert.equal(summary.elo.a.interval, null);
  assert.equal(summary.blitz.a, null);
});

test('IQ must cover every seed; Blitz is optional per brain but all-or-nothing', () => {
  const games = field(['a', 'b'], seeds3, [[1, 0], [0, 1], [1, 0]]);
  assert.throws(() => summariseField(['a', 'b'], seeds3, games.slice(1)), /every seed in IQ for a \(2 of 3\)/);
  assert.throws(() => summariseField(['a', 'b', 'c'], seeds3, games), /every seed in IQ for c \(0 of 3\)/);
  const blitzOnlyA = [...games, game('a', 'seed-01', 'Blitz', 5), game('a', 'seed-02', 'Blitz', 6), game('a', 'seed-03', 'Blitz', 7)];
  const summary = summariseField(['a', 'b'], seeds3, blitzOnlyA);
  assert.equal(summary.blitz.a?.mean, 6);
  assert.equal(summary.blitz.b, null);
  assert.throws(() => summariseField(['a', 'b'], seeds3, blitzOnlyA.slice(0, -1)), /every seed in Blitz for a \(2 of 3\)/);
});

test('duplicate, unexpected and nonfinite observations are rejected', () => {
  const games = field(['a', 'b'], seeds3, [[1, 0], [0, 1], [1, 0]]);
  assert.throws(() => summariseField(['a', 'b'], seeds3, [...games, games[0]]), /Duplicate game/);
  assert.throws(() => summariseField(['a', 'a'], seeds3, games), /Duplicate brain/);
  assert.throws(() => summariseField(['a', 'b'], ['seed-01', 'seed-01'], games), /Duplicate brain or seed/);
  assert.throws(() => summariseField(['a', 'b'], seeds3, [...games, game('extra', 'seed-01', 'IQ', 1)]), /Unexpected/);
  assert.throws(() => summariseField(['a', 'b'], seeds3, games.map((entry, i) => (i === 0 ? { ...entry, score: NaN } : entry))), /finite/);
  assert.throws(() => summariseField([], seeds3, []), /nonempty/);
});

test('rank orders by IQ mean, then mean lines, then slug', () => {
  const games: RatedGame[] = [];
  for (const seed of seeds3) {
    games.push({ brain: 'x', seed, mode: 'IQ', score: 100, lines: 5, pieces: 10, outcome: 'top-out' });
    games.push({ brain: 'y', seed, mode: 'IQ', score: 100, lines: 7, pieces: 10, outcome: 'top-out' });
    games.push({ brain: 'z', seed, mode: 'IQ', score: 100, lines: 7, pieces: 10, outcome: 'top-out' });
    games.push({ brain: 'w', seed, mode: 'IQ', score: 300, lines: 1, pieces: 10, outcome: 'top-out' });
  }
  const summary = summariseField(['x', 'y', 'z', 'w'], seeds3, games);
  assert.deepEqual(summary.rank, ['w', 'y', 'z', 'x']);
  // Head-to-head pairs are listed in rank order, higher-ranked first.
  assert.deepEqual(summary.headToHead.map(pair => `${pair.a}>${pair.b}`), ['w>y', 'w>z', 'w>x', 'y>z', 'y>x', 'z>x']);
  assert.deepEqual(summary.headToHead[3], { a: 'y', b: 'z', meanDiff: 0, interval: null, wins: 0, draws: 3, losses: 0 });
});

test('head-to-head: paired differences, seed W/D/L, and a bootstrap interval that contains the mean difference', () => {
  const next = rng(11);
  const matrix = syntheticMatrix(next, [3000, 2700, 500], 30);
  const summary = summariseField(['a', 'b', 'c'], seeds30, field(['a', 'b', 'c'], seeds30, matrix));
  for (const pair of summary.headToHead) {
    const scoresA = summary.iq[pair.a].perSeed.map(entry => entry.score);
    const scoresB = summary.iq[pair.b].perSeed.map(entry => entry.score);
    const paired = scoresA.map((score, s) => score - scoresB[s]);
    close(pair.meanDiff, paired.reduce((x, y) => x + y, 0) / 30);
    close(pair.meanDiff, summary.iq[pair.a].mean - summary.iq[pair.b].mean);
    assert.equal(pair.wins + pair.draws + pair.losses, 30);
    assert.equal(pair.wins, paired.filter(difference => difference > 0).length);
    assert.equal(pair.losses, paired.filter(difference => difference < 0).length);
    assert.ok(pair.interval);
    assert.ok(pair.interval.lower <= pair.meanDiff && pair.meanDiff <= pair.interval.upper);
  }
  // The clear gap (a - c ≈ 2500) excludes zero; the near-tie does not decide.
  const clear = summary.headToHead.find(pair => pair.b === 'c' && pair.a === summary.rank[0]);
  assert.ok(clear?.interval && clear.interval.lower > 0);
  assert.equal(summary.headToHead.length, 3);
});

test('ties are the adjacent ranked pairs whose head-to-head interval includes zero', () => {
  const next = rng(5);
  // Two brains that are the same generator plus a little noise, one far below.
  const matrix = syntheticMatrix(next, [3000, 3000, 500], 30, 800, 300);
  const summary = summariseField(['p', 'q', 'r'], seeds30, field(['p', 'q', 'r'], seeds30, matrix));
  assert.deepEqual(summary.rank.slice().sort(), ['p', 'q', 'r']);
  assert.equal(summary.rank[2], 'r');
  assert.deepEqual(summary.ties, [[summary.rank[0], summary.rank[1]]]);
  // No intervals on a quick field: no ties can be declared.
  const quick = summariseField(['p', 'q', 'r'], seeds3, field(['p', 'q', 'r'], seeds3, matrix.slice(0, 3)));
  assert.deepEqual(quick.ties, []);
});

test('the summary is invariant to input ordering and equivariant to slug relabelling', () => {
  const next = rng(23);
  const matrix = syntheticMatrix(next, [3000, 2800, 2600, 500], 30);
  const slugs = ['a', 'b', 'c', 'd'];
  const games = field(slugs, seeds30, matrix, matrix.map(row => row.map(score => Math.round(score / 2))));
  const summary = summariseField(slugs, seeds30, games);
  const shuffled = summariseField([...slugs].reverse(), [...seeds30].reverse(), [...games].reverse());
  assert.deepEqual(shuffled, summary);

  const rename: Record<string, string> = { a: 'z', b: 'x', c: 'y', d: 'w' };
  const renamed = summariseField(slugs.map(slug => rename[slug]), seeds30, games.map(entry => ({ ...entry, brain: rename[entry.brain] })));
  assert.deepEqual(renamed.rank, summary.rank.map(slug => rename[slug]));
  for (const slug of slugs) {
    assert.deepEqual(renamed.iq[rename[slug]], summary.iq[slug]);
    assert.deepEqual(renamed.blitz[rename[slug]], summary.blitz[slug]);
    close(renamed.elo[rename[slug]].rating, summary.elo[slug].rating, 1e-6);
  }
  assert.deepEqual(renamed.headToHead, summary.headToHead.map(pair => ({ ...pair, a: rename[pair.a], b: rename[pair.b] })));
  assert.deepEqual(renamed.ties, summary.ties.map(([a, b]) => [rename[a], rename[b]]));
});

test('Elo-style rating: centred at 1500, monotone in wins, all-ties neutral, separated records get no interval', () => {
  assert.deepEqual(fit([[1, 2, 3]], 1), [1500]);
  const next = rng(3);
  // Brain d sits far enough below the noise that it loses every pairing on every seed.
  const matrix = syntheticMatrix(next, [3000, 2500, 2000, -20000], 30);
  const summary = summariseField(['a', 'b', 'c', 'd'], seeds30, field(['a', 'b', 'c', 'd'], seeds30, matrix));
  const ratings = Object.values(summary.elo).map(entry => entry.rating);
  close(ratings.reduce((x, y) => x + y, 0) / ratings.length, 1500, 1e-6);
  // Brain d loses every pairing on every seed: rating lowest, interval withheld.
  assert.ok(summary.elo.d.rating < summary.elo.c.rating);
  assert.equal(summary.elo.d.interval, null);
  // The rest are mixed records and get bootstrap intervals containing the point.
  for (const slug of ['a', 'b', 'c']) {
    const { rating, interval } = summary.elo[slug];
    assert.ok(interval, `${slug} should have an interval`);
    assert.ok(interval.lower <= rating && rating <= interval.upper);
  }
  const tied = summariseField(['a', 'b', 'c'], seeds30, field(['a', 'b', 'c'], seeds30, seeds30.map(() => [7, 7, 7])));
  assert.deepEqual(tied.elo, {
    a: { rating: 1500, interval: { lower: 1500, upper: 1500 } },
    b: { rating: 1500, interval: { lower: 1500, upper: 1500 } },
    c: { rating: 1500, interval: { lower: 1500, upper: 1500 } },
  });
  const single = summariseField(['a'], seeds30, field(['a'], seeds30, seeds30.map((_, s) => [s])));
  assert.deepEqual(single.elo, { a: { rating: 1500, interval: null } });
  assert.deepEqual(single.headToHead, []);
});

test('simulation: t-intervals and paired bootstrap intervals cover their targets about 95% of the time', () => {
  const next = rng(99);
  const means = [3000, 2700];
  const trials = 60;
  let meanCovered = 0;
  let diffCovered = 0;
  let wrongSign = 0;
  for (let trial = 0; trial < trials; trial++) {
    const matrix = syntheticMatrix(next, means, 30);
    const summary = summariseField(['a', 'b'], seeds30, field(['a', 'b'], seeds30, matrix));
    const interval = summary.iq.a.interval;
    assert.ok(interval);
    if (interval.lower <= means[0] && means[0] <= interval.upper) meanCovered++;
    const pair = summary.headToHead.find(entry => new Set([entry.a, entry.b]).has('a') && new Set([entry.a, entry.b]).has('b'));
    assert.ok(pair?.interval);
    const trueGap = pair.a === 'a' ? means[0] - means[1] : means[1] - means[0];
    if (pair.interval.lower <= trueGap && trueGap <= pair.interval.upper) diffCovered++;
    if (pair.interval.lower > 0 && trueGap < 0) wrongSign++;
    if (pair.interval.upper < 0 && trueGap > 0) wrongSign++;
  }
  const meanRate = meanCovered / trials;
  const diffRate = diffCovered / trials;
  assert.ok(meanRate >= 0.86 && meanRate <= 1, `t-interval coverage ${meanRate}`);
  assert.ok(diffRate >= 0.86 && diffRate <= 1, `paired bootstrap coverage ${diffRate}`);
  assert.equal(wrongSign, 0);
  assert.equal(BOOTSTRAP_REPLICATES, 2000);
  assert.equal(MIN_SEEDS_FOR_INTERVAL, 10);
});

test('the summary is deterministic across calls', () => {
  const next = rng(42);
  const matrix = syntheticMatrix(next, [2000, 1500], 12);
  const seeds = seeds30.slice(0, 12);
  const games = field(['a', 'b'], seeds, matrix);
  assert.deepEqual(summariseField(['a', 'b'], seeds, games), summariseField(['a', 'b'], seeds, games));
});
