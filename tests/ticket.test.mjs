import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketOf } from '../mods/lazuli/core/ticket.js';
test('body links precede branch and trailing punctuation is removed', () => {
 assert.deepEqual(ticketOf({body:'Fixes https://linear.app/acme/issue/ENG-401/sign-in',branch:'me/x'}),{key:'ENG-401',url:'https://linear.app/acme/issue/ENG-401/sign-in'});
 assert.deepEqual(ticketOf({body:'see https://acme.atlassian.net/browse/OPS-7.',branch:'main'}),{key:'OPS-7',url:'https://acme.atlassian.net/browse/OPS-7'});
 assert.deepEqual(ticketOf({body:'https://github.com/acme/api/issues/4)',branch:'foo/ZZ-2'}),{key:'acme/api#4',url:'https://github.com/acme/api/issues/4'});
 assert.deepEqual(ticketOf({body:'',branch:'me/eng-401-login'}),{key:'ENG-401',url:null});
 assert.equal(ticketOf({body:null,branch:'main'}),null);
});
