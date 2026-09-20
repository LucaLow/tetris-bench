import { applyPlacement, legalPlacements } from './engine.ts';
import type { GameState, Placement } from './engine.ts';
import type { AgentAnswer, AgentInput, Brain } from './contract.ts';

function answer(input: AgentInput, placement: Placement | undefined): AgentAnswer {
  return { stateHash: input.stateHash, choice: placement ? [{ ...placement, p: 1 }] : [], costUsd: 0 };
}
function features(state: GameState) {
  const heights = Array.from({ length: 10 }, (_, x) => { const y = state.board.findIndex(r => r[x]); return y < 0 ? 0 : 20 - y; });
  let holes = 0, transitions = 0, wells = 0;
  for (let x = 0; x < 10; x++) {
    for (let y = 20 - heights[x]; y < 20; y++) if (!state.board[y][x]) holes++;
    wells += Math.max(0, Math.min(x ? heights[x - 1] : 20, x < 9 ? heights[x + 1] : 20) - heights[x]);
  }
  for (const row of state.board) { let previous = true; for (const cell of row) { if (!!cell !== previous) transitions++; previous = !!cell; } if (!previous) transitions++; }
  return { height: heights.reduce((a, b) => a + b, 0), holes, transitions, wells, bump: heights.slice(1).reduce((sum, h, i) => sum + Math.abs(h - heights[i]), 0) };
}
function evaluate(state: GameState, base: GameState, dellacherie = false) {
  if (state.over) return -1e9;
  const f = features(state);
  return (state.lines - base.lines) * 10 - f.height * 0.51 - f.holes * 7.5 - f.bump * 0.18 - (dellacherie ? f.transitions * 0.25 + f.wells * 0.35 : 0);
}
const random: Brain = { slug: 'random-legal', name: 'Random legal', kind: 'builtin', description: 'Seeded uniform choice over legal placements.', decide(input) {
  let hash = 2166136261; for (const char of input.stateHash) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return answer(input, input.legal[(hash >>> 0) % input.legal.length]);
} };
function heuristic(slug: string, name: string, dellacherie: boolean, search: boolean): Brain {
  return { slug, name, kind: 'builtin', description: search ? 'Two-ply search over the six best first placements.' : dellacherie ? 'Height, holes, transitions and wells. Inspired by Dellacherie.' : 'One-ply height, holes, bumpiness and line clears.', decide(input, { state }) {
    const candidates = input.legal.map(p => { const next = applyPlacement(state, p); return { p, next, value: evaluate(next, state, dellacherie) }; }).sort((a, b) => b.value - a.value || a.p.x - b.p.x || a.p.rotation - b.p.rotation);
    if (search) for (const c of candidates.slice(0, 6)) {
      const follow = legalPlacmentsSafe(c.next).map(p => evaluate(applyPlacement(c.next, p), state, true));
      c.value = follow.length ? Math.max(...follow) : -1e9;
    }
    const ranked = search ? candidates.slice(0, 6).sort((a, b) => b.value - a.value || a.p.x - b.p.x || a.p.rotation - b.p.rotation) : candidates;
    return answer(input, ranked[0]?.p);
  } };
}
function legalPlacmentsSafe(state: GameState) { return state.over ? [] : legalPlacements(state); }
export const builtInBrains: Brain[] = [random, heuristic('greedy', 'Greedy heuristic', false, false), heuristic('dellacherie', 'Dellacherie-style', true, false), heuristic('search', 'Two-ply search', true, true)];

const instructions = 'Select the legal hard-drop placement that maximises long-term Tetris score. Minimise holes and stack height. Return probabilities for the listed choices only.';
async function post(url: string, body: unknown, key: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://www.lowndes.dev/tetris-bench', 'X-Title': 'Tetris Bench' }, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`Provider request failed (HTTP ${response.status})`);
  return await response.json() as Record<string, unknown>;
}
function usageCost(data: Record<string, unknown>): number | undefined {
  const usage = data.usage as { cost?: unknown } | undefined;
  return typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
}
export function jevBrain(key = process.env.OPENROUTER_API_KEY): Brain {
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  return { slug: 'jev', name: 'Jev', description: 'Typed Choice and Noul classification through OpenRouter.', kind: 'remote', model: 'typesafe/jev-1.13', async decide(input, { signal }) {
    const criteria = Object.fromEntries(input.legal.map((p, i) => [`p${i}`, `x=${p.x}, rotation=${p.rotation}`]));
    const data = await post('https://openrouter.ai/api/v1/systemone', { model: 'typesafe/jev-1.13', state: JSON.stringify(input), questions: { placement: { type: 'choice', instructions, criteria }, hold: { type: 'noul', instructions: 'Should the active piece be held instead of placed this tick? Return true only if holding improves the position.' } } }, key, signal);
    const answers = data.answers as { placement?: { probabilities?: Record<string, number> }; hold?: { noul?: boolean | number } } | undefined;
    const probs = answers?.placement?.probabilities;
    if (!probs || Object.keys(probs).some(k => !/^p\d+$/.test(k) || !input.legal[Number(k.slice(1))])) return null;
    const hold = answers?.hold?.noul;
    return { stateHash: input.stateHash, choice: Object.entries(probs).map(([id, p]) => ({ ...input.legal[Number(id.slice(1))], p })), ...(typeof hold === 'boolean' || typeof hold === 'number' ? { noul: { hold: typeof hold === 'boolean' ? Number(hold) : hold } } : {}), costUsd: usageCost(data) };
  } };
}
export function openRouterBrain(model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini', key = process.env.OPENROUTER_API_KEY): Brain {
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  return { slug: 'llm-classifier', name: 'LLM classifier', description: 'A general-purpose language model constrained to a typed placement distribution.', kind: 'remote', model, async decide(input, { signal }) {
    const data = await post('https://openrouter.ai/api/v1/chat/completions', { model, temperature: 0, max_tokens: 400, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: `${instructions} Respond with JSON only: {"stateHash":"copied input hash","choice":[{"x":0,"rotation":0,"p":1}]}. Probabilities must sum to one. Optional noul:{hold:probability}, score:{risk:probability of game ending within ten locked pieces}. Never include prose.` }, { role: 'user', content: JSON.stringify(input) }] }, key, signal);
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const parsed: unknown = JSON.parse(choices?.[0]?.message?.content ?? 'null');
    return parsed && typeof parsed === 'object' ? { ...parsed, costUsd: usageCost(data) } : parsed;
  } };
}
