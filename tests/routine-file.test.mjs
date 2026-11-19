import {test} from 'node:test'; import assert from 'node:assert/strict';
import {parseWhen,nextAfter,lastDue,setField,parseRoutine,slugFor} from '../mods/lazuli/core/routine-file.js';
const L=(y,m,d,h,mi)=>new Date(y,m-1,d,h,mi).getTime();
test('calendar schedules and invalid expressions',()=>{
 const cases=[['daily 09:00',L(2026,10,29,8,59),L(2026,10,29,9,0)],['daily 09:00',L(2026,10,29,9,0),L(2026,10,30,9,0)],['weekdays 9:00, 17:30',L(2026,10,30,18,0),L(2026,11,2,9,0)],['cron */15 9-17 * * 1-5',L(2026,10,29,17,50),L(2026,10,30,9,0)],['cron 30 6 13 * 5',L(2026,10,29,12,0),L(2026,10,30,6,30)]];
 for(const [expr,after,want] of cases) assert.equal(nextAfter(parseWhen(expr),after),want,expr);
 assert.equal(nextAfter(parseWhen('every 30m'),L(2026,10,29,12,0)),null);
 assert.equal(lastDue(parseWhen('daily 09:00'),L(2026,10,27,10,0),L(2026,10,29,12,0)),L(2026,10,29,9,0));
 const more=[['weekends 10:00',L(2026,10,29,12,0),L(2026,10,31,10,0)],['mon,thu 14:00',L(2026,10,29,14,0),L(2026,11,2,14,0)],['tue-thu 08:15',L(2026,10,29,9,0),L(2026,11,3,8,15)],['at 7h',L(2026,10,29,9,0),L(2026,10,30,7,0)],['cron 0 0 1 * *',L(2026,10,29,12,0),L(2026,11,1,0,0)],['cron 0 12 * * 7',L(2026,10,29,12,0),L(2026,11,1,12,0)]];
 for(const [expr,after,want] of more) assert.equal(nextAfter(parseWhen(expr),after),want,expr);
 assert.equal(lastDue(parseWhen('daily 09:00'),L(2026,10,29,9,0),L(2026,10,29,12,0)),null);
 for(const [s,err] of [['every 10s','when-duration'],['cron 0 9 * *','cron-fields'],['on alert','on-unavailable']]) assert.equal(parseWhen(s).error,err);
 for(const [s,err] of [['daily 25:00','when-time'],['sometimes','when-unknown'],['on nothing','on-unknown'],['cron 99 9 * * *','cron-field']]) assert.equal(parseWhen(s).error,err);
 assert.deepEqual(parseWhen(''),{kind:'manual'});
});
test('front matter updates preserve body and parsed defaults',()=>{
 assert.equal(setField('---\nname: x\nwhen: hourly\n---\n\nDo it.\n','paused','true'),'---\nname: x\nwhen: hourly\npaused: true\n---\n\nDo it.\n'); assert.equal(setField('Do it.','when','hourly'),'---\nwhen: hourly\n---\n\nDo it.\n');
 const r=parseRoutine('morning-sweep','/r/morning-sweep.md','---\nname: Morning sweep\nwhen: weekdays 09:00\ncwd: ~/work\ntools: Read, Bash(gh pr list:*)\nmodel: sonnet\nbudget: $0.50/week\nnotify: failed\n---\n\nSum up my PRs.\n',{home:'/Users/u'});
 for(const [k,v] of Object.entries({name:'Morning sweep',body:'Sum up my PRs.',cwd:'/Users/u/work',tools:['Read','Bash(gh pr list:*)'],budget:0.5,timeout:30,notify:'failed',run:'agent',catchUp:720})) assert.deepEqual(r[k],v);
 assert.equal(slugFor('Sum up my PRs!',[]),'sum-up-my-prs'); assert.equal(slugFor('Sum up my PRs!',['sum-up-my-prs']),'sum-up-my-prs-2');
});
