import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPoint, rateField, OFFICIAL_SEEDS, QUICK_SEEDS } from '../../lib/tetris-bench/rating.ts';
import type { GameResult } from '../../lib/tetris-bench/contract.ts';

const seeds = ['s1', 's2', 's3'];
function field(slugs: string[], iq: number[][], blitz = iq): GameResult[] {
  return slugs.flatMap((brain, i) => seeds.flatMap((seed, s) => (['IQ', 'Blitz'] as const).map(mode => ({ brain, seed, mode, score: (mode === 'IQ' ? iq : blitz)[s][i] } as GameResult))));
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('headline fits IQ alone, Blitz separate; centered finite ratings and frozen seed counts', () => {
  const result = rateField(['a', 'b'], seeds, field(['a', 'b'], [[1, 0], [1, 0], [1, 0]], [[0, 1], [0, 1], [0, 1]]));
  assert.ok(result.ratings.a > 1500 && result.blitzRatings.a < 1500);
  close(result.ratings.a + result.ratings.b, 3000);
  close(result.ratings.a, result.blitzRatings.b);
  assert.ok(result.matches.every(match => match.point === 1 && match.iq === 1 && match.blitz === 0));
  assert.equal(matchPoint(4, 4), 0.5);
  assert.equal(OFFICIAL_SEEDS.length, 30);
  assert.equal(OFFICIAL_SEEDS.at(-1), 'seed-30');
  assert.deepEqual(QUICK_SEEDS, ['seed-01', 'seed-02', 'seed-03']);
});

test('ratings and intervals are invariant to input ordering and equivariant to slug relabeling', () => {
  const games = field(['a', 'b', 'c'], [[3, 2, 1], [1, 3, 2], [3, 1, 2]]);
  const result = rateField(['a', 'b', 'c'], seeds, games);
  assert.deepEqual(rateField(['c', 'a', 'b'], [...seeds].reverse(), [...games].reverse()), result);
  const rename: Record<string, string> = { a: 'z', b: 'x', c: 'y' };
  const renamed = rateField(['z', 'x', 'y'], seeds, games.map(game => ({ ...game, brain: rename[game.brain] })));
  for (const slug of ['a', 'b', 'c']) {
    close(result.ratings[slug], renamed.ratings[rename[slug]]);
    close(result.intervals[slug].lower, renamed.intervals[rename[slug]].lower);
    close(result.intervals[slug].upper, renamed.intervals[rename[slug]].upper);
  }
});

test('ties are symmetric and a one-brain exhibition stays neutral', () => {
  const result = rateField(['a', 'b', 'c'], seeds, field(['a', 'b', 'c'], [[1, 1, 1], [2, 2, 2], [0, 0, 0]]));
  assert.deepEqual(result.ratings, { a: 1500, b: 1500, c: 1500 });
  assert.deepEqual(result.intervals.a, { lower: 1500, upper: 1500 });
  const single = rateField(['a'], seeds, field(['a'], [[1], [2], [3]]));
  assert.deepEqual(single.ratings, { a: 1500 });
  assert.deepEqual(single.matches, []);
});

test('uncertainty resamples whole seeds preserving identical competitors and varying seed outcomes', () => {
  const result = rateField(['a', 'b', 'c'], seeds, field(['a', 'b', 'c'], [[1, 0, 0], [0, 1, 1], [1, 0, 0]]));
  assert.deepEqual(result.intervals.b, result.intervals.c);
  assert.ok(result.intervals.a.lower < 1500 && result.intervals.a.upper > 1500);
  // With one seed, every block resample must be the same complete field.
  const one = rateField(['a', 'b', 'c'], ['s1'], field(['a', 'b', 'c'], [[3, 2, 1], [1, 2, 3], [1, 2, 3]]).filter(game => game.seed === 's1'));
  for (const slug of ['a', 'b', 'c']) {
    close(one.intervals[slug].lower, one.ratings[slug]);
    close(one.intervals[slug].upper, one.ratings[slug]);
  }
});

test('incomplete, duplicate, unexpected and nonfinite observations are rejected', () => {
  const games = field(['a', 'b'], [[1, 0], [0, 1], [1, 0]]);
  assert.throws(() => rateField(['a', 'b'], seeds, games.slice(1)), /every seed/);
  assert.throws(() => rateField(['a', 'b'], seeds, [...games, games[0]]), /Duplicate game/);
  assert.throws(() => rateField(['a', 'a'], seeds, games), /Duplicate brain/);
  assert.throws(() => rateField(['a', 'b'], ['s1', 's1'], games), /Duplicate brain or seed/);
  assert.throws(() => rateField(['a', 'b'], seeds, [...games, { ...games[0], brain: 'extra' }]), /Unexpected/);
  assert.throws(() => rateField(['a', 'b'], seeds, games.map((game, i) => i === 0 ? { ...game, score: NaN } : game)), /finite/);
  assert.throws(() => rateField([], seeds, []), /nonempty/);
});
