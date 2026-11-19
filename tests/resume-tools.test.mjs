import {test} from 'node:test'; import assert from 'node:assert/strict';
import {baseArgv,resumeArgv,shellLine,sessionFrom,restoreStatus,decodeRecord,encodeRecord} from '../mods/lazuli/core/resume-tools.js';
test('resume argv, quoting and restore timeouts',()=>{
 assert.deepEqual(baseArgv('claude',['claude','--model','opus','--resume','abc','fix it']),['claude','--model','opus']); assert.equal(baseArgv('claude',['claude','-p','hi']),null);
 assert.deepEqual(baseArgv('codex',['codex','resume','-m','gpt-5','0199']),['codex','-m','gpt-5']); assert.deepEqual(resumeArgv('codex',['codex','-m','gpt-5'],'S'),['codex','resume','-m','gpt-5','S']);
 assert.equal(shellLine(['omp','--resume','/a b/s.jsonl'],'/w'),"cd /w && omp --resume '/a b/s.jsonl'"); assert.equal(sessionFrom('codex','/x/rollout-2026-11-09T15-51-59-01a1bf13-f7f2-75f1-866c-70931d67a6d4.jsonl\n'),'01a1bf13-f7f2-75f1-866c-70931d67a6d4');
 const r={tool:'omp',session:'/s.jsonl',argv:['omp'],cwd:null,pid:5,tried:{pid:9,at:1000,failed:false}}, t={pid:9,foreground:{pid:9}};
 assert.equal(restoreStatus(t,r,31000),'failed'); assert.equal(restoreStatus(t,r,2000),'sent'); assert.equal(restoreStatus(t,{...r,tried:null},2000),'pending'); assert.deepEqual(decodeRecord(encodeRecord(r)),r); assert.equal(decodeRecord('{bad'),null);
});
test('credentials are stripped from restored command arguments and old records',()=>{
 assert.deepEqual(baseArgv('omp',['omp','--api-key','sk-1','--model','x']),['omp','--model','x']);
 assert.deepEqual(baseArgv('omp',['omp','--api-key=sk-1']),['omp']);
 assert.deepEqual(baseArgv('codex',['codex','-c','model_providers.x.api_key=sk','-m','gpt-5']),['codex','-m','gpt-5']);
 assert.deepEqual(decodeRecord(JSON.stringify({tool:'omp',session:'/s.jsonl',argv:['omp','--api-key','sk-1'],pid:1})).argv,['omp']);
});
