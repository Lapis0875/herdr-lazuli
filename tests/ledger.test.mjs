import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeStretches,totals} from '../mods/lazuli/core/ledger.js';

test('merge adjacent checkpoints without changing ticket totals',()=>{
 const x=[{start:0,end:60000,ticket:'A',terminal:'t'},{start:60000,end:120000,ticket:'A',terminal:'t'},{start:120000,end:180000,ticket:'B',terminal:'t'},{start:30000,end:90000,ticket:'A',terminal:'u'}];
 const merged=mergeStretches(x);
 assert.deepEqual(merged,[{start:0,end:120000,ticket:'A',terminal:'t'},{start:30000,end:90000,ticket:'A',terminal:'u'},{start:120000,end:180000,ticket:'B',terminal:'t'}]);
 assert.deepEqual(totals(merged,180000).tickets,totals(x,180000).tickets);
});

test('gaps remain separate and invalid stretches are dropped',()=>{
 const a={start:0,end:60000,ticket:'A',terminal:'t'},b={start:60001,end:120000,ticket:'A',terminal:'t'};
 assert.deepEqual(mergeStretches([a,b,{...a,start:5,end:5},{...a,start:6,end:5},{...a,start:'0'},{...a,end:null}]),[a,b]);
});
