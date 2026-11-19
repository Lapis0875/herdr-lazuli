import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFile,access} from 'node:fs/promises';
test('read-only relay profile and referenced scripts',async()=>{
 const p=JSON.parse(await readFile(new URL('../relay/lazuli.profile.json',import.meta.url),'utf8')); assert.equal(p.id,'lazuli'); assert.deepEqual(p.folders,['lazuli']); assert.equal(p.overlay,'device');
 assert.deepEqual(p.exec.rows,['E1','E2','E4','E6','E7','E11']);
 for(const path of Object.keys(p.scripts)) await access(new URL('../'+path,import.meta.url));
 const scan=p.scripts['mods/lazuli/bin/scan.mjs']; assert.deepEqual(scan.subcommands,['tree','detail','run','call','transcript','usage','sessions']); assert.deepEqual(scan.allow.run,['ps']);
 for(const f of ['run-agent.mjs','html-view.mjs','chrome-broker.mjs']) assert.ok(p.scripts['mods/lazuli/bin/'+f].refuse);
});
