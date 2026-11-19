import {test} from 'node:test'; import assert from 'node:assert/strict';
import {rateFor,cost} from '../mods/lazuli/core/pricing.js'; import {ompUsage,claudeUsage,codexTotal,codexDelta,price} from '../mods/lazuli/core/spend.js';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {spawnSync} from 'node:child_process'; import {fileURLToPath} from 'node:url';
const R={'claude-opus-5':{input:1,output:1,cacheRead:1,cacheWrite:1},'claude-opus-5-5':{input:4,output:20,cacheRead:0.2,cacheWrite:5,cacheWrite1h:8}};
test('pricing and usage records',()=>{
 assert.equal(rateFor('claude-opus-5-5-20261001',R),R['claude-opus-5-5']); assert.equal(rateFor('mystery',R),null);
 assert.ok(Math.abs(cost({input:4,output:659,cacheRead:0,cacheWrite:0,cacheWrite1h:139830},R['claude-opus-5-5'])-1.131836)<1e-9);
 assert.deepEqual(ompUsage({type:'model_usage',timestamp:'2026-11-18T06:09:11.820Z',model:'claude-opus-5-5',usage:{input:1055,output:32,cacheRead:139830,cacheWrite:0,cost:{total:0.032826}}}),{tool:'omp',model:'claude-opus-5-5',at:Date.parse('2026-11-18T06:09:11.820Z'),tokens:{input:1055,output:32,cacheRead:139830,cacheWrite:0,cacheWrite1h:0},usd:0.032826,key:null});
 const c=price(claudeUsage({type:'assistant',timestamp:'2026-11-17T01:00:00.000Z',message:{id:'msg_1',model:'claude-opus-5-5',usage:{input_tokens:2,output_tokens:293,cache_read_input_tokens:13157,cache_creation_input_tokens:26058,cache_creation:{ephemeral_1h_input_tokens:26058,ephemeral_5m_input_tokens:0}}}}),R); assert.equal(c.key,'msg_1'); assert.ok(Math.abs(c.usd-0.2169634)<1e-9);
 assert.deepEqual(c.tokens,{input:2,output:293,cacheRead:13157,cacheWrite:0,cacheWrite1h:26058});
 const s=price(claudeUsage({type:'assistant',isSidechain:true,agentId:'a1',timestamp:'2026-11-17T01:00:00.000Z',message:{id:'msg_s1',model:'claude-opus-5-5',usage:{input_tokens:5,output_tokens:300,cache_read_input_tokens:4000,cache_creation_input_tokens:800,cache_creation:{ephemeral_1h_input_tokens:800,ephemeral_5m_input_tokens:0}}}}),R); assert.equal(s.key,'msg_s1'); assert.ok(Math.abs(s.usd-0.01322)<1e-9);
 assert.deepEqual(s.tokens,{input:5,output:300,cacheRead:4000,cacheWrite:0,cacheWrite1h:800});
 assert.deepEqual(codexTotal({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:1000,cached_input_tokens:400,output_tokens:50}}}}),{input:600,output:50,cacheRead:400,cacheWrite:0,cacheWrite1h:0});
 assert.equal(price({...c,model:'mystery',usd:null},R).usd,null);
});
test('scan counts duplicate Claude message usage once per file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lazuli-usage-'));
 try {
  const root=join(dir,'claude'), project=join(root,'project'); await mkdir(project,{recursive:true});
  const record={type:'assistant',timestamp:'2026-11-17T01:00:00.000Z',message:{id:'msg_1',model:'unknown-test-model',usage:{input_tokens:10,output_tokens:2}}};
  await writeFile(join(project,'session.jsonl'),JSON.stringify(record)+'\n'+JSON.stringify(record)+'\n');
  const sidechain={type:'assistant',isSidechain:true,agentId:'a1',timestamp:'2026-11-17T01:00:00.000Z',message:{id:'msg_s1',model:'unknown-test-model',usage:{input_tokens:5,output_tokens:300,cache_read_input_tokens:4000,cache_creation_input_tokens:800,cache_creation:{ephemeral_1h_input_tokens:800,ephemeral_5m_input_tokens:0}}}};
  const subagents=join(project,'session','subagents'); await mkdir(subagents,{recursive:true});
  await writeFile(join(subagents,'agent-a1.jsonl'),JSON.stringify(sidechain)+'\n'+JSON.stringify(sidechain)+'\n');
  const options={now:Date.parse('2026-11-17T12:00:00.000Z'),roots:{omp:null,claude:root,codex:null},cache:join(dir,'cache.json'),rates:{}};
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../mods/lazuli/bin/scan.mjs',import.meta.url)),'usage',JSON.stringify(options)],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr); const report=JSON.parse(run.stdout); assert.equal(report.byTool.claude.tokens,12+5105); assert.equal(report.unpriced[0].model,'unknown-test-model');
 } finally {await rm(dir,{recursive:true,force:true});}
});
