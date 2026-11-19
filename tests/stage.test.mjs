import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, stageOf, counts, nextInStage } from '../mods/lazuli/core/stage.js';
import {tick,covered,totals} from '../mods/lazuli/core/ledger.js';
import {mapGithub} from '../mods/lazuli/core/gh-map.js';
test('stage precedence and cycling', () => {
 const ok={review:'APPROVED',ci:'SUCCESS',isDraft:false,threads:0};
 assert.deepEqual([...STAGES],['needs','working','ready','done']);
 assert.equal(stageOf({status:'blocked',pr:ok}),'needs');
 assert.equal(stageOf({status:'idle',pr:ok}),'ready');
 assert.equal(stageOf({status:'working',pr:{...ok,review:'CHANGES_REQUESTED'}}),'working');
 assert.equal(stageOf({status:'done',pr:null,subagents:2}),'working');
 for (const pr of [{...ok,ci:'FAILURE'},{...ok,ci:'ERROR'},{...ok,threads:1},{...ok,review:'CHANGES_REQUESTED'}]) assert.equal(stageOf({status:'idle',pr}),'needs');
 assert.equal(stageOf({status:'idle',pr:{...ok,isDraft:true}}),'done');
 assert.equal(stageOf({status:'idle',pr:{...ok,ci:'FAILURE'},snoozedUntil:2000},1000),'done');
 assert.equal(stageOf({status:'idle',pr:{...ok,ci:'FAILURE'},snoozedUntil:2000},3000),'needs');
 const list=[{address:'t1',stage:'needs'},{address:'t2',stage:'done'},{address:'t3',stage:'needs'}];
 assert.equal(nextInStage(list,'needs','t3'),'t1'); assert.equal(nextInStage(list,'working',null),null);
 assert.deepEqual(counts(list),{needs:2,working:0,ready:0,done:1});
});
test('ledger checkpoint and overlapping ticket time contract examples',()=>{
 assert.deepEqual(tick({},[{terminal:'t1',ticket:'ENG-1'}],1000),{open:{t1:{start:1000,ticket:'ENG-1'}},done:[]});
 assert.deepEqual(tick({t1:{start:1000,ticket:'ENG-1'}},[{terminal:'t1',ticket:'ENG-1'}],61000),{open:{t1:{start:61000,ticket:'ENG-1'}},done:[{start:1000,end:61000,ticket:'ENG-1',terminal:'t1'}]});
 assert.equal(covered([[0,10000],[5000,15000],[20000,21000]],0,100000),16); assert.equal(covered([[0,10000]],4000,6000),2);
 const N=new Date(2026,10,4,12,0).getTime(),h=3600000;
 const result=totals([{start:N-2*h,end:N-h,ticket:'ENG-1',terminal:'a'},{start:N-2*h,end:N-h,ticket:'ENG-1',terminal:'b'},{start:N-30*h,end:N-29*h,ticket:'ENG-1',terminal:'a'}],N);
 assert.deepEqual(result.tickets['ENG-1'],{today:3600,week:7200}); assert.equal(result.agents.a,3600); assert.equal(result.days[0],'2026-11-02'); assert.deepEqual(result.week['ENG-1'].slice(1,3),[3600,3600]);
});
test('partial review threads prevent a green approved PR from being ready',()=>{
 const resolved=Array.from({length:50},()=>({isResolved:true}));
 const map=hasNextPage=>mapGithub({mine:{nodes:[{__typename:'PullRequest',reviewDecision:'APPROVED',isDraft:false,reviewThreads:{pageInfo:{hasNextPage},nodes:resolved},commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]}}]}}).mine[0];
 const partial=map(true); assert.equal(partial.threads,0); assert.equal(partial.threadsPartial,true); assert.equal(stageOf({status:'idle',pr:partial}),'done');
 const complete=map(false); assert.equal(complete.threads,0); assert.ok(!Object.hasOwn(complete,'threadsPartial')); assert.equal(stageOf({status:'idle',pr:complete}),'ready');
 assert.equal(stageOf({status:'idle',pr:{...partial,threads:1}}),'needs');
});
