import type { GameResult, MatchResult } from './contract.ts';

export const OFFICIAL_SEEDS = Array.from({ length: 30 }, (_, i) => `seed-${String(i + 1).padStart(2, '0')}`);
export const QUICK_SEEDS = OFFICIAL_SEEDS.slice(0, 3);
export const RATING_CENTER = 1500;
export const RATING_SCALE = 400 / Math.log(10);
// Gaussian N(0, 2^2) prior on log strengths keeps undefeated fields finite.
// Each pair has weight 1/(n-1): one seed contributes one opponent-average
// observation per brain, rather than increasing evidence with field size.
export const RATING_PRIOR_PRECISION = 0.25;
export const BOOTSTRAP_REPLICATES = 200;
export const BOOTSTRAP_SEED = 0x74544232;
export const INTERVAL_COVERAGE = 0.95;

export function matchPoint(a: number, b: number): number { return a === b ? 0.5 : a > b ? 1 : 0; }

function fit(scores: number[][], size: number): number[] {
  if (size < 2) return Array(size).fill(RATING_CENTER);
  const strengths = Array<number>(size).fill(0);
  const weight = 1 / (size - 1);
  // Bound on the logistic Hessian's largest eigenvalue. Synchronous updates
  // are invariant to labels and input order, unlike sequential Elo updates.
  const step = 1 / (RATING_PRIOR_PRECISION + scores.length * size * weight / 4);
  for (let iteration = 0; iteration < 2000; iteration++) {
    const gradient = strengths.map(value => -RATING_PRIOR_PRECISION * value);
    for (const seed of scores) for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) {
      const expected = 1 / (1 + Math.exp(strengths[j] - strengths[i]));
      const residual = weight * (matchPoint(seed[i], seed[j]) - expected);
      gradient[i] += residual;
      gradient[j] -= residual;
    }
    let largest = 0;
    for (let i = 0; i < size; i++) {
      const change = step * gradient[i];
      strengths[i] += change;
      largest = Math.max(largest, Math.abs(change));
    }
    if (largest < 1e-11) break;
  }
  const mean = strengths.reduce((a, b) => a + b, 0) / size;
  return strengths.map(value => RATING_CENTER + RATING_SCALE * (value - mean));
}

function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function rateField(slugs: string[], seeds: string[], games: GameResult[]) {
  if (!slugs.length || !seeds.length) throw new Error('Rating requires a nonempty field and seeds');
  if (new Set(slugs).size !== slugs.length || new Set(seeds).size !== seeds.length) throw new Error('Duplicate brain or seed in rating field');
  const sorted = [...slugs].sort(), sortedSeeds = [...seeds].sort();
  const key = (brain: string, seed: string, mode: string) => JSON.stringify([brain, seed, mode]);
  const lookup = new Map<string, GameResult>();
  for (const game of games) {
    if (!sorted.includes(game.brain) || !sortedSeeds.includes(game.seed) || !['IQ', 'Blitz'].includes(game.mode)) throw new Error('Unexpected game outside rating field');
    if (!Number.isFinite(game.score)) throw new Error('Rating requires finite scores');
    const id = key(game.brain, game.seed, game.mode);
    if (lookup.has(id)) throw new Error('Duplicate game in rating field');
    lookup.set(id, game);
  }
  const matrix = (mode: 'IQ' | 'Blitz') => sortedSeeds.map(seed => sorted.map(brain => {
    const game = lookup.get(key(brain, seed, mode));
    if (!game) throw new Error('Rating requires every seed and both modes for every brain');
    return game.score;
  }));
  const iq = matrix('IQ'), blitz = matrix('Blitz');
  const asRecord = (values: number[]) => Object.fromEntries(sorted.map((slug, i) => [slug, values[i]]));
  const ratings = asRecord(fit(iq, sorted.length));
  const blitzRatings = asRecord(fit(blitz, sorted.length));
  const matches: MatchResult[] = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) for (let s = 0; s < sortedSeeds.length; s++) {
    const point = matchPoint(iq[s][i], iq[s][j]);
    matches.push({ a: sorted[i], b: sorted[j], seed: sortedSeeds[s], iq: point, blitz: matchPoint(blitz[s][i], blitz[s][j]), point });
  }
  // Resample complete shared seed blocks, never individual pairings. These
  // percentile intervals describe seed variation conditional on this field,
  // not model stochasticity, provider variability, or a posterior interval.
  let rng = BOOTSTRAP_SEED;
  const samples = sorted.map(() => [] as number[]);
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate++) {
    const resampled = sortedSeeds.map(() => {
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
      return iq[Math.floor((rng >>> 0) / 0x100000000 * iq.length)];
    });
    fit(resampled, sorted.length).forEach((rating, i) => samples[i].push(rating));
  }
  const tail = (1 - INTERVAL_COVERAGE) / 2;
  const intervals = Object.fromEntries(sorted.map((slug, i) => [slug, { lower: quantile(samples[i], tail), upper: quantile(samples[i], 1 - tail) }]));
  return { ratings, blitzRatings, intervals, matches };
}
