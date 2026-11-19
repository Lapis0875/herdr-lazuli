import { test } from 'node:test';
import assert from 'node:assert/strict';
import {kindOf,modesFor,defaultMode,nextMode,fileKey,tabName,invalidName,editability,MAX_EDIT} from '../mods/lazuli/core/paths.js';
test('file kinds, modes and remote restrictions',()=>{
 for(const [name,kind] of [['README.MD','md'],['x.markdown','md'],['x.html','html'],['x.htm','html'],['x.pdf','pdf'],['x.svg','svg'],['x.PNG','image'],['x.jpeg','image'],['x.gif','image'],['x.webp','image'],['a.tar.gz','text']]) assert.equal(kindOf(name),kind);
 assert.equal(kindOf('photo.jpg'),'image'); assert.equal(kindOf('photo.jpeg'),'image');
 for(const [kind,modes,mode] of [['md',['edit','split','preview'],'split'],['html',['edit','split','preview'],'preview'],['svg',['edit','split','preview'],'split'],['pdf',['preview'],'preview'],['image',['preview'],'preview'],['text',['edit'],'edit']]) {assert.deepEqual(modesFor(kind),modes);assert.equal(defaultMode(kind),mode);}
 assert.deepEqual(modesFor('html',{remote:true}),['edit']); assert.deepEqual(modesFor('svg',{remote:true}),['edit']); assert.deepEqual(modesFor('pdf',{remote:true}),[]); assert.deepEqual(modesFor('image',{remote:true}),[]);
 assert.deepEqual(modesFor('md',{remote:true}),['edit','split','preview']); assert.deepEqual(modesFor('text',{remote:true}),['edit']);
 assert.equal(nextMode('md','edit'),'split'); assert.equal(nextMode('md','split'),'preview');
 assert.equal(nextMode('md','preview'),'edit'); assert.equal(nextMode('text','edit'),'edit');
});
test('identity, names and editability limits',()=>{
 assert.equal(fileKey('/a/b/../c.md',null),':/a/c.md'); assert.equal(fileKey('/a/c.md','vps'),'vps:/a/c.md');
 assert.equal(tabName('/a/c.md',{preview:true,dirty:false}),'◦ c.md'); assert.equal(tabName('/a/c.md',{preview:true,dirty:true}),'● c.md');
 assert.equal(tabName('/a/c.md',{preview:false,dirty:false}),'c.md');
 for(const [v,w] of [['a/b','slash'],['..','dots'],['.','dots'],[' ','empty'],['x','taken'],['ok.md',null]]) assert.equal(invalidName(v,['x']),w);
 assert.equal(MAX_EDIT,400000); assert.equal(editability({text:'x'.repeat(MAX_EDIT),writable:true}).readOnly,false);
 const big=editability({text:'x'.repeat(MAX_EDIT+1),writable:true}); assert.equal(big.reason,'too-large'); assert.equal(big.text.length,MAX_EDIT);
 assert.equal(editability({text:'a\0b',writable:true}).reason,'nul'); assert.equal(editability({text:'x',writable:false}).reason,'not-writable'); assert.equal(editability({text:'x',writable:false,on:'vps'}).reason,'remote');
});
