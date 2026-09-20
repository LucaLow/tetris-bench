/** Frozen deterministic game rules. Behavioural changes require a ruleset bump. */
export const RULESET = 'tetris-bench@1' as const;
export const WIDTH = 10, HEIGHT = 20, MAX_PIECES = 500, MAX_TICKS = 10_000;
export type Piece = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export type Rotation = 0 | 1 | 2 | 3;
export type Placement = { x: number; rotation: Rotation };
export type ActivePiece = Placement & { type: Piece; y: number };
export type ClearResult = { lines: number; spin: 'none' | 'mini' | 'full'; points: number };
export type GameState = {
  ruleset: typeof RULESET; seed: string; board: (Piece | null)[][];
  active: ActivePiece; next: Piece[]; hold: Piece | null; holdUsed: boolean;
  score: number; lines: number; level: number; tick: number; over: boolean;
  pieces: number; rng: number; bag: Piece[]; combo: number; backToBack: boolean;
  lastClear: ClearResult;
};
const PIECES: Piece[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const SHAPES: Record<Piece, string[]> = {
  I: ['....', 'IIII', '....', '....'], O: ['.OO.', '.OO.', '....', '....'],
  T: ['.T.', 'TTT', '...'], S: ['.SS', 'SS.', '...'],
  Z: ['ZZ.', '.ZZ', '...'], J: ['J..', 'JJJ', '...'], L: ['..L', 'LLL', '...'],
};
function calculateCells(piece: Piece, rotation: number): [number, number][] {
  const shape = SHAPES[piece];
  return shape.flatMap((row, y) => [...row].flatMap((c, x) => {
    if (c === '.') return [];
    let a = x, b = y;
    if (piece !== 'O') for (let r = 0; r < ((rotation % 4) + 4) % 4; r++) [a, b] = [shape.length - 1 - b, a];
    return [[a, b] as [number, number]];
  }));
}
function seedNumber(seed: string) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return hash >>> 0 || 1;
}
const CELL_TABLE = Object.fromEntries(PIECES.map(piece => [piece, [0,1,2,3].map(rotation => calculateCells(piece, rotation))])) as Record<Piece, [number, number][][]>;
export function cells(piece: Piece, rotation: number): [number, number][] { return CELL_TABLE[piece][((rotation % 4) + 4) % 4].map(([x,y]) => [x,y]); }
function random(s: GameState) {
  let x = s.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  s.rng = x >>> 0; return s.rng / 4294967296;
}
function draw(s: GameState): Piece {
  if (!s.bag.length) {
    s.bag = [...PIECES];
    for (let i = 6; i > 0; i--) { const j = Math.floor(random(s) * (i + 1)); [s.bag[i], s.bag[j]] = [s.bag[j], s.bag[i]]; }
  }
  return s.bag.shift()!;
}
function copy(s: GameState): GameState { return { ...s, board: s.board.map(row => [...row]), active: { ...s.active }, next: [...s.next], bag: [...s.bag], lastClear: { ...s.lastClear } }; }
export function fits(s: GameState, p: ActivePiece): boolean {
  return CELL_TABLE[p.type][p.rotation].every(([dx, dy]) => {
    const x = p.x + dx, y = p.y + dy;
    return x >= 0 && x < WIDTH && y >= -4 && y < HEIGHT && (y < 0 || s.board[y][x] === null);
  });
}
function spawn(s: GameState, type?: Piece) {
  const next = type ?? s.next.shift()!;
  if (!type) s.next.push(draw(s));
  s.active = { type: next, x: 3, y: -1, rotation: 0 };
  s.holdUsed = false;
  if (!fits(s, s.active)) s.over = true;
}
export function createGame(seed: string): GameState {
  const s: GameState = { ruleset: RULESET, seed, board: Array.from({ length: HEIGHT }, () => Array<Piece | null>(WIDTH).fill(null)), active: { type: 'I', x: 3, y: -1, rotation: 0 }, next: [], hold: null, holdUsed: false, score: 0, lines: 0, level: 1, tick: 0, over: false, pieces: 0, rng: seedNumber(seed), bag: [], combo: -1, backToBack: false, lastClear: { lines: 0, spin: 'none', points: 0 } };
  s.next = Array.from({ length: 6 }, () => draw(s));
  const first = s.next.shift()!; spawn(s, first); return s;
}
// SRS offsets use Cartesian y (positive upward).
const JLSTZ: Record<string, number[][]> = {
  '0>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]], '1>0': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  '1>2': [[0,0],[1,0],[1,-1],[0,2],[1,2]], '2>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '2>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]], '3>2': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '3>0': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]], '0>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
};
const IKICKS: Record<string, number[][]> = {
  '0>1': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]], '1>0': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  '1>2': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]], '2>1': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  '2>3': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]], '3>2': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  '3>0': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]], '0>3': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
};
export function rotate(s: GameState, p: ActivePiece, direction: -1 | 1): { piece: ActivePiece; kick: number } | null {
  const rotation = ((p.rotation + direction + 4) % 4) as Rotation;
  const table = p.type === 'I' ? IKICKS : JLSTZ;
  const offsets = p.type === 'O' ? [[0,0]] : table[`${p.rotation}>${rotation}`];
  for (let kick = 0; kick < offsets.length; kick++) {
    const [dx, dy] = offsets[kick]; const piece = { ...p, rotation, x: p.x + dx, y: p.y - dy };
    if (fits(s, piece)) return { piece, kick };
  }
  return null;
}
type Reachable = { piece: ActivePiece; rotated: boolean; kick: number };
function reachable(s: GameState): Reachable[] {
  if (s.over) return [];
  const queue: Reachable[] = [{ piece: s.active, rotated: false, kick: 0 }];
  const seen = new Set<string>(); const results: Reachable[] = []; const placements = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i], p = entry.piece; const key = `${p.x},${p.y},${p.rotation}`;
    if (seen.has(key)) continue; seen.add(key);
    const placementKey = `${p.x},${p.rotation}`;
    if (!placements.has(placementKey)) { results.push(entry); placements.add(placementKey); }
    for (const dx of [-1, 1]) { const piece = { ...p, x: p.x + dx }; if (fits(s, piece)) queue.push({ piece, rotated: false, kick: 0 }); }
    for (const direction of [1, -1] as const) { const r = rotate(s, p, direction); if (r) queue.push({ piece: r.piece, rotated: true, kick: r.kick }); }
  }
  return results;
}
export function legalPlacements(s: GameState): Placement[] { return reachable(s).map(({ piece }) => ({ x: piece.x, rotation: piece.rotation })); }
function lock(s: GameState, rotated = false, kick = 0) {
  const p = s.active;
  let spin: ClearResult['spin'] = 'none';
  if (p.type === 'T' && rotated) {
    const occupied = (dx: number, dy: number) => { const x = p.x + dx, y = p.y + dy; return x < 0 || x >= WIDTH || y >= HEIGHT || (y >= 0 && s.board[y][x] !== null); };
    const corners = [[0,0],[2,0],[2,2],[0,2]].map(([x,y]) => occupied(x,y));
    if (corners.filter(Boolean).length >= 3) {
      const front = [[0,1],[1,2],[2,3],[3,0]][p.rotation];
      spin = (corners[front[0]] && corners[front[1]]) || kick === 4 ? 'full' : 'mini';
    }
  }
  const blocks = cells(p.type, p.rotation).map(([x,y]) => [x + p.x, y + p.y]);
  if (blocks.some(([,y]) => y < 0)) { s.over = true; return; }
  for (const [x,y] of blocks) s.board[y][x] = p.type;
  const remaining = s.board.filter(row => row.some(cell => cell === null)); const cleared = HEIGHT - remaining.length;
  s.board = [...Array.from({ length: cleared }, () => Array<Piece | null>(WIDTH).fill(null)), ...remaining];
  if (spin === 'mini' && cleared >= 2) spin = 'full';
  const base = spin === 'full' ? [400,800,1200,1600][cleared] : spin === 'mini' ? [100,200,400][cleared] : [0,100,300,500,800][cleared];
  const difficult = cleared > 0 && (cleared === 4 || spin !== 'none');
  let points = base * s.level * (difficult && s.backToBack ? 1.5 : 1);
  if (cleared && remaining.every(row => row.every(cell => cell === null))) points += (cleared === 4 && s.backToBack ? 3200 : [0,800,1200,1800,2000][cleared]) * s.level;
  s.combo = cleared > 0 ? s.combo + 1 : -1;
  if (cleared) { points += 50 * s.combo * s.level; s.backToBack = difficult; }
  s.score += points; s.lines += cleared; s.level = 1 + Math.floor(s.lines / 10);
  s.lastClear = { lines: cleared, spin, points }; s.pieces++;
  if (s.pieces >= MAX_PIECES) s.over = true;
  if (!s.over) spawn(s);
}
export function applyPlacement(state: GameState, placement: Placement): GameState {
  const entry = reachable(state).find(({ piece }) => piece.x === placement.x && piece.rotation === placement.rotation);
  if (!entry) return state;
  const s = copy(state); s.active = { ...entry.piece };
  let distance = 0;
  while (fits(s, { ...s.active, y: s.active.y + 1 })) { s.active.y++; distance++; }
  s.score += distance * 2; lock(s, entry.rotated, entry.kick); return s;
}
export function applyHold(state: GameState): GameState {
  if (state.over || state.holdUsed) return state;
  const s = copy(state), old = s.hold; s.hold = s.active.type;
  spawn(s, old ?? undefined); s.holdUsed = true; return s;
}
export function advanceGravity(state: GameState): GameState {
  if (state.over) return state;
  const s = copy(state); s.tick++;
  if (fits(s, { ...s.active, y: s.active.y + 1 })) s.active.y++;
  else lock(s);
  if (s.tick >= MAX_TICKS) s.over = true;
  return s;
}
/** Stable transport hash covers state that can change a decision. */
export function stateHash(s: GameState): string {
  const value = JSON.stringify([s.ruleset,s.board,s.active,s.hold,s.next,s.level,s.score,s.tick,s.holdUsed,s.over,s.rng,s.bag]);
  return seedNumber(value).toString(16).padStart(8,'0');
}
export function gravityIntervalMs(s: Pick<GameState, 'level'>): number { return Math.max(16, Math.round(1000 * Math.pow(0.8, s.level - 1))); }
