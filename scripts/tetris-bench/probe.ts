/** Diagnostic only. These four fixed questions are not tournament seeds or ratings. */
import { jevBrain, openRouterBrain } from '../../lib/tetris-bench/adapters.ts';
import { createGame } from '../../lib/tetris-bench/engine.ts';
import { inputFor } from '../../lib/tetris-bench/harness.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';
import type { Placement } from '../../lib/tetris-bench/engine.ts';
import type { AgentInput } from '../../lib/tetris-bench/contract.ts';

function fixture(side: 'left' | 'right'): AgentInput {
  const state=createGame(`diagnostic-${side}`);
  state.active={type:'O',rotation:0,x:3,y:-1};
  state.holdUsed=true;
  const gap=side==='left'?0:8;
  for(const y of [18,19]) for(let x=0;x<10;x++) state.board[y][x]=x===gap||x===gap+1?null:'J';
  return inputFor(state,'IQ');
}
if(!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for the diagnostic probe');
const requested=process.argv.find(arg=>arg.startsWith('--brain='))?.slice(8);
const brains=requested==='jev'?[jevBrain()]:requested==='llm-classifier'?[openRouterBrain()]:[jevBrain(),openRouterBrain()];
for(const brain of brains) {
  const results: Array<{ side: string; reversed: boolean; status: string; placement?: Placement; label?: string; probability?: number; latencyMs: number; clearsTwo: boolean; error?: string }> = [];
  for(const side of ['left','right'] as const) for(const reversed of [false,true]) {
    const input=fixture(side);
    if(reversed) input.candidates=[...input.candidates].reverse().map((c,i)=>({...c,id:`p${i}`}));
    const expected=input.candidates.filter(c=>c.linesCleared===2);
    if(expected.length!==1) throw new Error('Probe fixture must have one unique two-line clear');
    const started=performance.now();
    try {
      const raw=await brain.decide(input,{signal:AbortSignal.timeout(10_000)});
      const checked=validateAnswer(raw,input.stateHash,input.legal,input.canHold);
      const placement=checked.status==='ok'?checked.placement:undefined;
      const selected=input.candidates.find(c=>c.placement.x===placement?.x&&c.placement.rotation===placement?.rotation);
      const probability=checked.status==='ok'?checked.answer.choice.find(c=>c.x===placement?.x&&c.rotation===placement?.rotation)?.p:undefined;
      results.push({side,reversed,status:checked.status,placement,label:selected?.id,probability,latencyMs:performance.now()-started,clearsTwo:!!selected&&selected.linesCleared===2});
    }catch(error) {
      // Provider error messages contain status only. Never write request headers or keys.
      results.push({side,reversed,status:'provider-error',error:error instanceof Error?error.message:'Unknown provider failure',latencyMs:performance.now()-started,clearsTwo:false});
    }
  }
  const stableSemanticChoice=['left','right'].every(side=>{
    const pair=results.filter(r=>r.side===side);
    return pair.every(r=>r.status==='ok')&&JSON.stringify(pair[0].placement)===JSON.stringify(pair[1].placement);
  });
  console.log(JSON.stringify({brain:brain.slug,diagnosticOnly:true,stableSemanticChoice,allUniqueClears:results.every(r=>r.clearsTwo),results},null,2));
}
