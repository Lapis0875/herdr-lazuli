import {test} from 'node:test'; import assert from 'node:assert/strict';
import {NEW_FILE,parse,text,items,add,toggle,links} from '../mods/lazuli/core/todo-doc.js';
test('to-do round trip and ordering',()=>{
 assert.equal(text(add(parse(NEW_FILE),'first')),'# To-do\n\n- [ ] first\n');
 assert.equal(text(add(add(parse(NEW_FILE),'first'),'second')),'# To-do\n\n- [ ] second\n- [ ] first\n');
 const src='# To-do\n\n- [ ] one\n  - [x] two (done 2026-10-27)\nnotes\n'; assert.equal(text(parse(src)),src);
 assert.deepEqual(items(parse(src))[1],{line:3,done:true,text:'two (done 2026-10-27)'});
 assert.equal(text(toggle(parse('# To-do\n\n- [ ] a\n- [ ] b\n- [x] c (done 2026-10-01)\n'),2,'2026-10-28')),'# To-do\n\n- [ ] b\n- [x] a (done 2026-10-28)\n- [x] c (done 2026-10-01)\n');
 const done=toggle(parse('# To-do\n\n- [ ] a\n- [ ] b\n- [x] c (done 2026-10-01)\n'),2,'2026-10-28');
 assert.equal(text(toggle(done,4,'2026-10-28')),'# To-do\n\n- [ ] b\n- [ ] c\n- [x] a (done 2026-10-28)\n');
 assert.deepEqual(toggle(done,0,'2026-10-28'),done); assert.deepEqual(toggle(done,99,'2026-10-28'),done);
 assert.deepEqual(links('review acme/api#4 and #7',{repo:'acme/web'}),[{kind:'ref',label:'acme/api#4',url:'https://github.com/acme/api/issues/4'},{kind:'ref',label:'#7',url:'https://github.com/acme/web/issues/7'}]);
});
