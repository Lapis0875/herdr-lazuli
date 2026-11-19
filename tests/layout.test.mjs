import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises';
import {isAction} from '../mods/lazuli/sys/state.js';
const json=async p=>JSON.parse(await readFile(new URL(p,import.meta.url),'utf8'));
test('layout nodes, views, keys and persistent activity rail',async()=>{
 const layout=await json('../layouts/lazuli.json'), keys=await json('../keys.json'); const source=await readFile(new URL('../mods/lazuli/main.js',import.meta.url),'utf8');
 const block=source.match(/export\s+const\s+VIEWS\s*=\s*Object\.freeze\s*\(\s*\{([\s\S]*?)\}\s*\)/); assert.ok(block,'VIEWS registry');
 const views=new Set([...block[1].matchAll(/(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*:/gm)].map(m=>m[1]??m[2]??m[3]));
 const ids=new Map(); function walk(x){if(!x||typeof x!=='object')return; if(Array.isArray(x)){x.forEach(walk);return;} if(x.id){assert.ok(!ids.has(x.id),`duplicate ${x.id}`);ids.set(x.id,x);} if(x.mod==='lazuli'){assert.ok(views.has(x.props?.view),`unknown view ${x.props?.view}`);} for(const v of Object.values(x))walk(v);} walk(layout);
 for(const action of Object.values(keys['layout:lazuli'])) assert.ok(isAction(typeof action==='string'?action:action.command),String(action));
 assert.deepEqual(layout.theme,{light:'lazuli-light',dark:'lazuli-dark'}); assert.equal(ids.get('panel-body').active,'files'); const body=ids.get('body'); assert.equal(body.type,'row'); assert.ok(body.children.some(x=>x.id==='activity')); assert.ok(!JSON.stringify(ids.get('panel')).includes('"id":"activity"'));
});
