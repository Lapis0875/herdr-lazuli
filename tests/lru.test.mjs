import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total, evict } from '../mods/lazuli/core/lru.js';
test('evict oldest until under cap, with deterministic ties',()=>{
 const e=[{name:'a',size:60,used:1},{name:'b',size:60,used:3},{name:'c',size:60,used:2}];
 assert.equal(total(e),180); assert.deepEqual(evict(e,100),['a','c']); assert.deepEqual(evict(e,200),[]);
 assert.deepEqual(evict([{name:'x',size:500,used:9}],100),['x']);
 assert.deepEqual(evict([{name:'b',size:1,used:1},{name:'a',size:1,used:1}],1),['a']);
});
