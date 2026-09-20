/**
 * The game loop: asks a brain one question per tick, applies the clocks of
 * the chosen mode and records every decision. Browser-safe: no Node imports.
 *
 * IQ pauses gravity and gives each question `iqTimeoutMs`. Blitz is real
 * time: the question stays open while its piece falls, gravity keeps running,
 * and a late answer is still applied when the disclosed outcome is still
 * reachable.
 */
import {
  MAX_PIECES,
  MAX_TICKS,
  RULESET,
  applyHold,
  applyPlacement,
  createGame,
  dropDistance,
  gravityIntervalMs,
  legalPlacements,
  stateHash,
  stepGravity,
} from './engine.ts';
import type { Board, GameState, Placement } from './engine.ts';
import { validateAnswer } from './contract.ts';
import type {
  AgentAnswer,
  AgentInput,
  Brain,
  CandidateOutcome,
  Decision,
  DecisionStatus,
  GameResult,
  Metrics,
  Mode,
  ReplayFrame,
} from './contract.ts';
import { boardFeatures } from './features.ts';

export const IQ_TIMEOUT_MS = 20_000;
/** How long to wait for an aborted call to settle before moving on. */
export const SETTLE_GRACE_MS = 250;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function samePlacement(a: Placement, b: Placement): boolean {
  return a.x === b.x && a.rotation === b.rotation;
}

function sameBoard(a: Board, b: Board): boolean {
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] !== b[y][x]) return false;
    }
  }
  return true;
}

/** Twins are placements that lock into the same grid; the one with more drop points is kept, then the lower rotation. */
function prefer(candidate: CandidateOutcome, existing: CandidateOutcome): boolean {
  if (candidate.scoreDelta !== existing.scoreDelta) return candidate.scoreDelta > existing.scoreDelta;
  return candidate.placement.rotation < existing.placement.rotation;
}

/** Candidate outcomes are computed once by the harness and disclosed to every adapter. */
export function inputFor(state: GameState, mode: Mode): AgentInput {
  const byOutcome = new Map<string, CandidateOutcome>();
  const order: string[] = [];
  for (const placement of legalPlacements(state)) {
    const after = applyPlacement(state, placement);
    const topOut = after.over && after.pieces < MAX_PIECES;
    const linesCleared = after.lines - state.lines;
    const scoreDelta = after.score - state.score;
    const dropPoints = 2 * dropDistance(state, placement);
    const candidate: CandidateOutcome = {
      id: '',
      placement,
      grid: after.board,
      linesCleared,
      scoreDelta,
      dropPoints,
      clearPoints: scoreDelta - dropPoints,
      topOut,
      features: boardFeatures(after.board),
    };
    const key = JSON.stringify([after.board, linesCleared, topOut]);
    const existing = byOutcome.get(key);
    if (!existing) {
      byOutcome.set(key, candidate);
      order.push(key);
    } else if (prefer(candidate, existing)) {
      byOutcome.set(key, candidate);
    }
  }
  const candidates = order.map(key => byOutcome.get(key)!);

  // Reproducible shuffle from the public hash so the spawn column is not always the first option.
  const hash = stateHash(state);
  let rng = Number.parseInt(hash, 16) || 1;
  for (let i = candidates.length - 1; i > 0; i--) {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    const j = (rng >>> 0) % (i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  candidates.forEach((candidate, index) => {
    candidate.id = `p${index}`;
  });

  return {
    ruleset: RULESET,
    grid: state.board,
    active: state.active,
    hold: state.hold,
    canHold: !state.holdUsed && !state.over,
    next: state.next,
    level: state.level,
    score: state.score,
    lines: state.lines,
    pieces: state.pieces,
    combo: state.combo,
    backToBack: state.backToBack,
    mode,
    tick: state.tick,
    stateHash: hash,
    legal: candidates.map(c => c.placement),
    candidates,
    features: boardFeatures(state.board),
  };
}

export interface GameOptions {
  maxPieces?: number;
  maxTicks?: number;
  iqTimeoutMs?: number;
  onProgress?: (frame: ReplayFrame) => void;
  /** Test hook only: overrides the Blitz gravity clock. The runner never sets it. */
  gravityInterval?: (state: GameState) => number;
}

type CallOutcome = { kind: 'answer'; value: unknown } | { kind: 'error'; reason: string };
/** A missed deadline may still carry the call result when it settled before the harness moved on. */
type Missed<Kind extends 'timeout' | 'locked'> = { kind: Kind; settled?: CallOutcome };
type Verdict = CallOutcome | Missed<'timeout'> | Missed<'locked'>;
type RaceOutcome = Verdict | { kind: 'gravity' };

function verdictOf(raced: RaceOutcome): Verdict {
  if (raced.kind === 'gravity') throw new Error('gravity is never a final outcome');
  return raced;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isHosted(brain: Brain): boolean {
  return brain.kind === 'llm' || brain.kind === 'classifier';
}

function numericCost(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const cost = (value as { costUsd?: unknown }).costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function delay<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>(resolve => {
    handle = setTimeout(() => resolve(value), Math.max(0, ms));
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

function isAccepted(status: DecisionStatus): boolean {
  return status === 'placement' || status === 'placement-late' || status === 'hold';
}

function isUnusable(status: DecisionStatus): boolean {
  return status === 'invalid' || status === 'stale' || status === 'error' || status === 'timeout';
}

/** Book-keeping for one game. */
class Ledger {
  latencies: number[] = [];
  preparation: number[] = [];
  forecasts: Array<{ pieces: number; risk: number }> = [];
  counts: Record<DecisionStatus, number> = {
    'placement': 0,
    'placement-late': 0,
    'hold': 0,
    'unreachable': 0,
    'invalid': 0,
    'stale': 0,
    'error': 0,
    'timeout': 0,
    'locked-by-gravity': 0,
  };
  calls = 0;
  completedCalls = 0;
  costUsd = 0;
  unpricedCalls = 0;
  retries = 0;
  maxLevel = 1;
  readonly hosted: boolean;

  constructor(hosted: boolean) {
    this.hosted = hosted;
  }

  /** Adds a call's reported cost; a hosted call without a numeric cost is counted as unpriced. */
  price(settled: CallOutcome | undefined): number | undefined {
    const cost = settled?.kind === 'answer' ? numericCost(settled.value) : undefined;
    if (cost !== undefined) this.costUsd += cost;
    else if (this.hosted) this.unpricedCalls++;
    return cost;
  }

  metrics(finalState: GameState): Metrics {
    // A forecast means top-out within the next ten locked pieces; censored forecasts are omitted.
    const topOut = finalState.over && finalState.pieces < MAX_PIECES;
    const resolved = this.forecasts.filter(f => topOut || finalState.pieces >= f.pieces + 10);
    const squaredErrors = resolved.map(f => (f.risk - Number(topOut && finalState.pieces <= f.pieces + 10)) ** 2);
    const calibrationError = resolved.length ? squaredErrors.reduce((sum, e) => sum + e, 0) / resolved.length : null;
    const c = this.counts;
    return {
      calls: this.calls,
      completedCalls: this.completedCalls,
      timedOutCalls: c.timeout,
      errors: c.error,
      invalid: c.invalid,
      stale: c.stale,
      unreachable: c.unreachable,
      accepted: c.placement + c['placement-late'] + c.hold,
      lateAccepted: c['placement-late'],
      lockedByGravity: c['locked-by-gravity'],
      holds: c.hold,
      p50Ms: percentile(this.latencies, 0.5),
      p95Ms: percentile(this.latencies, 0.95),
      costUsd: this.costUsd,
      unpricedCalls: this.unpricedCalls,
      calibrationError,
      calibrationCount: resolved.length,
      preparationP50Ms: percentile(this.preparation, 0.5),
      preparationP95Ms: percentile(this.preparation, 0.95),
      retries: this.retries,
      maxLevel: this.maxLevel,
    };
  }
}

/** The question a call must answer: its hash and legal set are fixed when the call starts. */
interface Question {
  hash: string;
  legal: Placement[];
  candidates: CandidateOutcome[];
  canHold: boolean;
  pieces: number;
}

interface Resolution {
  state: GameState;
  status: DecisionStatus;
  answer?: AgentAnswer;
  reason?: string;
}

/**
 * Validate an answer against its question and apply it to the current state,
 * which may have moved on by `gravitySteps` rows since the question was asked.
 */
function resolveAnswer(state: GameState, question: Question, value: unknown, gravitySteps: number): Resolution {
  const checked = validateAnswer(value, question.hash, question.legal, question.canHold);
  if (checked.status === 'invalid') return { state, status: 'invalid', reason: checked.reason };
  if (checked.status === 'stale') return { state, status: 'stale' };
  const reason = checked.ignored.length ? `ignored: ${checked.ignored.join(', ')}` : undefined;
  if (checked.hold) {
    return { state: applyHold(state), status: 'hold', answer: checked.answer, reason };
  }
  // A late placement must still be reachable and must still produce the outcome the brain was shown.
  const shown = question.candidates.find(c => samePlacement(c.placement, checked.placement));
  const stillReachable = legalPlacements(state).some(l => samePlacement(l, checked.placement));
  const after = stillReachable ? applyPlacement(state, checked.placement) : state;
  if (!shown || after === state || !sameBoard(after.board, shown.grid)) {
    return { state, status: 'unreachable', answer: checked.answer, reason: 'placement no longer yields the disclosed outcome' };
  }
  return { state: after, status: gravitySteps > 0 ? 'placement-late' : 'placement', answer: checked.answer, reason };
}

/**
 * Play one game. One question per tick, one call in flight at a time; the
 * outcome of a call is whichever promise wins the race (answer, error,
 * timeout, gravity), never a flag set by a late handler.
 */
export async function runGame(brain: Brain, seed: string, mode: Mode, options: GameOptions = {}): Promise<GameResult> {
  const startedAt = new Date().toISOString();
  const maxPieces = options.maxPieces ?? MAX_PIECES;
  const maxTicks = options.maxTicks ?? MAX_TICKS;
  const iqTimeoutMs = options.iqTimeoutMs ?? IQ_TIMEOUT_MS;
  const interval = options.gravityInterval ?? gravityIntervalMs;
  const ledger = new Ledger(isHosted(brain));

  let state = createGame(seed);
  const started = performance.now();
  let gravityAt = started + interval(state);
  const frames: ReplayFrame[] = [{ tick: 0, elapsedMs: 0, state, event: 'start' }];
  let consecutiveUnusable = 0;
  let adapterFailure = false;

  while (!state.over && state.pieces < maxPieces && state.tick < maxTicks) {
    const tick = state.tick + 1;
    const preparedAt = performance.now();
    const input = inputFor(state, mode);
    const preparationMs = performance.now() - preparedAt;
    ledger.preparation.push(preparationMs);

    const question: Question = {
      hash: input.stateHash,
      legal: input.legal,
      candidates: input.candidates,
      canHold: input.canHold,
      pieces: state.pieces,
    };
    const yAtQuestion = state.active.y;
    let yAtDecision = yAtQuestion;
    let gravitySteps = 0;

    const controller = new AbortController();
    const budgetMs = mode === 'IQ' ? iqTimeoutMs : null;
    const began = performance.now();
    ledger.calls++;
    const work: Promise<CallOutcome> = Promise.resolve()
      .then(() => brain.decide(structuredClone(input), { signal: controller.signal, budgetMs }))
      .then(
        value => ({ kind: 'answer', value }),
        error => ({ kind: 'error', reason: describeError(error) }),
      );

    /** Applies every due gravity step; true when the question's piece locked or the game ended. */
    const catchUpGravity = (): boolean => {
      while (!state.over && state.pieces === question.pieces && performance.now() >= gravityAt) {
        yAtDecision = state.active.y;
        state = stepGravity(state);
        gravitySteps++;
        gravityAt += interval(state);
      }
      if (state.over || state.pieces !== question.pieces) return true;
      yAtDecision = state.active.y;
      return false;
    };

    let raced: RaceOutcome;
    if (mode === 'IQ') {
      const timer = delay<RaceOutcome>(iqTimeoutMs, { kind: 'timeout' });
      raced = await Promise.race([work, timer.promise]);
      timer.cancel();
    } else {
      for (;;) {
        const timer = delay<RaceOutcome>(gravityAt - performance.now(), { kind: 'gravity' });
        raced = await Promise.race([work, timer.promise]);
        timer.cancel();
        if (raced.kind !== 'gravity') break;
        if (catchUpGravity()) {
          raced = { kind: 'locked' };
          break;
        }
      }
    }
    const latencyMs = performance.now() - began;

    // The call completed when it settled before the harness gave up on it. It still cannot act when a
    // synchronous brain blocked past the IQ deadline, or when overdue gravity locked the piece in Blitz
    // (a synchronous brain cannot pre-empt timers, so due steps are applied before its answer is judged).
    let verdict = verdictOf(raced);
    if (verdict.kind === 'answer' || verdict.kind === 'error') {
      const call: CallOutcome = verdict;
      ledger.completedCalls++;
      ledger.latencies.push(latencyMs);
      if (mode === 'IQ' && latencyMs > iqTimeoutMs) verdict = { kind: 'timeout', settled: call };
      else if (mode === 'Blitz' && catchUpGravity()) verdict = { kind: 'locked', settled: call };
    }

    const decision: Decision = {
      status: 'invalid',
      called: true,
      completed: verdict.kind === 'answer' || verdict.kind === 'error' || verdict.settled !== undefined,
      stateHash: question.hash,
      latencyMs,
      budgetMs,
      gravitySteps,
      yAtQuestion,
      yAtDecision,
      preparationMs,
    };

    if (verdict.kind === 'timeout' || verdict.kind === 'locked') {
      let settled = verdict.settled;
      if (!settled) {
        controller.abort();
        const grace = delay<undefined>(SETTLE_GRACE_MS, undefined);
        settled = await Promise.race([work, grace.promise]);
        grace.cancel();
      }
      ledger.price(settled);
      decision.status = verdict.kind === 'timeout' ? 'timeout' : 'locked-by-gravity';
    } else if (verdict.kind === 'error') {
      ledger.price(verdict);
      decision.status = 'error';
      decision.reason = verdict.reason;
    } else {
      const cost = ledger.price(verdict);
      if (cost !== undefined) decision.costUsd = cost;
      const resolution = resolveAnswer(state, question, verdict.value, gravitySteps);
      state = resolution.state;
      decision.status = resolution.status;
      if (resolution.reason) decision.reason = resolution.reason;
      if (resolution.answer) {
        decision.answer = resolution.answer;
        const meta = resolution.answer.meta;
        if (meta) decision.meta = meta;
        if (meta?.retries !== undefined) {
          decision.retries = meta.retries;
          ledger.retries += meta.retries;
        }
        if (resolution.answer.score) ledger.forecasts.push({ pieces: question.pieces, risk: resolution.answer.score.risk });
      }
    }

    ledger.counts[decision.status]++;
    // Every new piece receives a full gravity interval.
    if (mode === 'Blitz' && isAccepted(decision.status)) gravityAt = performance.now() + interval(state);
    if (isAccepted(decision.status)) consecutiveUnusable = 0;
    else if (isUnusable(decision.status)) consecutiveUnusable++;

    state = { ...state, tick };
    ledger.maxLevel = Math.max(ledger.maxLevel, state.level);
    const frame: ReplayFrame = { tick, elapsedMs: performance.now() - started, state, event: decision.status, decision };
    frames.push(frame);
    options.onProgress?.(frame);

    if (consecutiveUnusable >= 3) {
      adapterFailure = true;
      break;
    }
  }

  const topOut = state.over && state.pieces < MAX_PIECES;
  const outcome: GameResult['outcome'] = adapterFailure
    ? 'adapter-failure'
    : topOut
      ? 'top-out'
      : state.pieces >= maxPieces
        ? 'piece-cap'
        : 'tick-cap';

  return {
    id: `v3-${brain.slug}-${seed}-${mode.toLowerCase()}`,
    ruleset: RULESET,
    startedAt,
    brain: brain.slug,
    seed,
    mode,
    score: state.score,
    lines: state.lines,
    pieces: state.pieces,
    ticks: state.tick,
    outcome,
    metrics: ledger.metrics(state),
    frames,
  };
}
