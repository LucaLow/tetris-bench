/**
 * Rating: mean IQ score per brain with an honest interval, paired head-to-head
 * differences, a rank with declared ties, and a secondary Elo-style number.
 *
 * The data are one game per brain per seed. Seeds are the unit of variation,
 * so every interval here resamples or pools over seeds: the t-interval on the
 * mean, the seed-block bootstrap on paired differences, and the seed-block
 * bootstrap on the Bradley-Terry fit. Browser-safe: no Node imports.
 */
import type { GameOutcome, Mode } from './contract.ts';

export const OFFICIAL_SEEDS: readonly string[] = Array.from({ length: 30 }, (_, i) => `seed-${String(i + 1).padStart(2, '0')}`);
export const QUICK_SEEDS: readonly string[] = OFFICIAL_SEEDS.slice(0, 3);

/** Intervals are withheld below this many seeds: neither method reaches useful coverage. */
export const MIN_SEEDS_FOR_INTERVAL = 10;
export const BOOTSTRAP_REPLICATES = 2000;
export const BOOTSTRAP_SEED = 0x74544233;
export const INTERVAL_COVERAGE = 0.95;

export const RATING_CENTER = 1500;
export const RATING_SCALE = 400 / Math.log(10);
// Gaussian N(0, 2^2) prior on log strengths keeps undefeated fields finite.
// Each pair has weight 1/(n-1): one seed contributes one opponent-average
// observation per brain, rather than increasing evidence with field size.
export const RATING_PRIOR_PRECISION = 0.25;

export interface Interval {
  lower: number;
  upper: number;
}

export interface SeedScore {
  seed: string;
  score: number;
  lines: number;
  pieces: number;
  outcome: string;
}

export interface ScoreSummary {
  mean: number;
  /** Sample standard deviation over seeds (0 with fewer than two seeds). */
  sd: number;
  /** 95% t-interval on the mean; null below MIN_SEEDS_FOR_INTERVAL seeds. */
  interval: Interval | null;
  meanLines: number;
  perSeed: SeedScore[];
}

export interface HeadToHead {
  a: string;
  b: string;
  /** Mean over seeds of (score of a - score of b). */
  meanDiff: number;
  /** Seed-block bootstrap percentile interval; null below MIN_SEEDS_FOR_INTERVAL seeds. */
  interval: Interval | null;
  wins: number;
  draws: number;
  losses: number;
}

export interface EloEstimate {
  rating: number;
  /** Null below MIN_SEEDS_FOR_INTERVAL seeds or when the brain's record is separated (all wins or all losses). */
  interval: Interval | null;
}

export interface FieldSummary {
  iq: Record<string, ScoreSummary>;
  blitz: Record<string, ScoreSummary | null>;
  headToHead: HeadToHead[];
  rank: string[];
  ties: Array<[string, string]>;
  elo: Record<string, EloEstimate>;
}

/** The fields the rating reads; both GameResult and RunSummary satisfy it. */
export interface RatedGame {
  brain: string;
  seed: string;
  mode: Mode;
  score: number;
  lines: number;
  pieces: number;
  outcome: GameOutcome;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/** Two-sided 97.5% quantiles of Student's t for 9..40 degrees of freedom. */
const T_QUANTILES: Record<number, number> = {
  9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120,
  17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064,
  25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042, 31: 2.040, 32: 2.037,
  33: 2.035, 34: 2.032, 35: 2.030, 36: 2.028, 37: 2.026, 38: 2.024, 39: 2.023, 40: 2.021,
};

/** t(0.975, df): the embedded table for 9..40 df, the normal quantile beyond it. */
export function tQuantile(degreesOfFreedom: number): number {
  if (degreesOfFreedom > 40) return 1.96;
  const value = T_QUANTILES[degreesOfFreedom];
  if (value === undefined) throw new Error(`No t quantile for ${degreesOfFreedom} degrees of freedom`);
  return value;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function sampleSd(values: number[]): number {
  if (values.length < 2) return 0;
  const centre = mean(values);
  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += (value - centre) ** 2;
  return Math.sqrt(sumOfSquares / (values.length - 1));
}

/** Linear-interpolation quantile of a sample. */
export function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** 95% t-interval on the mean, or null when there are too few seeds. */
export function tInterval(values: number[]): Interval | null {
  const count = values.length;
  if (count < MIN_SEEDS_FOR_INTERVAL) return null;
  const centre = mean(values);
  const halfWidth = tQuantile(count - 1) * sampleSd(values) / Math.sqrt(count);
  return { lower: centre - halfWidth, upper: centre + halfWidth };
}

export function matchPoint(a: number, b: number): number {
  if (a === b) return 0.5;
  return a > b ? 1 : 0;
}

/**
 * Deterministic seed-block resamples: each replicate is a list of seed
 * indices drawn with replacement. Every bootstrap in this module shares them
 * so a field summary is a pure function of the sorted field.
 */
function seedBlockResamples(seedCount: number, replicates: number): number[][] {
  let rng = BOOTSTRAP_SEED;
  const nextIndex = (): number => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return Math.floor(((rng >>> 0) / 0x100000000) * seedCount);
  };
  return Array.from({ length: replicates }, () => Array.from({ length: seedCount }, nextIndex));
}

function percentileInterval(samples: number[]): Interval {
  const tail = (1 - INTERVAL_COVERAGE) / 2;
  return { lower: quantile(samples, tail), upper: quantile(samples, 1 - tail) };
}

// ---------------------------------------------------------------------------
// Penalised Bradley-Terry fit (the secondary Elo-style number)
// ---------------------------------------------------------------------------

/**
 * Fit log strengths to the seed-by-brain score matrix by synchronous gradient
 * ascent with a Gaussian prior. Synchronous updates are invariant to labels
 * and input order, unlike sequential Elo updates.
 */
export function fit(scores: number[][], size: number): number[] {
  if (size < 2) return Array<number>(size).fill(RATING_CENTER);
  const strengths = Array<number>(size).fill(0);
  const weight = 1 / (size - 1);
  // 1 / (largest eigenvalue bound of the negative Hessian): monotone convergence.
  const step = 1 / (RATING_PRIOR_PRECISION + (scores.length * size * weight) / 4);
  for (let iteration = 0; iteration < 2000; iteration++) {
    const gradient = strengths.map(value => -RATING_PRIOR_PRECISION * value);
    for (const seed of scores) {
      for (let i = 0; i < size; i++) {
        for (let j = i + 1; j < size; j++) {
          const expected = 1 / (1 + Math.exp(strengths[j] - strengths[i]));
          const residual = weight * (matchPoint(seed[i], seed[j]) - expected);
          gradient[i] += residual;
          gradient[j] -= residual;
        }
      }
    }
    let largest = 0;
    for (let i = 0; i < size; i++) {
      const change = step * gradient[i];
      strengths[i] += change;
      largest = Math.max(largest, Math.abs(change));
    }
    if (largest < 1e-11) break;
  }
  const centre = mean(strengths);
  return strengths.map(value => RATING_CENTER + RATING_SCALE * (value - centre));
}

/** Total seed points of brain `index` against every opponent. */
function record(scores: number[][], index: number): number {
  let points = 0;
  for (const seed of scores) {
    for (let j = 0; j < seed.length; j++) {
      if (j !== index) points += matchPoint(seed[index], seed[j]);
    }
  }
  return points;
}

function eloEstimates(sorted: string[], iqMatrix: number[][], resamples: number[][]): Record<string, EloEstimate> {
  const size = sorted.length;
  const seedCount = iqMatrix.length;
  const ratings = fit(iqMatrix, size);
  const samples = sorted.map(() => [] as number[]);
  const intervalsAllowed = seedCount >= MIN_SEEDS_FOR_INTERVAL && size >= 2;
  if (intervalsAllowed) {
    for (const resample of resamples) {
      const replicate = fit(resample.map(index => iqMatrix[index]), size);
      replicate.forEach((rating, i) => samples[i].push(rating));
    }
  }
  const maximumRecord = (size - 1) * seedCount;
  const estimates: Record<string, EloEstimate> = {};
  sorted.forEach((slug, i) => {
    const points = record(iqMatrix, i);
    // A perfect or winless record cannot be resampled into anything else, so
    // the bootstrap would only measure the prior ceiling: withhold it.
    const separated = points === 0 || points === maximumRecord;
    const interval = intervalsAllowed && !separated ? percentileInterval(samples[i]) : null;
    estimates[slug] = { rating: ratings[i], interval };
  });
  return estimates;
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function gameKey(brain: string, seed: string, mode: Mode): string {
  return JSON.stringify([brain, seed, mode]);
}

function indexGames(slugs: string[], seeds: string[], games: RatedGame[]): Map<string, RatedGame> {
  const slugSet = new Set(slugs);
  const seedSet = new Set(seeds);
  const lookup = new Map<string, RatedGame>();
  for (const game of games) {
    if (!slugSet.has(game.brain) || !seedSet.has(game.seed) || (game.mode !== 'IQ' && game.mode !== 'Blitz')) {
      throw new Error(`Unexpected game outside rating field: ${game.brain} ${game.seed} ${game.mode}`);
    }
    if (!Number.isFinite(game.score)) throw new Error(`Rating requires finite scores: ${game.brain} ${game.seed} ${game.mode}`);
    const key = gameKey(game.brain, game.seed, game.mode);
    if (lookup.has(key)) throw new Error(`Duplicate game in rating field: ${game.brain} ${game.seed} ${game.mode}`);
    lookup.set(key, game);
  }
  return lookup;
}

/** The brain's games in seed order, or null when it has none in this mode; partial coverage throws. */
function modeGames(lookup: Map<string, RatedGame>, slug: string, seeds: string[], mode: Mode): RatedGame[] | null {
  const found = seeds.map(seed => lookup.get(gameKey(slug, seed, mode)));
  const present = found.filter((game): game is RatedGame => game !== undefined);
  if (present.length === 0) return null;
  if (present.length !== seeds.length) {
    throw new Error(`Rating requires every seed in ${mode} for ${slug} (${present.length} of ${seeds.length})`);
  }
  return present;
}

function summariseScores(games: RatedGame[]): ScoreSummary {
  const scores = games.map(game => game.score);
  return {
    mean: mean(scores),
    sd: sampleSd(scores),
    interval: tInterval(scores),
    meanLines: mean(games.map(game => game.lines)),
    perSeed: games.map(game => ({ seed: game.seed, score: game.score, lines: game.lines, pieces: game.pieces, outcome: game.outcome })),
  };
}

// ---------------------------------------------------------------------------
// Field summary
// ---------------------------------------------------------------------------

function compareRank(iq: Record<string, ScoreSummary>): (a: string, b: string) => number {
  return (a, b) => iq[b].mean - iq[a].mean || iq[b].meanLines - iq[a].meanLines || (a < b ? -1 : a > b ? 1 : 0);
}

function headToHeadFor(a: string, b: string, iq: Record<string, ScoreSummary>, resamples: number[][]): HeadToHead {
  const differences = iq[a].perSeed.map((entry, s) => entry.score - iq[b].perSeed[s].score);
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const difference of differences) {
    if (difference > 0) wins++;
    else if (difference < 0) losses++;
    else draws++;
  }
  let interval: Interval | null = null;
  if (differences.length >= MIN_SEEDS_FOR_INTERVAL) {
    const replicateMeans = resamples.map(resample => mean(resample.map(index => differences[index])));
    interval = percentileInterval(replicateMeans);
  }
  return { a, b, meanDiff: mean(differences), interval, wins, draws, losses };
}

/**
 * Summarise a field: every brain needs one IQ game per seed; Blitz is
 * optional per brain but must cover every seed when present. The result is
 * invariant to the order of slugs, seeds and games.
 */
export function summariseField(slugs: readonly string[], seeds: readonly string[], games: RatedGame[]): FieldSummary {
  if (slugs.length === 0 || seeds.length === 0) throw new Error('Rating requires a nonempty field and seeds');
  if (new Set(slugs).size !== slugs.length || new Set(seeds).size !== seeds.length) throw new Error('Duplicate brain or seed in rating field');
  const sortedSlugs = [...slugs].sort();
  const sortedSeeds = [...seeds].sort();
  const lookup = indexGames(sortedSlugs, sortedSeeds, games);

  const iq: Record<string, ScoreSummary> = {};
  const blitz: Record<string, ScoreSummary | null> = {};
  for (const slug of sortedSlugs) {
    const iqGames = modeGames(lookup, slug, sortedSeeds, 'IQ');
    if (!iqGames) throw new Error(`Rating requires every seed in IQ for ${slug} (0 of ${sortedSeeds.length})`);
    iq[slug] = summariseScores(iqGames);
    const blitzGames = modeGames(lookup, slug, sortedSeeds, 'Blitz');
    blitz[slug] = blitzGames ? summariseScores(blitzGames) : null;
  }

  const rank = [...sortedSlugs].sort(compareRank(iq));
  const resamples = seedBlockResamples(sortedSeeds.length, BOOTSTRAP_REPLICATES);

  const headToHead: HeadToHead[] = [];
  for (let i = 0; i < rank.length; i++) {
    for (let j = i + 1; j < rank.length; j++) headToHead.push(headToHeadFor(rank[i], rank[j], iq, resamples));
  }

  const ties: Array<[string, string]> = [];
  for (let i = 0; i + 1 < rank.length; i++) {
    const pair = headToHead.find(entry => entry.a === rank[i] && entry.b === rank[i + 1]);
    if (pair?.interval && pair.interval.lower <= 0 && pair.interval.upper >= 0) ties.push([rank[i], rank[i + 1]]);
  }

  const iqMatrix = sortedSeeds.map((_, s) => sortedSlugs.map(slug => iq[slug].perSeed[s].score));
  const elo = eloEstimates(sortedSlugs, iqMatrix, resamples);

  return { iq, blitz, headToHead, rank, ties, elo };
}
