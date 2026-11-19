import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFramer, encode, parseReply, checkRequest, utf8Decode } from '../mods/lazuli/core/proto.js';
test('line framing retains partial UTF-8 and refuses oversize permanently',()=>{
 const B=s=>new TextEncoder().encode(s), f=createFramer();
 assert.deepEqual(f.push(B('{"id":1,"pa')),{lines:[],error:null});
 assert.deepEqual(f.push(B('ges":3}\n{"id":2}\n')),{lines:['{"id":1,"pages":3}','{"id":2}'],error:null});
 const g=createFramer(); assert.deepEqual(g.push(Uint8Array.of(0xed,0x95)),{lines:[],error:null}); assert.deepEqual(g.push(Uint8Array.of(0x9c,10)),{lines:['한'],error:null});
 const h=createFramer(4); assert.deepEqual(h.push(B('12345')),{lines:[],error:'line-too-long'}); assert.deepEqual(h.push(B('\n')),{lines:[],error:'line-too-long'}); assert.equal(utf8Decode(B('한')),'한');
});
test('request and reply validation',()=>{
 assert.equal(encode({op:'ping'}),'{"op":"ping"}\n');
 assert.deepEqual(parseReply('{"id":7,"pages":3}'),{id:7,ok:true,value:{pages:3}});
 assert.deepEqual(parseReply('{"id":7,"error":{"code":"not_found","message":"x"}}'),{id:7,ok:false,error:{code:'not_found',message:'x'}});
 assert.deepEqual(parseReply('nope'),{bad:true}); assert.equal(checkRequest({op:'render',doc:'d',page:1}),'missing-field'); assert.equal(checkRequest({op:'zap'}),'bad-op'); assert.equal(checkRequest({op:'ping'}),null);
});
