import {test} from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ='America/New_York';
const {nextAfter,lastDue,parseWhen}=await import('../mods/lazuli/core/routine-file.js');

test('daily schedules across New York daylight saving transitions',t=>{
 if(new Date(2026,2,8,3,0).getTimezoneOffset()!==240){t.skip('America/New_York time zone unavailable or process TZ was overridden');return;}
 assert.equal(nextAfter(parseWhen('daily 02:30'),new Date(2026,2,8,1,0).getTime()),Date.UTC(2026,2,8,7,0));
 assert.equal(lastDue(parseWhen('daily 02:30'),new Date(2026,2,7,3,0).getTime(),Date.UTC(2026,2,8,7,10)),Date.UTC(2026,2,8,7,0));
 assert.equal(nextAfter(parseWhen('daily 01:30'),Date.UTC(2026,10,1,5,30)),new Date(2026,10,2,1,30).getTime());
 assert.equal(lastDue(parseWhen('daily 01:30'),Date.UTC(2026,10,1,5,30),Date.UTC(2026,10,1,6,45)),null);
});
