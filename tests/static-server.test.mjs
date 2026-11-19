import {test} from 'node:test'; import assert from 'node:assert/strict'; import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import http from 'node:http';
import {startStaticServer} from '../mods/lazuli/bin/lib/static-server.mjs';
function request(port,path,options={}){return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port,path,method:options.method||'GET',headers:options.headers||{}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});r.on('error',reject);r.end();});}
test('serves only root files and rejects traversal, hosts and methods',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lazuli-test-')), root=join(dir,'root'); const {mkdir}=await import('node:fs/promises'); await mkdir(root); await writeFile(join(root,'a b.html'),'hello'); await writeFile(join(root,'doc.md'),'# title'); await writeFile(join(dir,'outside'),'secret'); await symlink(join(dir,'outside'),join(root,'link'));
 let server; try {server=await startStaticServer({root,renderMarkdown:(text,{title})=>`${title}:${text}`}); const get=(p,o)=>request(server.port,p,o);
 assert.equal(server.origin,`http://127.0.0.1:${server.port}`); assert.equal(server.url('a b.html'),`${server.origin}/a%20b.html`);
 let r=await get('/a%20b.html'); assert.equal(r.status,200); assert.equal(r.body,'hello'); assert.equal(r.headers['content-type'],'text/html; charset=utf-8'); assert.equal(r.headers['cache-control'],'no-store');
 const head=await get('/a%20b.html',{method:'HEAD'}); assert.equal(head.status,200); assert.equal(head.body,''); assert.equal(head.headers['content-type'],r.headers['content-type']);
 for(const path of ['/','/missing','/../outside','/%2e%2e/outside','/link','/__lazuli/md/a%20b.html']) {r=await get(path); assert.equal(r.status,404,path); assert.equal(r.headers['cache-control'],'no-store');}
 r=await get('/doc.md',{headers:{host:'evil'}}); assert.equal(r.status,403); assert.equal(r.body,'');
 r=await get('/doc.md',{method:'POST'}); assert.equal(r.status,405); assert.equal(r.headers.allow,'GET, HEAD');
 r=await get('/__lazuli/md/doc.md'); assert.equal(r.status,200); assert.equal(r.headers['content-type'],'text/html; charset=utf-8'); assert.equal(r.body,'doc.md:# title');
 await writeFile(join(root,'a b.html'),'changed'); assert.equal((await get('/a%20b.html')).body,'changed');
 } finally {if(server) await server.close(); await rm(dir,{recursive:true,force:true});}
});
