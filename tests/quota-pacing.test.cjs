// Offline quota and pacing regressions. Loads the real background functions in an isolated VM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter((item) => item !== fn); } });

function backgroundHarness() {
  const store = Object.create(null);
  const calls = { scriptSpecs: [], noticeSpecs: [], delays: [] };
  let page = { id: 7, url: 'https://agentrouter.org/console', status: 'complete' };
  let scriptHandler = async () => null;
  const storageChanged = event();
  const chrome = {
    storage: {
      onChanged: storageChanged,
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
          }
          callback(result);
        },
        set(values, callback) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = value;
          }
          for (const listener of storageChanged.listeners) listener(changes, 'local');
          if (callback) callback();
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          if (callback) callback();
        },
      },
    },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async get(id) { return { ...page, id }; },
      async query() { return []; },
      async create(options) { page = { id: 7, status: 'complete', ...options }; return { ...page }; },
      async update(id, options) { page = { ...page, ...options }; return { ...page, id }; },
      async reload(id) { return { ...page, id }; },
      async remove() {},
    },
    scripting: {
      async executeScript(spec) {
        if (spec.func.name === 'tabDismissSiteNotice') { calls.noticeSpecs.push(spec); return [{ result: { ok: true, dismissed: false } }]; }
        calls.scriptSpecs.push(spec);
        return [{ result: await scriptHandler(spec) }];
      },
    },
    runtime: {
      id: 'quota-pacing-test', lastError: null,
      onMessage: event(), onStartup: event(), onInstalled: event(),
      getURL(file) { return `chrome-extension://quota-pacing-test/${file}`; },
      getManifest() { return { version: '1.7.12' }; },
      sendMessage(_message, callback) { if (callback) callback({ ok: true }); },
    },
    notifications: { onButtonClicked: event(), create() {}, async clear() {} },
    alarms: { onAlarm: event(), create() {}, async clear() {} },
    action: { onClicked: event() },
    sidePanel: { async setPanelBehavior() {}, async open() {} },
  };

  let context;
  context = vm.createContext({
    chrome, console, URL, URLSearchParams, Date, Promise, Blob, AbortController,
    crypto: webcrypto, structuredClone,
    fetch: async () => { throw new Error('unexpected network request in offline quota test'); },
    setTimeout(callback, milliseconds) {
      calls.delays.push(milliseconds);
      if (milliseconds < 10000) queueMicrotask(callback);
      return calls.delays.length;
    },
    clearTimeout() {},
    importScripts(file) {
      vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return {
    context, chrome, calls,
    setPage(value) { page = { ...value }; },
    setScriptHandler(handler) { scriptHandler = handler; },
    run(expression) { return vm.runInContext(expression, context); },
  };
}

function dashboardBody(data) {
  return { success: true, data: { id: '42', username: 'alice', ...data } };
}

test('accountFromSelf accepts per-account quota unit aliases and preserves the legacy fallback', () => {
  const h = backgroundHarness();
  h.context.accountSample = {
    quota: '1,234.5', used_quota: '2,000', quota_per_unit: '1,000,000', request_count: '17',
  };
  let account = h.run('accountFromSelf(accountSample)');
  assert.equal(account.available, 1234.5);
  assert.equal(account.used, 2000);
  assert.equal(account.quotaPerUnit, 1000000);
  assert.equal(account.requestCount, 17);

  h.context.accountSample = { available_quota: '750000', usedQuota: 125000, quota_per_unit: '', quotaPerUnit: '250000' };
  account = h.run('accountFromSelf(accountSample)');
  assert.equal(account.available, 750000);
  assert.equal(account.used, 125000);
  assert.equal(account.quotaPerUnit, 250000);

  h.context.accountSample = { quota: 100, quotaPerUnit: 250000 };
  assert.equal(h.run('accountFromSelf(accountSample).quotaPerUnit'), 250000, 'numeric per-account units remain numeric');

  h.context.accountSample = { quota: 500000, used: '0' };
  account = h.run('accountFromSelf(accountSample)');
  assert.equal(account.quotaPerUnit, 500000, 'responses predating per-account units keep the legacy default');
  assert.equal(account.used, 0);

  h.context.accountSample = { quota: 10, quota_per_unit: false };
  assert.equal(h.run('accountFromSelf(accountSample).quotaPerUnit'), null, 'an invalid explicit unit is unknown, not the legacy default');
});

test('missing and malformed used-quota values remain unknown instead of becoming zero', () => {
  const h = backgroundHarness();
  const invalid = [
    ['missing', {}],
    ['empty string', { used_quota: '' }],
    ['whitespace', { used_quota: '   ' }],
    ['boolean false', { used_quota: false }],
    ['boolean true', { used_quota: true }],
    ['NaN number', { used_quota: Number.NaN }],
    ['positive infinity', { used_quota: Number.POSITIVE_INFINITY }],
    ['negative infinity', { used_quota: Number.NEGATIVE_INFINITY }],
    ['NaN string', { used_quota: 'NaN' }],
    ['Infinity string', { used_quota: 'Infinity' }],
  ];
  for (const [label, sample] of invalid) {
    h.context.accountSample = sample;
    assert.equal(h.run('accountFromSelf(accountSample).used'), null, label);
  }

  h.context.accountSample = { used_quota: 0 };
  assert.equal(h.run('accountFromSelf(accountSample).used'), 0, 'a valid numeric zero remains a real zero');
  h.context.accountSample = { used_quota: '0' };
  assert.equal(h.run('accountFromSelf(accountSample).used'), 0, 'a valid string zero remains a real zero');
});

test('fetchAccount keeps used null when the real account endpoint omits it', async () => {
  const h = backgroundHarness();
  h.context.testPlatform = {
    id: 'site', name: 'Site', baseUrl: 'https://site.example.test',
    authMode: 'token', accessToken: 'test-token', userId: '',
  };
  const paths = [];
  h.context.readAccountApi = async (endpoint) => {
    paths.push(endpoint);
    if (endpoint === '/api/user/self') {
      return { success: true, data: { quota: '750000', quotaPerUnit: '250000' } };
    }
    if (endpoint === '/api/log/self') return { success: true, data: [] };
    throw new Error(`unexpected endpoint ${endpoint}`);
  };

  const account = await h.run('fetchAccount(testPlatform, "2026-10", null, readAccountApi)');
  assert.equal(account.available, 750000);
  assert.equal(account.used, null);
  assert.equal(account.quotaPerUnit, 250000);
  assert.deepEqual(paths, ['/api/user/self', '/api/log/self']);
});

test('dashboard dollar amounts convert to raw quota using the site unit and return that unit', () => {
  const h = backgroundHarness();
  const visible = (text) => ({
    textContent: text, children: [], getClientRects() { return [{ width: 100, height: 20 }]; },
  });
  const rows = [
    ['当前余额', '$2.50'],
    ['历史消耗', '$1.25'],
    ['请求次数', '1,234'],
  ].map(([label, value]) => {
    const amount = visible(value);
    return { ...visible(label), nextElementSibling: amount };
  });
  const card = {
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return rows; },
    getClientRects() { return [{ width: 400, height: 200 }]; },
  };
  const identity = visible('alice');
  h.context.location = { origin: 'https://agentrouter.org', pathname: '/console' };
  h.context.document = {
    readyState: 'complete',
    querySelectorAll(selector) { return selector === '.semi-card' ? [card] : [identity]; },
  };
  h.context.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' });
  h.context.localStorage = {
    getItem(key) {
      if (key === 'user') return JSON.stringify({ id: 42, username: 'alice' });
      if (key === 'quota_per_unit') return '250000';
      if (key === 'display_in_currency') return 'true';
      return null;
    },
  };

  const dashboard = h.run('tabReadAgentRouterDashboard("https://agentrouter.org", "42")');
  h.context.dashboardSample = dashboard.body.data;
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.body.data.quota, 625000);
  assert.equal(dashboard.body.data.used_quota, 312500);
  assert.equal(dashboard.body.data.request_count, 1234);
  assert.equal(dashboard.body.data.quota_per_unit, 250000);
  assert.equal(dashboard.body.data._accountSource, 'dashboard');
  assert.equal(h.run('accountFromSelf(dashboardSample).quotaPerUnit'), 250000);
  assert.equal(h.run('accountFromSelf(dashboardSample).available'), 625000);
});

test('Agent Router dashboard retries five times at 2000ms, retaining the conservative dual-zero rule', async (t) => {
  await t.test('five unsuccessful reads make exactly four 2000ms waits', async () => {
    const h = backgroundHarness();
    let reads = 0;
    h.setScriptHandler(async () => { reads++; return { ok: false, message: 'dashboard loading' }; });

    await assert.rejects(
      h.run('waitAgentRouterAccountOnTab({ baseUrl: "https://agentrouter.org", userId: "42" }, 7)'),
      /已尝试 5 次/,
    );
    assert.equal(reads, 5);
    assert.deepEqual(h.calls.delays, [2000, 2000, 2000, 2000]);
  });

  await t.test('dual zero waits once and then accepts a recovered balance', async () => {
    const h = backgroundHarness();
    let reads = 0;
    h.setScriptHandler(async () => {
      reads++;
      return { ok: true, body: reads === 1
        ? dashboardBody({ quota: '0', used_quota: '0', quota_per_unit: '500000' })
        : dashboardBody({ quota: '500000', used_quota: '250000', quota_per_unit: '500000' }) };
    });

    const user = await h.run('waitAgentRouterAccountOnTab({ baseUrl: "https://agentrouter.org", userId: "42" }, 7)');
    assert.equal(reads, 2);
    assert.deepEqual(h.calls.delays, [2000]);
    assert.equal(user.quota, '500000');
  });

  await t.test('zero available with missing used is not misclassified as dual zero', async () => {
    const h = backgroundHarness();
    let reads = 0;
    h.setScriptHandler(async () => {
      reads++;
      return { ok: true, body: dashboardBody({ quota: '0', quota_per_unit: '500000' }) };
    });

    const user = await h.run('waitAgentRouterAccountOnTab({ baseUrl: "https://agentrouter.org", userId: "42" }, 7)');
    assert.equal(reads, 1);
    assert.deepEqual(h.calls.delays, []);
    assert.equal(user.quota, '0');
  });
});

// Slow identity reads must not log out a healthy session or masquerade as Stop.
test('visit session retries timeouts, but stops after three attempts', async (t) => {
  for (const entry of ['initialVisitSession(p, 7)', 'waitVisitSession(p, 7, false, false, true)']) {
    await t.test(entry, async () => {
      const h = backgroundHarness();
      h.run('var p = { baseUrl: "https://agentrouter.org", userId: "42", authMode: "cookie" }');
      let reads = 0;
      h.setScriptHandler(async () => ++reads < 3
        ? { ok: false, timedOut: true }
        : { ok: true, body: dashboardBody({ quota: '500000', used_quota: '250000', quota_per_unit: '500000' }) });
      assert.equal(String((await h.run(entry)).id), '42');
      assert.equal(reads, 3);
      reads = 0;
      h.setScriptHandler(async () => { reads++; return { ok: false, timedOut: true }; });
      await assert.rejects(h.run(entry), { code: 'SESSION_REQUEST_TIMEOUT' });
      assert.equal(reads, 3);
      for (const [result, code] of [
        [{ ok: false, cancelled: true }, 'CHECKIN_CANCELLED'],
        [{ ok: false, status: 403 }, 'SESSION_REQUEST_FAILED'],
        [{ ok: true, body: { success: true, data: { id: 99 } } }, 'ACCOUNT_MISMATCH'],
      ]) {
        reads = 0;
        h.setScriptHandler(async () => { reads++; return result; });
        if (entry.startsWith('initial') && code === 'ACCOUNT_MISMATCH') {
          assert.equal(await h.run(entry), null); // Initial probe may request an intentional account switch.
        } else await assert.rejects(h.run(entry), { code });
        assert.equal(reads, 1);
      }
    });
  }
});

test('online identity on a login route waits for SPA navigation without logging out', async () => {
  const h = backgroundHarness();
  h.setPage({ id: 7, url: 'https://agentrouter.org/login', status: 'complete' });
  let reads = 0;
  h.setScriptHandler(async () => {
    if (++reads === 2) h.setPage({ id: 7, url: 'https://agentrouter.org/console', status: 'complete' });
    return { ok: true, body: dashboardBody({ quota: '500000' }) };
  });
  const user = await h.run('initialVisitSession({ baseUrl: "https://agentrouter.org", userId: "42", authMode: "cookie" }, 7)');
  assert.equal(String(user.id), '42');
  assert.equal(reads, 2);
  assert.ok(h.calls.scriptSpecs.every(spec => spec.func.name === 'tabFetchCheckin'));
});

test('tab fetch distinguishes timeout during headers/body from explicit stop', async () => {
  for (const bodyPhase of [false, true]) {
    for (const stop of [false, true]) {
      const h = backgroundHarness();
      let timer, listener;
      Object.assign(h.context, {
        location: { origin: 'https://agentrouter.org' },
        window: { addEventListener(_name, fn) { listener = fn; }, removeEventListener() {} },
        setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {},
        fetch: async (_url, { signal }) => {
          const abort = () => {
            if (stop) listener({ detail: 'test-token' }); else timer();
            signal.throwIfAborted();
          };
          if (!bodyPhase) abort();
          return { ok: true, status: 200, headers: { get() { return 'application/json'; } }, text: async () => { abort(); } };
        },
      });
      const result = await h.run('tabFetchCheckin("/api/user/self", "GET", null, "42", "New-Api-User", null, "test-token", "https://agentrouter.org")');
      assert.equal(result.cancelled, stop);
      assert.equal(result.timedOut, !stop);
    }
  }
});
