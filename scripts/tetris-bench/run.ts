/**
 * Tetris Bench runner: plays a field of brains over the frozen seeds, writes
 * one compact recording per game and the tournament index, and merges into a
 * previous index under the same protocol. `node scripts/tetris-bench/run.ts --help`.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { builtInBrains, hostedBrain } from '../../lib/tetris-bench/adapters.ts';
import { findHostedModel } from '../../lib/tetris-bench/models.ts';
import { IQ_TIMEOUT_MS, inputFor, runGame } from '../../lib/tetris-bench/harness.ts';
import { OFFICIAL_SEEDS, QUICK_SEEDS, summariseField } from '../../lib/tetris-bench/rating.ts';
import type { FieldSummary } from '../../lib/tetris-bench/rating.ts';
import { RULESET, createGame } from '../../lib/tetris-bench/engine.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';
import type { BatchProvenance, Brain, BrainStanding, GameResult, Mode, RunSummary, TournamentIndex } from '../../lib/tetris-bench/contract.ts';
import { summaryOf, toRecording } from '../../lib/tetris-bench/recording.ts';
import type { Recording } from '../../lib/tetris-bench/recording.ts';
import {
  INDEX_FORMAT,
  USAGE,
  aggregateMetrics,
  artifactDigest,
  assertIqCoverage,
  assertMergeCompatible,
  assertOfficialPublishable,
  assertQuickRunAllowed,
  costPer100Decisions,
  counterbalancedJobs,
  distilGame,
  isHostedKind,
  orphanRecordingFiles,
  parseRunArgs,
  recordingId,
  spendOf,
  verifyRecording,
} from './runner-integrity.ts';
import type { GameRecord, Protocol, RunArgs } from './runner-integrity.ts';

// ---------------------------------------------------------------------------
// Brains
// ---------------------------------------------------------------------------

/** What the index needs to know about a brain; retained brains have no `decide`. */
type BrainIdentity = Pick<BrainStanding, 'slug' | 'name' | 'kind' | 'provider' | 'model' | 'via' | 'description' | 'adapterVersion'>;

function identityOf(brain: BrainIdentity): BrainIdentity {
  const identity: BrainIdentity = {
    slug: brain.slug,
    name: brain.name,
    kind: brain.kind,
    description: brain.description,
    adapterVersion: brain.adapterVersion,
  };
  if (brain.provider !== undefined) identity.provider = brain.provider;
  if (brain.model !== undefined) identity.model = brain.model;
  if (brain.via !== undefined) identity.via = brain.via;
  return identity;
}

function resolveBrain(slug: string): Brain {
  const builtin = builtInBrains.find(brain => brain.slug === slug);
  if (builtin) return builtin;
  const model = findHostedModel(slug);
  if (!model) throw new Error(`Unknown brain: ${slug} (built-ins: ${builtInBrains.map(b => b.slug).join(', ')}; hosted slugs are in lib/tetris-bench/models.ts)`);
  if (!process.env.OPENROUTER_API_KEY) throw new Error(`Hosted brain ${slug} requires OPENROUTER_API_KEY`);
  return hostedBrain(model);
}

/** The probe fixture: two full rows with a two-wide gap and an O piece, one unique two-line clear. */
function preflightInput() {
  const state = createGame('diagnostic-left');
  state.active = { type: 'O', rotation: 0, x: 3, y: -1 };
  state.holdUsed = true;
  for (const y of [18, 19]) {
    for (let x = 0; x < 10; x++) state.board[y][x] = x === 0 || x === 1 ? null : 'J';
  }
  return inputFor(state, 'IQ');
}

/** One real call per hosted brain before any game is played; a failure aborts the batch with the reason. */
async function preflight(brains: readonly Brain[]): Promise<void> {
  const hosted = brains.filter(brain => isHostedKind(brain.kind));
  if (hosted.length === 0) return;
  const input = preflightInput();
  for (const brain of hosted) {
    const began = performance.now();
    let raw: unknown;
    try {
      raw = await brain.decide(structuredClone(input), { signal: AbortSignal.timeout(IQ_TIMEOUT_MS), budgetMs: IQ_TIMEOUT_MS });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Pre-flight failed for ${brain.slug}: the call threw (${reason})`);
    }
    const verdict = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
    if (verdict.status !== 'ok') {
      const reason = verdict.status === 'invalid' ? verdict.reason : 'stale state hash';
      throw new Error(`Pre-flight failed for ${brain.slug}: ${reason}`);
    }
    console.log(`pre-flight ${brain.slug}: ok in ${Math.round(performance.now() - began)} ms (not counted in the index)`);
  }
}

// ---------------------------------------------------------------------------
// Source hashes and provenance
// ---------------------------------------------------------------------------

const PROTOCOL_FILES = ['engine', 'contract', 'harness', 'features', 'recording', 'rating'].map(name => `lib/tetris-bench/${name}.ts`);
const ADAPTER_FILES = ['lib/tetris-bench/adapters.ts', 'lib/tetris-bench/models.ts', 'scripts/tetris-bench/run.ts', 'scripts/tetris-bench/runner-integrity.ts'];

async function hashSources(paths: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of paths) hashes[path] = artifactDigest(await readFile(new URL(`../../${path}`, import.meta.url)));
  return hashes;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: SOURCE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The repository root that holds the hashed sources, independent of the caller's working directory. */
const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Provenance is a public claim ("clean at commit X"), so it is read from the
 * repository that contains the hashed sources, never from whatever directory
 * the runner was started in. When that directory is not a git checkout, or the
 * checkout's top level is not the source root, the tree is reported dirty and
 * the commit unknown.
 */
function sourceProvenance(): { sourceCommit: string | null; sourceTree: string | null; sourceDirty: boolean } {
  const topLevel = git(['rev-parse', '--show-toplevel']);
  if (topLevel === null || resolve(topLevel) !== resolve(SOURCE_ROOT)) return { sourceCommit: null, sourceTree: null, sourceDirty: true };
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const sourceTree = git(['rev-parse', 'HEAD:lib/tetris-bench']);
  const status = git(['status', '--porcelain', '--', 'lib/tetris-bench', 'scripts/tetris-bench', 'docs/tetris-bench-rules.md']);
  return { sourceCommit, sourceTree, sourceDirty: status === null ? true : status.length > 0 };
}

const hardware = { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length };
const runtime = process.version;
const platform = `${process.platform}/${process.arch}`;

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

function recordingPath(out: string, id: string): string {
  return resolve(out, 'runs', `${id}.json`);
}

/**
 * A dropped brain's games are paid for and useful for diagnosis, so they are
 * moved out of `runs/` (never listed, never deployed, ignored by git) rather
 * than deleted.
 */
async function shelveRecording(out: string, id: string): Promise<void> {
  const source = recordingPath(out, id);
  const shelf = resolve(out, 'partial');
  await mkdir(shelf, { recursive: true });
  await rename(source, resolve(shelf, `${id}.json`)).catch(() => undefined);
}

/** Serialise a finished game as a recording, write it, and return the distilled record from the written bytes. */
async function writeRecording(out: string, game: GameResult): Promise<GameRecord> {
  const bytes = JSON.stringify(toRecording(game));
  await writeFile(recordingPath(out, game.id), bytes);
  return loadRecording(out, game.id);
}

/** Read a recording back, re-simulate it, and distil it. The digest is taken from the bytes on disk. */
async function loadRecording(out: string, id: string): Promise<GameRecord> {
  const bytes = await readFile(recordingPath(out, id));
  const recording = JSON.parse(bytes.toString('utf8')) as Recording;
  const summary: RunSummary = { ...summaryOf(recording), artifactSha256: artifactDigest(bytes) };
  if (summary.id !== id) throw new Error(`Recording ${id} carries id ${summary.id}`);
  return distilGame(verifyRecording(bytes, summary, RULESET), summary);
}

// ---------------------------------------------------------------------------
// Playing games
// ---------------------------------------------------------------------------

interface Job {
  brain: Brain;
  seed: string;
  mode: Mode;
}

class WorkerPool {
  private readonly args: RunArgs;
  private readonly out: string;
  private readonly children = new Set<ChildProcess>();
  private failed = false;

  constructor(args: RunArgs, out: string) {
    this.args = args;
    this.out = out;
  }

  get aborted(): boolean {
    return this.failed;
  }

  /** Play one game in an isolated child process that writes the recording. */
  play(job: Job): Promise<void> {
    const id = recordingId(this.args.batchId, job.brain.slug, job.seed, job.mode);
    const childArgs = [
      fileURLToPath(import.meta.url),
      '--game', `${job.brain.slug},${job.seed},${job.mode}`,
      '--out', this.out,
      '--batch-id', this.args.batchId,
      '--max-pieces', String(this.args.maxPieces),
      '--max-ticks', String(this.args.maxTicks),
      ...(this.args.official ? ['--official'] : []),
    ];
    return new Promise<void>((resolveJob, reject) => {
      const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.children.add(child);
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on('error', error => {
        this.children.delete(child);
        this.fail();
        reject(new Error(`Worker for ${id} could not start: ${error.message}`));
      });
      child.on('exit', (code, signal) => {
        this.children.delete(child);
        if (code === 0) {
          resolveJob();
          return;
        }
        this.fail();
        const tail = stderr.trim().split('\n').slice(-12).join('\n');
        reject(new Error(`Worker for ${id} failed (exit ${code ?? signal}):\n${tail}`));
      });
    });
  }

  /** Stop scheduling and kill every sibling still running. */
  fail(): void {
    this.failed = true;
    for (const child of this.children) child.kill('SIGTERM');
  }
}

interface Batch {
  args: RunArgs;
  out: string;
  official: boolean;
  /** Finished records of this batch, per brain. */
  records: Map<string, GameRecord[]>;
  /** Brains removed from the batch, with the reason. */
  dropped: Map<string, string>;
  pool: WorkerPool;
}

function statusLine(record: GameRecord): string {
  const metrics = record.summary.metrics;
  const counts = [
    ['placement', metrics.accepted - metrics.holds - metrics.lateAccepted],
    ['late', metrics.lateAccepted],
    ['hold', metrics.holds],
    ['invalid', metrics.invalid],
    ['stale', metrics.stale],
    ['error', metrics.errors],
    ['timeout', metrics.timedOutCalls],
    ['unreachable', metrics.unreachable],
    ['locked', metrics.lockedByGravity],
  ] as const;
  return counts.map(([name, count]) => `${name} ${count}`).join(' ');
}

function spendLine(batch: Batch, brain: Brain): string {
  if (!isHostedKind(brain.kind)) return '';
  const spend = spendOf(batch.records.get(brain.slug) ?? []);
  const cap = batch.args.maxSpendUsd === null ? '' : ` of $${batch.args.maxSpendUsd}`;
  return ` | spend ${brain.slug} $${spend.known.toFixed(4)} known, $${spend.estimated.toFixed(4)} estimated${cap} (${spend.unpricedCalls} unpriced)`;
}

async function playOnce(batch: Batch, job: Job, concurrency: number): Promise<GameRecord> {
  const id = recordingId(batch.args.batchId, job.brain.slug, job.seed, job.mode);
  if (concurrency > 1) {
    await batch.pool.play(job);
    return loadRecording(batch.out, id);
  }
  const game = await runGame(job.brain, job.seed, job.mode, { maxPieces: batch.args.maxPieces, maxTicks: batch.args.maxTicks });
  game.id = id;
  return writeRecording(batch.out, game);
}

/** Only a failure with error or timeout statuses may be transient; anything else is the brain's own doing. */
function transientFailure(record: GameRecord): boolean {
  const metrics = record.summary.metrics;
  return record.summary.outcome === 'adapter-failure' && (metrics.errors > 0 || metrics.timedOutCalls > 0);
}

async function dropBrain(batch: Batch, slug: string, reason: string): Promise<void> {
  if (batch.dropped.has(slug)) return;
  batch.dropped.set(slug, reason);
  console.warn(`warning: dropping ${slug} from this batch: ${reason}; its recordings are kept under partial/`);
  for (const record of batch.records.get(slug) ?? []) {
    await shelveRecording(batch.out, record.summary.id);
  }
  batch.records.delete(slug);
}

async function playJob(batch: Batch, job: Job, concurrency: number): Promise<void> {
  const slug = job.brain.slug;
  if (batch.dropped.has(slug)) return;
  let record = await playOnce(batch, job, concurrency);
  if (batch.official && transientFailure(record)) {
    console.warn(`warning: ${record.summary.id} ended in adapter failure with errors or timeouts; retrying once`);
    record = await playOnce(batch, job, concurrency);
  }
  if (batch.dropped.has(slug)) {
    await shelveRecording(batch.out, record.summary.id);
    return;
  }
  if (batch.official && record.summary.outcome === 'adapter-failure') {
    await shelveRecording(batch.out, record.summary.id);
    await dropBrain(batch, slug, `${record.summary.id} ended in adapter failure`);
    return;
  }
  const records = batch.records.get(slug) ?? [];
  records.push(record);
  batch.records.set(slug, records);
  const { summary } = record;
  console.log(`${summary.id}: ${summary.score} pts, ${summary.pieces} pieces, level ${summary.metrics.maxLevel}, ${summary.outcome}; ${statusLine(record)}${spendLine(batch, job.brain)}`);
  if (batch.args.maxSpendUsd !== null && isHostedKind(job.brain.kind)) {
    const spend = spendOf(records);
    if (spend.estimated > batch.args.maxSpendUsd) {
      await dropBrain(batch, slug, `estimated spend $${spend.estimated.toFixed(4)} exceeds --max-spend-usd ${batch.args.maxSpendUsd}`);
    }
  }
}

/** Run the jobs with at most `concurrency` in flight; the first failure kills the siblings and rejects. */
async function runPhase(batch: Batch, jobs: Job[], concurrency: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(jobs.length, 1)) }, async () => {
    while (cursor < jobs.length && !batch.pool.aborted) {
      const job = jobs[cursor++];
      try {
        await playJob(batch, job, concurrency);
      } catch (error) {
        batch.pool.fail();
        throw error;
      }
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Worker mode
// ---------------------------------------------------------------------------

async function runWorker(args: RunArgs, seeds: readonly string[]): Promise<void> {
  const { slug, seed, mode } = args.game!;
  if (!seeds.includes(seed)) throw new Error(`Invalid worker seed ${seed}`);
  const brain = resolveBrain(slug);
  const out = resolve(args.out);
  await mkdir(resolve(out, 'runs'), { recursive: true });
  const game = await runGame(brain, seed, mode, { maxPieces: args.maxPieces, maxTicks: args.maxTicks });
  game.id = recordingId(args.batchId, slug, seed, mode);
  await writeFile(recordingPath(out, game.id), JSON.stringify(toRecording(game)));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

interface Retained {
  /** Brains whose kept games carry into the new index unchanged. */
  identities: Map<string, BrainIdentity>;
  records: Map<string, GameRecord[]>;
  /** Every brain in the previous index, so a re-run brain that this batch drops can keep its old standing. */
  previousIdentities: Map<string, BrainIdentity>;
  /** Verified previous games of re-run brains in the modes being re-run: restored if the re-run is dropped. */
  replaced: Map<string, GameRecord[]>;
  batches: BatchProvenance[];
}

function emptyRetained(): Retained {
  return { identities: new Map(), records: new Map(), previousIdentities: new Map(), replaced: new Map(), batches: [] };
}

async function loadPrevious(out: string): Promise<TournamentIndex> {
  const previous = await loadPreviousIfPresent(out);
  if (!previous) throw new Error(`Cannot merge: no index.json in ${out}`);
  return previous;
}

/** The index already in the output directory, or null when there is none or it is unreadable. */
async function loadPreviousIfPresent(out: string): Promise<TournamentIndex | null> {
  try {
    return JSON.parse(await readFile(resolve(out, 'index.json'), 'utf8')) as TournamentIndex;
  } catch {
    return null;
  }
}

/**
 * Keep every previous game that this batch does not replace: games of brains
 * outside the selection, and games of re-run brains in modes not being run.
 * Retained recordings are re-simulated before anything runs.
 */
async function retainPrevious(previous: TournamentIndex, protocol: Protocol, out: string, brains: readonly Brain[], modes: readonly Mode[]): Promise<Retained> {
  assertMergeCompatible(previous, protocol);
  for (const brain of brains) {
    const old = previous.brains.find(entry => entry.slug === brain.slug);
    if (old && old.model !== brain.model) throw new Error(`Cannot replace model ${String(old.model)} with ${String(brain.model)} under the brain ${brain.slug}`);
  }
  const rerun = new Set(brains.map(brain => brain.slug));
  const isReplaced = (run: RunSummary) => rerun.has(run.brain) && modes.includes(run.mode);
  const retained = emptyRetained();
  retained.batches = previous.provenance.batches;
  const verify = async (run: RunSummary): Promise<GameRecord> => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(run.id)) throw new Error(`Invalid prior recording id ${JSON.stringify(run.id)}`);
    const bytes = await readFile(recordingPath(out, run.id));
    return distilGame(verifyRecording(bytes, run, RULESET), run);
  };
  for (const old of previous.brains) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(old.slug)) throw new Error(`Invalid prior brain slug ${JSON.stringify(old.slug)}`);
    const all = previous.runs.filter(run => run.brain === old.slug);
    for (const mode of ['IQ', 'Blitz'] as const) {
      const count = all.filter(run => run.mode === mode).length;
      if (count !== 0 && count !== protocol.seeds.length) throw new Error(`Previous index has ${count} of ${protocol.seeds.length} ${mode} games for ${old.slug}`);
    }
    if (all.every(run => run.mode !== 'IQ')) throw new Error(`Previous index has no IQ games for ${old.slug}`);
    retained.previousIdentities.set(old.slug, identityOf(old));
    const kept: GameRecord[] = [];
    const replaced: GameRecord[] = [];
    for (const run of all) (isReplaced(run) ? replaced : kept).push(await verify(run));
    if (replaced.length > 0) retained.replaced.set(old.slug, replaced);
    if (kept.length === 0) continue;
    retained.identities.set(old.slug, identityOf(old));
    retained.records.set(old.slug, kept);
    console.log(`retained ${old.slug}: ${kept.length} recordings re-simulated${replaced.length ? ` (${replaced.length} to be replaced by this batch)` : ''}`);
  }
  return retained;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function standingOf(identity: BrainIdentity, records: readonly GameRecord[], field: FieldSummary): BrainStanding {
  const iqRecords = records.filter(record => record.summary.mode === 'IQ');
  const blitzRecords = records.filter(record => record.summary.mode === 'Blitz');
  const hosted = isHostedKind(identity.kind);
  return {
    ...identity,
    rank: field.rank.indexOf(identity.slug) + 1,
    iq: field.iq[identity.slug],
    blitz: field.blitz[identity.slug],
    elo: field.elo[identity.slug],
    iqMetrics: aggregateMetrics(iqRecords),
    blitzMetrics: blitzRecords.length > 0 ? aggregateMetrics(blitzRecords) : null,
    costPer100Decisions: hosted ? costPer100Decisions(records) : null,
    unpricedCalls: records.reduce((sum, record) => sum + record.summary.metrics.unpricedCalls, 0),
  };
}

/** Recordings no index lists any more are shelved under partial/, never deleted; nothing in the runner unlinks a recording. */
async function pruneOrphans(out: string, keptIds: ReadonlySet<string>): Promise<string[]> {
  const files = await readdir(resolve(out, 'runs'));
  const orphans = orphanRecordingFiles(files, keptIds);
  for (const file of orphans) await shelveRecording(out, file.replace(/\.json$/, ''));
  return orphans;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseRunArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const seeds = args.official ? OFFICIAL_SEEDS : QUICK_SEEDS;
  if (args.game) {
    await runWorker(args, seeds);
    return;
  }

  const startedAt = new Date().toISOString();
  const out = resolve(args.out);
  const brains = (args.brains ?? builtInBrains.map(brain => brain.slug)).map(resolveBrain);
  const protocolHashes = await hashSources(PROTOCOL_FILES);
  const adapterHashes = await hashSources(ADAPTER_FILES);
  const protocol: Protocol = {
    ruleset: RULESET,
    official: args.official,
    maxPieces: args.maxPieces,
    maxTicks: args.maxTicks,
    iqTimeoutMs: IQ_TIMEOUT_MS,
    seeds,
    protocolHashes,
  };

  await mkdir(resolve(out, 'runs'), { recursive: true });
  assertQuickRunAllowed(args, await loadPreviousIfPresent(out), out);
  let retained = emptyRetained();
  if (args.merge) retained = await retainPrevious(await loadPrevious(out), protocol, out, brains, args.modes);

  const fieldSlugs = new Set([...brains.map(brain => brain.slug), ...retained.identities.keys()]);
  assertOfficialPublishable(args.official, [...fieldSlugs], []);
  const retainedIqGames = new Map<string, number>();
  for (const [slug, records] of retained.records) retainedIqGames.set(slug, records.filter(record => record.summary.mode === 'IQ').length);
  assertIqCoverage(brains.map(brain => brain.slug), args.modes, retainedIqGames, seeds.length);
  await preflight(brains);

  const batch: Batch = {
    args,
    out,
    official: args.official,
    records: new Map(),
    dropped: new Map(),
    pool: new WorkerPool(args, out),
  };
  console.log(`batch ${args.batchId}: ${brains.map(brain => brain.slug).join(', ')} on ${seeds.length} seeds, modes ${args.modes.join('+')}, ${args.official ? 'official' : 'quick'}, caps ${args.maxPieces} pieces / ${args.maxTicks} ticks`);
  for (const mode of args.modes) {
    const concurrency = mode === 'IQ' ? args.concurrency : args.blitzConcurrency;
    await runPhase(batch, counterbalancedJobs(brains, seeds, [mode]), concurrency);
  }

  for (const [path, expected] of Object.entries({ ...protocolHashes, ...adapterHashes })) {
    const actual = artifactDigest(await readFile(new URL(`../../${path}`, import.meta.url)));
    if (actual !== expected) throw new Error(`Source changed during the run (${path}). Results must be regenerated before publication.`);
  }

  // Assemble the field: this batch's surviving brains plus the retained ones.
  const identities = new Map<string, BrainIdentity>();
  const recordsBySlug = new Map<string, GameRecord[]>();
  for (const brain of brains) {
    if (batch.dropped.has(brain.slug)) {
      // A dropped re-run contributed nothing; the brain keeps whatever the previous index had.
      const previous = retained.previousIdentities.get(brain.slug);
      if (!previous) continue;
      identities.set(brain.slug, previous);
      recordsBySlug.set(brain.slug, [...(retained.records.get(brain.slug) ?? []), ...(retained.replaced.get(brain.slug) ?? [])]);
      console.warn(`warning: ${brain.slug} keeps its previous standing; this batch's games for it were shelved`);
      continue;
    }
    identities.set(brain.slug, identityOf(brain));
    recordsBySlug.set(brain.slug, [...(batch.records.get(brain.slug) ?? []), ...(retained.records.get(brain.slug) ?? [])]);
  }
  for (const [slug, identity] of retained.identities) {
    if (identities.has(slug)) continue;
    identities.set(slug, identity);
    recordsBySlug.set(slug, retained.records.get(slug) ?? []);
  }
  if (identities.size === 0) throw new Error('No brain finished the batch');
  const summaries = [...recordsBySlug.values()].flat().map(record => record.summary);
  assertOfficialPublishable(args.official, [...identities.keys()], summaries);
  const field = summariseField([...identities.keys()], seeds, summaries);

  const provenanceBatch: BatchProvenance = {
    batchId: args.batchId,
    startedAt,
    brains: brains.filter(brain => !batch.dropped.has(brain.slug)).map(brain => brain.slug),
    modes: args.modes,
    iqConcurrency: args.concurrency,
    blitzConcurrency: args.blitzConcurrency,
    runtime,
    hardware,
  };
  const index: TournamentIndex = {
    format: INDEX_FORMAT,
    ruleset: RULESET,
    generatedAt: new Date().toISOString(),
    official: args.official,
    seeds: [...seeds],
    maxPieces: args.maxPieces,
    maxTicks: args.maxTicks,
    iqTimeoutMs: IQ_TIMEOUT_MS,
    provenance: {
      hardware,
      runtime,
      platform,
      ...sourceProvenance(),
      protocolHashes,
      adapterHashes,
      iqConcurrency: args.concurrency,
      blitzConcurrency: args.blitzConcurrency,
      batches: [...retained.batches, provenanceBatch],
    },
    brains: [...identities.values()].map(identity => standingOf(identity, recordsBySlug.get(identity.slug) ?? [], field)).sort((a, b) => a.rank - b.rank),
    headToHead: field.headToHead,
    ties: field.ties,
    runs: summaries.sort((a, b) => a.id.localeCompare(b.id)),
  };

  const temporary = resolve(out, `.index-${args.batchId}.tmp`);
  await writeFile(temporary, JSON.stringify(index, null, 2));
  await rename(temporary, resolve(out, 'index.json'));
  const orphans = await pruneOrphans(out, new Set(index.runs.map(run => run.id)));
  for (const file of orphans) console.log(`shelved orphan recording runs/${file} under partial/`);
  for (const [slug, reason] of batch.dropped) console.warn(`warning: ${slug} is not in the index: ${reason}`);
  console.log(`Wrote ${index.runs.length} games for ${index.brains.length} brains to ${out} (${args.official ? 'official' : 'quick'}); rank: ${field.rank.join(' > ')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
