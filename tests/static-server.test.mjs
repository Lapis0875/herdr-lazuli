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
test('never serves dot-segment paths but serves dotted names',async()=>{
 const {mkdir}=await import('node:fs/promises'); const root=await mkdtemp(join(tmpdir(),'lazuli-dot-'));
 for(const d of ['.git','a/.secret','.github','a.b']) await mkdir(join(root,d),{recursive:true});
 await writeFile(join(root,'.git/config'),'git'); await writeFile(join(root,'.env'),'env'); await writeFile(join(root,'a/.secret/x'),'x'); await writeFile(join(root,'.github/x.md'),'# x'); await writeFile(join(root,'a.b/c.html'),'ok');
 let server; try {server=await startStaticServer({root,renderMarkdown:(t)=>t}); const get=p=>request(server.port,p);
 for(const p of ['/.git/config','/.env','/a/.secret/x','/%2egit/config','/__lazuli/md/.github/x.md']) assert.equal((await get(p)).status,404,p);
 const r=await get('/a.b/c.html'); assert.equal(r.status,200); assert.equal(r.body,'ok');
 } finally {if(server) await server.close(); await rm(root,{recursive:true,force:true});}
});
test('adds the network-blocking CSP only while blockNetwork answers true',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazuli-csp-')); await writeFile(join(root,'p.html'),'page');
 let blocked, plain; try {
  blocked=await startStaticServer({root,blockNetwork:()=>true}); plain=await startStaticServer({root});
  let r=await request(blocked.port,'/p.html'); assert.equal(r.status,200); assert.equal(r.headers['content-security-policy'],"connect-src 'self' http: https: data: blob:");
  r=await request(blocked.port,'/missing'); assert.equal(r.status,404); assert.equal(r.headers['content-security-policy'],"connect-src 'self' http: https: data: blob:");
  r=await request(blocked.port,'/p.html',{headers:{'sec-fetch-dest':'sharedworker'}}); assert.equal(r.status,200); assert.equal(r.headers['content-security-policy'],"default-src 'self' data: blob:");
  r=await request(plain.port,'/p.html'); assert.equal(r.status,200); assert.equal(r.headers['content-security-policy'],undefined);
  r=await request(plain.port,'/p.html',{headers:{'sec-fetch-dest':'sharedworker'}}); assert.equal(r.headers['content-security-policy'],undefined);
 } finally {if(blocked) await blocked.close(); if(plain) await plain.close(); await rm(root,{recursive:true,force:true});}
});
