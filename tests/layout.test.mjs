import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises';
import {isAction, parseCommand, normalizeSettings, migratedSettings, CENTER} from '../mods/lazuli/sys/state.js';
const json=async p=>JSON.parse(await readFile(new URL(p,import.meta.url),'utf8'));
const viewNames=async()=>{const source=await readFile(new URL('../mods/lazuli/main.js',import.meta.url),'utf8');
 const block=source.match(/export\s+const\s+VIEWS\s*=\s*Object\.freeze\s*\(\s*\{([\s\S]*?)\}\s*\)/); assert.ok(block,'VIEWS registry');
 return new Set([...block[1].matchAll(/(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*:/gm)].map(m=>m[1]??m[2]??m[3]));};
test('layout nodes, views, keys and persistent activity rail',async()=>{
 const layout=await json('../layouts/lazuli.json'), keys=await json('../keys.json'); const views=await viewNames();
 const ids=new Map(); function walk(x){if(!x||typeof x!=='object')return; if(Array.isArray(x)){x.forEach(walk);return;} if(x.id){assert.ok(!ids.has(x.id),`duplicate ${x.id}`);ids.set(x.id,x);} if(x.mod==='lazuli'){assert.ok(views.has(x.props?.view),`unknown view ${x.props?.view}`);} for(const v of Object.values(x))walk(v);} walk(layout);
 for(const action of Object.values(keys['layout:lazuli'])) assert.ok(isAction(typeof action==='string'?action:action.command),String(action));
 assert.deepEqual(layout.theme,{light:'lazuli-light',dark:'lazuli-dark'}); assert.equal(ids.get('panel-body').active,'files'); const body=ids.get('body'); assert.equal(body.type,'row'); assert.ok(body.children.some(x=>x.id==='activity')); assert.ok(!JSON.stringify(ids.get('panel')).includes('"id":"activity"'));
});
test('assistant screen: center child, columns, views, key and commands',async()=>{
 const layout=await json('../layouts/lazuli.json'), keys=await json('../keys.json'); const views=await viewNames();
 const ids=new Map(); (function walk(x){if(!x||typeof x!=='object')return; if(Array.isArray(x)){x.forEach(walk);return;} if(x.id)ids.set(x.id,x); for(const v of Object.values(x))walk(v);})(layout);
 const kids=id=>ids.get(id).children.map(c=>c.id), props=id=>ids.get(id).content.props;
 assert.deepEqual(kids('center'),[...CENTER]); assert.equal(ids.get('assistant').type,'row');
 assert.deepEqual(kids('assistant'),['assistant-list','assistant-chat','assistant-side']); assert.deepEqual(kids('assistant-side'),['assistant-info','assistant-files']);
 assert.deepEqual(props('assistant-list'),{view:'assistant-list'}); assert.deepEqual(props('assistant-chat'),{view:'assistant'}); assert.deepEqual(props('assistant-info'),{view:'assistant-info'}); assert.deepEqual(props('assistant-files'),{view:'files',scope:'assistant',block:'assistant-files'});
 for(const v of ['assistant','assistant-list','assistant-info']) assert.ok(views.has(v),`VIEWS has ${v}`);
 assert.equal(keys['layout:lazuli']['cmd-alt-4'],'lazuli.go:assistant'); assert.equal(keys['layout:lazuli']['cmd-4'],'lazuli.panel:tree');
 assert.deepEqual(parseCommand('go:assistant'),{name:'go:assistant',arg:null,owner:'status'}); assert.deepEqual(parseCommand('assistant:new:default'),{name:'assistant',arg:'new:default',owner:'self'});
 assert.equal(parseCommand('assistant:'),null); assert.ok(isAction('lazuli.go:assistant'));
});
test('settings v1 → v2 pins the assistant once',()=>{
 const v1=normalizeSettings({version:1,pins:['todo','inbox']}); assert.equal(v1.version,2); assert.deepEqual(v1.pins,['todo','inbox','assistant']);
 assert.deepEqual(normalizeSettings(v1).pins,v1.pins); assert.deepEqual(normalizeSettings({version:1,pins:['assistant','todo']}).pins,['assistant','todo']); assert.deepEqual(normalizeSettings({version:1,pins:[]}).pins,['assistant']);
 // An edit as updateSettings makes it (normalized draft, change, normalized again): an unpinned assistant stays unpinned.
 assert.deepEqual(normalizeSettings({...v1,pins:['inbox']}).pins,['inbox']); assert.deepEqual(normalizeSettings({version:2,pins:['todo']}).pins,['todo']);
 const fresh=normalizeSettings(null); assert.deepEqual(fresh.pins,['inbox','todo','routines','assistant']); assert.deepEqual(fresh.assistant,{folder:null,debugAgent:null});
 assert.deepEqual(normalizeSettings({assistant:{folder:' /tmp/lz-assistant-a/ ',debugAgent:['/usr/local/bin/node','/x/fake-acp-agent.mjs']}}).assistant,{folder:'/tmp/lz-assistant-a',debugAgent:['/usr/local/bin/node','/x/fake-acp-agent.mjs']});
 assert.deepEqual(normalizeSettings({assistant:{folder:'rel/dir',debugAgent:[]}}).assistant,{folder:null,debugAgent:null}); assert.equal(normalizeSettings({assistant:{folder:'/'}}).assistant.folder,'/');
 // debugAgent: a non-empty array of non-empty strings, else null; one element of another kind voids it (not dropped).
 for(const bad of [['/usr/local/bin/node',3],['/usr/local/bin/node',''],['/usr/local/bin/node',null],[' '],'/usr/local/bin/node',{0:'node'},7])
  assert.equal(normalizeSettings({assistant:{debugAgent:bad}}).assistant.debugAgent,null,JSON.stringify(bad));
 assert.deepEqual(normalizeSettings({assistant:{debugAgent:['node',' x ']}}).assistant.debugAgent,['node',' x '],'kept as it is');
 // The one-time write-back (store.js): only an older file whose pins gain the assistant; never the result again.
 assert.deepEqual(migratedSettings({version:1,pins:['todo','inbox']}),v1); assert.equal(migratedSettings(v1),null); assert.equal(migratedSettings(JSON.parse(JSON.stringify(v1))),null);
 assert.deepEqual(migratedSettings({pins:['inbox']}).pins,['inbox','assistant']); assert.equal(migratedSettings({version:1,pins:['assistant']}),null); assert.equal(migratedSettings({version:1,language:'ko'}),null);
 assert.equal(migratedSettings({version:2,pins:['todo']}),null); for(const x of [null,[],'x',3]) assert.equal(migratedSettings(x),null);
});
