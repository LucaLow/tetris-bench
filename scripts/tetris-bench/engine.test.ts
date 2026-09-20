import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RULESET, advanceGravity, applyHold, applyPlacement, cells, createGame, fits, gravityIntervalMs, legalPlacements, rotate, stateHash, type GameState, type Piece } from '../../lib/tetris-bench/engine.ts';

test('dimensions, five-piece preview, seven-bag, deterministic seed and purity', () => {
  let s = createGame('seed-01'); const original = JSON.stringify(s);
  assert.equal(s.board.length,20); assert.ok(s.board.every(row => row.length === 10)); assert.equal(s.next.length,5);
  assert.deepEqual(s,createGame('seed-01')); assert.notEqual(stateHash(s),stateHash(createGame('seed-02')));
  applyPlacement(s,legalPlacements(s)[0]); assert.equal(JSON.stringify(s),original);
  const sequence: Piece[] = [];
  for (let i = 0; i < 70; i++) {
    sequence.push(s.active.type);
    s = applyPlacement(s,legalPlacements(s)[0]);
    // Clear the board only in this bag test so survival does not censor the stream.
    s.board = Array.from({length:20},()=>Array<Piece|null>(10).fill(null)); s.over=false;
  }
  for (let i = 0; i < sequence.length; i += 7) assert.equal(new Set(sequence.slice(i,i+7)).size,7);
});
test('all piece rotations contain four distinct cells, legal placements lock in bounds', () => {
  for (const type of ['I','O','T','S','Z','J','L'] as const) {
    const s=createGame('shapes'); s.active={type,x:3,y:0,rotation:0};
    for (const rotation of [0,1,2,3]) assert.equal(new Set(cells(type,rotation).map(String)).size,4);
    for (const p of legalPlacements(s)) {
      const next=applyPlacement(s,p); assert.equal(next.pieces,1); assert.equal(next.board.flat().filter(Boolean).length,4);
    }
  }
});
test('hold can be used once per piece, swaps without consuming preview, changes hash',()=>{
  const s=createGame('hold'), held=applyHold(s);
  assert.equal(held.hold,s.active.type); assert.equal(held.active.type,s.next[0]); assert.equal(held.next.length,5);
  assert.equal(applyHold(held),held); assert.notEqual(stateHash(s),stateHash(held));
  const locked=applyPlacement(held,legalPlacements(held)[0]), swapped=applyHold(locked);
  assert.equal(swapped.active.type,s.active.type); assert.deepEqual(swapped.next,locked.next);
});
test('SRS T floor kick and I wall kick use ordered offsets',()=>{
  const s=createGame('kicks');
  const t={type:'T' as const,x:3,y:18,rotation:0 as const}; assert.ok(fits(s,t));
  assert.deepEqual(rotate(s,t,1),{piece:{type:'T',x:2,y:17,rotation:1},kick:2});
  const i={type:'I' as const,x:-2,y:5,rotation:1 as const}; assert.ok(fits(s,i));
  assert.deepEqual(rotate(s,i,-1),{piece:{type:'I',x:0,y:5,rotation:0},kick:1});
});
function tetris(s:GameState):GameState {
  s.board=Array.from({length:20},(_,y)=>Array.from({length:10},(_,x)=>y>=16&&x!==4?'J':null));
  s.board[0][0]='J'; // No perfect-clear bonus.
  s.active={type:'I',x:2,y:0,rotation:1}; return applyPlacement(s,{x:2,rotation:1});
}
test('Tetris scoring, back-to-back, combos and level boundaries',()=>{
  let s=tetris(createGame('score')); assert.deepEqual(s.lastClear,{lines:4,spin:'none',points:800});
  s=tetris(s); assert.equal(s.lastClear.points,1250); assert.equal(s.lines,8);
  s=tetris(s); assert.equal(s.lastClear.points,1300); assert.equal(s.level,2);
  s=tetris(s); assert.equal(s.lastClear.points,2700);
});
test('full T-spin single from reachable rotation scores 800',()=>{
  const s=createGame('spin');
  s.active={type:'T',x:3,y:17,rotation:3};
  for(let x=0;x<10;x++) if(x<3||x>5)s.board[18][x]='J';
  s.board[17][3]='J'; s.board[17][5]='J'; s.board[19][3]='J';
  assert.ok(fits(s,s.active));
  const result=applyPlacement(s,{x:3,rotation:0});
  assert.deepEqual(result.lastClear,{lines:1,spin:'full',points:800});
});
test('perfect clear bonus, gravity, blocked spawn and illegal action',()=>{
  const s=createGame('single'); s.active={type:'I',x:3,y:18,rotation:0};
  for(let x=0;x<10;x++)if(x<3||x>6)s.board[19][x]='J';
  const clear=applyPlacement(s,{x:3,rotation:0}); assert.equal(clear.lastClear.points,900);
  assert.equal(applyPlacement(s,{x:99,rotation:0}),s);
  const falling=advanceGravity(createGame('fall')); assert.equal(falling.tick,1); assert.equal(falling.active.y,0);
  assert.equal(gravityIntervalMs({level:1}),1000); assert.equal(gravityIntervalMs({level:99}),16);
  const blocked=createGame('blocked'); blocked.board[0].fill('J');
  assert.equal(applyHold(blocked).over,true);
});
test('late placement cannot teleport through an occupied wall',()=>{
  const s=createGame('wall'); s.active={type:'O',x:0,y:15,rotation:0};
  for(let y=0;y<20;y++)s.board[y][4]='J';
  assert.ok(legalPlacements(s).every(p=>p.x<=1));
  assert.equal(applyPlacement(s,{x:6,rotation:0}),s);
});
test('frozen seed-01 canonical replay hashes',()=>{
  let s=createGame('seed-01'); const hashes:string[]=[];
  for(let i=0;i<12;i++){
    const choices=legalPlacements(s); s=applyPlacement(s,choices[(i*7)%choices.length]); hashes.push(stateHash(s));
  }
  assert.deepEqual(hashes,['f4e7ba0a','1e956998','524ee9d1','9a7251b4','01d6e90d','166663e4','26876243','8e809c73','b8900579','59f8c29a','d5283122','4cf1111f']);
  assert.equal(s.score,340); assert.equal(s.pieces,12);
});
test('40 deterministic mixed-action games preserve board and stream invariants',()=>{
  for(let seed=0;seed<40;seed++){
    let s=createGame(`stress-${seed}`), twin=createGame(`stress-${seed}`), rng=seed+1;
    for(let step=0;step<400&&!s.over;step++){
      rng=(Math.imul(rng,1664525)+1013904223)>>>0;
      const before=JSON.stringify(s), options=legalPlacements(s), pick=options[rng%options.length];
      const action=(state:GameState)=>rng%5===0?applyHold(state):rng%5===1?advanceGravity(state):applyPlacement(state,pick);
      const next=action(s); twin=action(twin);
      assert.equal(JSON.stringify(s),before,'actions must not mutate their input'); s=next;
      assert.deepEqual(s,twin); assert.equal(stateHash(s),stateHash(twin));
      assert.equal(s.board.length,20); assert.ok(s.board.every(row=>row.length===10));
      assert.ok(s.board.flat().every(cell=>cell===null||'IOTSZJL'.includes(cell)));
      assert.equal(s.board.flat().filter(Boolean).length,4*s.pieces-10*s.lines);
      assert.equal(s.next.length,5); assert.equal(s.level,1+Math.floor(s.lines/10));
      assert.ok(Number.isSafeInteger(s.score)&&s.score>=0); assert.ok(s.bag.length<=7);
      if(!s.over)assert.ok(fits(s,s.active),'live active piece cannot overlap settled cells');
    }
  }
});
test('frozen rules source fingerprint: deliberate version review required to update',()=>{
  assert.equal(RULESET,'tetris-bench@1');
  const source=readFileSync(new URL('../../lib/tetris-bench/engine.ts',import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),'be7365116192d672cf973480237a6219b8a3827b259909c49d2573063e820aa0');
});
