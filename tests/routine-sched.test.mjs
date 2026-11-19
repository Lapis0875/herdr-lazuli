import {test} from 'node:test'; import assert from 'node:assert/strict';
import {parseRoutine} from '../mods/lazuli/core/routine-file.js'; import {emptyState,round,runNow,requestStop,forget,normalizeState,lead,resign,offerEvents,LEASE_MS,KILL_AFTER_MS,EVENT_GAP_MS} from '../mods/lazuli/core/routine-sched.js';
const L=(y,m,d,h,mi)=>new Date(y,m-1,d,h,mi).getTime(); const R=text=>parseRoutine('r','/r/r.md',text,{home:'/h'}); const S=seen=>({...emptyState(),marks:{r:{seen,fired:0}}});
test('catch-up, missed and interval boundaries',()=>{
 const now=L(2026,10,29,12,0), due=L(2026,10,29,9,0), base=L(2026,10,27,10,0);
 const a=round(S(base),[R('---\nwhen: daily 09:00\n---\nx')],now);
 assert.deepEqual(a.start,[{slug:'r',id:String(now),why:{kind:'schedule',at:due,late:true},event:null}]); assert.equal(a.state.marks.r.fired,due); assert.deepEqual(round(a.state,[R('---\nwhen: daily 09:00\n---\nx')],now+15000).start,[]);
 const b=round(S(base),[R('---\nwhen: daily 09:00\ncatch-up: 60\n---\nx')],now); assert.deepEqual(b.start,[]); assert.deepEqual(b.state.runs.r[0],{id:String(due),started:due,ended:due,ok:false,missed:true,code:null,why:{kind:'schedule',at:due},summary:''}); assert.equal(b.notify[0].kind,'missed');
 const r=R('---\nwhen: every 30m\n---\nx'); assert.deepEqual(round(S(1000),[r],1800999).start,[]); assert.deepEqual(round(S(1000),[r],1801000).start[0].why,{kind:'interval',at:1801000});
 assert.deepEqual(round(S(1000),[R('---\nwhen: every 30m\npaused: true\n---\nx')],1801000).start,[]);
 const fired={...emptyState(),marks:{r:{seen:1000,fired:5000}}}; assert.deepEqual(round(fired,[r],1804999).start,[]); assert.equal(round(fired,[r],1805000).start[0].why.kind,'interval');
});
test('parallel limit and timeout escalation',()=>{
 const routines=['a','b','c','d'].map(slug=>parseRoutine(slug,`/r/${slug}.md`,'---\nwhen: every 30m\n---\nx',{home:'/h'}));
 const state={...emptyState(),marks:Object.fromEntries(routines.map(r=>[r.slug,{seen:1000,fired:0}]))};
 const started=round(state,routines,1801000); assert.equal(started.start.length,3); assert.equal(started.state.queued.length,1);
 const running={...emptyState(),running:{r:{id:'1',started:0,why:{kind:'manual'},event:null,timeout:30}}};
 const timed=round(running,[],1800001); assert.deepEqual(timed.stop,[{slug:'r',id:'1',kill:false}]);
 assert.deepEqual(round(timed.state,[],1810002).stop,[{slug:'r',id:'1',kill:true}]);
});
test('paused queued schedules are dropped while manual runs still start',()=>{
 const mk=p=>['a','b','c','d'].map(s=>parseRoutine(s,`/r/${s}.md`,`---\nwhen: every 30m\n${s==='d'&&p?'paused: true\n':''}---\nx`,{home:'/h'}));
 const st={...emptyState(),marks:Object.fromEntries(['a','b','c','d'].map(s=>[s,{seen:1000,fired:0}]))};
 const r1=round(st,mk(false),1801000);
 assert.deepEqual(r1.start.map(x=>x.slug),['a','b','c']);
 assert.deepEqual(r1.state.queued,[{slug:'d',why:{kind:'interval',at:1801000},event:null}]);
 const r2=round(r1.state,mk(true),1802000,{finished:[{slug:'a',code:0,text:'ok'}]});
 assert.deepEqual(r2.start,[]); assert.deepEqual(r2.state.queued,[]); assert.equal(r2.state.runs.d,undefined);
 assert.deepEqual(round(runNow(r2.state,'d').state,mk(true),1803000).start.map(x=>x.why.kind),['manual']);
});
test('replayed operations never claim a completed occurrence twice',()=>{
 const d9=R('---\nwhen: daily 09:00\n---\nx'), s0={...emptyState(),marks:{r:{seen:L(2026,11,2,12,0),fired:0}}}, t=L(2026,11,3,9,0);
 const a1=round(s0,[d9],t+5000,{owner:'aaaaaa1'});
 const a2=round(a1.state,[d9],t+60000,{owner:'aaaaaa1',finished:[{slug:'r',id:a1.start[0].id,code:0,text:'done'}]});
 assert.deepEqual(round(a2.state,[d9],t+65000,{owner:'bbbbbb1'}).start,[]);
 const stale=normalizeState(a2.state); stale.marks.r.fired=0;
 assert.deepEqual(round(stale,[d9],t+65000,{owner:'bbbbbb1'}).start,[]);
 assert.equal(forget(a2.state,'r').runs.r,undefined);
 const wrong=round(a1.state,[],t+60000,{finished:[{slug:'r',id:'other',code:0}]});
 assert.equal(wrong.state.running.r.id,a1.start[0].id);
});
test('stopped queued runs disappear and unavailable definitions hold then drop',()=>{
 const w={...R('x'),slug:'w'};
 const stopped=requestStop(runNow(emptyState(),'w').state,'w',1);
 assert.ok(!round(stopped.state,[w],2).start.some(x=>x.slug==='w'));
 const u={...R('x'),slug:'u',unavailable:true};
 const held=round(runNow(emptyState(),'u').state,[u],2);
 assert.deepEqual(held.start,[]); assert.ok(held.state.queued.some(x=>x.slug==='u'));
 assert.deepEqual(round(held.state,[],3).state.queued,[]);
});
test('hold retains queued jobs while recording launch failures',()=>{
 const routine=R('x'), base=round(emptyState(),[routine],1).state;
 const queued=runNow(base,'r').state;
 const held=round(queued,[routine],2,{hold:true});
 assert.deepEqual(held.start,[]); assert.ok(held.state.queued.some(job=>job.slug==='r'));
 assert.equal(round(queued,[routine],2).start.length,1);
 const rn=R('---\nnotify: failed\n---\nx'), t=100;
 const s1=round(runNow(base,'r').state,[rn],t,{owner:'aaaaaa'});
 const s2=round(s1.state,[rn],t+1,{owner:'aaaaaa',finished:[{slug:'r',id:s1.start[0].id,code:null,text:'',isError:true,error:'no-folder'}],hold:true});
 assert.equal(s2.state.runs.r[0].error,'no-folder'); assert.deepEqual(s2.start,[]); assert.equal(s2.notify[0].kind,'failed');
});
const J=x=>JSON.parse(JSON.stringify(x));
test('scheduler lease: holder keeps it, others wait for expiry, resign frees it',()=>{
 const l1=lead(emptyState(),'A',1000);
 assert.equal(l1.ok,true); assert.deepEqual(J(l1.state.leader),{owner:'A',until:1000+LEASE_MS});
 const busy=lead(l1.state,'B',2000); assert.equal(busy.ok,false); assert.equal(busy.state.leader.owner,'A');
 const took=lead(l1.state,'B',1000+LEASE_MS+1); assert.equal(took.ok,true); assert.equal(took.state.leader.owner,'B');
 assert.equal(resign(l1.state,'A').leader,undefined);
 assert.equal(resign(l1.state,'B').leader.owner,'A');
});
test('requestStop marks stopping; the leading round signals once, then kills after KILL_AFTER_MS',()=>{
 const routine=R('x');
 const run={...emptyState(),running:{r:{id:'9',started:100,why:{kind:'manual'},event:null,timeout:30}}};
 const asked=requestStop(run,'r',200); assert.equal(asked.state.running.r.stopping,200);
 const r1=round(asked.state,[routine],300); assert.deepEqual(J(r1.stop),[{slug:'r',id:'9',kill:false}]);
 assert.deepEqual(round(r1.state,[routine],400).stop,[]);
 assert.deepEqual(J(round(r1.state,[routine],200+KILL_AFTER_MS+1).stop),[{slug:'r',id:'9',kill:true}]);
});
test('forget keeps a running run as forgotten until it ends, then drops it without a record',()=>{
 const run={...emptyState(),running:{r:{id:'9',started:100,why:{kind:'manual'},event:null,timeout:30}}};
 const f=forget({...run,runs:{r:[{id:'1',started:1}]}},'r',500);
 assert.equal(f.runs.r,undefined); assert.equal(f.running.r.forgotten,true); assert.equal(f.running.r.stopping,500);
 const ended=round(round(f,[],600).state,[],700,{finished:[{slug:'r',id:'9',code:null,text:''}]});
 assert.equal(ended.state.runs.r,undefined); assert.equal(ended.state.running.r,undefined);
 assert.deepEqual(J(ended.drop),[{slug:'r',id:'9'}]); assert.deepEqual(ended.notify,[]);
});
test('lease handover and offered events',()=>{
 const a=lead(emptyState(),'A',1000).state;
 assert.deepEqual(J(lead(a,'B',1000+LEASE_MS+5).state.leaderBefore),{owner:'A',until:1000+LEASE_MS});
 const ev={kind:'approved',key:'https://github.com/a/b/pull/1',title:'t',url:'https://github.com/a/b/pull/1'};
 const s=offerEvents(offerEvents(emptyState(),[ev,ev],100),[ev],200); assert.equal(s.pendingEvents.length,1);
 assert.equal(offerEvents(s,[ev],100+EVENT_GAP_MS).pendingEvents.length,2);
 assert.equal(offerEvents(emptyState(),[{key:'x'}],1).pendingEvents,undefined);
 const W=parseRoutine('w','/r/w.md','---\nwhen: on approved\n---\nx',{home:'/h'});
 const r1=round(s,[W],300); assert.equal(r1.start.length,1); assert.equal(r1.start[0].why.kind,'event'); assert.equal(r1.state.pendingEvents,undefined);
 assert.deepEqual(round(offerEvents(r1.state,[ev],400),[W],500).start,[]);
});
test('events de-duplicate per kind and PR across rounds',()=>{
 const U='https://github.com/a/b/pull/1';
 const W2=parseRoutine('w','/r/w.md','---\nwhen: on any\n---\nx',{home:'/h'});
 const ev={kind:'approved',key:U,title:'t',url:U};
 const r1=round(offerEvents(emptyState(),[ev],1000),[W2],1001); assert.equal(r1.start.length,1);
 const done=round(r1.state,[W2],61000,{finished:[{slug:'w',id:r1.start[0].id,code:0,text:'ok'}]}).state;
 assert.deepEqual(round(offerEvents(done,[ev],1000+11*60000),[W2],1000+11*60000+1).start,[]);
 assert.equal(round(done,[W2],1000+11*60000+2,{events:[{...ev,kind:'ci_failed'}]}).start.length,1);
});
