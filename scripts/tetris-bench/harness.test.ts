import test from 'node:test';
import assert from 'node:assert/strict';
import { runGame, inputFor } from '../../lib/tetris-bench/harness.ts';
import { createGame, stateHash } from '../../lib/tetris-bench/engine.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';
import type { Brain } from '../../lib/tetris-bench/contract.ts';
const brain = (decide: Brain['decide']): Brain => ({ slug: 'test', name: 'Test', kind: 'builtin', description: 'Test', decide });
test('invalid probabilities, duplicate placements, empty choices and stale hashes are rejected', () => {
  const input = inputFor(createGame('test'), 'IQ'); const p = input.legal[0];
  assert.equal(validateAnswer({ stateHash: 'old', choice: [{...p,p:1}] }, input.stateHash, input.legal).status,'stale');
  for (const choice of [[], [{...p,p:NaN}], [{...p,p:.2}], [{...p,p:.5},{...p,p:.5}], [{x:99,rotation:0,p:1}]]) assert.equal(validateAnswer({stateHash:input.stateHash,choice},input.stateHash,input.legal).status,'invalid');
});
test('IQ pauses gravity while a legal answer is pending', async () => {
  const game = await runGame(brain(async input => { await new Promise(r => setTimeout(r, 15)); return {stateHash:input.stateHash,choice:[{...input.legal[0],p:1}]}; }), 'test','IQ',{maxPieces:1,maxTicks:5});
  assert.equal(game.pieces,1); assert.equal(game.metrics.misses,0); assert.equal(game.frames[1].event,'placement');
});
test('Blitz deadlines abort and do not pile up calls that ignore cancellation', async () => {
  let calls=0,aborted=false;
  const game = await runGame(brain((_input,{signal}) => { calls++; signal.addEventListener('abort',()=>{aborted=true;}); return new Promise(()=>{}); }), 'test','Blitz',{maxTicks:3,blitzCapMs:3});
  assert.equal(calls,1); assert.equal(game.metrics.misses,3); assert.equal(aborted,true); assert.equal(game.pieces,0);
});
test('stale answer never moves the piece', async () => {
  const game=await runGame(brain(input=>({stateHash:'stale',choice:[{...input.legal[0],p:1}]})),'test','IQ',{maxTicks:2});
  assert.equal(game.metrics.stale,2); assert.equal(game.pieces,0);
});
test('adapter mutation cannot alter authoritative input or replay', async()=>{
  const initial=createGame('test');
  const game=await runGame(brain(input=>{input.grid[19][0]='I';input.active.y=19;return null;}),'test','IQ',{maxTicks:1});
  assert.equal(stateHash(game.frames[0].state),stateHash(initial));
  assert.equal(game.frames[1].state.board[19][0],null);
});
test('a missing remote cost remains unknown when a later call has a cost',async()=>{
  let call=0;
  const remote={...brain(input=>({stateHash:input.stateHash,choice:[{...input.legal[0],p:1}],...(call++?{costUsd:.1}:{})})),kind:'remote' as const};
  const game=await runGame(remote,'test','IQ',{maxPieces:2});
  assert.equal(game.metrics.costUsd,null);
});
test('misses are not reported as successful model latency',async()=>{
  const game=await runGame(brain(()=>new Promise(()=>{})),'test','Blitz',{maxTicks:2,blitzCapMs:2});
  assert.equal(game.metrics.p50Ms,null);assert.equal(game.metrics.p95Ms,null);assert.equal(game.metrics.calls,1);
});
test('public candidate outcomes deduplicate physical O placements and disclose hold/scoring state', () => {
  const state = createGame('test'); state.active = { type:'O',x:3,y:-1,rotation:0 }; state.holdUsed = true;
  state.combo=2; state.backToBack=true;
  const input = inputFor(state,'IQ');
  assert.equal(input.candidates.length,9); assert.equal(input.legal.length,9);
  assert.equal(input.canHold,false); assert.equal(input.combo,2); assert.equal(input.backToBack,true);
  assert.equal(validateAnswer({stateHash:input.stateHash,choice:[{...input.legal[0],p:1}],noul:{hold:1}},input.stateHash,input.legal,input.canHold).status,'invalid');
  assert.deepEqual(input,inputFor(state,'IQ'));
});
test('input, ordering and hashes do not disclose the hidden bag or RNG',()=>{
  const a=createGame('test'),b=structuredClone(a); b.rng=42;b.bag=['I','T'];b.seed='secret';
  assert.deepEqual(inputFor(a,'IQ'),inputFor(b,'IQ'));
});
test('three unusable IQ answers end an adapter failure instead of inflating game calls',async()=>{
  const game=await runGame(brain(()=>null),'test','IQ');
  assert.equal(game.outcome,'adapter-failure');assert.equal(game.metrics.calls,3);assert.equal(game.pieces,0);
});
test('sync calls over the deadline remain measured but cannot act',async()=>{
  const game=await runGame(brain(input=>{const start=performance.now();while(performance.now()-start<8){};return {stateHash:input.stateHash,choice:[{...input.legal[0],p:1}]};}),'test','Blitz',{maxTicks:1,blitzCapMs:2});
  assert.equal(game.metrics.completedCalls,1);assert.equal(game.metrics.timedOutCalls,1);assert.ok((game.metrics.p50Ms??0)>=8);assert.equal(game.pieces,0);
});
test('adapter gets only public input and cancellation context',async()=>{
  const game=await runGame(brain((input,context)=>{assert.deepEqual(Object.keys(context),['signal']);return {stateHash:input.stateHash,choice:[{...input.legal[0],p:1}]};}),'test','IQ',{maxPieces:1});
  assert.equal(game.pieces,1);assert.ok((game.metrics.preparationP50Ms??0)>0);
});
