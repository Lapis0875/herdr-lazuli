import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_EVERY_MS, draftFile, makeDraft, parseDraft, shouldWrite, decide } from '../mods/lazuli/core/drafts.js';
test('draft recovery and debounce',()=>{
 const d=makeDraft({file:'/a/x.md',on:null,baseHash:'h1',text:'new',now:5});
 assert.equal(DRAFT_EVERY_MS,1000); assert.equal(draftFile('/d','hash'),'/d/hash.json');
 assert.deepEqual(d,{version:1,file:'/a/x.md',on:null,baseHash:'h1',text:'new',at:5}); assert.deepEqual(parseDraft(JSON.stringify(d)),d); assert.equal(parseDraft('{bad'),null);
 const disk={file:'/a/x.md',on:null,text:'old',hash:'h1'};
 assert.deepEqual(decide(d,disk),{banner:true,remove:false,baseChanged:false});
 assert.deepEqual(decide(d,{...disk,hash:'h2'}),{banner:true,remove:false,baseChanged:true});
 assert.deepEqual(decide(d,{...disk,text:'new'}),{banner:false,remove:true,baseChanged:false});
 assert.deepEqual(decide(d,{...disk,on:'remote'}),{banner:false,remove:false,baseChanged:false});
 assert.deepEqual(decide(null,disk),{banner:false,remove:false,baseChanged:false});
 assert.equal(shouldWrite({dirty:true,text:'a',lastText:'a',lastAt:0,now:5000}),false);
 assert.equal(shouldWrite({dirty:true,text:'a',lastText:'b',lastAt:4500,now:5000}),false);
 assert.equal(shouldWrite({dirty:true,text:'a',lastText:'b',lastAt:4000,now:5000}),true);
 assert.equal(shouldWrite({dirty:false,text:'a',lastText:'b',lastAt:0,now:5000}),false);
});
