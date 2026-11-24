import {test} from 'node:test'; import assert from 'node:assert/strict';
import * as w from '../mods/lazuli/core/acp-wire.js';

test('constants follow K3 and the S8 limits',()=>{
 assert.equal(w.PROTOCOL_VERSION,1); assert.equal(w.DISCOVERY_VERSION,1); assert.equal(w.MAX_LINE_BYTES,16*1024*1024); assert.equal(w.MAX_WRITE_BYTES,1048576);
 assert.equal(w.PING_MS,10000); assert.ok(w.PING_MS+1000<w.READ_TIMEOUT_MS); assert.equal(w.LOST_AFTER_TIMEOUTS,3); assert.equal(w.MAX_PARALLEL_SENDS,8);
 assert.equal(w.RING_RECORDS,4000); assert.equal(w.RING_BYTES,8*1024*1024); assert.equal(w.IDLE_MIN,30); assert.equal(w.AUTH_MS,5000); assert.equal(w.HELLO_MS,5000);
 assert.ok(w.INIT_TIMEOUT_MS<w.DISCOVERY_WAIT_MS); assert.equal(w.DISCOVERY_WAIT_MS,45000);
 assert.deepEqual(w.START_ERRORS,['agent-exit','init-failed','init-timeout']); assert.ok(['idle','herdr-gone','signal','agent-exit'].every(r=>w.BYE_REASONS.includes(r)));
 assert.equal(w.METHOD.sessionPrompt,'session/prompt'); assert.equal(w.METHOD.requestPermission,'session/request_permission'); assert.ok(Object.isFrozen(w.METHOD));
});

test('JSON-RPC builders',()=>{
 assert.deepEqual(w.request('c:1','session/list',{cwd:'/x'}),{jsonrpc:'2.0',id:'c:1',method:'session/list',params:{cwd:'/x'}});
 assert.deepEqual(w.request('c:1','x'),{jsonrpc:'2.0',id:'c:1',method:'x'});
 assert.deepEqual(w.notification('session/cancel',{sessionId:'s'}),{jsonrpc:'2.0',method:'session/cancel',params:{sessionId:'s'}});
 assert.deepEqual(w.result(3,{a:1}),{jsonrpc:'2.0',id:3,result:{a:1}}); assert.deepEqual(w.result(3),{jsonrpc:'2.0',id:3,result:null});
 assert.deepEqual(w.rpcError(3,-32601,'nope'),{jsonrpc:'2.0',id:3,error:{code:-32601,message:'nope'}}); assert.deepEqual(w.rpcError(3,1,'m',{d:1}).error.data,{d:1});
 assert.deepEqual(w.initialize('b:1',1),{jsonrpc:'2.0',id:'b:1',method:'initialize',params:{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'lazuli',title:'lazuli',version:'1'}}});
 assert.deepEqual(w.sessionNew('c:2','/f').params,{cwd:'/f',mcpServers:[]});
 assert.deepEqual(w.sessionLoad('c:3','s1','/f').params,{sessionId:'s1',cwd:'/f',mcpServers:[]});
 assert.deepEqual(w.sessionFork('c:4','s1','/f'),{jsonrpc:'2.0',id:'c:4',method:'session/fork',params:{sessionId:'s1',cwd:'/f',mcpServers:[]}});
 assert.deepEqual(w.sessionList('c:5','/f').params,{cwd:'/f'}); assert.deepEqual(w.sessionList('c:5','/f','cur').params,{cwd:'/f',cursor:'cur'}); assert.deepEqual(w.sessionList('c:5','/f','').params,{cwd:'/f'});
 assert.deepEqual(w.sessionSetModel('c:6','s1','fake:beta').params,{sessionId:'s1',modelId:'fake:beta'}); assert.equal(w.sessionSetMode('c:7','s1','default').method,'session/set_mode');
 assert.deepEqual(w.sessionPrompt('c:8','s1',[{type:'text',text:'hi'}]).params,{sessionId:'s1',prompt:[{type:'text',text:'hi'}]});
 assert.deepEqual(w.sessionCancel('s1'),{jsonrpc:'2.0',method:'session/cancel',params:{sessionId:'s1'}});
 assert.deepEqual(w.permissionSelected(7,'allow_session'),{jsonrpc:'2.0',id:7,result:{outcome:{outcome:'selected',optionId:'allow_session'}}});
 assert.deepEqual(w.permissionCancelled(7).result,{outcome:{outcome:'cancelled'}});
 const ids=w.createIds('n9'); assert.equal(ids.next(),'n9:1'); assert.equal(ids.next(),'n9:2'); assert.ok(ids.owns('n9:7')); assert.ok(!ids.owns('b:1')); assert.ok(!ids.owns(7));
 assert.equal(w.createIds('b').next(),'b:1');
});

test('prompt blocks: text, then resource links of absolute paths',()=>{
 assert.equal(w.fileUri('/Users/me/한 글/a#b.md'),'file:///Users/me/%ED%95%9C%20%EA%B8%80/a%23b.md'); assert.equal(w.fileUri('rel/a'),null); assert.equal(w.fileUri(null),null); assert.equal(w.fileUri('/a\0b'),null);
 assert.deepEqual(w.promptBlocks('hello',['/tmp/x/a.md',{path:'/tmp/y/b.txt',name:'B'},'rel.md',{name:'no path'},7]),[
  {type:'text',text:'hello'},{type:'resource_link',uri:'file:///tmp/x/a.md',name:'a.md'},{type:'resource_link',uri:'file:///tmp/y/b.txt',name:'B'}]);
 assert.deepEqual(w.promptBlocks('',['/a']),[{type:'resource_link',uri:'file:///a',name:'a'}]); assert.deepEqual(w.promptBlocks('x'),[{type:'text',text:'x'}]); assert.deepEqual(w.promptBlocks('',null),[]);
 assert.equal(w.promptText([{type:'text',text:'a'},{type:'resource_link',uri:'file:///a'},{type:'text',text:'b'}]),'a\nb'); assert.equal(w.promptText(null),'');
});

test('classify tells requests, updates, notifications, answers and junk apart',()=>{
 assert.deepEqual(w.classify({jsonrpc:'2.0',id:3,method:'session/request_permission',params:{sessionId:'s',options:[]}}),{kind:'request',id:3,method:'session/request_permission',params:{sessionId:'s',options:[]},sessionId:'s'});
 const u=w.classify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'}}}});
 assert.equal(u.kind,'update'); assert.equal(u.sessionId,'s'); assert.equal(u.updateKind,'agent_message_chunk'); assert.equal(u.update.content.text,'x');
 assert.deepEqual(w.classify({jsonrpc:'2.0',method:'session/update',params:{}}),{kind:'update',sessionId:null,update:null,updateKind:null});
 assert.deepEqual(w.classify({jsonrpc:'2.0',method:'x/y'}),{kind:'notification',method:'x/y',params:null,sessionId:null});
 assert.deepEqual(w.classify({jsonrpc:'2.0',id:'c:1',result:{}}),{kind:'result',id:'c:1',result:{}}); assert.deepEqual(w.classify({jsonrpc:'2.0',id:'c:1',result:null}),{kind:'result',id:'c:1',result:null});
 assert.deepEqual(w.classify({jsonrpc:'2.0',id:'c:1',error:{code:-32603,message:'boom',data:{a:1}}}),{kind:'error',id:'c:1',error:{code:-32603,message:'boom',data:{a:1}}});
 assert.deepEqual(w.classify({id:null,error:{code:'x'}}),{kind:'error',id:null,error:{code:null,message:''}});
 for(const bad of [null,7,'x',[],{},{id:1},{id:{},result:1},{id:null,method:'m'},{method:5}]) assert.deepEqual(w.classify(bad),{kind:'invalid'},JSON.stringify(bad));
});

test('bridge lines: first lines, ASCII encoding, chunked writes, records',()=>{
 assert.deepEqual(w.streamLine('t',5,'mod'),{op:'stream',token:'t',since:5,client:'mod'}); assert.equal(w.streamLine('t').since,null); assert.equal(w.streamLine('t',-1).since,null); assert.equal(w.streamLine('t',1.5).since,null);
 assert.deepEqual(w.streamLine('t',null,'mod',true),{op:'stream',token:'t',since:null,client:'mod',turns:true},'turns: the running turns, only with since null'); assert.equal(w.streamLine('t',5,'mod',true).turns,undefined); assert.equal(w.streamLine('t',null,'mod',1).turns,undefined);
 assert.deepEqual(w.sendLine('t',{a:1}),{op:'send',token:'t',msg:{a:1}}); assert.deepEqual(w.shutdownLine('t'),{op:'shutdown',token:'t'});
 const line=w.encodeLine({text:'한글 😀 é',n:1}); assert.match(line,/^[\x00-\x7f]*\n$/); assert.deepEqual(JSON.parse(line),{text:'한글 😀 é',n:1}); assert.equal(Buffer.byteLength(line),line.length);
 const big=w.encodeLine({pad:'가'.repeat(400000)}); const parts=w.writeChunks(big); assert.ok(parts.length>=3); assert.ok(parts.every(p=>Buffer.byteLength(p)<=w.MAX_WRITE_BYTES)); assert.equal(parts.join(''),big);
 assert.deepEqual(w.writeChunks('abc\n',2),['ab','c\n']); assert.deepEqual(w.writeChunks('short\n'),['short\n']); assert.deepEqual(w.writeChunks('한글',1),['한글']);
 assert.deepEqual(w.parseRecord({seq:4,at:9,msg:{jsonrpc:'2.0',method:'m'}}),{kind:'agent',seq:4,at:9,msg:{jsonrpc:'2.0',method:'m'}});
 assert.deepEqual(w.parseRecord({ev:'ping',at:3}),{ev:'ping',at:3,kind:'event'}); assert.deepEqual(w.parseRecord({seq:5,at:1,ev:'dropped',bytes:9}),{seq:5,at:1,ev:'dropped',bytes:9,kind:'event'});
 assert.deepEqual(w.parseRecord({ok:true}),{kind:'reply',ok:true,error:null}); assert.deepEqual(w.parseRecord({ok:false,error:{code:'auth'}}),{kind:'reply',ok:false,error:{code:'auth'}});
 for(const bad of [null,[],{},{seq:'1',msg:{}},{ev:''},{ok:false},{ok:false,error:{}}]) assert.deepEqual(w.parseRecord(bad),{kind:'invalid'});
});

test('discovery files: ready, failed, invalid; reuse match by profile, folder, Herdr and agent argv',()=>{
 const ARGV=['/opt/homebrew/bin/hermes','-p','default','acp'];
 const good={version:1,pid:10,agentPid:11,port:5000,token:'a'.repeat(64),profile:'default',cwd:'/tmp/f',herdrPid:9,startedAt:1,argv:ARGV};
 const d=w.parseDiscovery(JSON.stringify(good)); assert.deepEqual(d,{state:'ready',...Object.fromEntries(Object.entries(good).filter(([k])=>k!=='version'))});
 const want={profile:'default',cwd:'/tmp/f',herdrPid:9,argv:ARGV};
 assert.ok(w.discoveryMatches(d,want)); for(const other of [{profile:'work'},{cwd:'/tmp/f/'},{herdrPid:8},{argv:['/usr/local/bin/hermes','-p','default','acp']},{argv:['/usr/bin/node','/x/fake-acp-agent.mjs','-p','default','acp']},{argv:ARGV.slice(0,3)},{argv:undefined},{argv:[]}]) assert.ok(!w.discoveryMatches(d,{...want,...other}),JSON.stringify(other));
 // A file written before the argv was kept (or with a bad one) is read, and never reused.
 for(const argv of [undefined,'hermes',[],[1,2],null]){const old=w.parseDiscovery(JSON.stringify({...good,argv})); assert.equal(old.state,'ready'); assert.equal(old.argv,null); assert.ok(!w.discoveryMatches(old,want));}
 assert.notEqual(w.parseDiscovery(JSON.stringify(good)).argv,good.argv,'a copy');
 assert.deepEqual(w.parseDiscovery(JSON.stringify({version:1,pid:10,error:{code:'init-timeout',detail:'no answer'}})),{state:'failed',pid:10,code:'init-timeout',detail:'no answer'});
 assert.equal(w.parseDiscovery(JSON.stringify({version:1,pid:10,error:{code:'weird'}})).code,'init-failed');
 for(const bad of ['','{',JSON.stringify({...good,version:2}),JSON.stringify({...good,token:'A'.repeat(64)}),JSON.stringify({...good,token:'ab'}),JSON.stringify({...good,port:0}),JSON.stringify({...good,port:70000}),JSON.stringify({...good,cwd:'rel'}),JSON.stringify({...good,agentPid:0}),JSON.stringify({...good,herdrPid:-1}),JSON.stringify({...good,pid:1.5})])
  assert.deepEqual(w.parseDiscovery(bad),{state:'invalid'},bad.slice(0,60));
 assert.ok(!w.discoveryMatches({state:'failed'},want));
});

test('tracker: prompts in flight, steer alongside, agent requests, the idle rule',()=>{
 const t=w.createTracker(1000); const P=(id,s,text='x')=>w.sessionPrompt(id,s,[{type:'text',text}]);
 assert.ok(!t.busy()); assert.ok(!t.idleExpired(1999,1000)); assert.ok(t.idleExpired(2000,1000));
 t.fromClient(P('c:1','s1'),2000,40); assert.deepEqual(t.running(),[{id:'c:1',sessionId:'s1',at:2000,seq:40,prompt:[{type:'text',text:'x'}]}]); assert.ok(t.busy()); assert.ok(!t.idleExpired(99999,1000),'a prompt in flight never idles');
 t.fromClient(P('c:2','s1','/steer go left'),2100); assert.deepEqual(t.runningSessions(),['s1']); assert.equal(t.running().length,2); assert.equal(t.running()[1].seq,null); assert.deepEqual([...t.turnStarts()],[['s1',40]],'a turn starts at its oldest running prompt');
 t.fromAgent({jsonrpc:'2.0',id:9,method:'session/request_permission',params:{sessionId:'s1'}},2200,17);
 assert.deepEqual(t.pending().map(p=>[p.id,p.method,p.sessionId,p.at,p.seq]),[[9,'session/request_permission','s1',2200,17]]);
 t.fromAgent({jsonrpc:'2.0',id:'c:2',result:{stopReason:'end_turn'}},2300); assert.equal(t.running().length,1); assert.equal(t.pending().length,1,'the steer ending leaves the turn and its request');
 t.fromClient(w.permissionSelected(9,'allow_once'),2400); assert.equal(t.pending().length,0);
 t.fromAgent({jsonrpc:'2.0',id:10,method:'session/request_permission',params:{sessionId:'s1'}},2500); assert.ok(t.busy());
 t.fromAgent({jsonrpc:'2.0',id:'c:1',error:{code:-32603,message:'x'}},2600); assert.equal(t.running().length,0); assert.equal(t.pending().length,0,'the last prompt of the session ends its requests');
 assert.ok(!t.idleExpired(3599,1000)); assert.ok(t.idleExpired(3600,1000)); assert.equal(t.lastActivity(),2600);
 t.fromAgent({jsonrpc:'2.0',id:'zz',method:'session/request_permission',params:{sessionId:'s2'}},2700); assert.ok(!t.idleExpired(99999,1000),'a pending request never idles');
 t.fromAgent({jsonrpc:'2.0',method:'$/cancel_request',params:{requestId:'zz'}},2800); assert.ok(!t.busy());
 t.fromAgent({jsonrpc:'2.0',id:44,method:'session/request_permission',params:{sessionId:'s3'}},2900); t.fromAgent({jsonrpc:'2.0',method:'$/cancel_request',params:{id:44}},2950); assert.ok(!t.busy());
 t.fromClient(P(5,'s4'),3000); t.fromAgent({jsonrpc:'2.0',id:'5',result:{}},3001); assert.equal(t.running().length,1,'ids keep their type'); t.fromAgent({jsonrpc:'2.0',id:5,result:{}},3002); assert.equal(t.running().length,0);
 t.touch(5000); assert.equal(t.lastActivity(),5000); t.touch(4000); assert.equal(t.lastActivity(),5000,'time never goes back');
 t.fromClient(P('c:9','s5'),5100); t.fromAgent({jsonrpc:'2.0',id:1,method:'session/request_permission',params:{sessionId:'s5'}},5200); t.clear(); assert.ok(!t.busy());
 const kinds=[t.fromClient({jsonrpc:'2.0',method:'session/cancel',params:{sessionId:'s'}},1).kind,t.fromAgent('junk',1).kind]; assert.deepEqual(kinds,['notification','invalid']);
});

test('tracker: running turns, session loads and the records that belong to a turn',()=>{
 const t=w.createTracker(0); const P=(id,s,text)=>w.sessionPrompt(id,s,[{type:'text',text},{type:'resource_link',uri:'file:///tmp/a%20b.md',name:'a b.md'}]);
 const upd=(s,k='agent_message_chunk')=>t.fromAgent({jsonrpc:'2.0',method:'session/update',params:{sessionId:s,update:{sessionUpdate:k,content:{type:'text',text:'x'}}}},1);
 assert.equal(t.turnRecord(upd('s1')),false,'no prompt running');
 t.fromClient(P('c:1','s1','go'),1,7); assert.deepEqual(t.running()[0].prompt,P('c:1','s1','go').params.prompt);
 assert.equal(t.turnRecord(upd('s1')),true); assert.equal(t.turnRecord(upd('s2')),false,'another session');
 assert.equal(t.turnRecord(t.fromAgent({jsonrpc:'2.0',id:9,method:'session/request_permission',params:{sessionId:'s1'}},1)),false,'requests are hello pending');
 assert.equal(t.turnRecord(t.fromAgent({jsonrpc:'2.0',method:'x/other',params:{sessionId:'s1'}},1)),false); assert.equal(t.turnRecord(null),false);
 // A load of the running session: its updates replay the history until its answer.
 t.fromClient(w.sessionLoad('c:2','s1','/f'),2); assert.equal(t.turnRecord(upd('s1','user_message_chunk')),false);
 t.fromClient(w.sessionLoad('c:3','s2','/f'),2); t.fromAgent({jsonrpc:'2.0',id:'c:2',result:{models:{}}},3); assert.equal(t.turnRecord(upd('s1')),true,'its load answered');
 t.fromAgent({jsonrpc:'2.0',id:'c:1',result:{stopReason:'end_turn'}},4); assert.equal(t.turnRecord(upd('s1')),false,'the turn ended'); assert.deepEqual([...t.turnStarts()],[]);
 t.fromClient(P('c:4','s1','again'),5,20); t.fromClient(w.sessionLoad('c:5','s1','/f'),5); t.clear(); t.fromClient(P('c:6','s1','after'),6,30); assert.equal(t.turnRecord(upd('s1')),true,'clear ends the loads too');
});

test('prompt paths: the file links promptBlocks makes',()=>{
 assert.deepEqual(w.promptPaths(w.promptBlocks('hi',['/Users/me/한 글/a#b.md','/tmp/x'])),['/Users/me/한 글/a#b.md','/tmp/x']);
 assert.deepEqual(w.promptPaths([{type:'resource_link',uri:'https://x/y'},{type:'resource_link',uri:'file:///bad%zz'},{type:'resource_link',uri:'file:///a%00b'},{type:'text',text:'file:///t'},null]),[]);
 assert.deepEqual(w.promptPaths(null),[]);
});

test('the agent PATH never gets an empty entry; a first line is authenticated by the token at its head',()=>{
 const tail='/opt/homebrew/bin:/usr/local/bin:/Users/u/.local/bin:/Users/u/.claude/local';
 assert.equal(w.agentPath('/usr/bin:/bin','/Users/u'),`/usr/bin:/bin:${tail}`);
 for(const empty of ['',undefined,null,':']) assert.equal(w.agentPath(empty,'/Users/u'),tail,String(empty));
 assert.equal(w.agentPath('/usr/bin::/bin:','/Users/u'),`/usr/bin:/bin:${tail}`);
 assert.ok(!w.agentPath('','/Users/u').split(':').includes(''));
 const tok='a'.repeat(64);
 for(const line of [w.sendLine(tok,{pad:'x'}),w.streamLine(tok,3,'mod',false),w.shutdownLine(tok)]) assert.equal(w.leadingToken(JSON.stringify(line).slice(0,120)),tok);
 assert.equal(w.leadingToken(w.encodeLine(w.sendLine(tok,{text:'한글'})).slice(0,90)),tok);
 for(const head of ['{"msg":{},"op":"send","token":"'+tok+'"}','{"op":"send","token":"'+tok.slice(1)+'"','{"op":"send","token":"'+tok.toUpperCase()+'"','x'.repeat(100),'',null]) assert.equal(w.leadingToken(head),null,String(head).slice(0,40));
 assert.equal(w.PRE_AUTH_BYTES,65536);
});

test('stderr filter keeps prompt text out of the log',()=>{
 const lengths={s1:250}; const f=w.createStderrFilter({promptLength:s=>lengths[s]??null});
 assert.deepEqual(f.push('2026-11-23 07:20:32 [INFO] acp_adapter.server: Prompt on session s1: secret plans for'),[]);
 assert.deepEqual(f.push(' tomorrow\n2026-11-23 07:20:33 [INFO] x: other\n'),['2026-11-23 07:20:32 [INFO] acp_adapter.server: Prompt on session s1: [250 chars]','2026-11-23 07:20:33 [INFO] x: other']);
 // A multi-line preview: its continuation lines are dropped while they fit in the 100 characters.
 assert.deepEqual(f.push('2026-11-23 07:20:34 [INFO] acp_adapter.server: Prompt on session s9: line one\nline two secret\r\n\nthird\n2026-11-23 07:20:35 [WARNING] y: next\n'),
  ['2026-11-23 07:20:34 [INFO] acp_adapter.server: Prompt on session s9: [redacted]','2026-11-23 07:20:35 [WARNING] y: next']);
 // A full 100-character preview leaves no room: the next line is logged.
 assert.deepEqual(f.push(`2026-11-23 07:20:36 [INFO] a: Prompt on session s1: ${'x'.repeat(100)}\nTraceback (most recent call last):\n`),['2026-11-23 07:20:36 [INFO] a: Prompt on session s1: [250 chars]','Traceback (most recent call last):']);
 // A line too long to be the rest of the preview is logged.
 assert.deepEqual(f.push(`2026-11-23 07:20:37 [INFO] a: Prompt on session s1: ${'y'.repeat(90)}\n${'z'.repeat(20)}\n`),['2026-11-23 07:20:37 [INFO] a: Prompt on session s1: [250 chars]','z'.repeat(20)]);
 assert.deepEqual(f.push('plain line\nPrompt on session s1: no prefix'),['plain line']); assert.deepEqual(f.end(),['Prompt on session s1: [250 chars]']); assert.deepEqual(f.end(),[]);
 const g=w.createStderrFilter(); assert.deepEqual(g.push('INFO Prompt on session abc: 한글 비밀\n'),['INFO Prompt on session abc: [redacted]']);
 assert.ok(!JSON.stringify(f.push('2026-11-23 07:20:38 [INFO] a: Prompt on session s1: 😀😀 secret\n')).includes('secret'));
});

test('stderr: the turn line keeps no prompt text; Hermes error lines become agent-error texts',()=>{
 const f=w.createStderrFilter();
 const head="2026-11-23 18:08:53 [INFO] agent.turn_context: conversation turn: session=15e8 model=gpt-5.4-mini provider=openai-codex platform=acp history=0 msg=";
 assert.deepEqual(f.push(`${head}'Run this exact shell command: rm -r /tmp/x'\n`),[`${head}[redacted]`]);
 // Hermes's stderr for a failed turn (the bridge log of 2026-11-23 09:09:33Z), then other shapes.
 const lines=[
  '2026-11-23 18:09:33 [WARNING] agent.conversation_loop: API call failed (attempt 1/3) error_type=BadRequestError',
  '\u26A0\uFE0F  API call failed (attempt 1/3): BadRequestError [HTTP 400]',
  "   \u{1F4DD} Error: HTTP 400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
  "\u274C Non-retryable error (HTTP 400): HTTP 400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
  '\u274C Non-retryable client error (HTTP 400). Aborting.',
  "   \u{1F4A1} This type of error won't be fixed by retrying.",
  "2026-11-23 18:09:33 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 400 - {'detail': 'nope'}",
  '[B1:P2] \u274C Max retries (3) exceeded',
  '2026-11-23 18:09:34,120 [CRITICAL] x: down',
  '[ERROR] bare: record',
 ];
 assert.deepEqual(lines.map((l)=>w.agentErrorText(l)),[null,null,null,
  "Non-retryable error (HTTP 400): HTTP 400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
  'Non-retryable client error (HTTP 400). Aborting.',null,
  "Non-retryable client error: Error code: 400 - {'detail': 'nope'}",
  'Max retries (3) exceeded','down','record']);
 // Never a prompt preview, even one that carries an error mark.
 for(const l of ['2026-11-23 07:20:40 [INFO] acp_adapter.server: Prompt on session s1: \u274C secret','Prompt on session s1: [ERROR] x: secret',"2026-11-23 18:08:53 [ERROR] t: conversation turn: session=1 msg='\u274C secret'",'','   ','info \u274C mid-line','\u274C ',null,7])
  assert.equal(w.agentErrorText(l),null,String(l));
 const long=w.agentErrorText(`\u274C ${'e'.repeat(1500)}`); assert.equal(long.length,w.AGENT_ERROR_MAX+1); assert.ok(long.endsWith('\u2026'));
});
