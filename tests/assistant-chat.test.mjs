import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyChat, reduce, isRunning, rows, queueHead, canAnswer, approvalButtons, MAX_ITEMS, MAX_MESSAGE, MAX_TOOL_TEXT, EXPIRY_GRACE_MS, NO_REPLY,
} from '../mods/lazuli/core/assistant-chat.js';

// Shapes as Hermes 0.17.0 sends them (docs/spikes/S9/*.jsonl, acp_adapter/tools.py, permissions.py).
const KEY = 'default/4733fa10-9a37-48dc-b388-7db72fdbd59b';
const live = () => emptyChat(KEY, { loaded: true });
const run = (s, events, now = 0) => events.reduce((st, e) => reduce(st, e, now), s);
const upd = (update) => ({ type: 'update', update });
const say = (text) => upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const think = (text) => upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const text = (t) => ({ type: 'content', content: { type: 'text', text: t } });
const toolCall = (id, extra = {}) => upd({ sessionUpdate: 'tool_call', toolCallId: id, title: 'ls', kind: 'execute', content: [text('$ ls')], ...extra });
const toolUpd = (id, extra) => upd({ sessionUpdate: 'tool_call_update', toolCallId: id, ...extra });
const types = (s) => s.items.map((i) => i.type);
const ids = (list) => list.map((o) => o.optionId);
const ACK = '\u23E9 Steer queued for the active turn: go left';

const FIVE = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  { optionId: 'deny_always', name: 'Deny always', kind: 'reject_always' },
];
const ask = (requestId, at, options = FIVE) => ({
  type: 'permission', requestId, at, options,
  toolCall: { toolCallId: 'perm-check-1', title: 'rm -r scratch', kind: 'execute', status: 'pending', content: [text('$ rm -r scratch')] },
});
const DIFF = { type: 'diff', path: '/tmp/lz/notes.md', oldText: 'a', newText: 'b' };
const editPermission = (requestId, at) => ({
  type: 'permission', requestId, at,
  toolCall: { toolCallId: 'edit-approval-1', title: 'Approve edit: /tmp/lz/notes.md', kind: 'edit', status: 'pending', content: [DIFF] },
  options: [{ optionId: 'allow_once', name: 'Allow edit', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
});

test('emptyChat and unknown events', () => {
  const s = emptyChat(KEY);
  assert.equal(s.profile, 'default');
  assert.equal(s.sessionId, '4733fa10-9a37-48dc-b388-7db72fdbd59b');
  assert.equal(s.agent, 'hermes');
  assert.equal(s.loaded, false);
  assert.equal(s.stale, false);
  assert.deepEqual([s.items, s.inflight, s.queue, s.permissions, s.commands], [[], {}, [], {}, []]);
  assert.deepEqual(s.usage, { context: null, lastTurn: null, stats: null });
  assert.equal(isRunning(s), false);
  assert.equal(reduce(s, { type: 'nope' }, 0), s);
  assert.equal(reduce(s, null, 0), s);
  assert.equal(reduce(s, { type: 'prompt-done', requestId: 'c:9', stopReason: 'end_turn' }, 0), s);
});

test('rule 1: chunks extend the last streaming item of their kind; any other item ends it', () => {
  let s = run(live(), [think('a'), think('b'), say('Hel'), say('lo')]);
  assert.deepEqual(s.items.map(({ type, text: t, streaming }) => ({ type, text: t, streaming })), [
    { type: 'thought', text: 'ab', streaming: false },
    { type: 'assistant', text: 'Hello', streaming: true },
  ]);
  s = run(s, [toolCall('t1'), say('more')]);
  assert.deepEqual(types(s), ['thought', 'assistant', 'tool', 'assistant']);
  assert.equal(s.items[1].streaming, false);
  assert.equal(s.items[3].text, 'more');
  assert.equal(s.items[3].streaming, true);
  // negative: a thought chunk never extends an assistant message, nor the other way round
  s = run(s, [think('x'), say('y')]);
  assert.deepEqual(types(s).slice(-2), ['thought', 'assistant']);
  assert.equal(s.items.at(-2).streaming, false);
  // an update to an existing tool is not a new item: streaming goes on
  s = reduce(s, toolUpd('t1', { status: 'completed' }), 5);
  assert.equal(s.items.at(-1).streaming, true);
  // empty and non-text chunks change nothing
  assert.equal(reduce(s, say(''), 6), s);
  assert.equal(reduce(s, upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }), 6), s);
});

test('rule 2: tool_call_update replaces the fields it carries; duration only for live items', () => {
  let s = reduce(live(), toolCall('t1', { locations: [{ path: '/tmp/a', line: 3 }] }), 1000);
  let t = s.items[0];
  assert.equal(t.status, 'pending');
  assert.equal(t.startedAt, 1000);
  assert.equal(t.endedAt, null);
  assert.deepEqual(t.content, [{ type: 'text', text: '$ ls' }]);
  s = reduce(s, toolUpd('t1', { status: 'in_progress' }), 1200);
  t = s.items[0];
  assert.equal(t.status, 'in_progress');
  assert.equal(t.title, 'ls');
  assert.deepEqual(t.content, [{ type: 'text', text: '$ ls' }]);
  assert.deepEqual(t.locations, [{ path: '/tmp/a', line: 3 }]);
  assert.equal(t.endedAt, null);
  assert.equal(rows(s)[0].duration, null);
  s = reduce(s, toolUpd('t1', { status: 'completed', title: 'ls -1', content: [text('a\nb')], rawOutput: 'a\nb' }), 2500);
  t = s.items[0];
  assert.equal(t.title, 'ls -1');
  assert.equal(t.kind, 'execute');
  assert.deepEqual(t.content, [{ type: 'text', text: 'a\nb' }]);
  assert.equal(t.input, '$ ls'); // kept from the start
  assert.equal(t.rawOutput, 'a\nb');
  assert.equal(t.endedAt, 2500);
  // raw arguments, when the agent sends them, are the input; an update carrying new ones replaces it
  let g = reduce(live(), toolCall('g1', { title: 'mcp_x', kind: 'other', content: [text('{"a": 1}')], rawInput: { a: 1 } }), 0);
  assert.deepEqual(g.items[0].input, { a: 1 });
  g = reduce(g, toolUpd('g1', { rawInput: { a: 2 } }), 1);
  assert.deepEqual(g.items[0].input, { a: 2 });
  assert.equal(reduce(live(), toolCall('r0', { title: 'Read notes.md', kind: 'read', content: undefined }), 0).items[0].input, null);
  assert.equal(rows(s)[0].duration, 1500);
  // a later update does not move the end time
  s = reduce(s, toolUpd('t1', { status: 'completed' }), 9000);
  assert.equal(rows(s)[0].duration, 1500);
  // an update for an unknown id changes nothing
  assert.equal(reduce(s, toolUpd('nope', { status: 'failed' }), 9000), s);
  // replayed items never get a duration
  const r = run(emptyChat(KEY), [toolCall('r1'), toolUpd('r1', { status: 'completed' })], 5000);
  assert.equal(r.items[0].replayed, true);
  assert.equal(r.items[0].startedAt, null);
  assert.equal(r.items[0].endedAt, null);
  assert.equal(rows(r)[0].duration, null);
});

test('rule 3: an edit approval attaches its diff to the newest unfinished edit tool with the same path', () => {
  const editTool = (id, path) => toolCall(id, { title: 'Edit', kind: 'edit', locations: [{ path }], content: [text('Preparing write')] });
  let s = run(live(), [editTool('e1', '/tmp/lz/notes.md'), editTool('e2', '/tmp/lz/notes.md'), editTool('e3', '/tmp/lz/other.md')], 100);
  s = reduce(s, editPermission(7, 200), 200);
  assert.equal(s.items[0].diff, null);
  assert.deepEqual(s.items[1].diff, { path: '/tmp/lz/notes.md', oldText: 'a', newText: 'b' });
  assert.equal(s.items[2].diff, null);
  // the diff stays when the completion replaces the content
  s = reduce(s, toolUpd('e2', { status: 'completed', content: [text('Wrote 1 line')] }), 300);
  assert.deepEqual(s.items[1].diff, { path: '/tmp/lz/notes.md', oldText: 'a', newText: 'b' });
  assert.deepEqual(s.items[1].content, [{ type: 'text', text: 'Wrote 1 line' }]);
  // negative: a finished edit, another kind, not an edit approval, a replayed item
  let n = run(live(), [editTool('f1', '/tmp/lz/notes.md'), toolUpd('f1', { status: 'completed' })], 100);
  assert.equal(reduce(n, editPermission(8, 200), 200).items[0].diff, null);
  n = reduce(live(), toolCall('x1', { kind: 'execute', locations: [{ path: '/tmp/lz/notes.md' }] }), 100);
  assert.equal(reduce(n, editPermission(9, 200), 200).items[0].diff, null);
  n = reduce(live(), editTool('g1', '/tmp/lz/notes.md'), 100);
  const notEdit = { ...editPermission(10, 200), toolCall: { toolCallId: 'perm-check-2', title: 'x', kind: 'execute', content: [DIFF] } };
  assert.equal(reduce(n, notEdit, 200).items[0].diff, null);
  n = run(emptyChat(KEY), [editTool('h0', '/tmp/lz/notes.md'), { type: 'loaded' }], 100);
  assert.equal(reduce(n, editPermission(11, 200), 200).items[0].diff, null);
  // the path is compared normalized
  n = reduce(live(), editTool('h1', '/tmp/lz/./notes.md'), 100);
  assert.equal(reduce(n, editPermission(12, 200), 200).items[0].diff.path, '/tmp/lz/notes.md');
});

test('rule 4: the deadline is 60 s after the bridge received the request', () => {
  const s = reduce(live(), ask('b:1', 1000), 5000); // `at` comes from the event, not from now
  const p = s.permissions['b:1'];
  assert.equal(p.at, 1000);
  assert.equal(p.deadline, 61000);
  assert.equal(p.state, 'pending');
  assert.equal(reduce(s, { type: 'tick' }, 60999), s); // 59,999 ms: unchanged
  assert.equal(reduce(s, { type: 'tick' }, 61000).permissions['b:1'].state, 'expired'); // 60,000 ms
  assert.equal(reduce(s, { type: 'tick' }, 61001).permissions['b:1'].state, 'expired'); // 60,001 ms
  assert.deepEqual(canAnswer(s, 'b:1', 60999), { ok: true, permission: p });
  assert.deepEqual(canAnswer(s, 'b:1', 61000), { error: 'too-late' });
  assert.deepEqual(canAnswer(s, 'b:1', 61001), { error: 'too-late' });
  assert.deepEqual(canAnswer(s, 'b:9', 1000), { error: 'not-found' });
  assert.deepEqual(canAnswer(s, 'b:1', 2000, 'maybe'), { error: 'not-found' });
  assert.equal(canAnswer(s, 'b:1', 2000, 'deny_always').ok, true);
  // an answer in time
  const ok = reduce(s, { type: 'permission-answered', requestId: 'b:1', optionId: 'allow_once' }, 60999);
  assert.equal(ok.permissions['b:1'].state, 'answered');
  assert.equal(ok.permissions['b:1'].optionId, 'allow_once');
  assert.deepEqual(canAnswer(ok, 'b:1', 61000), { error: 'too-late' });
  assert.equal(reduce(ok, { type: 'permission-answered', requestId: 'b:1', optionId: 'deny' }, 61000), ok);
  // an answer at the deadline is refused with a notice, before or after the tick
  const late = reduce(s, { type: 'permission-answered', requestId: 'b:1', optionId: 'deny' }, 61000);
  assert.equal(late.permissions['b:1'].state, 'expired');
  assert.equal(late.permissions['b:1'].optionId, null);
  assert.deepEqual(late.items.at(-1), { type: 'notice', code: 'too-late', seq: 0 });
  const late2 = run(s, [{ type: 'tick' }, { type: 'permission-answered', requestId: 'b:1', optionId: 'deny' }], 61001);
  assert.equal(late2.permissions['b:1'].state, 'expired');
  assert.equal(late2.items.at(-1).code, 'too-late');
  // lazuli cancelling a card (no option) adds no notice
  const cancelled = reduce(s, { type: 'permission-answered', requestId: 'b:1' }, 2000);
  assert.equal(cancelled.permissions['b:1'].state, 'cancelled');
  assert.deepEqual(cancelled.items, []);
  const lateCancel = reduce(s, { type: 'permission-answered', requestId: 'b:1', optionId: null }, 61000);
  assert.equal(lateCancel.permissions['b:1'].state, 'expired');
  assert.deepEqual(lateCancel.items, []);
  // without a receive time, `at` is now
  assert.equal(reduce(live(), { ...ask(3, 0), at: undefined }, 700).permissions['3'].deadline, 60700);
});

test('rule 4: an approval the agent gives up at its own 60 s ends expired, and a late answer is too late (AT-08)', () => {
  const turn = (requestId, at) => run(live(), [{ type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'approve four' }, ask(requestId, at)], at);
  // The agent's 60 s started a moment before the bridge received the request: its turn ends just before the deadline.
  let s = reduce(turn('b:1', 1000), { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 60995);
  assert.equal(s.permissions['b:1'].state, 'expired');
  for (const t of [60995, 61000, 61001]) assert.deepEqual(canAnswer(s, 'b:1', t, 'deny'), { error: 'too-late' });
  const late = reduce(s, { type: 'permission-answered', requestId: 'b:1', optionId: 'deny' }, 61001);
  assert.equal(late.permissions['b:1'].state, 'expired');
  assert.deepEqual(late.items.at(-1), { type: 'notice', code: 'too-late', seq: late.items.at(-1).seq });
  // at or after the deadline, and through a failed request too
  assert.equal(reduce(turn('b:2', 0), { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 60000).permissions['b:2'].state, 'expired');
  assert.equal(reduce(turn('b:3', 0), { type: 'prompt-failed', requestId: 'c:1', error: 'x' }, 61000).permissions['b:3'].state, 'expired');
  // the grace is the edge: a turn that ends earlier closes the card as cancelled
  assert.equal(EXPIRY_GRACE_MS, 2000);
  assert.equal(reduce(turn('b:4', 0), { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 60000 - EXPIRY_GRACE_MS).permissions['b:4'].state, 'expired');
  const early = reduce(turn('b:5', 0), { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 60000 - EXPIRY_GRACE_MS - 1);
  assert.equal(early.permissions['b:5'].state, 'cancelled');
  // a cancelled card is refused as too late whatever the time, and the late answer says so
  for (const t of [1000, 59999, 61000]) assert.deepEqual(canAnswer(early, 'b:5', t, 'deny'), { error: 'too-late' });
  const refused = reduce(early, { type: 'permission-answered', requestId: 'b:5', optionId: 'deny' }, 61000);
  assert.equal(refused.permissions['b:5'].state, 'cancelled');
  assert.equal(refused.items.at(-1).code, 'too-late');
  // an unknown request stays not-found
  assert.deepEqual(canAnswer(early, 'b:9', 1000, 'deny'), { error: 'not-found' });
});

test('rule 4: an answer sent while the card was open stays its answer when the send\'s reply comes after the deadline', () => {
  const s = reduce(live(), ask('b:1', 1000), 1000);
  const sent = (requestId, optionId = 'allow_once') => ({ type: 'permission-answered', requestId, optionId, sent: true });
  const tooLate = (st) => st.items.some((i) => i.type === 'notice' && i.code === 'too-late');
  // The reply returns at or after the deadline, with or without a tick having expired the card meanwhile.
  for (const [before, now] of [[[], 61000], [[{ type: 'tick' }], 61500]]) {
    const r = run(s, [...before, sent('b:1')], now);
    assert.deepEqual([r.permissions['b:1'].state, r.permissions['b:1'].optionId, tooLate(r)], ['answered', 'allow_once', false]);
    assert.equal(reduce(r, sent('b:1', 'deny'), now), r, 'answered once');
  }
  // Its turn ended meanwhile: near the deadline (expired) the sent answer is the card's; earlier (cancelled) the card
  // stays cancelled, with no refusal.
  const turn = (requestId) => run(live(), [{ type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'approve' }, ask(requestId, 0)], 0);
  const nearEnd = reduce(turn('b:2'), { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 59000);
  assert.equal(nearEnd.permissions['b:2'].state, 'expired');
  assert.equal(reduce(nearEnd, sent('b:2'), 60100).permissions['b:2'].state, 'answered');
  const early = reduce(turn('b:3'), { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 1000);
  assert.equal(early.permissions['b:3'].state, 'cancelled');
  assert.equal(reduce(early, sent('b:3'), 1200), early);
  // Not sent (refused before sending): still too late.
  const late = run(s, [{ type: 'tick' }, { type: 'permission-answered', requestId: 'b:1', optionId: 'allow_once' }], 61500);
  assert.deepEqual([late.permissions['b:1'].state, tooLate(late)], ['expired', true]);
});

test('approval buttons are chosen by option id (D29)', () => {
  let b = approvalButtons(FIVE);
  assert.deepEqual(ids(b.buttons), ['allow_once', 'allow_always', 'deny']);
  assert.deepEqual(ids(b.more), ['allow_session', 'deny_always']);
  // permanent approval not allowed: no allow_always
  b = approvalButtons(FIVE.filter((o) => o.optionId !== 'allow_always'));
  assert.deepEqual(ids(b.buttons), ['allow_once', 'deny']);
  assert.deepEqual(ids(b.more), ['allow_session', 'deny_always']);
  // allow_session carries kind allow_always but is never a button
  b = approvalButtons([FIVE[1], FIVE[3]]);
  assert.deepEqual(ids(b.buttons), ['deny']);
  assert.deepEqual(ids(b.more), ['allow_session']);
  // an unknown id goes in More whatever its kind; buttons keep the agent's order
  b = approvalButtons([{ optionId: 'deny', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_once' }, { optionId: 'allow_once', kind: 'allow_once' }]);
  assert.deepEqual(ids(b.buttons), ['allow_once', 'deny']);
  assert.deepEqual(ids(b.more), ['yes']);
  // an edit approval shows the two options it carries
  b = approvalButtons(editPermission(1, 0).options);
  assert.deepEqual(ids(b.buttons), ['allow_once', 'deny']);
  assert.deepEqual(b.more, []);
  assert.deepEqual(approvalButtons(null), { buttons: [], more: [] });
  // permission rows carry them
  const row = rows(reduce(live(), ask('b:2', 0), 0)).find((r) => r.type === 'permission');
  assert.deepEqual(ids(row.buttons), ['allow_once', 'allow_always', 'deny']);
  assert.deepEqual(ids(row.more), ['allow_session', 'deny_always']);
  assert.equal(row.edit, false);
  const edit = rows(reduce(live(), editPermission('b:3', 0), 0)).find((r) => r.type === 'permission');
  assert.equal(edit.edit, true);
  assert.deepEqual(edit.content, [{ type: 'diff', path: '/tmp/lz/notes.md', oldText: 'a', newText: 'b' }]);
});

test('rule 5: a steer answer becomes a notice and acknowledges the steer', () => {
  let s = run(live(), [
    { type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'slow' },
    say('one '),
    { type: 'prompt-sent', requestId: 'c:2', kind: 'steer', text: 'go left' },
  ]);
  assert.equal(isRunning(s), true);
  const steerRow = rows(s).at(-1);
  assert.equal(steerRow.via, 'steer');
  assert.equal(steerRow.sending, true);
  s = reduce(s, say(ACK), 10);
  assert.deepEqual(types(s), ['user', 'assistant', 'user', 'notice']);
  assert.deepEqual(s.items.at(-1), { type: 'notice', code: 'steer-ack', vars: { preview: 'go left' }, seq: 3 });
  assert.equal(s.inflight['c:2'].acked, true);
  assert.equal(rows(s).find((x) => x.via === 'steer').sending, false);
  assert.ok(!s.items.some((i) => i.type === 'assistant' && i.text.includes('Steer queued')));
  // the stream goes on in a new message
  s = reduce(s, say('two'), 20);
  assert.deepEqual(types(s), ['user', 'assistant', 'user', 'notice', 'assistant']);
  assert.equal(s.items[1].text, 'one ');
  assert.equal(s.items[1].streaming, false);
  // the steer's own response ends it; the turn still runs
  s = reduce(s, { type: 'prompt-done', requestId: 'c:2', stopReason: 'end_turn' }, 30);
  assert.equal(isRunning(s), true);
  assert.equal(s.items.at(-1).streaming, true);
  // with no steer waiting, the same text is ordinary assistant text
  s = reduce(s, say(ACK), 40);
  assert.equal(s.items.at(-1).type, 'assistant');
  assert.ok(s.items.at(-1).text.endsWith(ACK));
});

test('rule 5 negatives and the other steer answers', () => {
  const base = run(live(), [
    { type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'slow' },
    { type: 'prompt-sent', requestId: 'c:2', kind: 'steer', text: 'go' },
  ]);
  // a reply starting "Queued" is not an acknowledgement
  let s = reduce(base, say('Queued for the next turn. (1 queued)'), 1);
  assert.equal(s.items.at(-1).type, 'assistant');
  assert.equal(s.inflight['c:2'].acked, false);
  assert.equal(rows(s).find((x) => x.via === 'steer').sending, true);
  // nor is an answer that does not start the chunk
  s = reduce(base, say(`ok ${ACK}`), 1);
  assert.equal(s.items.at(-1).type, 'assistant');
  assert.equal(s.inflight['c:2'].acked, false);
  for (const [t, code, vars] of [
    ['No active turn \u2014 queued for the next turn. (1 queued)', 'steer-queued', { depth: 1 }],
    ['\u26A0\uFE0F Steer failed: boom', 'steer-failed', { detail: 'boom' }],
    ['Usage: /steer <guidance>', 'steer-failed', { detail: 'Usage: /steer <guidance>' }],
  ]) {
    s = reduce(base, say(t), 1);
    assert.deepEqual(s.items.at(-1), { type: 'notice', code, vars, seq: 2 }, code);
    assert.equal(s.inflight['c:2'].acked, true);
  }
  // two steers: the oldest is acknowledged first
  s = run(base, [{ type: 'prompt-sent', requestId: 'c:3', kind: 'steer', text: 'go 2' }, say(ACK)], 2);
  assert.equal(s.inflight['c:2'].acked, true);
  assert.equal(s.inflight['c:3'].acked, false);
});

test('rule 6: running is any request not yet acknowledged', () => {
  // a steer on an idle session counts as running (Hermes runs it as a prompt)
  let s = reduce(live(), { type: 'prompt-sent', requestId: 'c:1', kind: 'steer', text: 'go left' }, 0);
  assert.equal(isRunning(s), true);
  s = reduce(s, { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }, 5);
  assert.equal(isRunning(s), false);
  assert.deepEqual(s.usage.lastTurn, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  // a command runs until its response; it has no usage, so the last turn's stays
  s = run(s, [
    { type: 'prompt-sent', requestId: 'c:2', kind: 'command', text: '/help' },
    say('Available commands:'),
  ], 6);
  assert.equal(isRunning(s), true);
  s = reduce(s, { type: 'prompt-done', requestId: 'c:2', stopReason: 'end_turn' }, 7);
  assert.equal(isRunning(s), false);
  assert.equal(s.items.at(-1).streaming, false);
  assert.deepEqual(s.usage.lastTurn, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  // an in-flight entry restored without text adds no item
  s = reduce(live(), { type: 'prompt-sent', requestId: 'c:9', kind: 'prompt' }, 0);
  assert.deepEqual(s.items, []);
  assert.equal(isRunning(s), true);
  // the end of the turn cancels open approval cards
  s = run(live(), [{ type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'approve' }, ask('b:1', 0)]);
  s = reduce(s, { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 10);
  assert.equal(s.permissions['b:1'].state, 'cancelled');
  assert.deepEqual(canAnswer(s, 'b:1', 20), { error: 'too-late' });
  // failures and other stop reasons become notices
  s = run(live(), [
    { type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'fail' },
    { type: 'prompt-failed', requestId: 'c:1', error: { code: -32603, message: 'Internal error' } },
  ]);
  assert.equal(isRunning(s), false);
  assert.deepEqual(s.items.at(-1), { type: 'notice', code: 'failed', vars: { detail: 'Internal error (-32603)' }, seq: 1 });
  assert.deepEqual(s.lastError, { code: -32603, message: 'Internal error' });
  s = run(live(), [{ type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'x' }, { type: 'prompt-done', requestId: 'c:1', stopReason: 'refusal' }]);
  assert.deepEqual(s.items.at(-1), { type: 'notice', code: 'stopped', vars: { detail: 'refusal' }, seq: 1 });
});

test('rule 6: the queue head is sent once the last request ends, not while paused', () => {
  let s = run(live(), [
    { type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'slow' },
    { type: 'queued', text: 'next one' },
    { type: 'queued', text: 'next two', chipId: 'k2' },
    { type: 'queued', text: '   ' },
  ]);
  assert.deepEqual(s.queue.map((c) => c.text), ['next one', 'next two']);
  assert.equal(s.queue[1].id, 'k2');
  assert.notEqual(s.queue[0].id, s.queue[1].id);
  assert.equal(queueHead(s), null); // running
  s = reduce(s, { type: 'unqueued', chipId: 'k2' }, 1);
  assert.deepEqual(s.queue.map((c) => c.text), ['next one']);
  s = reduce(s, { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }, 2);
  assert.equal(isRunning(s), false);
  assert.equal(queueHead(s).text, 'next one');
  s = reduce(s, { type: 'queue-flush', requestId: 'c:2' }, 3);
  assert.deepEqual(s.queue, []);
  assert.equal(isRunning(s), true);
  const sentItem = s.items.at(-1);
  assert.deepEqual([sentItem.type, sentItem.text, sentItem.via], ['user', 'next one', 'queue']);
  assert.equal(s.inflight['c:2'].kind, 'prompt');
  // Stop pauses the chips
  s = run(s, [{ type: 'queued', text: 'later' }, { type: 'queue-paused' }, { type: 'prompt-done', requestId: 'c:2', stopReason: 'cancelled' }], 4);
  assert.equal(s.items.at(-1).code, 'cancelled');
  assert.equal(s.queuePaused, true);
  assert.equal(queueHead(s), null);
  assert.deepEqual(s.queue.map((c) => c.text), ['later']);
  // a new message resumes them after its turn
  s = run(s, [{ type: 'queue-resumed' }, { type: 'prompt-sent', requestId: 'c:3', kind: 'prompt', text: 'new' }], 5);
  assert.equal(queueHead(s), null);
  s = reduce(s, { type: 'prompt-done', requestId: 'c:3', stopReason: 'end_turn' }, 6);
  assert.equal(queueHead(s).text, 'later');
  // nothing to flush, or no request id: unchanged
  assert.equal(reduce(live(), { type: 'queue-flush', requestId: 'c:4' }, 7).items.length, 0);
  assert.equal(reduce(s, { type: 'queue-flush' }, 7), s);
});

test('rule 7: load-start clears items and plan; items are replayed until loaded', () => {
  let s = run(live(), [say('old'), upd({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'pending' }] })]);
  assert.equal(s.plan.entries.length, 1);
  s = reduce(s, { type: 'load-start' }, 10);
  assert.deepEqual(s.items, []);
  assert.equal(s.plan, null);
  assert.equal(s.loaded, false);
  s = run(s, [
    upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }),
    think('t'), say('one'), say('two'),
    toolCall('r1'), toolUpd('r1', { status: 'completed', content: [text('out')] }),
  ], 20);
  assert.deepEqual(types(s), ['user', 'thought', 'assistant', 'assistant', 'tool']);
  assert.ok(s.items.every((i) => i.replayed === true));
  assert.ok(s.items.every((i) => i.streaming !== true));
  assert.equal(s.items[0].via, 'replay');
  s = reduce(s, { type: 'loaded', models: { currentModelId: 'm', availableModels: [] }, modes: { currentModeId: 'default', availableModes: [] } }, 30);
  assert.equal(s.loaded, true);
  assert.equal(s.models.currentModelId, 'm');
  assert.equal(s.modes.currentModeId, 'default');
  s = reduce(s, say('live'), 40);
  assert.equal(s.items.at(-1).replayed, undefined);
  assert.equal(s.items.at(-1).streaming, true);
  // live, a user chunk is a prompt Hermes queued itself
  const q = reduce(live(), upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'queued by hermes' } }), 0);
  assert.equal(q.items[0].via, 'queue');
});

test('rule 8: gap and disconnected set stale and end streaming', () => {
  for (const type of ['gap', 'disconnected']) {
    let s = run(live(), [{ type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'x' }, say('par')]);
    s = reduce(s, { type }, 1);
    assert.equal(s.stale, true, type);
    assert.equal(s.items[1].text, 'par');
    assert.equal(s.items[1].streaming, false);
    assert.equal(isRunning(s), true);
    // a gap says so once; a lost connection shows in the bridge state, not in the transcript
    assert.deepEqual(types(s), type === 'gap' ? ['user', 'assistant', 'notice'] : ['user', 'assistant']);
    if (type === 'gap') {
      assert.equal(s.items[2].code, 'gap');
      assert.equal(reduce(s, { type }, 2).items.length, 3);
    }
    s = reduce(s, say('tial'), 2);
    assert.equal(s.items.at(-1).text, 'tial'); // not joined to the ended message
    s = run(s, [{ type: 'load-start' }, { type: 'loaded' }], 3);
    assert.equal(s.stale, false);
  }
  // nothing else sets it
  const s = run(live(), [say('x'), { type: 'tick' }, { type: 'prompt-sent', requestId: 1, kind: 'prompt', text: 'y' }, { type: 'load-start' }]);
  assert.equal(s.stale, false);
});

test('service notices', () => {
  const s = reduce(live(), { type: 'notice', code: 'busy' }, 0);
  assert.deepEqual(s.items, [{ type: 'notice', code: 'busy', seq: 0 }]);
  assert.deepEqual(reduce(s, { type: 'notice', code: 'x', vars: { detail: 'd' } }, 1).items.at(-1), { type: 'notice', code: 'x', vars: { detail: 'd' }, seq: 1 });
  assert.equal(reduce(s, { type: 'notice' }, 1), s);
});

test('rule 9: caps on items, messages and tool text', () => {
  let s = live();
  for (let i = 0; i < MAX_ITEMS + 100; i++) s = reduce(s, toolCall(`t${i}`), i);
  assert.equal(s.items.length, MAX_ITEMS);
  assert.deepEqual([s.items[0].type, s.items[0].code, s.items[0].vars], ['notice', 'dropped', { count: 101 }]);
  assert.equal(s.items.filter((i) => i.code === 'dropped').length, 1);
  assert.equal(s.items[1].id, 't101');
  assert.equal(s.items.at(-1).id, 't2099');
  // finished cards go with their dropped anchor; open ones stay and are drawn last
  let p = run(live(), [toolCall('first'), ask('b:1', 0), ask('b:2', 0)]);
  p = reduce(p, { type: 'permission-answered', requestId: 'b:1', optionId: 'deny' }, 1);
  for (let i = 0; i < MAX_ITEMS; i++) p = reduce(p, toolCall(`n${i}`), 2);
  assert.equal(p.permissions['b:1'], undefined);
  assert.equal(p.permissions['b:2'].state, 'pending');
  assert.equal(rows(p).at(-1).requestId, 'b:2');
  // a message stops at MAX_MESSAGE characters
  let m = reduce(live(), say('x'.repeat(MAX_MESSAGE - 1)), 0);
  assert.equal(m.items[0].truncated, undefined);
  m = reduce(m, say('yz'), 1);
  assert.equal(m.items[0].text.length, MAX_MESSAGE);
  assert.equal(m.items[0].truncated, true);
  assert.ok(m.items[0].text.endsWith('y'));
  assert.equal(reduce(m, say('more'), 2), m);
  const big = reduce(live(), think('z'.repeat(MAX_MESSAGE + 5)), 0);
  assert.equal(big.items[0].text.length, MAX_MESSAGE);
  assert.equal(big.items[0].truncated, true);
  const pair = reduce(live(), say(`${'a'.repeat(MAX_MESSAGE - 1)}\u{1F600}`), 0); // no half surrogate pair
  assert.equal(pair.items[0].text.length, MAX_MESSAGE - 1);
  // tool text stops at MAX_TOOL_TEXT; diffs are kept whole
  const t = reduce(live(), toolCall('t', {
    content: [text('o'.repeat(MAX_TOOL_TEXT + 1)), { type: 'diff', path: '/a', oldText: null, newText: 'd'.repeat(MAX_TOOL_TEXT * 3) }, text('short')],
    rawOutput: 'r'.repeat(MAX_TOOL_TEXT + 1),
  }), 0);
  assert.equal(t.items[0].content[0].text.length, MAX_TOOL_TEXT);
  assert.equal(t.items[0].content[0].truncated, true);
  assert.equal(t.items[0].content[1].newText.length, MAX_TOOL_TEXT * 3);
  assert.deepEqual(t.items[0].content[2], { type: 'text', text: 'short' });
  assert.equal(t.items[0].rawOutput.length, MAX_TOOL_TEXT);
});

test('rule 10: unknown update kinds are ignored and counted', () => {
  const s = run(live(), [
    say('a'),
    upd({ sessionUpdate: 'mystery', x: 1 }),
    upd({}),
    upd({ sessionUpdate: 'config_option_update', configOptions: [] }),
  ]);
  assert.equal(s.unknown, 2);
  assert.deepEqual(types(s), ['assistant']);
  assert.equal(s.items[0].streaming, true);
  assert.equal(reduce(s, { type: 'update', update: 'x' }, 0), s);
});

test('session updates: commands, usage, mode, title, plan, model and stats', () => {
  let s = run(live(), [
    upd({ sessionUpdate: 'available_commands_update', availableCommands: [
      { name: 'help', description: 'List available commands' },
      { name: 'model', description: 'Show current model and provider, or switch models', input: { hint: 'model name to switch to' } },
    ] }),
    upd({ sessionUpdate: 'usage_update', size: 272000, used: 11369 }),
    upd({ sessionUpdate: 'current_mode_update', currentModeId: 'accept_edits' }),
    upd({ sessionUpdate: 'session_info_update', title: 'Weekly review', updatedAt: '2026-11-23T07:20:44+00:00' }),
    upd({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'completed' }, { content: 'b' }, { bad: 1 }] }),
  ]);
  assert.deepEqual(s.commands, [
    { name: 'help', description: 'List available commands', hint: null },
    { name: 'model', description: 'Show current model and provider, or switch models', hint: 'model name to switch to' },
  ]);
  assert.deepEqual(s.usage.context, { size: 272000, used: 11369, cost: null });
  assert.equal(s.modes.currentModeId, 'accept_edits');
  assert.equal(s.title, 'Weekly review');
  assert.equal(s.updatedAt, Date.parse('2026-11-23T07:20:44+00:00'));
  assert.deepEqual(s.plan, { entries: [{ content: 'a', priority: 'high', status: 'completed' }, { content: 'b', priority: 'medium', status: 'pending' }] });
  assert.deepEqual(s.items, []);
  s = reduce(s, { type: 'loaded', models: { currentModelId: 'openai-codex:gpt-5.5', availableModels: [
    { modelId: 'openai-codex:gpt-5.5', name: 'gpt-5.5' }, { modelId: 'openai-codex:gpt-6-sol', name: 'gpt-6-sol' },
  ] } }, 1);
  assert.equal(s.modes.currentModeId, 'accept_edits'); // a load result without modes keeps them
  s = reduce(s, { type: 'model-set', modelId: 'openai-codex:gpt-6-sol' }, 2);
  assert.equal(s.models.currentModelId, 'openai-codex:gpt-6-sol');
  assert.deepEqual(s.items.at(-1), { type: 'notice', code: 'model-set', vars: { model: 'gpt-6-sol' }, seq: 0 });
  s = reduce(s, { type: 'stats', stats: { apiCallCount: 3 } }, 3);
  assert.deepEqual(s.usage.stats, { apiCallCount: 3 });
});

test('rows: permission cards follow the item that was last when they arrived', () => {
  let s = run(live(), [
    { type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'rm' },
    toolCall('t1'),
    ask('b:1', 10),
    say('after'),
  ], 10);
  const r = rows(s);
  assert.deepEqual(r.map((x) => x.type), ['user', 'tool', 'permission', 'assistant']);
  assert.equal(r[2].requestId, 'b:1');
  assert.equal(r[2].state, 'pending');
  assert.equal(r[2].deadline, 60010);
  // load-start drops finished cards and keeps open ones, drawn last
  s = run(s, [{ type: 'permission-answered', requestId: 'b:1', optionId: 'allow_once' }, ask('b:2', 12), { type: 'load-start' }], 12);
  assert.deepEqual(Object.keys(s.permissions), ['b:2']);
  s = run(s, [upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'rm' } }), { type: 'loaded' }], 14);
  assert.deepEqual(rows(s).map((x) => x.type), ['user', 'permission']);
});

test('inputs are never changed', () => {
  const s0 = run(live(), [{ type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'x' }, say('a'), toolCall('t1'), ask('b:1', 0), { type: 'queued', text: 'q' }]);
  const before = JSON.stringify(s0);
  run(s0, [
    say('b'), toolUpd('t1', { status: 'completed' }), { type: 'tick' },
    { type: 'permission-answered', requestId: 'b:1', optionId: 'deny' }, { type: 'queued', text: 'q2' }, { type: 'unqueued', chipId: s0.queue[0].id },
    { type: 'queue-paused' }, { type: 'load-start' }, { type: 'disconnected' }, { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' },
  ], 70000);
  rows(s0);
  assert.equal(JSON.stringify(s0), before);
});

test('rule 11: a prompt turn that ends without a reply fails with its newest agent error, or no-reply', () => {
  const sent = (id, text = 'hi') => ({ type: 'prompt-sent', requestId: id, kind: 'prompt', text });
  const end = (id, stopReason = 'end_turn') => ({ type: 'prompt-done', requestId: id, stopReason });
  const err = (text) => ({ type: 'agent-error', text });
  // Hermes's failed turn: error lines on stderr, then end_turn and no message; the newest error is shown
  let s = run(live(), [sent('c:1'), err('Non-retryable error (HTTP 400): model not supported'), err('Non-retryable client error: Error code: 400'), end('c:1')], 5);
  assert.deepEqual(s.items.at(-1), { type: 'notice', code: 'failed', vars: { detail: 'Non-retryable client error: Error code: 400' }, seq: 1 });
  assert.deepEqual(s.lastError, { code: null, message: 'Non-retryable client error: Error code: 400' });
  assert.equal(s.turn, null);
  assert.equal(isRunning(s), false);
  // no error line: a generic detail, which an error line that comes just after fills in (separate pipes)
  s = run(live(), [sent('c:1'), end('c:1')], 5);
  assert.deepEqual([s.items.at(-1).code, s.items.at(-1).vars], ['failed', { detail: NO_REPLY }]);
  const late = reduce(s, err('boom'), 5 + 5000);
  assert.deepEqual(late.items.at(-1), { type: 'notice', code: 'failed', vars: { detail: 'boom' }, seq: 1 });
  assert.deepEqual(late.lastError, { code: null, message: 'boom' });
  assert.equal(reduce(late, err('again'), 5001), late, 'filled once');
  assert.equal(reduce(s, err('boom'), 5 + 5001), s, 'too late');
  const busy = run(s, [{ type: 'notice', code: 'busy' }], 6);
  assert.equal(reduce(busy, err('boom'), 6), busy, 'not the last item');
  const idle = live();
  assert.equal(reduce(idle, err('x'), 0), idle, 'between turns');
  assert.equal(reduce(run(idle, [sent('c:1')]), err('  '), 0).turn.error, null);
  // assistant text, a tool item or a permission is a reply; a thought or usage is not
  for (const reply of [say('ok'), toolCall('t1'), ask('b:1', 0)]) {
    const r = run(live(), [sent('c:1'), err('e'), reply, end('c:1')], 1);
    assert.ok(!r.items.some((i) => i.code === 'failed'), JSON.stringify(reply).slice(0, 60));
  }
  for (const quiet of [think('hmm'), upd({ sessionUpdate: 'usage_update', size: 1, used: 1 })]) {
    assert.equal(run(live(), [sent('c:1'), quiet, end('c:1')], 1).items.at(-1).code, 'failed');
  }
  // only a prompt's turn that ends with end_turn: not a stop, another stop reason, a failure, a command, an idle steer
  assert.equal(run(live(), [sent('c:1'), end('c:1', 'cancelled')]).items.at(-1).code, 'cancelled');
  assert.equal(run(live(), [sent('c:1'), end('c:1', 'max_tokens')]).items.at(-1).code, 'stopped');
  const failedOnce = run(live(), [sent('c:1'), err('e'), { type: 'prompt-failed', requestId: 'c:1', error: { code: -32603, message: 'Internal error' } }]);
  assert.deepEqual(failedOnce.items.filter((i) => i.code === 'failed').map((i) => i.vars.detail), ['Internal error (-32603)']);
  assert.ok(!run(live(), [{ ...sent('c:1', '/help'), kind: 'command' }, end('c:1')]).items.some((i) => i.type === 'notice'));
  assert.ok(!run(live(), [{ ...sent('c:1', 'go'), kind: 'steer' }, end('c:1')]).items.some((i) => i.type === 'notice'));
  // a steer's answer ends the steer, not the turn, and is not the turn's reply
  s = run(live(), [sent('c:1', 'slow'), { ...sent('c:2', 'go left'), kind: 'steer' }, say(ACK), end('c:2')]);
  assert.equal(isRunning(s), true);
  assert.equal(s.turn.reply, false);
  assert.equal(reduce(s, end('c:1'), 1).items.at(-1).code, 'failed');
  // the history a load replays is not the turn's reply
  s = run(live(), [sent('c:1'), { type: 'load-start' }, say('old answer'), toolCall('h1'), { type: 'loaded' }, end('c:1')]);
  assert.equal(s.items.at(-1).code, 'failed');
  // each prompt's turn starts clean
  s = run(live(), [sent('c:1'), err('first'), say('x'), end('c:1'), sent('c:2'), end('c:2')]);
  assert.deepEqual(s.items.at(-1).vars, { detail: NO_REPLY });
});

test('a running turn applied again after its history loads shows once and whole', () => {
  const steer = { type: 'prompt-sent', requestId: 'c:2', kind: 'steer', text: 'go left' };
  const turn = [
    { type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'slow' },
    say('Slow chunk 1/20. '),
    say('Slow chunk 2/20. '),
    steer,
  ];
  let s = run(live(), [...turn, say(ACK)], 1);
  const at = s.inflight['c:1'].at;
  // What the service keeps of the turn: its events, the steer's answer as its notice.
  const log = [...turn, { type: 'notice', code: 'steer-ack', vars: { preview: 'go left' } }];
  s = run(s, [
    { type: 'load-start' },
    upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier' } }),
    say('earlier answer'),
    { type: 'loaded' },
    ...log.map((e) => (e.type === 'prompt-sent' ? { ...e, again: true } : e)),
    say('Slow chunk 3/20. '),
  ], 50);
  assert.deepEqual(types(s), ['user', 'assistant', 'user', 'assistant', 'user', 'notice', 'assistant']);
  assert.deepEqual(s.items.map((i) => i.text ?? i.code), ['earlier', 'earlier answer', 'slow', 'Slow chunk 1/20. Slow chunk 2/20. ', 'go left', 'steer-ack', 'Slow chunk 3/20. ']);
  assert.deepEqual(s.items.map((i) => i.replayed === true), [true, true, false, false, false, false, false]);
  assert.equal(s.items.filter((i) => typeof i.text === 'string' && i.text.includes('Slow chunk 1/20')).length, 1);
  // the requests stay as they were: the prompt running, the steer answered
  assert.deepEqual([s.inflight['c:1'].at, s.inflight['c:1'].acked, s.inflight['c:2'].acked], [at, false, true]);
  assert.equal(isRunning(s), true);
  assert.equal(s.turn.reply, true);
  assert.equal(rows(s).find((r) => r.via === 'steer').sending, false);
  // a prompt already in flight sent again only adds its user item; `again` never starts a request
  const again = reduce(live(), { type: 'prompt-sent', requestId: 'c:9', kind: 'steer', text: 'done before', again: true }, 3);
  assert.deepEqual([again.inflight, isRunning(again), again.items[0].text], [{}, false, 'done before']);
  assert.equal(reduce(s, { type: 'prompt-sent', requestId: 'c:1', kind: 'prompt', text: 'slow' }, 99).inflight['c:1'].at, at);
});

test('a turn that replied ends without lastError even when a steer inside it failed (done, not failed)', () => {
  const sent = (id, kind, text) => ({ type: 'prompt-sent', requestId: id, kind, text });
  const steerFail = { type: 'prompt-failed', requestId: 'c:2', error: { code: -32603, message: 'steer refused' } };
  let s = run(live(), [sent('c:1', 'prompt', 'slow'), say('part one '), sent('c:2', 'steer', 'go left'), steerFail], 1);
  assert.equal(isRunning(s), true);
  assert.deepEqual(s.lastError, { code: -32603, message: 'steer refused' }, 'the refused steer, while the turn runs');
  assert.equal(s.items.at(-1).code, 'failed');
  s = run(s, [say('part two'), { type: 'prompt-done', requestId: 'c:1', stopReason: 'end_turn' }], 2);
  assert.equal(isRunning(s), false);
  assert.equal(s.lastError, null, 'the turn replied: the service raises done (sys/assistant.js onAnswer)');
  assert.equal(s.items.filter((i) => i.code === 'failed').length, 1, 'the steer failure stays in the transcript');
  // A turn stopped or cancelled did not fail either; one that ends without a reply sets its own (rule 11).
  const ended = (stopReason) => run(live(), [sent('c:1', 'prompt', 'x'), sent('c:2', 'steer', 'y'), steerFail, { type: 'prompt-done', requestId: 'c:1', stopReason }], 1);
  for (const stopReason of ['cancelled', 'max_tokens']) assert.equal(ended(stopReason).lastError, null, stopReason);
  assert.deepEqual(ended('end_turn').lastError, { code: null, message: NO_REPLY });
  // While the turn still runs (its steer answered first), a failure stays.
  const running = run(live(), [sent('c:1', 'prompt', 'x'), say('a'), sent('c:2', 'steer', 'y'), steerFail, sent('c:3', 'steer', 'z'), { type: 'prompt-done', requestId: 'c:3', stopReason: 'end_turn' }], 1);
  assert.equal(isRunning(running), true);
  assert.deepEqual(running.lastError, { code: -32603, message: 'steer refused' });
});
