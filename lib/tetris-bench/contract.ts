/**
 * The contract every brain codes against, and the shapes the harness,
 * runner and website exchange. Browser-safe: no Node imports.
 */
import type { Board, GameState, Placement, Rotation } from './engine.ts';
import type { BoardFeatures } from './features.ts';
import type { HeadToHead, ScoreSummary } from './rating.ts';

export type { BoardFeatures } from './features.ts';

export type Mode = 'IQ' | 'Blitz';

/** One disclosed option: the board after locking and clearing, with the points split into drop and clear parts. */
export interface CandidateOutcome {
  id: string;
  placement: Placement;
  grid: Board;
  linesCleared: number;
  scoreDelta: number;
  /** 2 x rows hard-dropped along the canonical path. */
  dropPoints: number;
  /** scoreDelta minus dropPoints: line clears, spins, combos and perfect clears. */
  clearPoints: number;
  topOut: boolean;
  features: BoardFeatures;
}

export interface AgentInput {
  ruleset: string;
  grid: Board;
  active: GameState['active'];
  hold: GameState['hold'];
  canHold: boolean;
  next: GameState['next'];
  level: number;
  score: number;
  lines: number;
  pieces: number;
  combo: number;
  backToBack: boolean;
  mode: Mode;
  tick: number;
  stateHash: string;
  /** The accepted placements; `legal[i]` is `candidates[i].placement`. Deduplicated by outcome. */
  legal: Placement[];
  candidates: CandidateOutcome[];
  features: BoardFeatures;
}

export interface AnswerMeta {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  retries?: number;
  raw?: string;
}

export interface AgentAnswer {
  stateHash: string;
  choice: Array<Placement & { p: number }>;
  noul?: { hold: number | boolean };
  score?: { risk: number };
  costUsd?: number;
  providerProbabilityMass?: number;
  meta?: AnswerMeta;
}

export interface Brain {
  slug: string;
  name: string;
  description: string;
  kind: 'baseline' | 'heuristic' | 'search' | 'llm' | 'classifier';
  provider?: string;
  model?: string;
  via?: string;
  adapterVersion: string;
  decide(input: AgentInput, ctx: { signal: AbortSignal; budgetMs: number | null }): Promise<unknown> | unknown;
}

export type DecisionStatus =
  | 'placement'
  | 'placement-late'
  | 'hold'
  | 'unreachable'
  | 'invalid'
  | 'stale'
  | 'error'
  | 'timeout'
  | 'locked-by-gravity';

export interface Decision {
  status: DecisionStatus;
  called: boolean;
  /** The call resolved with a value or an error before it was aborted. */
  completed: boolean;
  /** Hash of the question this decision answers. */
  stateHash: string;
  latencyMs: number;
  /** The IQ timeout; null in Blitz, where the falling piece is the deadline. */
  budgetMs: number | null;
  /** Gravity steps applied to the question's piece before the decision was applied. */
  gravitySteps: number;
  yAtQuestion: number;
  yAtDecision: number;
  preparationMs: number;
  answer?: AgentAnswer;
  costUsd?: number;
  retries?: number;
  meta?: AnswerMeta;
  reason?: string;
}

export interface ReplayFrame {
  tick: number;
  elapsedMs: number;
  state: GameState;
  event: 'start' | DecisionStatus;
  decision?: Decision;
}

export interface Metrics {
  calls: number;
  completedCalls: number;
  timedOutCalls: number;
  errors: number;
  invalid: number;
  stale: number;
  unreachable: number;
  /** Placements, late placements and holds. */
  accepted: number;
  lateAccepted: number;
  lockedByGravity: number;
  holds: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsd: number;
  /** Hosted-brain calls that reported no numeric cost, aborted calls included. */
  unpricedCalls: number;
  calibrationError: number | null;
  calibrationCount: number;
  preparationP50Ms: number | null;
  preparationP95Ms: number | null;
  retries: number;
  maxLevel: number;
}

export type GameOutcome = 'top-out' | 'piece-cap' | 'tick-cap' | 'adapter-failure';

export interface GameResult {
  id: string;
  ruleset: string;
  startedAt: string;
  brain: string;
  seed: string;
  mode: Mode;
  score: number;
  lines: number;
  pieces: number;
  ticks: number;
  outcome: GameOutcome;
  metrics: Metrics;
  frames: ReplayFrame[];
}

/** The index entry for one recorded game. */
export interface RunSummary {
  id: string;
  ruleset: string;
  format: string;
  brain: string;
  seed: string;
  mode: Mode;
  score: number;
  lines: number;
  pieces: number;
  ticks: number;
  outcome: GameOutcome;
  startedAt: string;
  metrics: Metrics;
  artifactSha256: string;
}

export interface BrainStanding {
  slug: string;
  name: string;
  kind: Brain['kind'];
  provider?: string;
  model?: string;
  via?: string;
  description: string;
  adapterVersion: string;
  rank: number;
  iq: ScoreSummary;
  blitz: ScoreSummary | null;
  elo: { rating: number; interval: { lower: number; upper: number } | null };
  iqMetrics: Metrics;
  blitzMetrics: Metrics | null;
  costPer100Decisions: number | null;
  unpricedCalls: number;
}

export interface BatchProvenance {
  batchId: string;
  startedAt: string;
  brains: string[];
  modes: Mode[];
  iqConcurrency: number;
  blitzConcurrency: number;
  runtime: string;
  hardware: { cpu: string; cores: number };
}

export interface TournamentIndex {
  format: 'tetris-bench-index@3';
  ruleset: 'tetris-bench@3';
  generatedAt: string;
  official: boolean;
  seeds: string[];
  maxPieces: number;
  maxTicks: number;
  iqTimeoutMs: number;
  provenance: {
    hardware: { cpu: string; cores: number };
    runtime: string;
    platform: string;
    sourceCommit: string | null;
    sourceTree: string | null;
    sourceDirty: boolean;
    protocolHashes: Record<string, string>;
    adapterHashes: Record<string, string>;
    iqConcurrency: number;
    blitzConcurrency: number;
    batches: BatchProvenance[];
  };
  brains: BrainStanding[];
  headToHead: HeadToHead[];
  ties: Array<[string, string]>;
  runs: RunSummary[];
}

export type ValidatedAnswer =
  | { status: 'ok'; answer: AgentAnswer; placement: Placement; hold: boolean; ignored: string[] }
  | { status: 'invalid'; reason: string }
  | { status: 'stale' };

const PROBABILITY_TOLERANCE = 0.001;

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePlacement(a: Placement, b: Placement): boolean {
  return a.x === b.x && a.rotation === b.rotation;
}

/** The placement the harness applies: highest probability, then lowest x, then lowest rotation. */
export function argmaxChoice(choice: AgentAnswer['choice']): Placement {
  const best = [...choice].sort((a, b) => b.p - a.p || a.x - b.x || a.rotation - b.rotation)[0];
  return { x: best.x, rotation: best.rotation };
}

/** Reads the hold request as a probability: booleans map to 0/1, numbers must lie in [0, 1]. */
function holdProbability(noul: unknown): number | null {
  if (!isRecord(noul)) return null;
  const hold = noul.hold;
  if (typeof hold === 'boolean') return hold ? 1 : 0;
  return isProbability(hold) ? hold : null;
}

function normaliseMeta(meta: unknown): AnswerMeta | null {
  if (!isRecord(meta)) return null;
  const result: AnswerMeta = {};
  for (const key of ['promptTokens', 'completionTokens', 'reasoningTokens', 'retries'] as const) {
    const value = meta[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  for (const key of ['finishReason', 'raw'] as const) {
    const value = meta[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function validateChoice(choice: unknown, legal: Placement[]): { choice: AgentAnswer['choice'] } | { reason: string } {
  if (!Array.isArray(choice)) return { reason: 'choice must be an array' };
  if (choice.length === 0) return { reason: 'choice is empty' };
  const normalised: AgentAnswer['choice'] = [];
  const seen = new Set<string>();
  for (const entry of choice) {
    if (!isRecord(entry)) return { reason: 'choice entry is not an object' };
    const { x, rotation, p } = entry;
    if (!Number.isInteger(x) || !Number.isInteger(rotation)) return { reason: 'choice entry needs integer x and rotation' };
    if (!isProbability(p)) return { reason: 'choice probability must be a finite number in [0, 1]' };
    const placement = { x: x as number, rotation: rotation as Rotation };
    if (!legal.some(l => samePlacement(l, placement))) return { reason: `placement (${placement.x}, ${placement.rotation}) is not legal` };
    const key = `${placement.x}:${placement.rotation}`;
    if (seen.has(key)) return { reason: `placement (${placement.x}, ${placement.rotation}) listed twice` };
    seen.add(key);
    normalised.push({ ...placement, p });
  }
  const mass = normalised.reduce((sum, c) => sum + c.p, 0);
  if (Math.abs(mass - 1) > PROBABILITY_TOLERANCE) return { reason: `probabilities sum to ${mass.toFixed(4)}, not 1` };
  return { choice: normalised };
}

/**
 * Validate a raw brain answer against the question it must answer. Returns a
 * normalised copy holding only the known fields. Malformed optional fields
 * (noul, score, costUsd, providerProbabilityMass, meta) are dropped and named
 * in `ignored`; only the required fields can make an answer invalid.
 */
export function validateAnswer(value: unknown, hash: string, legal: Placement[], canHold = true): ValidatedAnswer {
  if (!isRecord(value)) return { status: 'invalid', reason: 'answer is not an object' };
  if (typeof value.stateHash !== 'string') return { status: 'invalid', reason: 'stateHash missing' };
  if (value.stateHash !== hash) return { status: 'stale' };

  const checked = validateChoice(value.choice, legal);
  if ('reason' in checked) return { status: 'invalid', reason: checked.reason };

  const answer: AgentAnswer = { stateHash: value.stateHash, choice: checked.choice };
  const ignored: string[] = [];
  let hold = false;

  if (value.noul !== undefined) {
    const probability = holdProbability(value.noul);
    if (probability === null) {
      ignored.push('noul');
    } else {
      answer.noul = { hold: probability };
      if (probability > 0.5) {
        if (canHold) hold = true;
        else ignored.push('noul');
      }
    }
  }
  if (value.score !== undefined) {
    if (isRecord(value.score) && isProbability(value.score.risk)) answer.score = { risk: value.score.risk };
    else ignored.push('score');
  }
  if (value.costUsd !== undefined) {
    if (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0) answer.costUsd = value.costUsd;
    else ignored.push('costUsd');
  }
  if (value.providerProbabilityMass !== undefined) {
    if (typeof value.providerProbabilityMass === 'number' && Number.isFinite(value.providerProbabilityMass)) {
      answer.providerProbabilityMass = value.providerProbabilityMass;
    } else {
      ignored.push('providerProbabilityMass');
    }
  }
  if (value.meta !== undefined) {
    const meta = normaliseMeta(value.meta);
    if (meta) answer.meta = meta;
    else ignored.push('meta');
  }

  return { status: 'ok', answer, placement: argmaxChoice(answer.choice), hold, ignored };
}
