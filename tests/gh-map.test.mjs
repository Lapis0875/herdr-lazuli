import {test} from 'node:test'; import assert from 'node:assert/strict';
import {mapGithub,mapRuns,buildQuery,failedTests,ghError,diffEvents} from '../mods/lazuli/core/gh-map.js';
const node={__typename:'PullRequest',number:4,title:'Google sign-in',url:'https://github.com/acme/api/pull/4',isDraft:false,updatedAt:'2026-10-27T15:53:26Z',headRefName:'me/eng-401-login',baseRefName:'main',body:'Fixes https://linear.app/acme/issue/ENG-401/x',repository:{name:'api',nameWithOwner:'acme/api'},author:{__typename:'User',login:'me',name:'Me Too'},reviewDecision:'CHANGES_REQUESTED',reviewThreads:{nodes:[{isResolved:false},{isResolved:true}]},commits:{nodes:[{commit:{oid:'c0ffee4',committedDate:'2026-10-27T15:50:00Z',statusCheckRollup:{state:'FAILURE',contexts:{nodes:[{databaseId:111,name:'lint',status:'COMPLETED',conclusion:'FAILURE',detailsUrl:'https://x/1',checkSuite:{workflowRun:{databaseId:900}}},{context:'ci/circleci: test',state:'ERROR',targetUrl:'https://x/2'},{databaseId:112,name:'build',status:'COMPLETED',conclusion:'SUCCESS',checkSuite:{workflowRun:{databaseId:900}}}]}}}}]}};
test('contract mapping and safety',()=>{
 const g=mapGithub({review:{nodes:[]},direct:{nodes:[]},mine:{nodes:[node]},merged:{nodes:[]}});
 assert.deepEqual(g.mine[0],{repo:'api',slug:'acme/api',number:4,title:'Google sign-in',url:'https://github.com/acme/api/pull/4',author:'me',authorName:'Me Too',updatedAt:'2026-10-27T15:53:26Z',isDraft:false,isDirect:false,review:'CHANGES_REQUESTED',ci:'FAILURE',failedChecks:['lint','ci/circleci: test'],threads:1,branch:'me/eng-401-login',base:'main',body:'Fixes https://linear.app/acme/issue/ENG-401/x'});
 assert.deepEqual(mapRuns([node]),[{repo:'api',slug:'acme/api',branch:'me/eng-401-login',runId:'c0ffee4',createdAt:'2026-10-27T15:50:00Z',isRunning:false,outcome:'failed',done:3,total:3,pr:'https://github.com/acme/api/pull/4',workflowId:'900',failed:{job:'lint',jobId:'111',tests:[],logs:'gh run view --job 111 --log-failed -R acme/api'}}]);
 const q=buildQuery({orgs:['acme" evil'],mergedSince:'2026-09-28'}); assert.ok(q.includes('author:@me org:acmeevil"')); assert.ok(q.includes('merged:>=2026-09-28')); assert.ok(!buildQuery({orgs:[],mergedSince:'2026-09-28'}).includes('org:'));
 assert.deepEqual(failedTests('b\tTest\t2026-01-01T00:00:00Z not ok 3 - parses cron\nb\tTest\t2026-01-01T00:00:01Z FAILED tests/test_a.py::test_x - AssertionError\nb\tTest\t2026-01-01T00:00:02Z --- FAIL: TestSum (0.00s)'),['parses cron','tests/test_a.py::test_x','TestSum']); assert.deepEqual(diffEvents(null,g),[]); assert.equal(ghError({code:0,stderr:''}),null); assert.equal(ghError({code:1,stderr:'gh auth login'}).kind,'auth');
});

test('review split, bots, missing checks and merge commit filtering',()=>{
 const direct={...node,url:'https://github.com/acme/api/pull/1',number:1};
 const team={...node,url:'https://github.com/acme/api/pull/2',number:2,commits:{nodes:[]}};
 const bot={...node,url:'https://github.com/acme/api/pull/3',number:3,author:{__typename:'Bot',login:'bot'}};
 const merged={...node,mergeCommit:{oid:'abc'},mergedAt:'2026-10-28T00:00:00Z'};
 const g=mapGithub({review:{nodes:[direct,team,bot]},direct:{nodes:[direct]},mine:{nodes:[]},merged:{nodes:[merged,{...merged,mergeCommit:null}]}});
 assert.deepEqual(g.direct.map(p=>p.number),[1]); assert.deepEqual(g.team.map(p=>p.number),[2]); assert.deepEqual(g.botRepos,['api']);
 assert.equal(g.team[0].ci,null); assert.deepEqual(g.team[0].failedChecks,[]);
 assert.equal(g.merged.length,1); assert.equal(g.merged[0].mergeSha,'abc'); assert.deepEqual(mapRuns([team]),[]);
});
test('rollup state and total include checks beyond the first page',()=>{
 const N=(state,more,nodes)=>({headRefName:'b',repository:{name:'api',nameWithOwner:'acme/api'},commits:{nodes:[{commit:{oid:'c1',statusCheckRollup:{state,contexts:{totalCount:31,pageInfo:{hasNextPage:more},nodes}}}}]}});
 const P=Array.from({length:30},(_,index)=>{const i=index+1;return {databaseId:100+i,name:`c${i}`,status:'COMPLETED',conclusion:'SUCCESS',checkSuite:{workflowRun:{databaseId:900}}};});
 const F={databaseId:131,name:'c31',status:'COMPLETED',conclusion:'FAILURE',checkSuite:{workflowRun:{databaseId:931}}};
 const hidden=mapRuns([N('FAILURE',true,P)])[0];
 assert.equal(hidden.outcome,'failed'); assert.equal(hidden.isRunning,false); assert.equal(hidden.done,31); assert.equal(hidden.total,31); assert.ok(!Object.hasOwn(hidden,'failed')); assert.ok(!Object.hasOwn(hidden,'workflowId'));
 const listed=mapRuns([N('FAILURE',false,[...P,F])])[0];
 assert.equal(listed.outcome,'failed'); assert.equal(listed.workflowId,'931'); assert.equal(listed.done,31); assert.equal(listed.total,31);
 assert.deepEqual(listed.failed,{job:'c31',jobId:'131',tests:[],logs:'gh run view --job 131 --log-failed -R acme/api'});
 const pending=mapRuns([N('PENDING',true,P)])[0]; assert.equal(pending.isRunning,true); assert.equal(pending.outcome,'running'); assert.equal(pending.done,30); assert.equal(pending.total,31);
 const success=mapRuns([N('SUCCESS',true,P)])[0]; assert.equal(success.outcome,'succeeded'); assert.equal(success.done,31); assert.equal(success.total,31);
});
test('run PR identity and paginated review threads remain distinct',()=>{
 const u4='https://github.com/acme/api/pull/4',u5='https://github.com/acme/api/pull/5';
 const first={...node,url:u4,headRefName:'fix'};
 const second={...first,url:u5,commits:{nodes:[{commit:{...node.commits.nodes[0].commit,oid:'other'}}]}};
 assert.equal(mapRuns([first])[0].pr,u4);
 assert.deepEqual(mapRuns([first,second]).map(r=>({pr:r.pr,runId:r.runId})),[{pr:u4,runId:'c0ffee4'},{pr:u5,runId:'other'}]);
 const resolved=Array.from({length:50},()=>({isResolved:true}));
 const mapped=reviewThreads=>mapGithub({mine:{nodes:[{...node,reviewThreads}]}}).mine[0];
 const partial=mapped({pageInfo:{hasNextPage:true},nodes:resolved});
 assert.equal(partial.threads,0); assert.equal(partial.threadsPartial,true);
 for(const reviewThreads of [{pageInfo:{hasNextPage:false},nodes:resolved},{nodes:resolved}]) {
  const complete=mapped(reviewThreads); assert.equal(complete.threads,0); assert.ok(!Object.hasOwn(complete,'threadsPartial'));
 }
 const complete=mapped({pageInfo:{hasNextPage:false},nodes:[...resolved,{isResolved:false}]});
 assert.equal(complete.threads,1); assert.ok(!Object.hasOwn(complete,'threadsPartial'));
 const query=buildQuery({orgs:[],mergedSince:'x'});
 assert.ok(query.includes('reviewThreads(first: 50) { totalCount pageInfo { hasNextPage endCursor }'));
 assert.ok(query.includes('headRepository { nameWithOwner }'));
 const review=query.slice(query.indexOf('review: search('),query.indexOf('direct: search('));
 assert.ok(review.includes('review-requested:@me'));
 assert.ok(review.includes('headRefOid headRepository { nameWithOwner }'));
});