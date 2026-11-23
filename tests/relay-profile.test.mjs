import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFile,access} from 'node:fs/promises';
test('read-only relay profile and referenced scripts',async()=>{
 const p=JSON.parse(await readFile(new URL('../relay/lazuli.profile.json',import.meta.url),'utf8')); assert.equal(p.id,'lazuli'); assert.deepEqual(p.folders,['lazuli']); assert.equal(p.overlay,'device');
 assert.deepEqual(p.exec.rows,['E1','E2','E4','E6','E7','E11']);
 for(const path of Object.keys(p.scripts)) await access(new URL('../'+path,import.meta.url));
 const scan=p.scripts['mods/lazuli/bin/scan.mjs']; assert.deepEqual(scan.subcommands,['tree','detail','run','call','transcript','usage','sessions']); assert.deepEqual(scan.allow.run,['ps']);
 for(const f of ['run-agent.mjs','html-view.mjs','chrome-broker.mjs','acp-bridge.mjs']) assert.ok(p.scripts['mods/lazuli/bin/'+f].refuse);
});
test('the Assistant bridge never runs on a device and nothing grants it more',async()=>{
 const p=JSON.parse(await readFile(new URL('../relay/lazuli.profile.json',import.meta.url),'utf8'));
 const bridge=p.scripts['mods/lazuli/bin/acp-bridge.mjs']; assert.deepEqual(Object.keys(bridge),['refuse']); assert.match(bridge.refuse,/Assistant bridge/);
 // Only the scanner runs on a device; no script may start node or hermes there.
 const runners=Object.entries(p.scripts).filter(([,s])=>!s.refuse).map(([k])=>k); assert.deepEqual(runners,['mods/lazuli/bin/scan.mjs']);
 assert.ok(!JSON.stringify(p).includes('hermes')); assert.deepEqual(p.writes.extra,['~/.cache/lazuli/**']);
});
