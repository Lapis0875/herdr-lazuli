import {test} from 'node:test'; import assert from 'node:assert/strict';
import {emptyDoc,normalize,count,prompt,edit} from '../mods/lazuli/core/queue-doc.js';
test('queue operations preserve ordering and remove emptied handles',()=>{
 let r=edit(emptyDoc(),'add',['t3','run the tests'],1); assert.equal(r.note,'queued'); assert.deepEqual(r.doc.queues.t3,[{id:'q1-0',text:'run the tests',at:1}]);
 r=edit(r.doc,'add',['t3','then push'],2); assert.equal(r.doc.queues.t3[1].id,'q2-1'); assert.equal(edit(r.doc,'add',['t3','  '],3).note,'nothing-to-add'); assert.equal(count(r.doc),2);
 r=edit(r.doc,'move',['t3','q2-1',0],4); r=edit(r.doc,'send',['t3','all'],5); assert.deepEqual(r,{note:'sent',texts:['then push','run the tests'],doc:{version:1,queues:{}}});
 assert.equal(prompt(r.texts),'1. then push\n2. run the tests'); assert.equal(prompt(['one']),'one'); assert.deepEqual(edit(r.doc,'remove',['t3','q9'],6),{error:'not-in-queue'});
 assert.deepEqual(normalize({version:1,queues:{t:[{id:'a',text:'b',at:1},{id:3}]}}),{version:1,queues:{t:[{id:'a',text:'b',at:1}]}});
});
test('edit, remove, clear and send one do not affect other queues',()=>{
 let d=edit(emptyDoc(),'add',['t1','first'],1).doc;
 d=edit(d,'add',['t1','second'],2).doc; d=edit(d,'add',['t2','other'],3).doc;
 const original=structuredClone(d);
 let r=edit(d,'edit',['t1','q1-0','changed'],4); assert.equal(r.doc.queues.t1[0].text,'changed'); assert.deepEqual(d,original);
 r=edit(r.doc,'send',['t1','q1-0'],5); assert.deepEqual(r.texts,['changed']); assert.equal(r.doc.queues.t1.length,1);
 r=edit(r.doc,'remove',['t1','q2-1'],6); assert.equal(r.doc.queues.t1,undefined); assert.equal(r.doc.queues.t2.length,1);
 r=edit(r.doc,'clear',['t2'],7); assert.deepEqual(r.doc,emptyDoc());
 assert.deepEqual(edit(r.doc,'remove',['t1','missing'],8),{error:'not-in-queue'});
 assert.deepEqual(edit(r.doc,'bogus',['t1'],9),{error:'unknown-action'});
});
