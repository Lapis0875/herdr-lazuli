import {test} from 'node:test'; import assert from 'node:assert/strict';
import {AREAS,fragments} from '../mods/lazuli/core/catalog/index.js'; import {placeholders,translate,resolveLanguage} from '../mods/lazuli/core/i18n.js';
test('every area has matching nonempty translated keys and placeholders',()=>{
 for(const area of AREAS) {const {en,ko}=fragments[area]; assert.deepEqual(Object.keys(en).sort(),Object.keys(ko).sort(),area); for(const key of Object.keys(en)){assert.ok(key.startsWith(area+'.')); assert.ok(typeof en[key]==='string'&&en[key].trim(),key); assert.ok(typeof ko[key]==='string'&&ko[key].trim(),key); assert.deepEqual(placeholders(en[key]),placeholders(ko[key]),key);}}
});
test('fallback and system language',()=>{
 const table={ko:{a:'안녕 {name}',b:''},en:{a:'Hello {name}',b:'English'}};
 assert.equal(translate('ko','a',{name:'Kim'},table),'안녕 Kim'); assert.equal(translate('ko','b',{},table),'English'); assert.equal(translate('ko','missing',{},table),'missing'); assert.equal(translate('en','a',{name:'Kim'},table),'Hello Kim');
 assert.equal(resolveLanguage('system','(\n "ko-KR",\n en\n)'),'ko'); assert.equal(resolveLanguage('system','(en, ko)'),'en'); assert.equal(resolveLanguage('ko','(en)'),'ko');
});
