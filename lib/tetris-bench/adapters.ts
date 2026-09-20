import { applyPlacement, legalPlacements, createGame, MAX_PIECES } from './engine.ts';
import type { GameState, Placement } from './engine.ts';
import { boardFeatures } from './features.ts';
import type { BoardFeatures } from './features.ts';
import type { AgentAnswer, AgentInput, AnswerMeta, Brain, CandidateOutcome } from './contract.ts';
import type { HostedModel } from './models.ts';

export const ADAPTER_VERSION = '3.0.0';

type DecideContext = { signal: AbortSignal; budgetMs: number | null };

// ---------------------------------------------------------------------------
// Built-in brains
// ---------------------------------------------------------------------------

function singleChoice(input: AgentInput, placement: Placement | undefined): AgentAnswer {
  return {
    stateHash: input.stateHash,
    choice: placement ? [{ ...placement, p: 1 }] : [],
    costUsd: 0,
  };
}

type Evaluated = Pick<CandidateOutcome, 'linesCleared' | 'topOut'> & { features: BoardFeatures };

/**
 * One-ply value of a resulting board. The weights are the v2 weights; only the
 * feature computation moved to the shared `boardFeatures`.
 */
function evaluate(outcome: Evaluated, dellacherie: boolean): number {
  if (outcome.topOut) return -1e9;
  const f = outcome.features;
  let value = outcome.linesCleared * 10 - f.aggregateHeight * 0.51 - f.holes * 7.5 - f.bumpiness * 0.18;
  if (dellacherie) value -= f.rowTransitions * 0.25 + f.wells * 0.35;
  return value;
}

/** A two-ply preview consumes only the active piece and next[0], both publicly disclosed. */
function publicPreview(input: AgentInput): GameState {
  return {
    ...createGame('public-preview'),
    board: input.grid.map(row => [...row]),
    active: { ...input.active },
    hold: input.hold,
    holdUsed: !input.canHold,
    next: [...input.next],
    level: input.level,
    score: input.score,
    lines: input.lines,
    pieces: input.pieces,
    combo: input.combo,
    backToBack: input.backToBack,
    tick: input.tick,
  };
}

function byValueThenPosition(a: { value: number; outcome: CandidateOutcome }, b: { value: number; outcome: CandidateOutcome }): number {
  return b.value - a.value
    || a.outcome.placement.x - b.outcome.placement.x
    || a.outcome.placement.rotation - b.outcome.placement.rotation;
}

function hashToInt(hash: string): number {
  return Number.parseInt(hash, 16) || 1;
}

const randomLegal: Brain = {
  slug: 'random-legal',
  name: 'Random legal',
  kind: 'baseline',
  adapterVersion: ADAPTER_VERSION,
  description: 'Seeded uniform choice over legal placements.',
  decide(input) {
    let hash = 2166136261;
    for (const char of input.stateHash) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return singleChoice(input, input.legal[(hash >>> 0) % input.legal.length]);
  },
};

function heuristicBrain(slug: string, name: string, description: string, dellacherie: boolean): Brain {
  return {
    slug,
    name,
    kind: 'heuristic',
    adapterVersion: ADAPTER_VERSION,
    description,
    decide(input) {
      const ranked = input.candidates
        .map(outcome => ({ outcome, value: evaluate(outcome, dellacherie) }))
        .sort(byValueThenPosition);
      return singleChoice(input, ranked[0]?.outcome.placement);
    },
  };
}

const SEARCH_BREADTH = 6;

const searchBrain: Brain = {
  slug: 'search',
  name: 'Two-ply search',
  kind: 'search',
  adapterVersion: ADAPTER_VERSION,
  description: 'Two-ply search over the six best first placements using the visible next piece.',
  decide(input) {
    const ranked = input.candidates
      .map(outcome => ({ outcome, value: evaluate(outcome, true) }))
      .sort(byValueThenPosition)
      .slice(0, SEARCH_BREADTH);
    const visible = publicPreview(input);
    for (const candidate of ranked) {
      if (candidate.outcome.topOut) continue;
      const next = applyPlacement(visible, candidate.outcome.placement);
      if (next.over) continue;
      const followUps = legalPlacements(next).map(placement => {
        const result = applyPlacement(next, placement);
        return evaluate({
          linesCleared: result.lines - input.lines,
          topOut: result.over && result.pieces < MAX_PIECES,
          features: boardFeatures(result.board),
        }, true);
      });
      candidate.value = followUps.length ? Math.max(...followUps) : -1e9;
    }
    ranked.sort(byValueThenPosition);
    return singleChoice(input, ranked[0]?.outcome.placement);
  },
};

export const builtInBrains: Brain[] = [
  randomLegal,
  heuristicBrain('greedy', 'Greedy heuristic', 'One-ply height, holes, bumpiness and line clears.', false),
  heuristicBrain('dellacherie', 'Dellacherie-style', 'Height, holes, transitions and wells. Inspired by Dellacherie.', true),
  searchBrain,
];

// ---------------------------------------------------------------------------
// Shared evidence rendering for hosted models
// ---------------------------------------------------------------------------

export interface Evidence {
  system: string;
  user: string;
  /** Two-letter candidate id → the candidate it names. */
  ids: Map<string, CandidateOutcome>;
}

/** The goal rubric, shared by the chat system prompt and Jev's placement question. */
export const GOAL_RUBRIC = `Goal: survive as long as possible and score as many points as possible over the whole game, not just this move. In order of importance:
1. Never pick a candidate with topOut=yes.
2. Avoid creating holes (empty cells with a filled cell above them). Holes are the main way games are lost.
3. Keep the stack low and flat (low maxH and low bump). Avoid deep narrow wells except one well reserved for I pieces.
4. Clear lines when doing so does not cost holes. Multi-line clears score more.`;

export const EVIDENCE_SYSTEM_PROMPT = `You are choosing where to lock the current Tetris piece. The board is 10 columns (0-9, left to right) and 20 rows (row 0 is the top, row 19 is the floor). "#" is a filled cell, "." is empty. You lose if the stack reaches the top.

${GOAL_RUBRIC}

Each candidate line is a legal placement that has already been simulated for you. Its numbers describe the board AFTER the piece locks and completed lines are removed:
  lines = lines cleared, clear = points scored by clearing lines, drop = points for the hard drop (2 per row fallen; a big drop only means a deep landing spot, not a better board), maxH = tallest column height, holes = covered empty cells, bump = sum of adjacent height differences, wells = depth of narrow pits, topOut = whether this placement ends the game.
Candidate IDs are arbitrary two-letter codes; their order carries no meaning. You must answer with exactly one listed ID.

Two optional fields may be added to the answer. "hold": true swaps the active piece into the hold slot instead of placing it (the piece is then placed on a later turn); set it only when that clearly improves the position and only when the header says canHold=true. "risk": your probability (0-1) that the game tops out within the next ten pieces. Both are optional; "candidate" is required.`;

export const RISK_DEFINITION = 'your probability (0-1) that the game tops out within the next ten pieces';

// I and O are dropped so no code reads as a digit or a piece pair.
const ID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Deterministic two-letter candidate ids seeded from the state hash. The pool is
 * shuffled before ids are taken, so an id says nothing about list position.
 */
export function candidateIds(stateHash: string, count: number): string[] {
  const pool: string[] = [];
  for (const first of ID_LETTERS) for (const second of ID_LETTERS) pool.push(first + second);
  if (count > pool.length) throw new Error(`Cannot label ${count} candidates with two letters`);
  let order = hashToInt(stateHash);
  for (let i = pool.length - 1; i > 0; i--) {
    order ^= order << 13; order ^= order >>> 17; order ^= order << 5;
    const j = (order >>> 0) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function boardRows(grid: GameState['board']): string[] {
  return grid.map(row => row.map(cell => (cell ? '#' : '.')).join(''));
}

function evidenceHeader(input: AgentInput): string {
  return `Active piece: ${input.active.type}   Next: ${input.next.join(' ')}   Hold slot: ${input.hold ?? 'empty'} (canHold=${input.canHold})   `
    + `Level ${input.level}, score ${input.score}, lines ${input.lines}, pieces ${input.pieces}, combo ${input.combo}, back-to-back ${input.backToBack}`;
}

/** The occupied rows plus one empty row above them, with row numbers. */
function evidenceBoard(input: AgentInput): string {
  const rows = boardRows(input.grid);
  const firstOccupied = rows.findIndex(row => row.includes('#'));
  const top = firstOccupied < 0 ? rows.length : firstOccupied;
  const from = Math.max(0, Math.min(top - 1, rows.length - 1));
  const last = rows.length - 1;
  const title = from > 0
    ? `Current board (rows ${from}-${last} shown; rows above ${from} are empty):`
    : `Current board (rows 0-${last}):`;
  const lines = rows.slice(from).map((row, index) => `${String(from + index).padStart(2, ' ')} ${row}`);
  const f = input.features;
  return `${title}\n${lines.join('\n')}\n   0123456789\nColumn heights now: [${f.heights.join(',')}]  holes now: ${f.holes}  maxH now: ${f.maxHeight}`;
}

/** One candidate as the models see it (also used verbatim as Jev's criteria). */
export function candidateLine(candidate: CandidateOutcome): string {
  const f = candidate.features;
  return `x=${candidate.placement.x} rot=${candidate.placement.rotation} | lines=${candidate.linesCleared} clear=+${candidate.clearPoints} drop=+${candidate.dropPoints} `
    + `maxH=${f.maxHeight} holes=${f.holes} bump=${f.bumpiness} wells=${f.wells} topOut=${candidate.topOut ? 'yes' : 'no'}`;
}

export const REPLY_INSTRUCTION = 'Reply with JSON only: {"candidate":"<ID>","hold":false,"risk":0.1}';

/** Identical decision evidence for every hosted model. */
export function renderEvidence(input: AgentInput): Evidence {
  const codes = candidateIds(input.stateHash, input.candidates.length);
  const ids = new Map<string, CandidateOutcome>();
  const lines: string[] = [];
  input.candidates.forEach((candidate, index) => {
    ids.set(codes[index], candidate);
    lines.push(`${codes[index]}: ${candidateLine(candidate)}`);
  });
  const user = `${evidenceHeader(input)}\n\n${evidenceBoard(input)}\n\nCandidates (${input.candidates.length}):\n${lines.join('\n')}\n\n${REPLY_INSTRUCTION}`;
  return { system: EVIDENCE_SYSTEM_PROMPT, user, ids };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_RETRY_BACKOFF_MS = 500;
/** A retry is only attempted when at least this much budget remains after the backoff. */
const MIN_BUDGET_AFTER_BACKOFF_MS = 1500;

export class ProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export interface HostedBrainOptions {
  /** Defaults to OPENROUTER_API_KEY. */
  key?: string;
  /** Backoff before the single retry; tests shorten it. */
  retryBackoffMs?: number;
  /** Where warnings go (defaults to console.warn). */
  warn?: (message: string) => void;
}

function resolveKey(options: HostedBrainOptions): string {
  const key = options.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  return key;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.status === null || error.status === 429 || error.status >= 500;
  return false;
}

function retryFits(budgetMs: number | null, elapsedMs: number, backoffMs: number): boolean {
  if (budgetMs === null) return true;
  return budgetMs - elapsedMs - backoffMs >= MIN_BUDGET_AFTER_BACKOFF_MS;
}

async function postOnce(path: string, body: unknown, key: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.lowndes.dev/tetris-bench',
        'X-Title': 'Tetris Bench',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    // Network failures carry no status; the message never includes headers or the key.
    throw new ProviderError(`Provider request failed (${error instanceof Error ? error.name : 'network error'})`, null);
  }
  if (!response.ok) throw new ProviderError(`Provider request failed (HTTP ${response.status})`, response.status);
  const data = await response.json() as Record<string, unknown>;
  // OpenRouter can answer HTTP 200 with an error envelope when the upstream provider failed. That is
  // a provider failure (retryable when the embedded code says so), not the brain's answer.
  const envelope = data.error;
  if (envelope && typeof envelope === 'object') {
    const code = (envelope as { code?: unknown }).code;
    throw new ProviderError(`Provider returned an error envelope${typeof code === 'number' ? ` (code ${code})` : ''}`, typeof code === 'number' ? code : null);
  }
  return data;
}

/**
 * POST with one retry on 429/5xx/network failure. The retry is skipped when the
 * remaining budget could not fit the backoff plus a realistic second attempt.
 */
async function postWithRetry(path: string, body: unknown, key: string, context: DecideContext, backoffMs: number): Promise<{ data: Record<string, unknown>; retries: number }> {
  const started = performance.now();
  try {
    return { data: await postOnce(path, body, key, context.signal), retries: 0 };
  } catch (error) {
    if (context.signal.aborted || !isRetryable(error)) throw error;
    if (!retryFits(context.budgetMs, performance.now() - started, backoffMs)) throw error;
    await sleep(backoffMs, context.signal);
    return { data: await postOnce(path, body, key, context.signal), retries: 1 };
  }
}

interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readUsage(data: Record<string, unknown>): Usage {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return {};
  const details = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const cost = finiteNumber(usage.cost);
  return {
    promptTokens: finiteNumber(usage.prompt_tokens),
    completionTokens: finiteNumber(usage.completion_tokens),
    reasoningTokens: finiteNumber(details?.reasoning_tokens),
    costUsd: cost !== undefined && cost >= 0 ? cost : undefined,
  };
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** An answer that validates as invalid but still carries the cost and diagnostics of the call. */
function unusableAnswer(input: AgentInput, usage: Usage, meta: AnswerMeta): AgentAnswer {
  return withoutUndefined({ stateHash: input.stateHash, choice: [], costUsd: usage.costUsd, meta: withoutUndefined(meta) });
}

// ---------------------------------------------------------------------------
// Chat-completion brains
// ---------------------------------------------------------------------------

/**
 * Returns the first balanced `{…}` object in the text. Models sometimes wrap the
 * answer in code fences, add prose, or emit the object twice.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

interface ParsedReply { candidate?: unknown; hold?: unknown; risk?: unknown }

export function parseReply(content: string): ParsedReply | null {
  const object = extractFirstJsonObject(content);
  if (!object) return null;
  try {
    const parsed: unknown = JSON.parse(object);
    return parsed && typeof parsed === 'object' ? parsed as ParsedReply : null;
  } catch {
    return null;
  }
}

export function responseFormatFor(model: HostedModel, ids: string[]): Record<string, unknown> {
  if (model.jsonSchema === false) return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'tetris_choice',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          candidate: { type: 'string', enum: ids },
          hold: { type: 'boolean' },
          risk: { type: 'number' },
        },
        // Strict mode (OpenAI) requires every property to be listed here, so
        // hold and risk are always answered under the schema path.
        required: ['candidate', 'hold', 'risk'],
        additionalProperties: false,
      },
    },
  };
}

export function chatRequestBody(model: HostedModel, evidence: Evidence): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: [
      { role: 'system', content: evidence.system },
      { role: 'user', content: evidence.user },
    ],
    max_tokens: model.maxTokens,
    response_format: responseFormatFor(model, [...evidence.ids.keys()]),
    usage: { include: true },
  };
  if (model.temperature !== undefined) body.temperature = model.temperature;
  if (model.reasoning === 'off') body.reasoning = { enabled: false };
  return body;
}

function optionalHold(hold: unknown): AgentAnswer['noul'] | undefined {
  if (typeof hold === 'boolean') return { hold };
  if (typeof hold === 'number' && Number.isFinite(hold)) return { hold };
  return undefined;
}

function optionalRisk(risk: unknown): AgentAnswer['score'] | undefined {
  return typeof risk === 'number' && Number.isFinite(risk) ? { risk } : undefined;
}

const RAW_LIMIT = 300;

export function openRouterBrain(model: HostedModel, options: HostedBrainOptions = {}): Brain {
  if (model.kind !== 'llm') throw new Error(`${model.slug} is not a chat model`);
  const key = resolveKey(options);
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  return {
    slug: model.slug,
    name: model.name,
    kind: 'llm',
    provider: model.provider,
    model: model.model,
    via: 'OpenRouter',
    adapterVersion: ADAPTER_VERSION,
    description: 'A general-purpose language model reading the shared evidence and answering with one candidate id.',
    async decide(input, context) {
      const evidence = renderEvidence(input);
      const { data, retries } = await postWithRetry('/chat/completions', chatRequestBody(model, evidence), key, context, backoffMs);
      const usage = readUsage(data);
      const choices = data.choices as Array<{ message?: { content?: unknown }; finish_reason?: unknown }> | undefined;
      const first = choices?.[0];
      const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : undefined;
      const content = typeof first?.message?.content === 'string' ? first.message.content : '';
      const meta: AnswerMeta = {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        finishReason,
        retries,
      };
      if (finishReason === 'length') return unusableAnswer(input, usage, { ...meta, raw: content.slice(0, RAW_LIMIT) });
      const parsed = parseReply(content);
      const candidate = parsed ? evidence.ids.get(String(parsed.candidate ?? '').trim().toUpperCase()) : undefined;
      if (!candidate) return unusableAnswer(input, usage, { ...meta, raw: content.slice(0, RAW_LIMIT) });
      return withoutUndefined({
        stateHash: input.stateHash,
        choice: [{ ...candidate.placement, p: 1 }],
        noul: optionalHold(parsed?.hold),
        score: optionalRisk(parsed?.risk),
        costUsd: usage.costUsd,
        meta: withoutUndefined(meta),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Jev (typed classification through /systemone)
// ---------------------------------------------------------------------------

/** Transport quantisation: renormalise only small rounding drift, never arbitrary scores. */
export function normaliseChoiceProbabilities(probs: Record<string, number>): { probabilities: Record<string, number>; mass: number } | null {
  const values = Object.values(probs);
  const isProbability = (p: unknown) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
  if (!values.length || values.some(p => !isProbability(p))) return null;
  const mass = values.reduce((sum, p) => sum + p, 0);
  const roundingBound = Math.min(0.05, values.length * 0.005) + 1e-9;
  if (mass <= 0 || Math.abs(mass - 1) > roundingBound) return null;
  const probabilities = Object.fromEntries(Object.entries(probs).map(([id, p]) => [id, p / mass]));
  return { probabilities, mass };
}

export interface JevBrainOptions extends HostedBrainOptions {
  /** Ask the `risk` score question (default true). Dropped for the rest of the process after an HTTP 400. */
  riskQuestion?: boolean;
}

/** Process-wide memory of whether /systemone rejected the risk question. */
export const jevMemory = { riskQuestionRejected: false };

export const JEV_MODEL = 'typesafe/jev-1.13';

export function jevHoldInstructions(input: AgentInput): string {
  const placedInstead = input.hold ?? input.next[0];
  return `Hold the active piece ${input.active.type} instead of placing it. The hold slot holds ${input.hold ?? 'nothing'}; holding means the piece placed now is ${placedInstead}. Answer yes only if that is clearly better.`;
}

export const JEV_PLACEMENT_INSTRUCTIONS = `${GOAL_RUBRIC}\nEach criterion is one candidate line from the state; its numbers describe the board after the piece locks and completed lines are removed.`;

/**
 * A System One `score` question rates the state against an ordered ladder of
 * criteria and returns a probability per rung. The rungs below are likelihood
 * bands for a top-out within ten pieces; the adapter turns the rung
 * probabilities into one 0-1 risk by taking the expected band midpoint.
 */
export const JEV_RISK_LADDER: ReadonlyArray<{ label: string; midpoint: number }> = [
  { label: 'Very unlikely to top out within the next ten pieces (0 to 10%)', midpoint: 0.05 },
  { label: 'Unlikely to top out within the next ten pieces (10 to 35%)', midpoint: 0.225 },
  { label: 'Even chance of topping out within the next ten pieces (35 to 65%)', midpoint: 0.5 },
  { label: 'Likely to top out within the next ten pieces (65 to 90%)', midpoint: 0.775 },
  { label: 'Almost certain to top out within the next ten pieces (90 to 100%)', midpoint: 0.95 },
];

export function jevRequestBody(input: AgentInput, evidence: Evidence, includeRisk: boolean): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const [id, candidate] of evidence.ids) criteria[id] = candidateLine(candidate);
  const questions: Record<string, unknown> = {
    placement: { type: 'choice', instructions: JEV_PLACEMENT_INSTRUCTIONS, criteria },
  };
  if (input.canHold) questions.hold = { type: 'noul', instructions: jevHoldInstructions(input) };
  if (includeRisk) {
    questions.risk = {
      type: 'score',
      instructions: `Estimate ${RISK_DEFINITION}. Pick the band that matches the current board and the next pieces.`,
      criteria: JEV_RISK_LADDER.map(rung => rung.label),
    };
  }
  return { model: JEV_MODEL, state: `${evidence.system}\n\n${evidence.user}`, questions };
}

interface JevAnswers {
  placement?: { probabilities?: Record<string, number> };
  hold?: { noul?: unknown };
  risk?: { probabilities?: Record<string, unknown>; score?: unknown };
}

/** Expected band midpoint over the rung probabilities; falls back to the expected rung index. */
export function jevRiskFromAnswer(risk: JevAnswers['risk']): number | undefined {
  if (!risk || typeof risk !== 'object') return undefined;
  const probabilities = risk.probabilities;
  if (probabilities && typeof probabilities === 'object') {
    let mass = 0;
    let expected = 0;
    for (const [rung, value] of Object.entries(probabilities)) {
      const index = Number(rung);
      const band = JEV_RISK_LADDER[index];
      if (!band || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      mass += value;
      expected += value * band.midpoint;
    }
    if (mass > 0) return Math.min(1, Math.max(0, expected / mass));
  }
  const score = risk.score;
  if (typeof score === 'number' && Number.isFinite(score)) {
    const last = JEV_RISK_LADDER.length - 1;
    const position = Math.min(last, Math.max(0, score));
    const low = Math.floor(position);
    const high = Math.min(last, low + 1);
    const fraction = position - low;
    return JEV_RISK_LADDER[low].midpoint + (JEV_RISK_LADDER[high].midpoint - JEV_RISK_LADDER[low].midpoint) * fraction;
  }
  return undefined;
}

export function jevBrain(options: JevBrainOptions = {}): Brain {
  const key = resolveKey(options);
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return {
    slug: 'jev',
    name: 'Jev 1.13',
    kind: 'classifier',
    provider: 'TypeSafe',
    model: JEV_MODEL,
    via: 'OpenRouter',
    adapterVersion: ADAPTER_VERSION,
    description: 'Typed choice, noul and score questions over the shared evidence through /systemone.',
    async decide(input, context) {
      const evidence = renderEvidence(input);
      const wantRisk = options.riskQuestion !== false && !jevMemory.riskQuestionRejected;
      let result: { data: Record<string, unknown>; retries: number };
      try {
        result = await postWithRetry('/systemone', jevRequestBody(input, evidence, wantRisk), key, context, backoffMs);
      } catch (error) {
        const rejectedRisk = wantRisk && error instanceof ProviderError && error.status === 400;
        if (!rejectedRisk) throw error;
        jevMemory.riskQuestionRejected = true;
        warn('tetris-bench: /systemone returned HTTP 400 with the risk score question; dropping it for the rest of this process.');
        result = await postWithRetry('/systemone', jevRequestBody(input, evidence, false), key, context, backoffMs);
      }
      const usage = readUsage(result.data);
      const meta: AnswerMeta = { retries: result.retries };
      const answers = result.data.answers as JevAnswers | undefined;
      const probabilities = answers?.placement?.probabilities;
      if (!probabilities || typeof probabilities !== 'object') return unusableAnswer(input, usage, { ...meta, raw: 'no placement probabilities' });
      const unknown = Object.keys(probabilities).filter(id => !evidence.ids.has(id));
      if (unknown.length) return unusableAnswer(input, usage, { ...meta, raw: `unknown ids: ${unknown.join(',')}` });
      const distribution = normaliseChoiceProbabilities(probabilities);
      if (!distribution) return unusableAnswer(input, usage, { ...meta, raw: 'probability mass outside rounding bound' });
      const choice = Object.entries(distribution.probabilities).map(([id, p]) => {
        const candidate = evidence.ids.get(id) as CandidateOutcome;
        return { ...candidate.placement, p };
      });
      const hold = input.canHold ? optionalHold(answers?.hold?.noul) : undefined;
      const risk = optionalRisk(jevRiskFromAnswer(answers?.risk));
      return withoutUndefined({
        stateHash: input.stateHash,
        choice,
        providerProbabilityMass: distribution.mass,
        noul: hold,
        score: risk,
        costUsd: usage.costUsd,
        meta,
      });
    },
  };
}

/** The brain for a registry entry. */
export function hostedBrain(model: HostedModel, options: JevBrainOptions = {}): Brain {
  return model.kind === 'classifier' ? jevBrain(options) : openRouterBrain(model, options);
}
