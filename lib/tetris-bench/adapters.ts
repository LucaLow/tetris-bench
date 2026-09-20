import { applyPlacement, legalPlacements, createGame, MAX_PIECES } from './engine.ts';
import type { GameState, Placement } from './engine.ts';
import type { AgentAnswer, AgentInput, Brain, CandidateOutcome } from './contract.ts';

function answer(input: AgentInput, placement: Placement | undefined): AgentAnswer {
  return { stateHash: input.stateHash, choice: placement ? [{ ...placement, p: 1 }] : [], costUsd: 0 };
}
function features(board: GameState['board']) {
  const heights = Array.from({ length: 10 }, (_, x) => { const y = board.findIndex(r => r[x]); return y < 0 ? 0 : 20 - y; });
  let holes = 0, transitions = 0, wells = 0;
  for (let x = 0; x < 10; x++) {
    for (let y = 20 - heights[x]; y < 20; y++) if (!board[y][x]) holes++;
    wells += Math.max(0, Math.min(x ? heights[x - 1] : 20, x < 9 ? heights[x + 1] : 20) - heights[x]);
  }
  for (const row of board) { let previous = true; for (const cell of row) { if (!!cell !== previous) transitions++; previous = !!cell; } if (!previous) transitions++; }
  return { height: heights.reduce((a, b) => a + b, 0), holes, transitions, wells, bump: heights.slice(1).reduce((sum, h, i) => sum + Math.abs(h - heights[i]), 0) };
}
function evaluate(outcome: Pick<CandidateOutcome, 'grid' | 'linesCleared' | 'topOut'>, dellacherie = false) {
  if (outcome.topOut) return -1e9;
  const f = features(outcome.grid);
  return outcome.linesCleared * 10 - f.height * 0.51 - f.holes * 7.5 - f.bump * 0.18 - (dellacherie ? f.transitions * 0.25 + f.wells * 0.35 : 0);
}
/** A two-ply preview consumes only active and next[0], both publicly disclosed. */
function publicPreview(input: AgentInput): GameState {
  return { ...createGame('public-preview'), board: input.grid.map(row => [...row]), active: { ...input.active }, hold: input.hold, holdUsed: !input.canHold, next: [...input.next], level: input.level, score: input.score, lines: input.lines, pieces: input.pieces, combo: input.combo, backToBack: input.backToBack, tick: input.tick };
}
const random: Brain = { slug: 'random-legal', name: 'Random legal', kind: 'builtin', description: 'Seeded uniform choice over legal placements.', decide(input) {
  let hash = 2166136261; for (const char of input.stateHash) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return answer(input, input.legal[(hash >>> 0) % input.legal.length]);
} };
function heuristic(slug: string, name: string, dellacherie: boolean, search: boolean): Brain {
  return { slug, name, kind: 'builtin', description: search ? 'Two-ply search over the six best first placements using the visible next piece.' : dellacherie ? 'Height, holes, transitions and wells. Inspired by Dellacherie.' : 'One-ply height, holes, bumpiness and line clears.', decide(input) {
    const candidates = input.candidates.map(outcome => ({ outcome, value: evaluate(outcome, dellacherie) })).sort((a, b) => b.value - a.value || a.outcome.placement.x - b.outcome.placement.x || a.outcome.placement.rotation - b.outcome.placement.rotation);
    const ranked = search ? candidates.slice(0, 6) : candidates;
    if (search) {
      const visible = publicPreview(input);
      for (const c of ranked) {
        const next = applyPlacement(visible, c.outcome.placement);
        if (c.outcome.topOut || next.over) continue;
        const follow = legalPlacements(next).map(p => {
          const result = applyPlacement(next, p);
          return evaluate({ grid: result.board, linesCleared: result.lines - input.lines, topOut: result.over && result.pieces < MAX_PIECES }, true);
        });
        c.value = follow.length ? Math.max(...follow) : -1e9;
      }
      ranked.sort((a, b) => b.value - a.value || a.outcome.placement.x - b.outcome.placement.x || a.outcome.placement.rotation - b.outcome.placement.rotation);
    }
    return answer(input, ranked[0]?.outcome.placement);
  } };
}
export const builtInBrains: Brain[] = [random, heuristic('greedy', 'Greedy heuristic', false, false), heuristic('dellacherie', 'Dellacherie-style', true, false), heuristic('search', 'Two-ply search', true, true)];

export const decisionInstructions = 'Choose the candidate that maximises long-term Tetris score. Every candidate includes the resulting board after locking and line clears, linesCleared, scoreDelta and topOut. Boards are 20 rows from top to bottom, each containing 10 cells from left to right: # occupied, . empty. Minimise holes and stack height while clearing lines. Candidate IDs are opaque labels. Select only a listed candidate. Hold is available only when canHold is true.';
/** Identical public decision evidence is sent to both hosted models. */
export function remoteState(input: AgentInput) {
  const rows = (grid: GameState['board']) => grid.map(row => row.map(cell => cell ? '#' : '.').join(''));
  return { ruleset: input.ruleset, active: input.active, hold: input.hold, canHold: input.canHold, next: input.next, level: input.level, score: input.score, lines: input.lines, pieces: input.pieces, combo: input.combo, backToBack: input.backToBack, mode: input.mode, tick: input.tick, grid: rows(input.grid), candidates: input.candidates.map(c => ({ ...c, grid: rows(c.grid) })) };
}
async function post(url: string, body: unknown, key: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://www.lowndes.dev/tetris-bench', 'X-Title': 'Tetris Bench' }, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`Provider request failed (HTTP ${response.status})`);
  return await response.json() as Record<string, unknown>;
}
function usageCost(data: Record<string, unknown>): number | undefined {
  const usage = data.usage as { cost?: unknown } | undefined;
  return typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
}
/** Transport quantisation: renormalise only small rounding drift, never arbitrary scores. */
export function normaliseChoiceProbabilities(probs: Record<string, number>): { probabilities: Record<string, number>; mass: number } | null {
  const values = Object.values(probs);
  if (!values.length || values.some(p => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)) return null;
  const mass = values.reduce((sum,p) => sum+p,0);
  const roundingBound = Math.min(.05, values.length * .005) + 1e-9;
  if (mass <= 0 || Math.abs(mass-1) > roundingBound) return null;
  return { probabilities: Object.fromEntries(Object.entries(probs).map(([id,p]) => [id,p/mass])), mass };
}
export function jevBrain(key = process.env.OPENROUTER_API_KEY): Brain {
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  return { slug: 'jev', name: 'Jev', description: 'Typed Choice and Noul classification through OpenRouter.', kind: 'remote', model: 'typesafe/jev-1.13', async decide(input, { signal }) {
    const criteria = Object.fromEntries(input.candidates.map(c => [c.id, `Choose candidate ${c.id} described in state.candidates.`]));
    const data = await post('https://openrouter.ai/api/v1/systemone', { model: 'typesafe/jev-1.13', state: JSON.stringify(remoteState(input)), questions: { placement: { type: 'choice', instructions: decisionInstructions, criteria }, ...(input.canHold ? { hold: { type: 'noul', instructions: 'Should the active piece be held instead of placed? Return true only if holding improves the position.' } } : {}) } }, key, signal);
    const answers = data.answers as { placement?: { probabilities?: Record<string, number> }; hold?: { noul?: boolean | number } } | undefined;
    const probs = answers?.placement?.probabilities;
    if (!probs || Object.keys(probs).some(id => !input.candidates.some(c => c.id === id))) return null;
    const distribution = normaliseChoiceProbabilities(probs);
    if (!distribution) return { stateHash: input.stateHash, choice: [], costUsd: usageCost(data) };
    const hold = answers?.hold?.noul;
    return { stateHash: input.stateHash, providerProbabilityMass: distribution.mass, choice: Object.entries(distribution.probabilities).map(([id, p]) => ({ ...input.candidates.find(c => c.id === id)!.placement, p })), ...(input.canHold && (typeof hold === 'boolean' || typeof hold === 'number') ? { noul: { hold: typeof hold === 'boolean' ? Number(hold) : hold } } : {}), costUsd: usageCost(data) };
  } };
}
export function openRouterBrain(model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini', key = process.env.OPENROUTER_API_KEY): Brain {
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  return { slug: 'llm-classifier', name: 'LLM classifier', description: 'A general-purpose language model constrained to a typed candidate choice.', kind: 'remote', model, async decide(input, { signal }) {
    const data = await post('https://openrouter.ai/api/v1/chat/completions', { model, temperature: 0, max_tokens: 120, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: `${decisionInstructions} Respond with JSON only: {"candidate":"a listed candidate ID"${input.canHold ? ',"hold":false' : ''}}. One selected candidate is enough. ${input.canHold ? 'Optional hold is a boolean or probability. Return true only if holding improves the position.' : 'Do not request hold.'} Optional risk is a probability of top-out within ten locked pieces. Never include prose. The transport handles the state hash.` }, { role: 'user', content: JSON.stringify(remoteState(input)) }] }, key, signal);
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const parsed = JSON.parse(choices?.[0]?.message?.content ?? 'null') as { candidate?: unknown; hold?: unknown; risk?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = input.candidates.find(c => c.id === parsed.candidate);
    if (!candidate) return null;
    return { stateHash: input.stateHash, choice: [{ ...candidate.placement, p: 1 }], ...(parsed.hold !== undefined ? { noul: { hold: typeof parsed.hold === 'boolean' ? Number(parsed.hold) : parsed.hold } } : {}), ...(parsed.risk !== undefined ? { score: { risk: parsed.risk } } : {}), costUsd: usageCost(data) };
  } };
}
