import test from 'node:test';
import assert from 'node:assert/strict';
import { elo, matchPoint, rateField, OFFICIAL_SEEDS } from '../../lib/tetris-bench/rating.ts';
import type { GameResult } from '../../lib/tetris-bench/contract.ts';
test('Elo conserves points and weights modes equally',()=>{
  assert.deepEqual(elo(1500,1500,1),[1516,1484]); assert.equal(matchPoint(4,4),.5);
  const games = ['a','b'].flatMap(brain=>(['IQ','Blitz'] as const).map(mode=>({brain,mode,seed:'seed-01',score:(brain==='a')===(mode==='IQ')?100:0} as GameResult)));
  const result=rateField(['b','a'],['seed-01'],games);
  assert.equal(result.matches[0].point,.5); assert.deepEqual(result.ratings,{a:1500,b:1500});
  assert.deepEqual(OFFICIAL_SEEDS,['seed-01','seed-02','seed-03','seed-04','seed-05']);
});
test('incomplete field cannot get a rating',()=>assert.throws(()=>rateField(['a','b'],['seed-01'],[]),/every seed/));
