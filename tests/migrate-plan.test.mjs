import {test} from 'node:test'; import assert from 'node:assert/strict';
import {pinsFrom,queueFrom,plan} from '../mods/lazuli/core/migrate-plan.js';
test('migration filters secrets, translates queue and is idempotent',()=>{
 assert.deepEqual(pinsFrom({spaces:['inbox','terminal','todo',{name:'notes'},'meetings','routines'],token:'sekret'}),['inbox','todo','routines']); assert.equal(pinsFrom({}),null);
 assert.deepEqual(pinsFrom({spaces:['terminal','runbook']}),[]); assert.deepEqual(pinsFrom({spaces:[]}),[]); assert.equal(pinsFrom({spaces:'inbox'}),null);
 assert.deepEqual(queueFrom({version:1,queues:{'app:t3':[{id:'q1-0',text:'a',at:1}],'w1:p2':[{id:'q2-0',text:'b',at:2}]}}),{version:1,queues:{t3:[{id:'q1-0',text:'a',at:1}]}});
 const i={done:false,now:5,home:'/h',appHome:'/h/.config/herdr-app',todo:{exists:true,targetExists:false},routines:{names:[],existing:[]},config:null,queue:{doc:null,targetExists:false},terminals:[{address:'t2',labels:{'lstack-herdr.resume':'X'}}],cacheExists:true,pendingMachines:[]};
 const emptyPins=plan({...i,config:{spaces:['terminal']}});
 assert.ok(emptyPins.steps.some(s=>s.op==='pins'&&Array.isArray(s.pins)&&s.pins.length===0)); assert.equal(emptyPins.counts.pins,0);
 assert.equal(plan({...i,config:{github:{token:'x'}}}).steps.some(s=>s.op==='pins'),false);
 assert.deepEqual(plan(i).steps,[{op:'copy',from:'/h/.config/cockpit/todo.md',to:'/h/.config/herdr-app/data/lazuli/todo.md'},{op:'label',address:'t2',key:'lazuli.resume',value:'X',clear:'lstack-herdr.resume'},{op:'rm',path:'/h/.cache/lstack-herdr'},{op:'marker',to:'/h/.config/herdr-app/data/lazuli/migrated.json',value:{version:1,at:5,counts:{todo:1,routines:0,pins:0,queue:0,labels:1,cache:1},pendingMachines:[]}}]);
 assert.deepEqual(plan({...i,done:true}).steps,[]); assert.equal(plan({...i,todo:{exists:true,targetExists:true}}).steps.some(x=>x.op==='copy'),false); assert.ok(!JSON.stringify(plan({...i,config:{spaces:['todo'],token:'sekret'}})).includes('sekret'));
 const missing={...i,todo:{exists:false,targetExists:false},terminals:[],cacheExists:false};
 assert.equal(plan(missing).steps.some(s=>s.op==='copy'),false);
 const source={...missing,routines:{names:['z.md','.hidden.md','a.md','existing.md'],existing:['existing.md']}};
 assert.deepEqual(plan(source).steps.filter(s=>s.op==='copy'),[
  {op:'copy',from:'/h/.config/cockpit/routines/a.md',to:'/h/.config/herdr-app/data/lazuli/routines/a.md'},
  {op:'copy',from:'/h/.config/cockpit/routines/z.md',to:'/h/.config/herdr-app/data/lazuli/routines/z.md'}]);
});
test('migration strips credentials from persisted resume labels',()=>{
 const record=JSON.stringify({tool:'omp',session:'/s.jsonl',argv:['omp','--api-key','sk-1'],pid:1});
 const input={done:false,now:5,home:'/h',appHome:'/h/.config/herdr-app',todo:{exists:false,targetExists:false},routines:{names:[],existing:[]},config:null,queue:{doc:null,targetExists:false},terminals:[{address:'t2',labels:{'lstack-herdr.resume':record}}],cacheExists:false,pendingMachines:[]};
 const label=plan(input).steps.find(step=>step.op==='label'&&step.address==='t2');
 assert.ok(label); assert.equal(label.key,'lazuli.resume'); assert.ok(!label.value.includes('sk-1')); assert.deepEqual(JSON.parse(label.value).argv,['omp']);
});
