import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readdir,readFile} from 'node:fs/promises'; import {join} from 'node:path'; import {fileURLToPath} from 'node:url';
test('core modules remain pure and platform independent',async()=>{
 const root=fileURLToPath(new URL('../mods/lazuli/core/',import.meta.url));
 async function scan(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name); if(e.isDirectory()) await scan(p); else if(e.name.endsWith('.js')) {const s=await readFile(p,'utf8'); assert.doesNotMatch(s,/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:node:)?(?:herdr|gpui-kit|gpui-base|net|fs(?:\/promises)?|crypto)(?:["'/])/g,p); assert.doesNotMatch(s,/\b(?:Date\.now|Math\.random|crypto\b)/g,p);}}} await scan(root);
});
