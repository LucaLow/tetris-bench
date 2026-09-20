import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Brain, DecisionStatus, GameResult, Metrics, Mode, RunSummary, TournamentIndex } from '../../lib/tetris-bench/contract.ts';
import { RECORDING_FORMAT, fromRecording, summaryOf } from '../../lib/tetris-bench/recording.ts';
import type { Recording } from '../../lib/tetris-bench/recording.ts';
import { MAX_PIECES, MAX_TICKS } from '../../lib/tetris-bench/engine.ts';
import { percentile } from '../../lib/tetris-bench/harness.ts';

export function artifactDigest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Counters that must be reproducible from the event statuses alone. */
const RECOUNTED_METRICS: Array<{ metric: keyof Metrics; statuses: DecisionStatus[] }> = [
  { metric: 'accepted', statuses: ['placement', 'placement-late', 'hold'] },
  { metric: 'lateAccepted', statuses: ['placement-late'] },
  { metric: 'holds', statuses: ['hold'] },
  { metric: 'invalid', statuses: ['invalid'] },
  { metric: 'stale', statuses: ['stale'] },
  { metric: 'errors', statuses: ['error'] },
  { metric: 'timedOutCalls', statuses: ['timeout'] },
  { metric: 'lockedByGravity', statuses: ['locked-by-gravity'] },
  { metric: 'unreachable', statuses: ['unreachable'] },
];

/**
 * Verify a recording file against its index entry: digest, format and
 * ruleset, summary equality, full re-simulation (every frame hash), and the
 * status counters recomputed from the events. Returns the expanded game.
 */
export function verifyRecording(bytes: string | Uint8Array, summary: RunSummary, ruleset: string): GameResult {
  if (!summary.artifactSha256 || artifactDigest(bytes) !== summary.artifactSha256) {
    throw new Error(`Recording digest mismatch: ${summary.id}`);
  }
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  const recording = JSON.parse(text) as Recording;
  if (recording.format !== RECORDING_FORMAT) throw new Error(`Recording format mismatch: ${summary.id}`);
  if (recording.ruleset !== ruleset) throw new Error(`Recording ruleset mismatch: ${summary.id}`);

  const { artifactSha256, ...expected } = summary;
  void artifactSha256;
  if (!isDeepStrictEqual(summaryOf(recording), expected)) throw new Error(`Recording summary mismatch: ${summary.id}`);

  let game: GameResult;
  try {
    game = fromRecording(recording);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Recording re-simulation failed: ${summary.id} (${reason})`);
  }

  const statusCounts = new Map<DecisionStatus, number>();
  for (const frame of game.frames) {
    if (frame.event === 'start') continue;
    statusCounts.set(frame.event, (statusCounts.get(frame.event) ?? 0) + 1);
  }
  for (const { metric, statuses } of RECOUNTED_METRICS) {
    const recounted = statuses.reduce((sum, status) => sum + (statusCounts.get(status) ?? 0), 0);
    if (game.metrics[metric] !== recounted) {
      throw new Error(`Recording metrics mismatch: ${summary.id} (${metric} is ${String(game.metrics[metric])}, events say ${recounted})`);
    }
  }

  // Fields that follow from the events themselves must agree with the summary, so a relabelled
  // recording (different mode, call counts or level) cannot pass on its refreshed digest alone.
  const mismatch = (what: string) => new Error(`Recording summary mismatch: ${summary.id} (${what})`);
  const events = recording.events;
  if (game.metrics.calls !== events.length) throw mismatch(`calls is ${game.metrics.calls}, events say ${events.length}`);
  const completed = events.filter(event => event.d.k === 1).length;
  if (game.metrics.completedCalls !== completed) throw mismatch(`completedCalls is ${game.metrics.completedCalls}, events say ${completed}`);
  const maxLevel = Math.max(...game.frames.map(frame => frame.state.level));
  if (game.metrics.maxLevel !== maxLevel) throw mismatch(`maxLevel is ${game.metrics.maxLevel}, frames say ${maxLevel}`);
  if (game.mode === 'IQ') {
    if (events.some(event => event.g !== 0)) throw mismatch('an IQ game has gravity steps');
    if (events.some(event => event.e === 'placement-late' || event.e === 'locked-by-gravity' || event.e === 'unreachable')) throw mismatch('an IQ game has Blitz statuses');
  } else if (events.some(event => event.d.b !== null)) {
    throw mismatch('a Blitz game has a fixed call budget');
  }
  return game;
}

// ---------------------------------------------------------------------------
// Merge and publication gates
// ---------------------------------------------------------------------------

export const INDEX_FORMAT = 'tetris-bench-index@3';

/** The protocol a batch was run under; every field must match for a merge. */
export interface Protocol {
  ruleset: string;
  official: boolean;
  maxPieces: number;
  maxTicks: number;
  iqTimeoutMs: number;
  seeds: readonly string[];
  protocolHashes: Record<string, string>;
}

export function protocolOf(index: TournamentIndex): Protocol {
  return {
    ruleset: index.ruleset,
    official: index.official,
    maxPieces: index.maxPieces,
    maxTicks: index.maxTicks,
    iqTimeoutMs: index.iqTimeoutMs,
    seeds: index.seeds,
    protocolHashes: index.provenance.protocolHashes,
  };
}

/**
 * A merge may only add or replace brains under the same protocol: ruleset,
 * official flag, caps, timeout, seeds and the protocol source hashes. Adapter
 * and runner hashes are recorded, never enforced, so new brains can join an
 * existing field.
 */
export function assertMergeCompatible(previous: TournamentIndex, current: Protocol): void {
  if (previous.format !== INDEX_FORMAT) {
    throw new Error(`Cannot merge: the previous index is ${String(previous.format)}, not ${INDEX_FORMAT} (archive it first)`);
  }
  const before = protocolOf(previous);
  for (const field of ['ruleset', 'official', 'maxPieces', 'maxTicks', 'iqTimeoutMs', 'seeds'] as const) {
    if (!isDeepStrictEqual(before[field], current[field])) {
      throw new Error(`Cannot merge different protocols: ${field} was ${JSON.stringify(before[field])}, now ${JSON.stringify(current[field])}`);
    }
  }
  const names = new Set([...Object.keys(before.protocolHashes), ...Object.keys(current.protocolHashes)]);
  for (const name of names) {
    if (before.protocolHashes[name] !== current.protocolHashes[name]) {
      throw new Error(`Cannot merge different protocol sources: ${name} changed`);
    }
  }
}

/** Official publication needs a field of at least two brains and no game that ended in adapter failure. */
export function assertOfficialPublishable(official: boolean, slugs: readonly string[], games: ReadonlyArray<Pick<GameResult, 'id' | 'outcome'>>): void {
  if (!official) return;
  if (new Set(slugs).size < 2) throw new Error('Official publication requires at least two brains');
  const failed = games.filter(game => game.outcome === 'adapter-failure');
  if (failed.length > 0) {
    throw new Error(`Official publication refused: adapter failure in ${failed.map(game => game.id).join(', ')}. Recordings retained for diagnosis; index unchanged.`);
  }
}

/** Seed-major blocks rotate sorted brains and alternate mode order. */
export function counterbalancedJobs<T extends { slug: string }>(brains: readonly T[], seeds: readonly string[], modes: readonly Mode[] = ['IQ', 'Blitz']): Array<{ brain: T; seed: string; mode: Mode }> {
  const sorted = [...brains].sort((a, b) => a.slug.localeCompare(b.slug));
  return seeds.flatMap((seed, s) => {
    const offset = s % sorted.length;
    const rotated = [...sorted.slice(offset), ...sorted.slice(0, offset)];
    const ordered = s % 2 ? [...modes].reverse() : [...modes];
    return ordered.flatMap(mode => rotated.map(brain => ({ brain, seed, mode })));
  });
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export const MAX_CONCURRENCY = 16;
export const DEFAULT_OUT_DIR = 'public/tetris-bench';

export interface RunArgs {
  help: boolean;
  official: boolean;
  merge: boolean;
  /** Null means the default field (the built-in brains). */
  brains: string[] | null;
  modes: Mode[];
  concurrency: number;
  blitzConcurrency: number;
  out: string;
  /** True when `--out` was given, so a quick run may write over an official index there. */
  outExplicit: boolean;
  maxPieces: number;
  maxTicks: number;
  batchId: string;
  maxSpendUsd: number | null;
  /** Worker mode: play exactly this game and write its recording. */
  game: { slug: string; seed: string; mode: Mode } | null;
}

/**
 * Every run writes an index and prunes recordings under `--out`. A quick run
 * in a checkout that holds the official field would replace the published
 * index and delete every official recording, so the default output directory
 * is refused for quick runs when it already holds an official index. Merges
 * are gated separately by assertMergeCompatible.
 */
/**
 * Rating needs every brain's IQ games. A batch that plays Blitz only for a
 * brain with no retained IQ games would pay for every game and then fail at
 * the rating step, so the gap is refused before anything is played.
 */
export function assertIqCoverage(slugs: readonly string[], modes: readonly Mode[], retainedIqGames: ReadonlyMap<string, number>, seedCount: number): void {
  if (modes.includes('IQ')) return;
  for (const slug of slugs) {
    if ((retainedIqGames.get(slug) ?? 0) === seedCount) continue;
    throw new Error(`${slug} has no IQ games for these seeds: run --modes IQ (or IQ,Blitz) for it first`);
  }
}

export function assertQuickRunAllowed(
  args: Pick<RunArgs, 'official' | 'merge' | 'outExplicit'>,
  previous: { official?: unknown } | null,
  out: string,
): void {
  if (args.official || args.merge || args.outExplicit) return;
  if (previous?.official === true) {
    throw new Error(`Refusing to replace the official index in ${out} with a quick run: pass --out <directory> for an exhibition, or --official to publish`);
  }
}

const BOOLEAN_FLAGS = ['--help', '--official', '--merge'] as const;
const VALUE_FLAGS = ['--brains', '--modes', '--concurrency', '--blitz-concurrency', '--out', '--max-pieces', '--max-ticks', '--batch-id', '--max-spend-usd', '--game'] as const;

export const USAGE = `Tetris Bench runner
  node scripts/tetris-bench/run.ts [--official] [--brains a,b] [--modes IQ,Blitz] [--concurrency N] [--blitz-concurrency N]
                                   [--out dir] [--merge] [--max-pieces N] [--max-ticks N] [--batch-id id] [--max-spend-usd X]
  Default: quick three-seed run of the built-in brains. --official plays the thirty frozen seeds at the frozen caps.
  Hosted brains are the slugs in lib/tetris-bench/models.ts and need OPENROUTER_API_KEY.
  --concurrency runs games in isolated child processes (1..${MAX_CONCURRENCY}); --blitz-concurrency defaults to it.
  --merge keeps the previous index's brains that are not re-run (same protocol only) and prunes orphan recordings.
  --max-spend-usd stops a hosted brain once its known cost plus the unpriced-call estimate exceeds the cap.
  --game slug,seed,mode is the internal worker path: it plays one game and writes runs/<id>.json.`;

export function batchIdFrom(date: Date): string {
  return date.toISOString().replace(/[^0-9]/g, '');
}

export const BRAIN_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function parseCount(name: string, raw: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}, got ${value}`);
  return value;
}

function parseMode(raw: string): Mode {
  if (raw === 'IQ' || raw === 'Blitz') return raw;
  throw new Error(`Unknown mode ${JSON.stringify(raw)}; expected IQ or Blitz`);
}

function parseList(name: string, raw: string): string[] {
  const items = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${name} needs at least one entry`);
  if (new Set(items).size !== items.length) throw new Error(`${name} lists an entry twice`);
  return items;
}

/** Parse the runner's command line. Every flag may appear once; unknown flags and missing values are errors. */
export function parseRunArgs(argv: readonly string[], now: Date = new Date()): RunArgs {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((BOOLEAN_FLAGS as readonly string[]).includes(flag)) {
      if (booleans.has(flag)) throw new Error(`Repeated option: ${flag}`);
      booleans.add(flag);
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      if (values.has(flag)) throw new Error(`Repeated option: ${flag}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Option ${flag} needs a value`);
      values.set(flag, value);
      i++;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }

  const official = booleans.has('--official');
  const maxPieces = values.has('--max-pieces') ? parseCount('--max-pieces', values.get('--max-pieces')!, 1, MAX_PIECES) : MAX_PIECES;
  const maxTicks = values.has('--max-ticks') ? parseCount('--max-ticks', values.get('--max-ticks')!, 1, MAX_TICKS) : MAX_TICKS;
  if (official && (maxPieces !== MAX_PIECES || maxTicks !== MAX_TICKS)) throw new Error('Official runs cannot override the frozen game caps');

  const concurrency = values.has('--concurrency') ? parseCount('--concurrency', values.get('--concurrency')!, 1, MAX_CONCURRENCY) : 1;
  const blitzConcurrency = values.has('--blitz-concurrency') ? parseCount('--blitz-concurrency', values.get('--blitz-concurrency')!, 1, MAX_CONCURRENCY) : concurrency;

  const batchId = values.get('--batch-id') ?? batchIdFrom(now);
  if (!/^[0-9]{17}$/.test(batchId)) throw new Error(`Invalid batch id ${JSON.stringify(batchId)}: expected 17 digits`);

  const brains = values.has('--brains') ? parseList('--brains', values.get('--brains')!) : null;
  for (const slug of brains ?? []) {
    if (!BRAIN_SLUG_PATTERN.test(slug)) throw new Error(`Invalid brain slug ${JSON.stringify(slug)}`);
  }
  const modes = values.has('--modes') ? parseList('--modes', values.get('--modes')!).map(parseMode) : ['IQ', 'Blitz'] as Mode[];

  let maxSpendUsd: number | null = null;
  if (values.has('--max-spend-usd')) {
    maxSpendUsd = Number(values.get('--max-spend-usd'));
    if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) throw new Error('--max-spend-usd must be a positive number');
  }

  let game: RunArgs['game'] = null;
  if (values.has('--game')) {
    const parts = values.get('--game')!.split(',');
    if (parts.length !== 3) throw new Error('--game expects slug,seed,mode');
    const [slug, seed, mode] = parts;
    if (!BRAIN_SLUG_PATTERN.test(slug)) throw new Error(`Invalid brain slug ${JSON.stringify(slug)}`);
    game = { slug, seed, mode: parseMode(mode) };
  }

  return {
    help: booleans.has('--help'),
    official,
    merge: booleans.has('--merge'),
    brains,
    modes,
    concurrency,
    blitzConcurrency,
    out: values.get('--out') ?? DEFAULT_OUT_DIR,
    outExplicit: values.has('--out'),
    maxPieces,
    maxTicks,
    batchId,
    maxSpendUsd,
    game,
  };
}

export function recordingId(batchId: string, slug: string, seed: string, mode: Mode): string {
  return `v3-${batchId}-${slug}-${seed}-${mode.toLowerCase()}`;
}

export const RECORDING_FILE_PATTERN = /^(v3-[0-9]{17}-[a-zA-Z0-9][a-zA-Z0-9_.-]*)\.json$/;

/** Recording files under `runs/` whose id is not in the index; other files are left alone. */
export function orphanRecordingFiles(files: readonly string[], keptIds: ReadonlySet<string>): string[] {
  const orphans: string[] = [];
  for (const file of files) {
    const match = RECORDING_FILE_PATTERN.exec(file);
    if (match && !keptIds.has(match[1])) orphans.push(file);
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** What the runner keeps per game once the frames have been distilled. */
export interface GameRecord {
  summary: RunSummary;
  /** Latencies of completed calls. */
  latencies: number[];
  preparations: number[];
}

export function distilGame(game: GameResult, summary: RunSummary): GameRecord {
  const latencies: number[] = [];
  const preparations: number[] = [];
  for (const frame of game.frames) {
    const decision = frame.decision;
    if (!decision) continue;
    preparations.push(decision.preparationMs);
    // Same population as the harness's own p50/p95: every completed call, including a synchronous
    // brain's over-deadline answer (measured, but it could not act).
    if (decision.called && decision.completed) latencies.push(decision.latencyMs);
  }
  return { summary, latencies, preparations };
}

const SUMMED_METRICS = [
  'calls', 'completedCalls', 'timedOutCalls', 'errors', 'invalid', 'stale', 'unreachable',
  'accepted', 'lateAccepted', 'lockedByGravity', 'holds', 'costUsd', 'unpricedCalls', 'calibrationCount', 'retries',
] as const;

/** Sum the counters, pool the latencies, weight the calibration error by its count, keep the highest level. */
export function aggregateMetrics(records: readonly GameRecord[]): Metrics {
  const sums: Record<(typeof SUMMED_METRICS)[number], number> = {
    calls: 0, completedCalls: 0, timedOutCalls: 0, errors: 0, invalid: 0, stale: 0, unreachable: 0,
    accepted: 0, lateAccepted: 0, lockedByGravity: 0, holds: 0, costUsd: 0, unpricedCalls: 0, calibrationCount: 0, retries: 0,
  };
  let weightedCalibration = 0;
  let maxLevel = 0;
  const latencies: number[] = [];
  const preparations: number[] = [];
  for (const record of records) {
    const metrics = record.summary.metrics;
    for (const key of SUMMED_METRICS) sums[key] += metrics[key];
    if (metrics.calibrationError !== null) weightedCalibration += metrics.calibrationError * metrics.calibrationCount;
    maxLevel = Math.max(maxLevel, metrics.maxLevel);
    latencies.push(...record.latencies);
    preparations.push(...record.preparations);
  }
  return {
    ...sums,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    calibrationError: sums.calibrationCount > 0 ? weightedCalibration / sums.calibrationCount : null,
    preparationP50Ms: percentile(preparations, 0.5),
    preparationP95Ms: percentile(preparations, 0.95),
    maxLevel,
  };
}

/** Known cost of a hosted brain's priced calls, scaled to 100 decisions; null when nothing was priced. */
export function costPer100Decisions(records: readonly GameRecord[]): number | null {
  let cost = 0;
  let priced = 0;
  for (const record of records) {
    const metrics = record.summary.metrics;
    cost += metrics.costUsd;
    priced += metrics.calls - metrics.unpricedCalls;
  }
  if (priced <= 0) return null;
  return (cost / priced) * 100;
}

export interface Spend {
  known: number;
  unpricedCalls: number;
  /** Known cost plus the unpriced calls priced at the mean known cost per priced call. */
  estimated: number;
}

export function spendOf(records: readonly GameRecord[]): Spend {
  let known = 0;
  let priced = 0;
  let unpricedCalls = 0;
  for (const record of records) {
    const metrics = record.summary.metrics;
    known += metrics.costUsd;
    priced += metrics.calls - metrics.unpricedCalls;
    unpricedCalls += metrics.unpricedCalls;
  }
  const perCall = priced > 0 ? known / priced : 0;
  return { known, unpricedCalls, estimated: known + unpricedCalls * perCall };
}

export function isHostedKind(kind: Brain['kind']): boolean {
  return kind === 'llm' || kind === 'classifier';
}
