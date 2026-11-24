// The Assistant bridge (plan K3, AT-01's acp-bridge list) against the K9 fake agent
// (tests/fixtures/fake-acp-agent.mjs) and, for wire-level cases the fake has no row for (a 5 MiB burst, a
// 16 MiB line, non-JSON lines, a prompt held without output, a start that fails), a small raw agent written
// into each run's temp folder.
import {describe,it,before,after} from 'node:test'; import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process'; import {mkdtemp,mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises'; import {existsSync} from 'node:fs';
import net from 'node:net'; import {tmpdir,networkInterfaces} from 'node:os'; import {join} from 'node:path'; import {fileURLToPath} from 'node:url';
import * as w from '../mods/lazuli/core/acp-wire.js';

const BRIDGE=fileURLToPath(new URL('../mods/lazuli/bin/acp-bridge.mjs',import.meta.url));
const FAKE=fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs',import.meta.url));
const NODE=process.execPath;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const groupAlive=pgid=>{try{process.kill(-pgid,0);return true;}catch(e){return e.code==='EPERM';}};

// A raw ACP-ish agent: answers initialize (RAW_MODE: exit-before-init, init-error), holds prompts without
// output (logging them to stderr the way Hermes does), answers session/cancel, and on request writes many
// lines, a 5 MiB burst, a line over 16 MiB, non-JSON lines or an agent request. RAW_MODE=ignore-term
// survives SIGTERM.
// RAW_MODE=descendant starts a same-group fixture that survives SIGTERM and exits on a file handshake.
const RAW_AGENT=String.raw`
import readline from 'node:readline'; import {once} from 'node:events'; import {spawn} from 'node:child_process';
const mode=process.env.RAW_MODE||''; if(mode==='exit-before-init'){process.stderr.write('raw: no profile\n');process.exit(3);}
const out=o=>process.stdout.write(JSON.stringify(o)+'\n'); const held=new Map();
process.on('SIGTERM',()=>{if(mode!=='ignore-term')process.exit(0);}); process.on('SIGHUP',()=>{});
const descendantReady=mode==='descendant'?new Promise((resolve,reject)=>{
 const source=[
  "const fs=require('node:fs'),base=process.argv[1];",
  "const mark=(suffix,body)=>{fs.writeFileSync(base+suffix+'.tmp',body);fs.renameSync(base+suffix+'.tmp',base+suffix);};",
  "process.on('SIGTERM',()=>mark('.term','received'));",
  "const poll=setInterval(()=>{if(fs.existsSync(base+'.release')){clearInterval(poll);mark('.exit','self-exit');process.exit(0);}},10);",
  "setTimeout(()=>process.exit(2),8000);",
  "process.stdout.write('ready\\n');",
 ].join('\n');
 const child=spawn(process.execPath,['-e',source,process.env.RAW_DESCENDANT],{stdio:['ignore','pipe','inherit']});
 child.on('error',reject); child.once('exit',code=>reject(new Error('descendant exited before ready: '+code)));
 child.stdout.once('data',resolve);
}):null;
const UNIT=Array.from('한글😀abc-'); const sizeOf=n=>n%1000===999?1048576:n%100===99?32768:n%10===9?2048:60+((n*37)%400);
async function write(s){if(!process.stdout.write(s))await once(process.stdout,'drain');}
async function burst(total){let n=0,written=0;while(written<total){const want=sizeOf(n);const cps=[];let bytes=0;for(let k=n%UNIT.length;bytes<want;k++){const c=UNIT[k%UNIT.length];cps.push(c);bytes+=Buffer.byteLength(c);}
 const text=cps.join('');let sum=0;for(let i=0;i<text.length;i++)sum=(sum+text.charCodeAt(i))%1000000007;
 const l=JSON.stringify({jsonrpc:'2.0',method:'raw/chunk',params:{n,len:text.length,sum,text}})+'\n';written+=Buffer.byteLength(l);n++;await write(l);}
 out({jsonrpc:'2.0',method:'raw/burst-end',params:{count:n,bytes:written}});}
readline.createInterface({input:process.stdin}).on('line',async l=>{const m=JSON.parse(l);
 if(m.method==='initialize'){if(mode==='init-error')return out({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'no provider configured'}});
  if(descendantReady)await descendantReady;
  return out({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'raw',version:'0'},agentCapabilities:{loadSession:true}}});}
 if(m.method==='session/prompt'){const text=m.params.prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  process.stderr.write('2026-11-23 07:20:40 [INFO] acp_adapter.server: Prompt on session '+m.params.sessionId+': '+text.slice(0,100)+'\n');held.set(m.id,m.params.sessionId);return;}
 if(m.method==='session/cancel'){for(const [id,s] of held)if(s===m.params.sessionId){held.delete(id);out({jsonrpc:'2.0',id,result:{stopReason:'cancelled'}});}return;}
 if(m.method==='raw/ask')return out({jsonrpc:'2.0',id:77,method:'session/request_permission',params:{sessionId:'raw-s',toolCall:{toolCallId:'t1'},options:[{optionId:'allow_once',kind:'allow_once',name:'Allow once'}]}});
 if(m.id===77&&m.result)return out({jsonrpc:'2.0',method:'raw/answered',params:m.result});
 if(m.method==='raw/many'){for(let i=1;i<=m.params.count;i++)await write(JSON.stringify({jsonrpc:'2.0',method:'raw/n',params:{i}})+'\n');return out({jsonrpc:'2.0',method:'raw/many-end'});}
 if(m.method==='raw/burst')return burst(m.params.bytes);
 if(m.method==='raw/huge'){const head='{"jsonrpc":"2.0","method":"raw/huge","params":{"pad":"',tail='"}}';await write(head+'x'.repeat(m.params.bytes-head.length-tail.length)+tail+'\n');return out({jsonrpc:'2.0',method:'raw/after-huge'});}
 if(m.method==='raw/junk'){await write('this is not json\n[1,2]\n\n');return out({jsonrpc:'2.0',method:'raw/after-junk'});}
 if(m.id!==undefined&&m.method)return out({jsonrpc:'2.0',id:m.id,result:{echo:m.method}});});
`;

// An agent for the turn replay and its error lines (written by the test, not the shared fake): `session/prompt`
// logs the prompt preview the way Hermes does; `fail …` then writes Hermes's error lines to stderr and, 300 ms later,
// ends the turn with end_turn and no message; `stream` sends two chunks and holds the turn until `test/finish`, which
// sends a third and ends it. `test/other` sends an update of another session; `session/load` replays one history
// chunk before its answer.
const TURN_AGENT=String.raw`
import readline from 'node:readline';
const out=o=>process.stdout.write(JSON.stringify(o)+'\n'); const err=l=>process.stderr.write(l+'\n'); const held=new Map();
const chunk=(sessionId,text)=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);
 if(m.method==='initialize')return out({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'turns',version:'0'},agentCapabilities:{loadSession:true}}});
 if(m.method==='session/load'){chunk(m.params.sessionId,'history');return out({jsonrpc:'2.0',id:m.id,result:{models:{}}});}
 if(m.method==='test/other')return chunk('other','elsewhere');
 if(m.method==='test/finish'){for(const [id,s] of held){chunk(s,'three');out({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});}held.clear();return;}
 if(m.method!=='session/prompt')return;
 const s=m.params.sessionId; const text=m.params.prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n');
 err('2026-11-23 18:09:32 [INFO] acp_adapter.server: Prompt on session '+s+': '+text.slice(0,100));
 err("2026-11-23 18:09:32 [INFO] agent.turn_context: conversation turn: session="+s+" model=m provider=p platform=acp history=0 msg="+JSON.stringify(text.slice(0,80)));
 if(text.startsWith('fail')){
  err('2026-11-23 18:09:33 [WARNING] agent.conversation_loop: API call failed (attempt 1/3) error_type=BadRequestError');
  err("\u274C Non-retryable error (HTTP 400): HTTP 400: The 'm' model is not supported.");
  err('   \u{1F4A1} This type of error will not be fixed by retrying.');
  err("2026-11-23 18:09:33 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 400");
  return setTimeout(()=>out({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}),300);}
 chunk(s,'one'); chunk(s,'two'); held.set(m.id,s); setTimeout(()=>err("\u274C Stream trouble (HTTP 500)"),150);});
`;

let shared; let RAW; let TURNS;
before(async()=>{shared=await mkdtemp(join(tmpdir(),'lazuli-bridge-shared-')); RAW=join(shared,'raw-agent.mjs'); TURNS=join(shared,'turn-agent.mjs'); await writeFile(RAW,RAW_AGENT); await writeFile(TURNS,TURN_AGENT);});
after(async()=>{await rm(shared,{recursive:true,force:true});});

const fakeArgv=profile=>[NODE,FAKE,'-p',profile,'acp'];
const rawArgv=()=>[NODE,RAW];

/** Starts a bridge in a fresh temp folder; resolves once its discovery file is ready or failed. */
async function startBridge({agent,profile='default',idleMin=30,herdrPid=process.pid,env={},prepare,args}={}){
 const dir=await mkdtemp(join(tmpdir(),'lazuli-bridge-')); const run=join(dir,'cache','lazuli','assistant','abcd1234'); const folder=join(dir,'folder'); await mkdir(folder);
 if(prepare) await prepare(run);
 const discovery=join(run,`${profile}.json`), log=join(run,`${profile}.log`);
 const argv=args??['--profile',profile,'--cwd',folder,'--discovery',discovery,'--log',log,'--herdr-pid',String(herdrPid),'--idle-min',String(idleMin),'--agent','--',...(agent??fakeArgv(profile))];
 const proc=spawn(NODE,[BRIDGE,...argv],{env:{...process.env,FAKE_ACP_HOME:join(dir,'fake-home'),...env},stdio:['ignore','ignore','pipe']});
 let stderr=''; proc.stderr.on('data',d=>{stderr+=d;});
 const exited=new Promise(r=>proc.on('exit',(code,signal)=>r({code,signal,at:Date.now()})));
 const b={dir,run,folder,discovery,log,proc,exited,profile,stderr:()=>stderr};
 let done=null; exited.then(x=>{done=x;});
 const end=Date.now()+20000;
 for(;;){
  let d={state:'invalid'}; try{d=w.parseDiscovery(await readFile(discovery,'utf8'));}catch{}
  if(d.state!=='invalid'){b.d=d;b.readyAt=Date.now();break;}
  if(done){b.d={state:'none'};break;}
  if(Date.now()>end) throw new Error(`no discovery in 20 s; stderr: ${stderr}`);
  await sleep(20);
 }
 b.cleanup=async()=>{
  if(b.proc.exitCode===null&&b.proc.signalCode===null){
   b.proc.kill('SIGTERM');
   const timer=setTimeout(()=>{if(b.proc.exitCode===null&&b.proc.signalCode===null)b.proc.kill('SIGKILL');},1000);
   try{await b.exited;}finally{clearTimeout(timer);}
  }
  await rm(dir,{recursive:true,force:true});
 };
 return b;
}

/** A client connection: `next(ms)` gives the next line parsed (null at EOF), `until(pred, ms)` skips to a match. */
function open(port,first){
 const sock=net.connect(port,'127.0.0.1'); const items=[]; let parts=[]; let ended=false; let waiter=null; let error=null;
 const wake=()=>{if(waiter){const f=waiter;waiter=null;f();}};
 sock.on('data',chunk=>{let start=0;for(;;){const i=chunk.indexOf(10,start);if(i<0){if(start<chunk.length)parts.push(chunk.subarray(start));break;}
  const line=Buffer.concat([...parts,chunk.subarray(start,i)]).toString('utf8');parts=[];start=i+1;let v;try{v=JSON.parse(line);}catch{v={unparsed:line};}items.push(v);} wake();});
 sock.on('error',e=>{error=e;ended=true;wake();}); sock.on('close',()=>{ended=true;wake();});
 if(first!==undefined) sock.write(typeof first==='string'?first:JSON.stringify(first)+'\n');
 return {sock,get error(){return error;},get ended(){return ended;},
  async next(ms=5000){const end=Date.now()+ms;while(!items.length){if(ended)return null;const left=end-Date.now();if(left<=0)throw new Error(`no line within ${ms} ms`);await new Promise(r=>{waiter=r;setTimeout(r,left);});}return items.shift();},
  async until(pred,ms=5000){const end=Date.now()+ms;for(;;){const v=await this.next(Math.max(1,end-Date.now()));if(v===null)throw new Error('closed before a match');if(pred(v))return v;}},
  drain(){return items.splice(0);},close(){sock.destroy();}};
}

/** One send connection: the reply and whether the bridge then closed it. */
async function send(b,msg,token=b.d.token){const c=open(b.d.port,w.sendLine(token,msg));const reply=await c.next(5000);const eof=(await c.next(3000))===null;return {reply,eof};}
async function sendOk(b,msg){const r=await send(b,msg);assert.deepEqual(r.reply,{ok:true},JSON.stringify(msg).slice(0,80));assert.ok(r.eof);}
const stream=(b,since=null)=>open(b.d.port,w.streamLine(b.d.token,since,'test'));
async function hello(b,since=null){const s=stream(b,since);const h=await s.next(5000);assert.equal(h.ev,'hello');return [s,h];}
const waitExit=(b,ms)=>Promise.race([b.exited,sleep(ms).then(()=>null)]);
const readLog=async b=>{try{return await readFile(b.log,'utf8');}catch{return '';}};
const isResult=id=>v=>v.msg?.id===id&&('result' in v.msg||'error' in v.msg);
async function fakeSession(b,s,id='t:new'){await sendOk(b,w.sessionNew(id,b.folder));const r=await s.until(isResult(id),15000);assert.ok(r.msg.result?.sessionId,'session/new gives a sessionId');return r.msg.result.sessionId;}
const text=t=>[{type:'text',text:t}];
/** A streamed chunk of that session's turn (not the commands list `session/new` brings). */
const isChunk=sid=>v=>v.msg?.method==='session/update'&&v.msg.params?.sessionId===sid&&/_chunk$/.test(v.msg.params.update?.sessionUpdate??'');
function standIn(){const p=spawn('/bin/sleep',['120'],{stdio:'ignore'});return p;}

describe('acp-bridge',{concurrency:8},()=>{

 it('writes its discovery after initialize: 0600 in a 0700 folder, 127.0.0.1 only, hello with the cached initialize',async()=>{
  const b=await startBridge({prepare:async run=>{await mkdir(run,{recursive:true,mode:0o755});}});
  try{
   const d=b.d; assert.equal(d.state,'ready'); assert.equal(d.pid,b.proc.pid); assert.match(d.token,/^[0-9a-f]{64}$/); assert.equal(d.profile,'default'); assert.equal(d.cwd,b.folder); assert.equal(d.herdrPid,process.pid);
   assert.ok(d.agentPid!==d.pid&&alive(d.agentPid)); assert.ok(groupAlive(d.agentPid),'the agent leads its own process group'); assert.ok(Number.isFinite(d.startedAt));
   const raw=JSON.parse(await readFile(b.discovery,'utf8')); assert.deepEqual(Object.keys(raw).sort(),['agentPid','argv','cwd','herdrPid','pid','port','profile','startedAt','token','version']);
   assert.deepEqual(raw.argv,fakeArgv('default'),'the agent argv, for the reuse rule'); assert.deepEqual(d.argv,fakeArgv('default'));
   assert.equal((await stat(b.run)).mode&0o777,0o700,'an existing 0755 folder is made 0700'); assert.equal((await stat(b.discovery)).mode&0o777,0o600); assert.equal((await stat(b.log)).mode&0o777,0o600);
   // Listening on loopback only.
   const lsof=await new Promise(r=>execFile('lsof',['-nP','-iTCP','-sTCP:LISTEN','-a','-p',String(d.pid)],(e,out)=>r(e?.code==='ENOENT'?null:String(out))));
   if(lsof!==null){assert.match(lsof,new RegExp(`127\\.0\\.0\\.1:${d.port} \\(LISTEN\\)`));assert.doesNotMatch(lsof,new RegExp(`\\*:${d.port}`));}
   const lan=Object.values(networkInterfaces()).flat().find(i=>i&&i.family==='IPv4'&&!i.internal);
   if(lan){const err=await new Promise(r=>{const s=net.connect(d.port,lan.address);s.on('connect',()=>{s.destroy();r(null);});s.on('error',r);});assert.ok(err,`connecting through ${lan.address} must fail`);}
   const [s1,h1]=await hello(b); assert.equal(h1.seq,0); assert.equal(h1.bridge.pid,d.pid); assert.equal(h1.bridge.agentPid,d.agentPid); assert.equal(h1.agent.protocolVersion,1); assert.ok(h1.agent.agentCapabilities&&typeof h1.agent.agentCapabilities==='object');
   assert.deepEqual(h1.running,[]); assert.deepEqual(h1.pending,[]); s1.close();
   const [s2,h2]=await hello(b); assert.deepEqual(h2.agent,h1.agent,'the initialize result is cached'); s2.close();
   assert.equal((await readLog(b)).match(/initialize sent/g).length,1,'initialize is sent once');
  }finally{await b.cleanup();}
 });

 it('refuses a missing, wrong, short, malformed or late token with auth and a close',async()=>{
  const b=await startBridge();
  try{
   const auth={ok:false,error:{code:'auth'}}; const wrong=b.d.token.replace(/^./,c=>c==='0'?'1':'0');
   for(const first of [{op:'send',msg:{}},w.sendLine(wrong,{jsonrpc:'2.0',method:'x'}),w.sendLine('ab',{}),w.streamLine(wrong),w.shutdownLine(''),'not json\n',w.sendLine(b.d.token.toUpperCase(),{})]){
    const c=open(b.d.port,first); assert.deepEqual(await c.next(),auth,JSON.stringify(first)); assert.equal(await c.next(),null,'closed after auth');}
   await Promise.all([undefined,`{"op":"send","token":"${b.d.token}"`].map(async partial=>{
    const t0=Date.now(); const c=open(b.d.port,partial); assert.deepEqual(await c.next(8000),auth); const ms=Date.now()-t0; assert.ok(ms>=4500&&ms<7500,`late token refused after ${ms} ms`); assert.equal(await c.next(),null);}));
   await sendOk(b,w.notification('raw/none',{})); assert.ok(alive(b.d.pid),'refusals leave the bridge running');
   const bad=await send(b,[1,2]); assert.deepEqual(bad.reply,{ok:false,error:{code:'bad-request'}}); assert.ok(bad.eof);
   assert.deepEqual((await send(b,{jsonrpc:'2.0'})).reply,{ok:false,error:{code:'bad-request'}});
   const c=open(b.d.port,{op:'zap',token:b.d.token}); assert.deepEqual(await c.next(),{ok:false,error:{code:'bad-request'}});
   assert.ok(!(await readLog(b)).includes(b.d.token));
  }finally{await b.cleanup();}
 });

 it('replays records after since, says gap when the ring dropped them, and replaces an older stream',async()=>{
  const b=await startBridge({agent:rawArgv()});
  try{
   const [s1,h1]=await hello(b); assert.equal(h1.seq,0);
   await sendOk(b,w.notification('raw/many',{count:5})); const got=[]; for(let i=0;i<6;i++) got.push(await s1.next());
   assert.deepEqual(got.map(r=>r.seq),[1,2,3,4,5,6]); assert.deepEqual(got.map(r=>r.msg.params?.i??r.msg.method),[1,2,3,4,5,'raw/many-end']); assert.ok(got.every(r=>Number.isFinite(r.at)));
   const [s2,h2]=await hello(b,2); assert.equal((await s1.next()).ev,'replaced'); assert.equal(await s1.next(),null,'the older stream is closed');
   assert.equal(h2.seq,6); const again=[]; for(let i=0;i<4;i++) again.push(await s2.next()); assert.deepEqual(again,got.slice(2),'records 3 to 6 replayed as first sent'); s2.close();
   const [s3]=await hello(b); await assert.rejects(s3.next(400),/no line/,'since null: live records only'); s3.close();
   const [s4]=await hello(b,9); const ahead=await s4.next(); assert.deepEqual([ahead.ev,ahead.since,ahead.first,ahead.last],['gap',9,1,6],'a since this bridge never reached'); s4.close();
   // Overflow the ring of 4,000 records.
   const [s5]=await hello(b); await sendOk(b,w.notification('raw/many',{count:4100})); const end=await s5.until(r=>r.msg?.method==='raw/many-end',30000); assert.equal(end.seq,4107); s5.close();
   const [s6,h6]=await hello(b,2); assert.equal(h6.seq,4107); const gap=await s6.next(); assert.deepEqual([gap.ev,gap.since,gap.first,gap.last],['gap',2,4107-w.RING_RECORDS+1,4107]);
   const seqs=[]; for(;;){const r=await s6.next(); seqs.push(r.seq); if(r.seq===4107) break;} assert.equal(seqs.length,w.RING_RECORDS); assert.ok(seqs.every((q,i)=>q===gap.first+i)); s6.close();
  }finally{await b.cleanup();}
 });

 it('pings a silent stream after 10 s',async()=>{
  const b=await startBridge();
  try{
   const [s]=await hello(b); const t0=Date.now(); const p=await s.next(14000); const ms=Date.now()-t0;
   assert.equal(p.ev,'ping'); assert.ok(Number.isFinite(p.at)); assert.ok(ms>=w.PING_MS-500&&ms<=w.PING_MS+2500,`first ping after ${ms} ms`); s.close();
  }finally{await b.cleanup();}
 });

 it('exits after --idle-min idle with bye idle, the agent group gone and the discovery removed',async()=>{
  const b=await startBridge({idleMin:0.02});
  try{
   const [s]=await hello(b); const bye=await s.until(v=>v.ev==='bye',8000); assert.equal(bye.reason,'idle'); assert.equal(await s.next(),null);
   const x=await waitExit(b,5000); assert.ok(x,'exited'); assert.equal(x.code,0); assert.ok(x.at-b.readyAt>=1000,`idle exit ${x.at-b.readyAt} ms after the start`);
   assert.ok(!existsSync(b.discovery)); assert.ok(!groupAlive(b.d.agentPid),'the agent group is gone');
  }finally{await b.cleanup();}
 });

 it('stays up while a prompt is in flight without output, and keeps its stderr preview out of the log',async()=>{
  const b=await startBridge({agent:rawArgv(),idleMin:0.02});
  try{
   await sendOk(b,w.sessionPrompt('t:p','raw-s',text('top secret plan\nsecond line'))); await sleep(3500); assert.ok(alive(b.d.pid),'a prompt in flight keeps the bridge');
   const [s,h]=await hello(b); assert.deepEqual(h.running.map(r=>[r.id,r.sessionId]),[['t:p','raw-s']]);
   await sendOk(b,w.sessionCancel('raw-s')); const r=await s.until(isResult('t:p')); assert.equal(r.msg.result.stopReason,'cancelled');
   assert.equal((await s.until(v=>v.ev==='bye',8000)).reason,'idle'); assert.equal((await waitExit(b,5000))?.code,0);
   const log=await readLog(b); assert.match(log,/Prompt on session raw-s: \[27 chars\]/); assert.ok(!log.includes('top secret')&&!log.includes('second line')); assert.ok(!log.includes(b.d.token));
  }finally{await b.cleanup();}
 });

 it('stays up while a K9 permission request is pending, lists it in hello, then idles out after the answer',async()=>{
  const b=await startBridge({idleMin:0.03});
  try{
   const [s]=await hello(b); const sid=await fakeSession(b,s); await sendOk(b,w.sessionPrompt('t:a',sid,text('approve')));
   const req=await s.until(v=>v.msg?.method==='session/request_permission',15000); assert.ok(req.msg.params.options.some(o=>o.optionId==='allow_once'));
   await sleep(4000); assert.ok(alive(b.d.pid));
   const [s2,h2]=await hello(b); assert.deepEqual(h2.pending.map(p=>[p.id,p.method,p.sessionId,p.seq]),[[req.msg.id,'session/request_permission',sid,req.seq]]); assert.deepEqual(h2.pending[0].msg,req.msg); assert.deepEqual(h2.running.map(r=>r.id),['t:a']);
   await sendOk(b,w.permissionSelected(req.msg.id,'allow_once')); await s2.until(isResult('t:a'),15000);
   assert.equal((await s2.until(v=>v.ev==='bye',10000)).reason,'idle'); assert.equal((await waitExit(b,5000))?.code,0);
  }finally{await b.cleanup();}
 });

 it('stays up while an agent request is pending without a prompt',async()=>{
  const b=await startBridge({agent:rawArgv(),idleMin:0.02});
  try{
   const [s]=await hello(b); await sendOk(b,w.notification('raw/ask',{})); await s.until(v=>v.msg?.id===77); await sleep(3500); assert.ok(alive(b.d.pid));
   await sendOk(b,w.permissionSelected(77,'allow_once')); const ans=await s.until(v=>v.msg?.method==='raw/answered'); assert.deepEqual(ans.msg.params,{outcome:{outcome:'selected',optionId:'allow_once'}});
   assert.equal((await s.until(v=>v.ev==='bye',8000)).reason,'idle');
  }finally{await b.cleanup();}
 });

 it('exits within 5 s of the Herdr pid going away with no prompt running',async()=>{
  const herdr=standIn(); const b=await startBridge({herdrPid:herdr.pid});
  try{
   const [s]=await hello(b); const t0=Date.now(); herdr.kill('SIGKILL');
   assert.equal((await s.until(v=>v.ev==='bye',6000)).reason,'herdr-gone');
   const x=await waitExit(b,6000); assert.ok(x,'exited'); assert.equal(x.code,0); assert.ok(x.at-t0<5000,`exit ${x.at-t0} ms after Herdr went`);
   assert.ok(!existsSync(b.discovery)); assert.ok(!groupAlive(b.d.agentPid));
  }finally{herdr.kill('SIGKILL');await b.cleanup();}
 });

 it('exits within 12 s of the Herdr pid going away with a prompt running, after session/cancel',async()=>{
  const herdr=standIn(); const b=await startBridge({herdrPid:herdr.pid});
  try{
   const [s]=await hello(b); const sid=await fakeSession(b,s); await sendOk(b,w.sessionPrompt('t:slow',sid,text('slow')));
   await s.until(isChunk(sid),15000);
   const t0=Date.now(); herdr.kill('SIGKILL'); const x=await waitExit(b,13000); assert.ok(x,'exited'); assert.equal(x.code,0); assert.ok(x.at-t0<12000,`exit ${x.at-t0} ms after Herdr went`);
   const rest=[]; for(let v;(v=await s.next(2000))!==null;) rest.push(v); assert.equal(rest.find(v=>v.ev==='bye')?.reason,'herdr-gone');
   const log=await readLog(b); assert.match(log,new RegExp(`session/cancel ${sid}`)); assert.match(log,/herdr pid \d+ gone/); assert.ok(!existsSync(b.discovery)); assert.ok(!groupAlive(b.d.agentPid));
  }finally{herdr.kill('SIGKILL');await b.cleanup();}
 });

 it('takes the fast path on SIGHUP: bye signal, SIGKILL for an agent that ignores SIGTERM, exit within 400 ms',async()=>{
  const b=await startBridge({agent:rawArgv(),env:{RAW_MODE:'ignore-term'}});
  try{
   const [s]=await hello(b); await sendOk(b,w.sessionPrompt('t:p','raw-s',text('hold'))); await sleep(200);
   const t0=Date.now(); b.proc.kill('SIGHUP'); const x=await waitExit(b,3000); assert.ok(x,'exited'); assert.equal(x.code,0); assert.ok(x.at-t0<1000,`exit ${x.at-t0} ms after SIGHUP (the bridge's own budget is 400 ms)`);
   const rest=[]; for(let v;(v=await s.next(2000))!==null;) rest.push(v); assert.equal(rest.find(v=>v.ev==='bye')?.reason,'signal');
   assert.ok(!groupAlive(b.d.agentPid),'the agent group was killed'); assert.ok(!existsSync(b.discovery));
   const log=await readLog(b); assert.match(log,/session\/cancel raw-s/); assert.match(log,/SIGKILL to agent group/); const m=log.match(/exit 0 \(signal\), (\d+) ms after the stop began/); assert.ok(m&&Number(m[1])<=400,`bridge log: ${m?.[0]}`);
  }finally{await b.cleanup();}
 });

 it('takes the fast path on SIGHUP with the K9 agent',async()=>{
  const b=await startBridge();
  try{
   const [s]=await hello(b); const t0=Date.now(); b.proc.kill('SIGHUP'); const x=await waitExit(b,3000); assert.equal(x?.code,0); assert.ok(x.at-t0<1000,`exit ${x.at-t0} ms after SIGHUP`);
   assert.equal((await s.until(v=>v.ev==='bye')).reason,'signal'); assert.ok(!existsSync(b.discovery)); assert.ok(!groupAlive(b.d.agentPid));
  }finally{await b.cleanup();}
 });

 it('reports a K9 agent crash: agent-exit, bye agent-exit, exit 1, no respawn',async()=>{
  const b=await startBridge();
  try{
   const [s]=await hello(b); const sid=await fakeSession(b,s); await sendOk(b,w.sessionPrompt('t:c',sid,text('crash')));
   const ex=await s.until(v=>v.ev==='agent-exit',15000); assert.equal(ex.code,1); const bye=await s.next(); assert.deepEqual([bye.ev,bye.reason],['bye','agent-exit']); assert.equal(await s.next(),null);
   const x=await waitExit(b,5000); assert.equal(x?.code,1); assert.ok(!existsSync(b.discovery));
   const err=await new Promise(r=>{const c=net.connect(b.d.port,'127.0.0.1');c.on('connect',()=>{c.destroy();r(null);});c.on('error',r);}); assert.ok(err,'nothing listens any more');
   assert.equal((await readLog(b)).match(/agent pid \d+/g).length,1,'no respawn');
  }finally{await b.cleanup();}
 });

 it('delivers a 5 MiB burst complete and in order',async()=>{
  const b=await startBridge({agent:rawArgv()});
  try{
   const [s,h]=await hello(b); await sendOk(b,w.notification('raw/burst',{bytes:5*1024*1024}));
   const recs=[]; for(;;){const r=await s.next(30000); assert.ok(r,'stream open'); recs.push(r); if(r.msg?.method==='raw/burst-end') break;}
   const end=recs.pop(); let n=0;
   recs.forEach((r,i)=>{assert.equal(r.seq,h.seq+1+i); const p=r.msg.params; assert.equal(p.n,n++); assert.equal(p.text.length,p.len); let sum=0; for(let k=0;k<p.text.length;k++) sum=(sum+p.text.charCodeAt(k))%1000000007; assert.equal(sum,p.sum,`line ${p.n}`);});
   assert.equal(end.seq,h.seq+recs.length+1); assert.equal(end.msg.params.count,recs.length); assert.ok(end.msg.params.bytes>=5*1024*1024); assert.ok(recs.some(r=>Buffer.byteLength(r.msg.params.text)>=1048576),'a 1 MiB line went through');
  }finally{await b.cleanup();}
 });

 it('turns an agent line over 16 MiB into dropped and skips lines that are not JSON objects',async()=>{
  const b=await startBridge({agent:rawArgv()});
  try{
   const [s,h]=await hello(b); await sendOk(b,w.notification('raw/huge',{bytes:w.MAX_LINE_BYTES+1}));
   const d=await s.next(30000); assert.deepEqual([d.seq,d.ev,d.bytes],[h.seq+1,'dropped',w.MAX_LINE_BYTES+1]); assert.ok(Number.isFinite(d.at));
   const a=await s.next(); assert.deepEqual([a.seq,a.msg.method],[h.seq+2,'raw/after-huge']);
   await sendOk(b,w.notification('raw/huge',{bytes:1000})); const ok=await s.next(); assert.deepEqual([ok.seq,ok.msg.method],[h.seq+3,'raw/huge']); await s.next();
   await sendOk(b,w.notification('raw/junk',{})); const j=await s.next(); assert.deepEqual([j.seq,j.msg.method],[h.seq+5,'raw/after-junk'],'skipped lines take no seq');
   const log=await readLog(b); assert.match(log,/skipped a non-JSON line of 16 bytes/); assert.match(log,/not a JSON object/); assert.match(log,/16777217 bytes dropped/); assert.ok(!log.includes('this is not json'));
  }finally{await b.cleanup();}
 });

 it('shutdown with no prompt running: bye shutdown, exit 0 within 3 s',async()=>{
  const b=await startBridge();
  try{
   const [s]=await hello(b); const t0=Date.now(); const c=open(b.d.port,w.shutdownLine(b.d.token)); assert.deepEqual(await c.next(),{ok:true});
   assert.equal((await s.until(v=>v.ev==='bye')).reason,'shutdown'); const x=await waitExit(b,4000); assert.equal(x?.code,0); assert.ok(x.at-t0<3000,`exit ${x.at-t0} ms after the request`);
   assert.ok(!existsSync(b.discovery)); assert.ok(!groupAlive(b.d.agentPid));
   const log=await readLog(b); assert.ok(log.includes(`SIGTERM to agent group ${b.d.agentPid}`)); assert.ok(!log.includes('SIGKILL to agent group'));
  }finally{await b.cleanup();}
 });

 it('owned shutdown never escalates after the agent exits, even with a same-group descendant',async()=>{
  const marker=join(shared,'shutdown-descendant');
  const b=await startBridge({agent:rawArgv(),env:{RAW_MODE:'descendant',RAW_DESCENDANT:marker}});
  try{
   const [s]=await hello(b);
   const c=open(b.d.port,w.shutdownLine(b.d.token)); assert.deepEqual(await c.next(),{ok:true});
   assert.equal((await s.until(v=>v.ev==='bye')).reason,'shutdown');
   const x=await waitExit(b,4000); assert.equal(x?.code,0); assert.equal(x.signal,null);
   const log=await readLog(b);
   assert.ok(log.includes(`SIGTERM to agent group ${b.d.agentPid}`));
   assert.doesNotMatch(log,/SIGKILL to agent group/); assert.ok(!existsSync(b.discovery));
   const termUntil=Date.now()+1000;
   while(!existsSync(`${marker}.term`)&&Date.now()<termUntil)await sleep(10);
   assert.equal(await readFile(`${marker}.term`,'utf8'),'received');
   assert.ok(!existsSync(`${marker}.exit`),'only the test can release the descendant');
   await writeFile(`${marker}.release`,'');
   const until=Date.now()+2000;
   while(!existsSync(`${marker}.exit`)&&Date.now()<until)await sleep(10);
   assert.equal(await readFile(`${marker}.exit`,'utf8'),'self-exit');
  }finally{await writeFile(`${marker}.release`,'');await b.cleanup();}
 });

 it('shutdown with a K9 prompt running: session/cancel, its answer before bye, exit 0 within 11 s',async()=>{
  const b=await startBridge();
  try{
   const [s]=await hello(b); const sid=await fakeSession(b,s); await sendOk(b,w.sessionPrompt('t:slow',sid,text('slow')));
   await s.until(isChunk(sid),15000);
   const t0=Date.now(); const c=open(b.d.port,w.shutdownLine(b.d.token)); assert.deepEqual(await c.next(),{ok:true});
   const rest=[]; for(let v;(v=await s.next(12000))!==null;) rest.push(v);
   const iResult=rest.findIndex(isResult('t:slow')), iBye=rest.findIndex(v=>v.ev==='bye'); assert.ok(iResult>=0,'the prompt was answered'); assert.equal(rest[iResult].msg.result.stopReason,'cancelled'); assert.ok(iBye>iResult); assert.equal(rest[iBye].reason,'shutdown');
   const x=await waitExit(b,12000); assert.equal(x?.code,0); assert.ok(x.at-t0<11000,`exit ${x.at-t0} ms after the request`); assert.match(await readLog(b),new RegExp(`session/cancel ${sid}`));
  }finally{await b.cleanup();}
 });

 it('writes a failed start into the discovery file (0600) and exits 1; bad arguments exit 2',async()=>{
  const cases=[[{RAW_MODE:'exit-before-init'},rawArgv(),'agent-exit',/exit code 3.*raw: no profile/],[{RAW_MODE:'init-error'},rawArgv(),'init-failed',/rpc -32000/],[{},['/nonexistent/lazuli-agent'],'agent-exit',/spawn: ENOENT/]];
  for(const [env,agent,code,detail] of cases){
   const b=await startBridge({agent,env});
   try{const x=await waitExit(b,10000); assert.equal(x?.code,1,code); assert.equal(b.d.state,'failed'); assert.equal(b.d.code,code); assert.match(b.d.detail,detail); assert.equal(b.d.pid,b.proc.pid); assert.equal((await stat(b.discovery)).mode&0o777,0o600);}
   finally{await b.cleanup();}
  }
  const bad=await startBridge({args:['--profile','default','--agent','--','x']}); try{const x=await waitExit(bad,5000); assert.equal(x?.code,2); assert.match(bad.stderr(),/acp-bridge: /);}finally{await bad.cleanup();}
 });

 it('logs methods, ids and sizes, never the token or message bodies',async()=>{
  const b=await startBridge();
  try{
   const [s]=await hello(b); const sid=await fakeSession(b,s); await sendOk(b,w.sessionPrompt('t:e',sid,text('hello secret words 123')));
   const r=await s.until(isResult('t:e'),15000); assert.equal(r.msg.result.stopReason,'end_turn');
   assert.deepEqual((await send(b,{jsonrpc:'2.0',method:'x/pad',params:{pad:'y'.repeat(w.MAX_LINE_BYTES)}})).reply,{ok:false,error:{code:'too-large'}});
   const log=await readLog(b); assert.ok(!log.includes(b.d.token)); assert.ok(!log.includes('secret words')); assert.ok(!log.includes('Echo:'));
   assert.match(log,/client → request session\/prompt id "t:e"/); assert.match(log,/agent → update \S+ session /); assert.match(log,/agent → result id "t:e"/); assert.match(log,/too-large/);
  }finally{await b.cleanup();}
 });

 it('sends agent-error for Hermes error lines on stderr, never for a prompt preview, and keeps no prompt text in its log',async()=>{
  const b=await startBridge({agent:[NODE,TURNS]});
  try{
   const [s]=await hello(b); await sendOk(b,w.sessionPrompt('t:f','s1',text('fail \u274C secret plan')));
   const got=[]; for(;;){const v=await s.next(5000); got.push(v); if(isResult('t:f')(v)) break;}
   const errors=got.filter(v=>v.ev==='agent-error');
   assert.deepEqual(errors.map(v=>v.text),["Non-retryable error (HTTP 400): HTTP 400: The 'm' model is not supported.",'Non-retryable client error: Error code: 400']);
   assert.ok(errors.every(v=>Number.isInteger(v.seq)&&Number.isFinite(v.at))); assert.ok(errors[0].seq<errors[1].seq);
   assert.equal(got.at(-1).msg.result.stopReason,'end_turn'); assert.ok(got.at(-1).seq>errors[1].seq,'the errors come before the reply-less end');
   // They are records: a stream from before them gets them again.
   const [s2]=await hello(b,errors[0].seq-1); const again=[await s2.next(),await s2.next(),await s2.next()]; assert.deepEqual(again.map(v=>v.ev??v.msg.id),['agent-error','agent-error','t:f']); s2.close();
   const log=await readLog(b); assert.ok(!log.includes('secret plan'),'no prompt text'); assert.match(log,/Prompt on session s1: \[18 chars\]/); assert.match(log,/conversation turn: .*msg=\[redacted\]/); assert.match(log,/\[ERROR\] agent\.conversation_loop: Non-retryable/);
  }finally{await b.cleanup();}
 });

 it('gives a stream that starts over (since null, turns) the running turns: hello with their start, then their records',async()=>{
  const b=await startBridge({agent:[NODE,TURNS]});
  try{
   const [s]=await hello(b); await sendOk(b,w.sessionPrompt('t:s','s1',w.promptBlocks('stream',['/tmp/a b.md'])));
   const one=await s.until(v=>v.msg?.params?.update?.content?.text==='one'); await s.until(v=>v.msg?.params?.update?.content?.text==='two');
   const trouble=await s.until(v=>v.ev==='agent-error'); assert.equal(trouble.text,'Stream trouble (HTTP 500)');
   await sendOk(b,w.notification('test/other',{})); await s.until(v=>v.msg?.params?.sessionId==='other');
   await sendOk(b,w.sessionLoad('t:l','s1',b.folder)); await s.until(isResult('t:l'));
   // A plain stream from now on gets live records only.
   const [plain]=await hello(b); await assert.rejects(plain.next(400),/no line/); plain.close();
   const t=open(b.d.port,w.streamLine(b.d.token,null,'test',true)); const h=await t.next();
   assert.equal(h.ev,'hello'); assert.equal(h.running.length,1);
   assert.deepEqual([h.running[0].id,h.running[0].sessionId,h.running[0].seq],['t:s','s1',one.seq-1]); assert.deepEqual(h.running[0].prompt,w.promptBlocks('stream',['/tmp/a b.md']));
   // The turn's two chunks and the error line it wrote: not the other session's update, not the history its load replayed.
   const replay=[await t.next(),await t.next(),await t.next()]; assert.deepEqual(replay.map(v=>v.msg?.params.update.content.text??v.ev),['one','two','agent-error']); assert.ok(replay.every(v=>v.seq<=h.seq));
   assert.deepEqual([replay[2].seq,replay[2].text],[trouble.seq,'Stream trouble (HTTP 500)']);
   await sendOk(b,w.notification('test/finish',{})); const next=await t.next(); assert.equal(next.msg.params.update.content.text,'three','then live');
   assert.equal((await t.next()).msg.id,'t:s'); t.close();
   // Once the turn ended there is nothing to replay.
   const u=open(b.d.port,w.streamLine(b.d.token,null,'test',true)); const h2=await u.next(); assert.deepEqual(h2.running,[]); await assert.rejects(u.next(400),/no line/); u.close();
  }finally{await b.cleanup();}
 });

 it('closes a refused or answered connection itself, and refuses a first line that runs past 64 KiB without its token',async()=>{
  const b=await startBridge({agent:rawArgv()});
  try{
   // A client that never closes its own side (allowHalfOpen) and keeps writing after the reply: a socket the bridge
   // destroyed answers with a reset (an error or a close here); one it kept half-open would swallow the bytes.
   const halfOpen=(first)=>new Promise((resolve)=>{const sock=net.connect({port:b.d.port,host:'127.0.0.1',allowHalfOpen:true});let got='';let replyAt=null;let done=false;const t0=Date.now();
    const finish=(how)=>{if(done)return;done=true;clearTimeout(give);clearInterval(poke);sock.destroy();const line=got.split('\n')[0];resolve({how,reply:line?JSON.parse(line):null,replyMs:replyAt===null?null:replyAt-t0,goneMs:Date.now()-t0});};
    sock.on('data',d=>{got+=d;if(replyAt===null&&got.includes('\n'))replyAt=Date.now();}); sock.on('error',e=>finish(`error ${e.code}`)); sock.on('close',()=>finish('close'));
    const poke=setInterval(()=>{if(replyAt!==null&&!done)sock.write('x');},250); const give=setTimeout(()=>finish('still open'),6000);
    sock.on('connect',()=>sock.write(first));});
   for(const first of [JSON.stringify(w.sendLine('ab',{}))+'\n',JSON.stringify(w.sendLine(b.d.token,w.notification('raw/none',{})))+'\n']){
    const r=await halfOpen(first); assert.notEqual(r.how,'still open',JSON.stringify(r)); assert.ok(r.goneMs<5000,`gone after ${r.goneMs} ms`); assert.ok(r.reply&&('ok' in r.reply),JSON.stringify(r.reply));}
   // 70 KiB with no token at its head: refused at once, not after the 5 s first-line wait.
   const big=await halfOpen('x'.repeat(70*1024)); assert.deepEqual(big.reply,{ok:false,error:{code:'auth'}}); assert.ok(big.replyMs<3000,`refused after ${big.replyMs} ms`); assert.notEqual(big.how,'still open');
   // A long line whose token comes first goes through.
   await sendOk(b,w.notification('raw/none',{pad:'z'.repeat(200*1024)})); assert.ok(alive(b.d.pid));
   assert.match(await readLog(b),/no token in the first 65536 bytes/);
  }finally{await b.cleanup();}
 });

});
