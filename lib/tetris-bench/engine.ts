/**
 * Frozen deterministic game rules for Tetris Bench.
 *
 * Every behavioural change to this file requires a ruleset bump and a new
 * source fingerprint in `scripts/tetris-bench/engine.test.ts`. The engine is
 * pure: no function mutates its input, and it must stay free of Node-only
 * imports because the browser re-simulates recordings with it.
 */
export const RULESET = 'tetris-bench@3' as const;
export const WIDTH = 10;
export const HEIGHT = 20;
export const MAX_PIECES = 500;
export const MAX_TICKS = 10_000;

export type Piece = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export type Rotation = 0 | 1 | 2 | 3;
export type Board = (Piece | null)[][];
export type Placement = { x: number; rotation: Rotation };
export type ActivePiece = Placement & { type: Piece; y: number };
export type ClearResult = { lines: number; spin: 'none' | 'mini' | 'full'; points: number };

export type GameState = {
  ruleset: typeof RULESET;
  seed: string;
  board: Board;
  active: ActivePiece;
  next: Piece[];
  hold: Piece | null;
  holdUsed: boolean;
  score: number;
  lines: number;
  level: number;
  tick: number;
  over: boolean;
  pieces: number;
  rng: number;
  bag: Piece[];
  combo: number;
  backToBack: boolean;
  lastClear: ClearResult;
};

const PIECES: Piece[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/** Spawn pictures in the SRS bounding box; rotations are derived by turning the box. */
const SHAPES: Record<Piece, string[]> = {
  I: ['....', 'IIII', '....', '....'],
  O: ['.OO.', '.OO.', '....', '....'],
  T: ['.T.', 'TTT', '...'],
  S: ['.SS', 'SS.', '...'],
  Z: ['ZZ.', '.ZZ', '...'],
  J: ['J..', 'JJJ', '...'],
  L: ['..L', 'LLL', '...'],
};

function normaliseRotation(rotation: number): Rotation {
  return (((rotation % 4) + 4) % 4) as Rotation;
}

function calculateCells(piece: Piece, rotation: number): [number, number][] {
  const shape = SHAPES[piece];
  const size = shape.length;
  const result: [number, number][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < shape[y].length; x++) {
      if (shape[y][x] === '.') continue;
      let cellX = x;
      let cellY = y;
      if (piece !== 'O') {
        for (let turn = 0; turn < normaliseRotation(rotation); turn++) {
          [cellX, cellY] = [size - 1 - cellY, cellX];
        }
      }
      result.push([cellX, cellY]);
    }
  }
  return result;
}

const CELL_TABLE = Object.fromEntries(
  PIECES.map(piece => [piece, [0, 1, 2, 3].map(rotation => calculateCells(piece, rotation))]),
) as Record<Piece, [number, number][][]>;

/** Cells of a piece in its bounding box (screen coordinates, y down). */
export function cells(piece: Piece, rotation: number): [number, number][] {
  return CELL_TABLE[piece][normaliseRotation(rotation)].map(([x, y]) => [x, y]);
}

/** FNV-1a over a string, used for seeding and for the state hash. */
function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

function seedNumber(seed: string): number {
  return fnv1a(seed) || 1;
}

/** xorshift32 step on the state's RNG; returns a float in [0, 1). */
function random(s: GameState): number {
  let x = s.rng;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.rng = x >>> 0;
  return s.rng / 4294967296;
}

/** Seven-bag draw with an unbiased Fisher-Yates shuffle. */
function draw(s: GameState): Piece {
  if (s.bag.length === 0) {
    s.bag = [...PIECES];
    for (let i = 6; i > 0; i--) {
      const j = Math.floor(random(s) * (i + 1));
      [s.bag[i], s.bag[j]] = [s.bag[j], s.bag[i]];
    }
  }
  return s.bag.shift()!;
}

function copy(s: GameState): GameState {
  return {
    ...s,
    board: s.board.map(row => [...row]),
    active: { ...s.active },
    next: [...s.next],
    bag: [...s.bag],
    lastClear: { ...s.lastClear },
  };
}

function emptyBoard(): Board {
  return Array.from({ length: HEIGHT }, () => Array<Piece | null>(WIDTH).fill(null));
}

/** True when every cell of the piece is inside the walls and not on a settled block. Rows above the board (y < 0) are free. */
export function fits(s: GameState, p: ActivePiece): boolean {
  return CELL_TABLE[p.type][p.rotation].every(([dx, dy]) => {
    const x = p.x + dx;
    const y = p.y + dy;
    if (x < 0 || x >= WIDTH || y < -4 || y >= HEIGHT) return false;
    return y < 0 || s.board[y][x] === null;
  });
}

function spawn(s: GameState, type?: Piece): void {
  const next = type ?? s.next.shift()!;
  if (!type) s.next.push(draw(s));
  s.active = { type: next, x: 3, y: -1, rotation: 0 };
  s.holdUsed = false;
  if (!fits(s, s.active)) s.over = true;
}

export function createGame(seed: string): GameState {
  const s: GameState = {
    ruleset: RULESET,
    seed,
    board: emptyBoard(),
    active: { type: 'I', x: 3, y: -1, rotation: 0 },
    next: [],
    hold: null,
    holdUsed: false,
    score: 0,
    lines: 0,
    level: 1,
    tick: 0,
    over: false,
    pieces: 0,
    rng: seedNumber(seed),
    bag: [],
    combo: -1,
    backToBack: false,
    lastClear: { lines: 0, spin: 'none', points: 0 },
  };
  s.next = Array.from({ length: 6 }, () => draw(s));
  const first = s.next.shift()!;
  spawn(s, first);
  return s;
}

// SRS kick offsets use Cartesian y (positive upward); `rotate` flips the sign.
const JLSTZ_KICKS: Record<string, number[][]> = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const I_KICKS: Record<string, number[][]> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

/** Rotate a piece using the ordered SRS kicks; returns the first fitting position and the kick index used. */
export function rotate(s: GameState, p: ActivePiece, direction: -1 | 1): { piece: ActivePiece; kick: number } | null {
  const rotation = normaliseRotation(p.rotation + direction);
  const table = p.type === 'I' ? I_KICKS : JLSTZ_KICKS;
  const offsets = p.type === 'O' ? [[0, 0]] : table[`${p.rotation}>${rotation}`];
  for (let kick = 0; kick < offsets.length; kick++) {
    const [dx, dy] = offsets[kick];
    const piece: ActivePiece = { ...p, rotation, x: p.x + dx, y: p.y - dy };
    if (fits(s, piece)) return { piece, kick };
  }
  return null;
}

type Reachable = { piece: ActivePiece; rotated: boolean; kick: number };

/**
 * Breadth-first search over horizontal moves and rotations at the piece's
 * current height. The first path to each (x, rotation) is canonical; its
 * last move (`rotated`) and kick decide T-spin credit after the hard drop.
 */
function reachable(s: GameState): Reachable[] {
  if (s.over) return [];
  const queue: Reachable[] = [{ piece: s.active, rotated: false, kick: 0 }];
  const seen = new Set<string>();
  const placements = new Set<string>();
  const results: Reachable[] = [];
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    const p = entry.piece;
    const key = `${p.x},${p.y},${p.rotation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const placementKey = `${p.x},${p.rotation}`;
    if (!placements.has(placementKey)) {
      results.push(entry);
      placements.add(placementKey);
    }
    for (const dx of [-1, 1]) {
      const moved = { ...p, x: p.x + dx };
      if (fits(s, moved)) queue.push({ piece: moved, rotated: false, kick: 0 });
    }
    for (const direction of [1, -1] as const) {
      const turned = rotate(s, p, direction);
      if (turned) queue.push({ piece: turned.piece, rotated: true, kick: turned.kick });
    }
  }
  return results;
}

export function legalPlacements(s: GameState): Placement[] {
  return reachable(s).map(({ piece }) => ({ x: piece.x, rotation: piece.rotation }));
}

function tSpinKind(s: GameState, rotated: boolean, kick: number, dropDistance: number): ClearResult['spin'] {
  const p = s.active;
  // Guideline rule: the rotation must be the last movement before the lock, so any hard drop cancels the spin.
  if (p.type !== 'T' || !rotated || dropDistance !== 0) return 'none';
  const occupied = (dx: number, dy: number): boolean => {
    const x = p.x + dx;
    const y = p.y + dy;
    return x < 0 || x >= WIDTH || y >= HEIGHT || (y >= 0 && s.board[y][x] !== null);
  };
  const corners = [[0, 0], [2, 0], [2, 2], [0, 2]].map(([x, y]) => occupied(x, y));
  if (corners.filter(Boolean).length < 3) return 'none';
  const front = [[0, 1], [1, 2], [2, 3], [3, 0]][p.rotation];
  const frontCornersFilled = corners[front[0]] && corners[front[1]];
  return frontCornersFilled || kick === 4 ? 'full' : 'mini';
}

/** Lock the active piece where it is, score the result and spawn the next piece. */
function lock(s: GameState, rotated: boolean, kick: number, dropDistance: number): void {
  const p = s.active;
  let spin = tSpinKind(s, rotated, kick, dropDistance);
  const blocks = cells(p.type, p.rotation).map(([x, y]) => [x + p.x, y + p.y]);

  if (blocks.some(([, y]) => y < 0)) {
    // Lock-out: the visible part of the fatal piece is recorded so replays show it; nothing is scored.
    for (const [x, y] of blocks) {
      if (y >= 0) s.board[y][x] = p.type;
    }
    s.lastClear = { lines: 0, spin: 'none', points: 0 };
    s.over = true;
    return;
  }

  for (const [x, y] of blocks) s.board[y][x] = p.type;
  const remaining = s.board.filter(row => row.some(cell => cell === null));
  const cleared = HEIGHT - remaining.length;
  s.board = [...Array.from({ length: cleared }, () => Array<Piece | null>(WIDTH).fill(null)), ...remaining];

  // A mini that clears two lines is promoted to a full T-spin double (the Guideline has no mini double).
  if (spin === 'mini' && cleared >= 2) spin = 'full';
  const base = spin === 'full'
    ? [400, 800, 1200, 1600][cleared]
    : spin === 'mini'
      ? [100, 200, 400][cleared]
      : [0, 100, 300, 500, 800][cleared];
  const difficult = cleared > 0 && (cleared === 4 || spin !== 'none');
  let points = base * s.level * (difficult && s.backToBack ? 1.5 : 1);
  const perfectClear = cleared > 0 && remaining.every(row => row.every(cell => cell === null));
  if (perfectClear) {
    const bonus = cleared === 4 && s.backToBack ? 3200 : [0, 800, 1200, 1800, 2000][cleared];
    points += bonus * s.level;
  }
  s.combo = cleared > 0 ? s.combo + 1 : -1;
  if (cleared > 0) {
    points += 50 * s.combo * s.level;
    s.backToBack = difficult;
  }
  s.score += points;
  s.lines += cleared;
  s.level = 1 + Math.floor(s.lines / 10);
  s.lastClear = { lines: cleared, spin, points };
  s.pieces++;
  if (s.pieces >= MAX_PIECES) s.over = true;
  if (!s.over) spawn(s);
}

/** Resolve a placement along its canonical path and hard-drop it; null when the placement is not reachable. */
export function simulatePlacement(state: GameState, placement: Placement): { state: GameState; dropDistance: number } | null {
  const entry = reachable(state).find(({ piece }) => piece.x === placement.x && piece.rotation === placement.rotation);
  if (!entry) return null;
  const s = copy(state);
  s.active = { ...entry.piece };
  let dropDistance = 0;
  while (fits(s, { ...s.active, y: s.active.y + 1 })) {
    s.active.y++;
    dropDistance++;
  }
  s.score += dropDistance * 2;
  lock(s, entry.rotated, entry.kick, dropDistance);
  return { state: s, dropDistance };
}

/** Apply a placement; an unreachable placement returns the input state unchanged. */
export function applyPlacement(state: GameState, placement: Placement): GameState {
  return simulatePlacement(state, placement)?.state ?? state;
}

/** Rows the canonical piece falls before locking; -1 when the placement is not reachable. */
export function dropDistance(state: GameState, placement: Placement): number {
  return simulatePlacement(state, placement)?.dropDistance ?? -1;
}

export function applyHold(state: GameState): GameState {
  if (state.over || state.holdUsed) return state;
  const s = copy(state);
  const previouslyHeld = s.hold;
  s.hold = s.active.type;
  spawn(s, previouslyHeld ?? undefined);
  s.holdUsed = true;
  return s;
}

/** One gravity step without touching the tick counter: the piece falls one row or locks where it rests. */
export function stepGravity(state: GameState): GameState {
  if (state.over) return state;
  const s = copy(state);
  if (fits(s, { ...s.active, y: s.active.y + 1 })) {
    s.active.y++;
  } else {
    lock(s, false, 0, 0);
  }
  return s;
}

/** A gravity step that also consumes a tick. Caps are the harness's responsibility. */
export function advanceGravity(state: GameState): GameState {
  if (state.over) return state;
  const s = stepGravity(state);
  return { ...s, tick: s.tick + 1 };
}

/** Stable transport hash over everything that can change a decision; hidden RNG and bag are excluded. */
export function stateHash(s: GameState): string {
  const value = JSON.stringify([
    s.ruleset,
    s.board,
    [s.active.type, s.active.x, s.active.y, s.active.rotation],
    s.hold,
    s.next,
    s.level,
    s.score,
    s.tick,
    s.holdUsed,
    s.over,
    s.lines,
    s.pieces,
    s.combo,
    s.backToBack,
  ]);
  return seedNumber(value).toString(16).padStart(8, '0');
}

export function gravityIntervalMs(s: Pick<GameState, 'level'>): number {
  return Math.max(16, Math.round(1000 * Math.pow(0.8, s.level - 1)));
}
