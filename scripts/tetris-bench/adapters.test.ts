import test from 'node:test';
import assert from 'node:assert/strict';
import { builtInBrains, jevBrain, openRouterBrain, remoteState, decisionInstructions } from '../../lib/tetris-bench/adapters.ts';
import { applyHold, createGame } from '../../lib/tetris-bench/engine.ts';
import { inputFor } from '../../lib/tetris-bench/harness.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';

test('Jev maps every returned candidate ID to its actual placement, independently of order', async () => {
  const previous = globalThis.fetch;
  const input=inputFor(createGame('test'),'IQ');
  const signal=new AbortController().signal;
  let selected=0;
  globalThis.fetch=async (url,init)=>{
    assert.equal(url,'https://openrouter.ai/api/v1/systemone');
    assert.equal(init?.signal,signal);
    const body=JSON.parse(String(init?.body));
    assert.equal(body.model,'typesafe/jev-1.13');
    assert.equal(body.questions.placement.instructions,decisionInstructions);
    assert.equal(body.questions.hold.type,'noul');
    assert.deepEqual(JSON.parse(body.state),remoteState(input));
    const id=input.candidates[selected].id;
    assert.ok(body.questions.placement.criteria[id]);
    return new Response(JSON.stringify({answers:{placement:{type:'choice',choice:id,probabilities:{[id]:1}},hold:{type:'noul',noul:.2}},usage:{cost:.000013}}));
  };
  try {
    for(selected=0;selected<input.candidates.length;selected++) {
      const raw=await jevBrain('test-key').decide(input,{signal});
      const checked=validateAnswer(raw,input.stateHash,input.legal,input.canHold);
      assert.equal(checked.status,'ok');
      if(checked.status==='ok') { assert.equal(checked.answer.costUsd,.000013); assert.equal(checked.hold,false); assert.deepEqual(checked.placement,input.candidates[selected].placement); }
      assert.ok(!JSON.stringify(raw).includes('test-key'));
    }
    input.candidates.reverse(); selected=2;
    const checked=validateAnswer(await jevBrain('test-key').decide(input,{signal}),input.stateHash,input.legal,input.canHold);
    assert.equal(checked.status,'ok');
    if(checked.status==='ok') assert.deepEqual(checked.placement,input.candidates[selected].placement);
  } finally { globalThis.fetch=previous; }
});

test('both hosted models receive identical compact evidence and transport-bound state hash',async()=>{
  const previous=globalThis.fetch;const input=inputFor(createGame('test'),'IQ');
  const bodies: Record<string,unknown>[]=[];
  globalThis.fetch=async(url,init)=>{
    const body=JSON.parse(String(init?.body));bodies.push(body);
    return String(url).endsWith('/systemone')
      ? new Response(JSON.stringify({answers:{placement:{probabilities:{[input.candidates[1].id]:1}}}}))
      : new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({candidate:input.candidates[1].id,stateHash:'not-a-transport-field'})}}],usage:{cost:.002}}));
  };
  try {
    await jevBrain('test-key').decide(input,{signal:new AbortController().signal});
    const raw=await openRouterBrain('openai/gpt-4o-mini','test-key').decide(input,{signal:new AbortController().signal});
    const checked=validateAnswer(raw,input.stateHash,input.legal,input.canHold);
    assert.equal(checked.status,'ok');
    if(checked.status==='ok') { assert.equal(checked.answer.costUsd,.002); assert.deepEqual(checked.placement,input.candidates[1].placement); }
    const jevState=JSON.parse(bodies[0].state as string);
    const llmState=JSON.parse((bodies[1].messages as Array<{content:string}>)[1].content);
    assert.deepEqual(jevState,llmState);
    assert.equal(jevState.stateHash,undefined);
    assert.equal(jevState.grid.length,20);
    assert.ok(jevState.grid.every((row:string)=>/^[.#]{10}$/.test(row)));
  }finally{globalThis.fetch=previous;}
});

test('hold legality is visible and repeated holds are rejected',async()=>{
  const previous=globalThis.fetch;const input=inputFor(applyHold(createGame('test')),'IQ');
  assert.equal(input.canHold,false);
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    assert.equal(body.questions.hold,undefined);
    return new Response(JSON.stringify({answers:{placement:{probabilities:{[input.candidates[0].id]:1}}}}));
  };
  try {
    const raw=await jevBrain('test-key').decide(input,{signal:new AbortController().signal});
    assert.equal(validateAnswer(raw,input.stateHash,input.legal,input.canHold).status,'ok');
    assert.equal(validateAnswer({stateHash:input.stateHash,choice:[{...input.legal[0],p:1}],noul:{hold:1}},input.stateHash,input.legal,input.canHold).status,'invalid');
  }finally{globalThis.fetch=previous;}
});

test('all built-in brains decide using only the public input and an abort signal',async()=>{
  const input=inputFor(createGame('test'),'IQ');
  for(const brain of builtInBrains) {
    const raw=await brain.decide(structuredClone(input),{signal:new AbortController().signal});
    assert.equal(validateAnswer(raw,input.stateHash,input.legal,input.canHold).status,'ok',brain.slug);
  }
});

test('Jev transport rounding preserves argmax without accepting arbitrary scores',async()=>{
  const { normaliseChoiceProbabilities } = await import('../../lib/tetris-bench/adapters.ts');
  const rounded = normaliseChoiceProbabilities({p0:.55,p1:.3,p2:.14});
  assert.ok(rounded);assert.ok(Math.abs(Object.values(rounded.probabilities).reduce((s,p)=>s+p,0)-1)<1e-12);
  assert.ok(rounded.probabilities.p0>rounded.probabilities.p1);assert.ok(Math.abs(rounded.mass-.99)<1e-12);
  const invalidCases: Record<string, number>[] = [{p0:0},{p0:NaN},{p0:1.1},{p0:.6,p1:.6},{p0:.7,p1:.1}];
  for(const invalid of invalidCases) assert.equal(normaliseChoiceProbabilities(invalid),null);
});
