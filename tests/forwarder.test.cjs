const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/コード.js'), 'utf8');

function setup(route, options = {}) {
  const props = { SLACK_BOT_TOKEN: 'bot-test', SLACK_CHANNEL_ID: 'channel-test',
    MAIL_TO: 'recipient-test', LAST_TS: '100.000000', ...options.props };
  const calls = [], mail = [];
  let releases = 0;
  class Clock extends Date { static now() { return 1000000; } }
  const context = {
    Date: Clock, console: { log() {}, warn() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => !options.busy,
      releaseLock: () => { releases++; } }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props[key], setProperty: (key, value) => { props[key] = value; },
      deleteProperty: key => { delete props[key]; },
    }) },
    Utilities: { formatDate: date => date.toISOString() },
    UrlFetchApp: { fetch: (url, request) => {
      const u = new URL(url);
      calls.push({ method: u.pathname.split('/').pop(), query: u.searchParams,
        auth: request.headers.Authorization });
      const result = route(calls[calls.length - 1]);
      return { getResponseCode: () => result.status || 200,
        getContentText: () => JSON.stringify({ ok: true, ...result }) };
    } },
    GmailApp: { sendEmail: (...args) => {
      if (options.sendFailure) throw new Error('send failed');
      mail.push(args);
    } },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, props, calls, mail, released: () => releases };
}

const parent = { ts: '10.000001', thread_ts: '10.000001', reply_count: 3,
  latest_reply: '120.000002', text: 'old parent' };
function pages(call) {
  assert.equal(call.query.get('limit'), '100');
  assert.equal(call.query.get('latest'), '1000.000000');
  if (call.method === 'conversations.history') {
    assert.equal(call.query.get('oldest'), null);
    if (!call.query.get('cursor')) return { messages: [
      { ts: '110.000001', text: 'new root' },
      { ts: '120.000001', thread_ts: parent.ts, text: 'broadcast' },
    ], has_more: true, response_metadata: { next_cursor: 'history-2' } };
    return { messages: [parent] };
  }
  assert.equal(call.method, 'conversations.replies');
  assert.equal(call.query.get('ts'), parent.ts);
  assert.equal(call.query.get('oldest'), '100.000000');
  if (!call.query.get('cursor')) return { messages: [parent,
    { ts: '99.000000', text: 'already processed' },
    { ts: '120.000001', text: 'reply one' },
  ], has_more: true, response_metadata: { next_cursor: 'reply-2' } };
  return { messages: [
    { ts: '120.000002', text: 'reply two' },
    { ts: '1001.000000', text: 'future' },
  ] };
}

test('old parent, paginated replies, broadcast deduplication and exact ordering', () => {
  const s = setup(pages, { props: { SLACK_USER_TOKEN: 'user-test' } });
  s.context.checkSlackMessages();
  assert.equal(s.mail.length, 1);
  assert.equal(s.mail[0][1], '[Slack] 3件の新着メッセージ');
  const body = s.mail[0][2];
  assert(body.indexOf('new root') < body.indexOf('reply one'));
  assert(body.indexOf('reply one') < body.indexOf('reply two'));
  assert(!/old parent|already processed|future/.test(body));
  assert.equal((body.match(/種別: スレッド返信/g) || []).length, 2);
  assert.equal(s.props.LAST_TS, '120.000002');
  assert(s.calls.filter(c => c.method === 'conversations.replies').every(c => c.auth === 'Bearer user-test'));
  assert.equal(s.released(), 1);
});

test('only a new reply to an old root is forwarded', () => {
  const s = setup(c => c.method === 'conversations.history'
    ? { messages: [parent] } : { messages: [{ ts: '120.000002', text: 'reply' }] });
  s.context.checkSlackMessages();
  assert.equal(s.mail.length, 1);
  assert.equal(s.mail[0][1], '[Slack] 1件の新着メッセージ');
  assert.equal(s.props.LAST_TS, '120.000002');
  assert.equal(s.calls[1].auth, 'Bearer bot-test');
  s.context.checkSlackMessages();
  assert.equal(s.mail.length, 1);
});

test('API failure does not send a partial digest or advance checkpoint', () => {
  const s = setup(c => c.method === 'conversations.history'
    ? { messages: [parent, { ts: '111.000000', text: 'root' }] }
    : { ok: false, error: 'missing_scope' });
  assert.throws(() => s.context.checkSlackMessages(), /SLACK_USER_TOKEN/);
  assert.equal(s.mail.length, 0);
  assert.equal(s.props.LAST_TS, '100.000000');
  assert.equal(s.released(), 1);
});

test('send failure preserves checkpoint and releases lock', () => {
  const s = setup(() => ({ messages: [{ ts: '111.000000', text: 'root' }] }), { sendFailure: true });
  assert.throws(() => s.context.checkSlackMessages(), /send failed/);
  assert.equal(s.props.LAST_TS, '100.000000');
  assert.equal(s.released(), 1);
});

test('concurrent run does no work', () => {
  const s = setup(() => { throw new Error('unexpected call'); }, { busy: true });
  s.context.checkSlackMessages();
  assert.equal(s.mail.length, 0);
  assert.equal(s.calls.length, 0);
  assert.equal(s.released(), 0);
});

test('incomplete pagination fails without advancing', () => {
  const s = setup(() => ({ messages: [], has_more: true }));
  assert.throws(() => s.context.checkSlackMessages(), /カーソル/);
  assert.equal(s.props.LAST_TS, '100.000000');
});

test('request budget fails without advancing', () => {
  let page = 0;
  const s = setup(() => ({ messages: [], has_more: true,
    response_metadata: { next_cursor: String(++page) } }));
  assert.throws(() => s.context.checkSlackMessages(), /200/);
  assert.equal(s.calls.length, 200);
  assert.equal(s.props.LAST_TS, '100.000000');
});

test('initialization uses current time, including for an empty channel', () => {
  const s = setup(() => ({ messages: [] }));
  s.context.initializeLastTs();
  assert.equal(s.props.LAST_TS, '1000.000000');
  assert.equal(s.mail.length, 0);
});
