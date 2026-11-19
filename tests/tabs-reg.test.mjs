import {test} from 'node:test'; import assert from 'node:assert/strict';
import {openPlan,pin,sweep,findOpen,previewOf} from '../mods/lazuli/core/tabs-reg.js';
test('deduplication, preview replacement and pinning',()=>{
 const reg={p1:{file:'/a/x.md',on:null,preview:true,mode:null,space:'s1',tab:'T1',pane:'P1',at:1}};
 const q={file:'/a/./x.md',on:null,space:'s1',pin:false,fid:'n',now:9};
 assert.deepEqual(openPlan(reg,q),{action:'select',fid:'p1'}); assert.equal(findOpen(reg,q),'p1'); assert.equal(previewOf(reg,'s1'),'p1');
 const changed=openPlan(reg,{...q,file:'/a/y.md'}); assert.deepEqual(changed,{action:'retarget',fid:'p1',name:'◦ y.md',reg:{p1:{...reg.p1,file:'/a/y.md',at:9}}}); assert.equal(reg.p1.file,'/a/x.md');
 assert.equal(openPlan(reg,{...q,file:'/a/y.md',dirty:['p1']}).action,'new'); assert.equal(openPlan(reg,{...q,file:'/a/y.md',pin:true}).action,'new');
 assert.deepEqual(openPlan(reg,{...q,file:'/a/y.md',space:'s2',pin:true}).props,{view:'file',fid:'n',file:'/a/y.md',on:null,preview:false}); assert.equal(pin(reg,'p1').p1.preview,false);
 assert.deepEqual(sweep(reg,[],{},9),{reg,misses:{p1:1}}); assert.deepEqual(sweep(reg,[],{p1:1},9),{reg:{},misses:{}});
});
