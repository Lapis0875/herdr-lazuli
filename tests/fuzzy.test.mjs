import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, score } from '../mods/lazuli/core/fuzzy.js';
test('ranking and subsequence boundaries',()=>{
 assert.deepEqual(rank('main',['src/domain/index.js','src/main.js','main.js']).map(x=>x.path),['main.js','src/main.js','src/domain/index.js']);
 assert.deepEqual(rank('xyz',['a.js']),[]); assert.notEqual(score('MD','docs/README.md'),null);
 assert.deepEqual(rank('', ['b','a']).map(x=>x.path),['b','a']); assert.equal(rank('', ['b','a'],1).length,1);
 assert.deepEqual(rank('abc',['a-b-c.txt','abc.txt']).map(x=>x.path),['abc.txt','a-b-c.txt']);
 assert.deepEqual(rank('', ['b','a'],2).map(({score})=>score),[0,0]);
});
