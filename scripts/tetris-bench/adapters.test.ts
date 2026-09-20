import test from 'node:test';
import assert from 'node:assert/strict';
import { jevBrain, openRouterBrain } from '../../lib/tetris-bench/adapters.ts';
import { createGame } from '../../lib/tetris-bench/engine.ts';
import { inputFor } from '../../lib/tetris-bench/harness.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';
test('Jev translates typed System One probability map and usage without exposing credentials', async () => {
  const previous = globalThis.fetch;
  const state=createGame('test'),input=inputFor(state,'IQ');
  const signal=new AbortController().signal;
  globalThis.fetch=async (url,init)=>{
    assert.equal(url,'https://openrouter.ai/api/v1/systemone');
    assert.equal(init?.signal,signal);
    const body=JSON.parse(String(init?.body));
    assert.equal(body.model,'typesafe/jev-1.13');
    assert.equal(body.questions.placement.type,'choice');
    assert.equal(body.questions.hold.type,'noul');
    assert.equal(body.questions.placement.criteria.p0,`x=${input.legal[0].x}, rotation=${input.legal[0].rotation}`);
    return new Response(JSON.stringify({answers:{placement:{type:'choice',choice:'p0',probabilities:{p0:.8,p1:.2}},hold:{type:'noul',noul:false}},usage:{cost:.000013}}));
  };
  try {
    const raw=await jevBrain('test-key').decide(input,{signal,state});
    const checked=validateAnswer(raw,input.stateHash,input.legal);
    assert.equal(checked.status,'ok');
    if(checked.status==='ok') { assert.equal(checked.answer.costUsd,.000013); assert.equal(checked.hold,false); assert.deepEqual(checked.placement,input.legal[0]); }
    assert.ok(!JSON.stringify(raw).includes('test-key'));
  } finally { globalThis.fetch=previous; }
});
test('LLM adapter requires typed JSON and preserves provider cost',async()=>{
  const previous=globalThis.fetch;const state=createGame('test'),input=inputFor(state,'IQ');
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({stateHash:input.stateHash,choice:[{...input.legal[0],p:1}]})}}],usage:{cost:.002}}));
  try { const raw=await openRouterBrain('openai/gpt-4o-mini','test-key').decide(input,{state,signal:new AbortController().signal});assert.equal(validateAnswer(raw,input.stateHash,input.legal).status,'ok'); }finally{globalThis.fetch=previous;}
});
