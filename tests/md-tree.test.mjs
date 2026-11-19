import {test} from 'node:test'; import assert from 'node:assert/strict';
import {parse,resolveLink,slug} from '../mods/lazuli/core/md-tree.js';
test('marked blocks and links retain semantic content',()=>{
 assert.deepEqual(parse('# Hi **you**\n\nSee [docs](./a.md).\n\n```js\nlet a\n```\n').map(({key,...b})=>b),[{type:'heading',depth:1,id:'hi-you',inlines:[{type:'text',text:'Hi '},{type:'text',text:'you',bold:true}]},{type:'paragraph',inlines:[{type:'text',text:'See '},{type:'link',href:'./a.md',title:null,inlines:[{type:'text',text:'docs'}]},{type:'text',text:'.'}]},{type:'code',lang:'js',text:'let a'}]);
 assert.deepEqual(resolveLink('./b/c.md#x','/a'),{kind:'file',path:'/a/b/c.md',anchor:'x'}); assert.deepEqual(resolveLink('#top','/a'),{kind:'anchor',anchor:'top'}); assert.deepEqual(resolveLink('mailto:x@y','/a'),{kind:'other'}); assert.equal(slug('Hi You'),'hi-you');
});
