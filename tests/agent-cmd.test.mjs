import {test} from 'node:test'; import assert from 'node:assert/strict';
import {adapterOf,headlessArgv,forkArgv,parseOutput,summaryLine,canReadOnly} from '../mods/lazuli/core/agent-cmd.js';
test('tool-specific argv and result parsing',()=>{
 assert.equal(adapterOf(['/usr/bin/claude']),'claude'); assert.equal(adapterOf(['custom']),null);
 assert.deepEqual(headlessArgv(['omp'],'hi',{sessionDir:'/r/s'}),['omp','-p','--session-dir','/r/s','--','hi']);
 assert.deepEqual(headlessArgv(['claude'],'hi',{model:'sonnet',edits:true}),['claude','-p','hi','--output-format','stream-json','--verbose','--model','sonnet','--permission-mode','acceptEdits']);
 assert.deepEqual(headlessArgv(['codex'],'hi',{edits:true}),['codex','exec','--skip-git-repo-check','--sandbox','workspace-write','hi']);
 assert.deepEqual(headlessArgv(['my-agent','--ask','{prompt}'],'hi'),['my-agent','--ask','hi']);
 assert.deepEqual(forkArgv('claude',['claude'],'S'),['claude','--resume','S','--fork-session']); assert.deepEqual(forkArgv('codex',['codex','-m','x'],'S'),['codex','fork','-m','x','S']); assert.deepEqual(forkArgv('omp',['omp'],'/a.jsonl'),['omp','--fork','/a.jsonl']);
 assert.deepEqual(parseOutput('claude',{out:'{"type":"system","subtype":"init"}\n{"type":"result","is_error":false,"result":"Done.\\nDetails","total_cost_usd":0.12,"session_id":"s1"}\n',err:'',code:0}),{text:'Done.\nDetails',usd:0.12,session:'s1',isError:false});
 assert.equal(summaryLine('\n# Summary\nDetails'),'Summary'); assert.equal(parseOutput(null,{out:'',err:'bad',code:1}).isError,true);
});
test('read-only runs discard unsafe command options and reject unsupported templates',()=>{
 assert.deepEqual(headlessArgv(['omp','--yolo'],'hi',{readOnly:true}),['omp','-p','--tools=read,grep,glob','--approval-mode=always-ask','--','hi']);
 assert.deepEqual(headlessArgv(['codex','--dangerously-bypass-approvals-and-sandbox'],'hi',{readOnly:true,edits:true}),['codex','exec','--skip-git-repo-check','--ignore-user-config','--ignore-rules','--sandbox','read-only','hi']);
 assert.equal(headlessArgv(['x','{prompt}'],'hi',{readOnly:true}),null); assert.equal(canReadOnly(['aider']),false);
});
