// Self-contained UI regression suite for stop controls, cancellation, and quota display.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const PLATFORMS = 'nacheckin.platforms';
const SETTINGS = 'nacheckin.settings';
const STOP_VERSION = 'nacheckin.checkinStopVersion';

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function event() {
  return { listeners: [], addListener(fn) { this.listeners.push(fn); } };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function settle() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}
async function waitFor(predicate, message) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message || 'timed out waiting for UI state');
}
function platform(id, extra = {}) {
  return {
    id,
    name: id.toUpperCase(),
    baseUrl: `https://${id}.example.test`,
    authMode: 'token',
    accessToken: `token-${id}`,
    userId: '',
    stats: { checked_in_today: true, checkin_count: 3 },
    statsDate: localToday(),
    account: { available: 123456, used: 654321 },
    ...extra,
  };
}

function uiHarness(htmlFile, initial = {}, options = {}) {
  const html = fs.readFileSync(path.join(root, htmlFile), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const classes = new Set();
    const node = {
      id: match[1], value: '', style: {}, dataset: {}, checked: false, required: false,
      disabled: false, textContent: '', innerHTML: '', className: '', attributes: {},
      events: {}, clickCount: 0,
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key] || null; },
      addEventListener(name, fn) { this.events[name] = fn; },
      querySelectorAll() { return []; },
      focus() {},
      click() { this.clickCount++; },
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
        toggle(name) { if (classes.has(name)) classes.delete(name); else classes.add(name); },
      },
    };
    nodes.set(match[1], node);
  }

  const store = structuredClone({
    [PLATFORMS]: [],
    [SETTINGS]: { autoEnabled: false, autoTime: '08:01', autoApprove: false, notify: true },
    [STOP_VERSION]: 0,
    ...initial,
  });
  const storageChanged = event();
  const messages = [];
  const toasts = [];
  const timers = new Map(); let timerId = 0;
  let customHandler = null;
  let capabilityResult = null;
  const storageSet = (values) => {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: structuredClone(store[key]), newValue: structuredClone(value) };
      store[key] = structuredClone(value);
    }
    for (const listener of storageChanged.listeners) listener(changes, 'local');
  };
  const chrome = {
    storage: {
      onChanged: storageChanged,
      local: {
        get(keys, callback) {
          const out = {};
          for (const key of typeof keys === 'string' ? [keys] : keys) out[key] = structuredClone(store[key]);
          queueMicrotask(() => callback(out));
        },
        set(values, callback) {
          storageSet(values);
          if (callback) queueMicrotask(callback);
        },
      },
    },
    runtime: {
      id: "ui-test", onMessage: event(),
      lastError: null,
      getURL(file) { return `chrome-extension://test/${file}`; },
      sendMessage(message, callback) {
        messages.push(message);
        let response;
        if (message.type === 'getCapabilities') {
          response = capabilityResult || {
            ok: true,
            authBuild: ctx.NACheckinAuth.build,
            authModes: [...ctx.NACheckinAuth.modes],
          };
        } else {
          response = customHandler
            ? customHandler(message, defaultHandler)
            : defaultHandler(message);
        }
        Promise.resolve(response).then((value) => callback(value));
      },
    },
    tabs: {
      create() {},
    },
  };
  function defaultHandler(message) {
    if (message.type === 'stopCheckin') {
      const nextVersion = (Number(store[STOP_VERSION]) || 0) + 1;
      storageSet({ [STOP_VERSION]: nextVersion });
      return { ok: true, cancelled: true, stopVersion: nextVersion, message: '签到已终止' };
    }
    if (message.type === 'savePlatforms') {
      storageSet({ [PLATFORMS]: message.platforms });
      return { ok: true };
    }
    if (message.type === 'getLastAuto') return { ok: true, last: null };
    if (message.type === 'saveSettings') { storageSet({ [SETTINGS]: message.settings }); return { ok: true, settings: message.settings }; }
    return { ok: true };
  }
  const bodyClasses = new Set((html.match(/<body[^>]*class="([^"]+)"/) || [])[1]?.split(/\s+/) || []);
  const ctx = vm.createContext({
    chrome,
    console,
    URL,
    URLSearchParams,
    Date,
    Blob,
    Promise,
    crypto: require('node:crypto').webcrypto,
    CSS: { escape: (value) => String(value) },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem() { return null; }, setItem() {} },
    window: { matchMedia() { return { matches: false }; } },
    location: { search: '' },
    document: {
      getElementById(id) { return nodes.get(id) || null; },
      createElement() { return { click() {}, set href(value) { this._href = value; }, get href() { return this._href; } }; },
      querySelector() { return null; },
      addEventListener() {},
      body: { classList: { contains(name) { return bodyClasses.has(name); }, add(name) { bodyClasses.add(name); } } },
      documentElement: { getAttribute() { return 'dark'; }, setAttribute() {} },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'auth-config.js'), 'utf8'), ctx, { filename: 'auth-config.js' });
  let source = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  source = source.replace(/\ninit\(\);\s*$/, '');
  vm.runInContext(source, ctx, { filename: 'popup.js' });
  ctx.toastCapture = (text, isError = false) => toasts.push({ text: String(text), isError: !!isError });
  vm.runInContext('toast = toastCapture', ctx);

  return {
    html,
    nodes,
    store,
    messages,
    toasts,
    timers,
    ctx,
    value(expression) { return vm.runInContext(expression, ctx); },
    setStorage: storageSet,
    setHandler(fn) { customHandler = fn; },
    setCapabilities(value) { capabilityResult = value; },
    defaultHandler,
    async init() { await vm.runInContext('init()', ctx); await settle(); },
  };
}

for (const htmlFile of ['popup.html', 'sidebar.html']) {
  test(`${htmlFile}: stop control is next to Add, import remains usable, and stop uses capability handshake`, async () => {
    const ui = uiHarness(htmlFile);
    await ui.init();
    assert.ok(ui.nodes.has('importBtn'), 'top import button remains present');
    assert.ok(ui.nodes.has('stopCheckinBtn'));
    assert.ok(ui.html.indexOf('id="stopCheckinBtn"') < ui.html.indexOf('id="addBtn"'));
    assert.match(ui.html, /id="stopCheckinBtn"[^>]*>[\s\S]*?终止签到<\/button>/);
    assert.equal(typeof ui.nodes.get('stopCheckinBtn').onclick, 'function');
    assert.equal(typeof ui.nodes.get('importBtn').onclick, 'function');
    ui.nodes.get('importBtn').onclick();
    assert.equal(ui.nodes.get('fileInput').clickCount, 1);
    ui.nodes.get('addBtn').onclick();
    assert.equal(ui.nodes.get('modal').classList.contains('open'), true);

    await ui.nodes.get('stopCheckinBtn').onclick();
    assert.equal(ui.messages.filter((message) => message.type === 'stopCheckin').length, 1);
    assert.ok(ui.messages.some((message) => message.type === 'getCapabilities'));
    assert.equal(ui.store[STOP_VERSION], 1, 'an idle stop request is accepted as an idempotent stop');
  });
}

test('page batch stops after a cancelled result and cancellation preserves cached check-in and quota data', async () => {
  const cached = [
    platform('first', {
      stats: { checked_in_today: true, checkin_count: 9 },
      statsDate: localToday(),
      account: { available: 900000, used: 300000, quotaPerUnit: 300000 },
    }),
    platform('second'),
  ];
  const ui = uiHarness('popup.html', { [PLATFORMS]: cached });
  await ui.init();
  const pendingCheckin = deferred();
  ui.setHandler((message, fallback) => {
    if (message.type === 'checkin') return pendingCheckin.promise;
    return fallback(message);
  });

  const batchRun = ui.nodes.get('batchBtn').onclick();
  await waitFor(() => ui.messages.some((message) => message.type === 'checkin'), 'first batch check-in was not sent');
  const firstMessage = ui.messages.find((message) => message.type === 'checkin');
  assert.equal(firstMessage.stopVersion, 0);
  assert.equal(ui.nodes.get('stopCheckinBtn').disabled, false, 'stop remains available during a batch');

  await ui.nodes.get('stopCheckinBtn').onclick();
  pendingCheckin.resolve({ ok: false, cancelled: true, code: 'CHECKIN_CANCELLED', message: '签到已终止' });
  await batchRun;

  assert.equal(ui.messages.filter((message) => message.type === 'checkin').length, 1, 'no later platform is dispatched');
  assert.equal(ui.messages.filter((message) => message.type === 'savePlatforms').length, 0, 'cancellation is not persisted as a result');
  assert.equal(ui.value('platforms[0].stats.checked_in_today'), true);
  assert.equal(ui.value('platforms[0].stats.checkin_count'), 9);
  assert.equal(ui.value('platforms[0].account.available'), 900000);
  assert.equal(ui.value('platforms[0].account.used'), 300000);
  assert.match(ui.nodes.get('platformGrid').innerHTML, /已终止/);
});

test('a CHECKIN_CANCELLED response stops the page batch and is not saved as success or failure', async () => {
  const ui = uiHarness('popup.html', { [PLATFORMS]: [platform('cancelled'), platform('must-not-run')] });
  await ui.init();
  const calls = [];
  ui.setHandler((message, fallback) => {
    if (message.type === 'checkin') {
      calls.push(message.platform.id);
      return { ok: false, cancelled: true, code: 'CHECKIN_CANCELLED', message: '签到已终止' };
    }
    return fallback(message);
  });

  await ui.nodes.get('batchBtn').onclick();
  assert.deepEqual(calls, ['cancelled']);
  assert.equal(ui.messages.filter((message) => message.type === 'savePlatforms').length, 0);
  assert.equal(ui.value('platforms[0].stats.checked_in_today'), true);
  assert.equal(ui.value('platforms[0].stats.checkin_count'), 3);
  assert.equal(ui.value('platforms[0].account.available'), 123456);
  assert.match(ui.nodes.get('platformGrid').innerHTML, /已终止/);
});

test('a stop-version storage change from another window halts the local batch before the next platform', async () => {
  const ui = uiHarness('sidebar.html', { [PLATFORMS]: [platform('one'), platform('two'), platform('three')] });
  await ui.init();
  const first = deferred();
  ui.setHandler((message, fallback) => message.type === 'checkin' ? first.promise : fallback(message));

  const batchRun = ui.nodes.get('batchBtn').onclick();
  await waitFor(() => ui.messages.some((message) => message.type === 'checkin'));
  ui.setStorage({ [STOP_VERSION]: 1 }); // represents another extension page's successful stop
  first.resolve({ ok: false, cancelled: true, code: 'CHECKIN_CANCELLED', message: '签到已终止' });
  await batchRun;

  assert.equal(ui.messages.filter((message) => message.type === 'checkin').length, 1);
  assert.equal(ui.nodes.get('batchBtn').disabled, false);
  assert.match(ui.nodes.get('platformGrid').innerHTML, /已终止/);
});

test('a newer batch captures the new stop version and an old batch finally cannot unlock it', async () => {
  const ui = uiHarness('popup.html', { [PLATFORMS]: [platform('one'), platform('two')] });
  await ui.init();
  const requests = [];
  ui.setHandler((message, fallback) => {
    if (message.type === 'checkin') {
      const task = deferred();
      requests.push({ message, task });
      return task.promise;
    }
    return fallback(message);
  });

  const oldRun = ui.nodes.get('batchBtn').onclick();
  await waitFor(() => requests.length === 1);
  await ui.nodes.get('stopCheckinBtn').onclick();
  const newRun = ui.nodes.get('batchBtn').onclick();
  await waitFor(() => requests.length === 2);
  assert.equal(requests[0].message.stopVersion, 0);
  assert.equal(requests[1].message.stopVersion, 1);

  requests[0].task.resolve({ ok: false, cancelled: true, code: 'CHECKIN_CANCELLED', message: '签到已终止' });
  await oldRun;
  assert.equal(ui.nodes.get('batchBtn').disabled, true, 'the old finally leaves the newer batch disabled');

  requests[1].task.resolve({ ok: true, message: '签到成功', account: { available: 700000, used: 100000, quotaPerUnit: 700000 } });
  await waitFor(() => requests.length === 3);
  assert.equal(requests[2].message.stopVersion, 1);
  requests[2].task.resolve({ ok: true, message: '签到成功', account: { available: 500000, used: 0 } });
  await newRun;
  assert.equal(ui.nodes.get('batchBtn').disabled, false);
  assert.equal(ui.messages.filter((message) => message.type === 'checkin').length, 3);
});

test('autoRun carries its captured version, and a cancelled older run cannot restore a newer button state', async () => {
  const ui = uiHarness('popup.html', { [STOP_VERSION]: 4 });
  await ui.init();
  const runs = [];
  ui.setHandler((message, fallback) => {
    if (message.type === 'autoRun') {
      const task = deferred();
      runs.push({ message, task });
      return task.promise;
    }
    return fallback(message);
  });

  const oldRun = ui.nodes.get('runNowBtn').onclick();
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].message.stopVersion, 4);
  assert.equal(ui.nodes.get('stopCheckinBtn').disabled, false, 'stop remains available during autoRun');
  await ui.nodes.get('stopCheckinBtn').onclick();
  assert.equal(ui.nodes.get('runNowBtn').disabled, false);

  const newRun = ui.nodes.get('runNowBtn').onclick();
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1].message.stopVersion, 5);
  runs[0].task.resolve({ ok: false, cancelled: true, code: 'CHECKIN_CANCELLED', message: '签到已终止' });
  await oldRun;
  assert.equal(ui.nodes.get('runNowBtn').disabled, true);
  runs[1].task.resolve({ ok: true, summary: { ok: 1, already: 0, fail: 0 } });
  await newRun;
  assert.equal(ui.nodes.get('runNowBtn').disabled, false);
});

test('mixed site quota units are converted before aggregation; invalid amounts render as unknown', async () => {
  const ui = uiHarness('popup.html', {
    [PLATFORMS]: [
      platform('unit-million', { account: { available: 1000000, used: 500000, quotaPerUnit: 1000000 } }),
      platform('unit-half-million', { account: { available: 1000000, used: '', quotaPerUnit: 500000 } }),
      platform('legacy-unit', { account: { available: 500000, used: false } }),
      platform('invalid-values', { account: { available: NaN, used: Infinity, quotaPerUnit: true } }),
    ],
  });
  await ui.init();

  assert.match(ui.nodes.get('totalQuota').innerHTML, /4\.0000/);
  const cards = ui.nodes.get('platformGrid').innerHTML.split('<article class="platform-card">').slice(1);
  assert.match(cards[0], /<strong>1\.0000<\/strong><span>可用额度/);
  assert.match(cards[0], /<strong>0\.5000<\/strong><span>已用额度/);
  assert.match(cards[1], /<strong>2\.0000<\/strong><span>可用额度/);
  assert.match(cards[1], /<strong>—<\/strong><span>已用额度/);
  assert.match(cards[2], /<strong>1\.0000<\/strong><span>可用额度/);
  assert.match(cards[2], /<strong>—<\/strong><span>已用额度/);
  assert.match(cards[3], /<strong>—<\/strong><span>可用额度/);
  assert.match(cards[3], /<strong>—<\/strong><span>已用额度/);
  assert.equal(ui.value('formatQuota(500000)'), '1.0000', 'the legacy one-argument conversion remains supported');
});

test('older background capability handshake gives a reload warning and does not pretend to stop', async () => {
  const ui = uiHarness('sidebar.html', { [STOP_VERSION]: 2 });
  ui.setCapabilities({ ok: true, authBuild: 'older-build', authModes: ['token'] });
  await ui.init();

  await ui.nodes.get('stopCheckinBtn').onclick();
  assert.equal(ui.messages.filter((message) => message.type === 'stopCheckin').length, 0);
  assert.equal(ui.store[STOP_VERSION], 2);
  assert.ok(ui.toasts.some(({ text, isError }) => isError && /重新加载/.test(text)));
  assert.ok(!ui.toasts.some(({ text }) => /签到已终止/.test(text)));
});

for (const htmlFile of ['popup.html', 'sidebar.html']) {
  test(`${htmlFile}: legacy settings default to a 60-second interval and saving keeps other settings`, async () => {
    const ui = uiHarness(htmlFile, { [SETTINGS]: { autoEnabled:false, autoTime:'09:30', autoApprove:true, notify:false } });
    await ui.init();
    const interval = ui.nodes.get('checkinIntervalSeconds');
    assert.ok(interval);
    assert.match(ui.html, /id="checkinIntervalSeconds"[^>]*type="number"[^>]*min="0"[^>]*max="3600"[^>]*value="60"/);
    assert.equal(interval.value, '60');
    interval.value = '120';
    await interval.onchange();
    const settings = ui.store[SETTINGS];
    assert.equal(settings.checkinIntervalSeconds, 120);
    assert.equal(settings.autoTime, '09:30');
    assert.equal(settings.autoApprove, true);
    assert.equal(settings.notify, false);
    ui.nodes.get('notifyEnabled').checked = true;
    await ui.nodes.get('notifyEnabled').onchange();
    assert.equal(ui.store[SETTINGS].checkinIntervalSeconds, 120);
  });
  test(`${htmlFile}: interval supports zero, rejects invalid values, and synchronizes between windows`, async () => {
    const ui = uiHarness(htmlFile, { [SETTINGS]: { checkinIntervalSeconds:15 } });
    await ui.init();
    const interval = ui.nodes.get('checkinIntervalSeconds');
    assert.equal(interval.value, '15');
    interval.value = '0'; await interval.onchange();
    assert.equal(ui.store[SETTINGS].checkinIntervalSeconds, 0);
    for (const value of ['', '-1', '1.5', '3601', 'invalid']) {
      interval.value = value; await interval.onchange();
      assert.equal(interval.value, '60');
      assert.equal(ui.store[SETTINGS].checkinIntervalSeconds, 60);
    }
    ui.setStorage({ [SETTINGS]: { checkinIntervalSeconds:45, notify:false } });
    assert.equal(interval.value, '45');
    assert.equal(ui.nodes.get('notifyEnabled').checked, false);
  });
}

for (const htmlFile of ['popup.html', 'sidebar.html']) {
  test(`${htmlFile}: quota refresh failure is separate from visit status and a successful retry clears it`, async () => {
    const p = platform('visit-refresh', {visitOnly: true, lastVisitDate: localToday(), error: '', message: '今日已访问'});
    const ui = uiHarness(htmlFile, {[PLATFORMS]: [p]});
    await ui.init();
    const beforeStats = JSON.stringify(ui.value('platforms[0].stats'));
    ui.ctx.refreshButton = {disabled: false};
    const pending = deferred();
    ui.setHandler((message, fallback) => message.type === 'account' ? pending.promise : fallback(message));
    const first = ui.value('fetchStats(platforms[0].id, refreshButton)');
    await waitFor(() => ui.messages.some(message => message.type === 'account'));
    assert.equal(ui.ctx.refreshButton.disabled, true);
    assert.notEqual(ui.value('platforms[0].loading'), true);
    pending.resolve({ok: false, message: '获取账户额度失败：Frame with ID 0 was removed.'});
    await first;
    assert.equal(ui.ctx.refreshButton.disabled, false);
    assert.equal(ui.value('platforms[0].error'), '');
    assert.match(ui.value('platforms[0].accountError'), /Frame with ID 0/);
    assert.equal(ui.value('platforms[0].lastVisitDate'), p.lastVisitDate);
    assert.equal(ui.store[PLATFORMS][0].account.available, p.account.available);
    assert.match(ui.nodes.get('platformGrid').innerHTML, /额度刷新失败/);
    assert.doesNotMatch(ui.nodes.get('platformGrid').innerHTML, /访问失败/);

    ui.setHandler((message, fallback) => message.type === 'account'
      ? {ok: true, account: {available: 1000000, used: 500000, quotaPerUnit: 500000}} : fallback(message));
    await ui.value('fetchStats(platforms[0].id, refreshButton)');
    assert.equal(ui.value('platforms[0].accountError'), '');
    assert.equal(ui.value('platforms[0].message'), '额度已更新');
    assert.equal(ui.store[PLATFORMS][0].account.available, 1000000);
    assert.equal(ui.store[PLATFORMS][0].accountError, '');
    assert.equal(JSON.stringify(ui.value('platforms[0].stats')), beforeStats);
    assert.equal(ui.value('platforms[0].statsDate'), p.statsDate);
    assert.match(ui.nodes.get('platformGrid').innerHTML, /今日已访问/);
    assert.match(ui.nodes.get('platformGrid').innerHTML, /2\.0000/);
    assert.doesNotMatch(ui.nodes.get('platformGrid').innerHTML, /额度刷新失败|Frame with ID 0|class="message err"/);
    assert.equal(ui.messages.filter(message => ['checkin', 'stats'].includes(message.type)).length, 0);
  });

  test(`${htmlFile}: successful quota refresh clears a legacy quota error but preserves a real visit failure`, async () => {
    const ui = uiHarness(htmlFile, {[PLATFORMS]: [
      platform('legacy-refresh', {visitOnly: true, lastVisitDate: localToday(), error: '获取账户额度失败：Frame with ID 0 was removed.'}),
      platform('real-visit-failure', {visitOnly: true, error: '访问登录失败，请检查账号'}),
    ]});
    await ui.init();
    ui.setHandler((message, fallback) => message.type === 'account'
      ? {ok: true, account: {available: 500000, used: 0, quotaPerUnit: 500000}} : fallback(message));
    await ui.value('refreshStats("legacy-refresh", true)');
    assert.equal(ui.store[PLATFORMS][0].error, '');
    assert.equal(ui.store[PLATFORMS][0].accountError, '');
    assert.equal(ui.value('status(platforms[0])[0]'), '今日已访问');
    await ui.value('refreshStats("real-visit-failure", true)');
    assert.equal(ui.store[PLATFORMS][1].error, '访问登录失败，请检查账号');
    assert.equal(ui.value('status(platforms[1])[0]'), '访问失败');
    assert.match(ui.nodes.get('platformGrid').innerHTML, /访问登录失败，请检查账号/);
  });
}

for (const htmlFile of ['popup.html', 'sidebar.html']) {
  test(`${htmlFile}: saving an old OAuth UI snapshot preserves the newly cleared quota error`, async () => {
    const completed = platform('oauth-cleared', {authMode: 'agentrouter_linuxdo', userId: '12',
      reauthPending: false, reauthStartedAt: 100, reauthCompletedAt: 200, accountError: '', message: '额度已更新'});
    const ui = uiHarness(htmlFile, {[PLATFORMS]: [completed]});
    await ui.init();
    ui.ctx.stale = {...completed, reauthPending: true, accountError: '此前额度刷新失败'};
    ui.value('platforms = [stale]');
    await ui.value('savePlatforms()');
    assert.equal(ui.store[PLATFORMS][0].accountError, '');
    assert.equal(ui.store[PLATFORMS][0].reauthPending, false);
    assert.equal(ui.store[PLATFORMS][0].message, '额度已更新');
  });
}

for(const htmlFile of ['popup.html','sidebar.html']) {
  test(`${htmlFile}: same API accounts collapse, expand and retain separate account actions`,async()=>{
    const list=[platform('a',{baseUrl:'https://API.example.test/',userId:'12'}),platform('b',{baseUrl:'https://api.example.test',userId:'22'}),platform('c',{baseUrl:'https://api.example.test/other'})];
    const h=uiHarness(htmlFile,{[PLATFORMS]:list});await h.init();
    let html=h.nodes.get('platformGrid').innerHTML;
    assert.match(html,/2 个账号配置/);assert.match(html,/aria-expanded="false"/);assert.match(html,/用户 ID 12/);assert.match(html,/用户 ID 22/);
    assert.equal(h.value('groupAccounts(platforms).length'),2,'different deployment path stays separate');
    h.value('toggleAccountGroup("https://api.example.test")');html=h.nodes.get('platformGrid').innerHTML;
    assert.match(html,/aria-expanded="true"/);assert.match(html,/data-action="checkin" data-id="a"/);assert.match(html,/data-action="checkin" data-id="b"/);
    assert.deepEqual(h.store['nacheckin.expandedAccountGroups'],['https://api.example.test']);
    h.value('render()');assert.match(h.nodes.get('platformGrid').innerHTML,/aria-expanded="true"/);
    h.setStorage({'nacheckin.expandedAccountGroups':[]});assert.match(h.nodes.get('platformGrid').innerHTML,/aria-expanded="false"/);
  });
  test(`${htmlFile}: grouped balances exclude unknown and duplicate verified identities`,async()=>{
    const list=[platform('a',{baseUrl:'https://api.example.test',account:{userId:'12',available:500000,quotaPerUnit:500000,updatedAt:'2026-10-01T00:00:00Z'}}),
      platform('b',{baseUrl:'https://api.example.test/',account:{userId:'12',available:1000000,quotaPerUnit:500000,updatedAt:'2026-10-02T00:00:00Z'}}),
      platform('c',{baseUrl:'https://api.example.test',account:{available:null}})];
    const h=uiHarness(htmlFile,{[PLATFORMS]:list});await h.init();
    assert.equal(h.value('accountGroupSummary(platforms).total'),2);
    const html=h.nodes.get('platformGrid').innerHTML;
    assert.match(html,/1 个余额未知/);assert.match(html,/1 个重复身份配置未重复累计/);assert.match(html,/最近快照/);assert.match(h.nodes.get('totalQuota').innerHTML,/2\.0000/);
    h.value('toggleAccountGroup("https://api.example.test")');assert.match(h.nodes.get('platformGrid').innerHTML,/余额更新时间/);
  });
}

test('visit progress is shown only for the current extension/generation and cleared on stop or completion',async()=>{
  const h=uiHarness('sidebar.html',{[PLATFORMS]:[platform('a',{visitOnly:true,error:'旧错误'})]});await h.init();
  const receive=h.ctx.chrome.runtime.onMessage.listeners[0];
  const msg={type:'visitProgress',id:'a',phase:'visit-logs',message:'余额已获取，正在统计本月 Token',stopVersion:0};
  receive(msg,{id:'other'});assert.equal(h.value('currentVisitProgress("a")'),'');
  receive({...msg,stopVersion:2},{id:'ui-test'});assert.equal(h.value('currentVisitProgress("a")'),'');
  receive(msg,{id:'ui-test'});let html=h.nodes.get('platformGrid').innerHTML;
  assert.match(html,/余额已获取，正在统计本月 Token/);assert.match(html,/data-action="checkin" data-id="a" disabled/);assert.doesNotMatch(html,/class="message err"/);
  receive({...msg,phase:'done',message:''},{id:'ui-test'});assert.equal(h.value('currentVisitProgress("a")'),'');
  receive(msg,{id:'ui-test'});h.value('applyStopVersion(1)');assert.equal(h.value('currentVisitProgress("a")'),'');
});

for (const html of ['popup.html','sidebar.html']) {
  test(`${html}: stale stored loading never masks completed account results`, async () => {
    const h = uiHarness(html, {[PLATFORMS]:[platform('one',{loading:true}),platform('two',{loading:true})]});
    await h.init();
    assert.equal(h.value('platforms.some(p=>p.loading)'),false);
    await h.value('savePlatforms()');
    const saved = h.messages.filter(m=>m.type==='savePlatforms').at(-1);
    assert.ok(saved.platforms.every(p=>!Object.hasOwn(p,'loading')));
  });
}

for (const html of ['popup.html','sidebar.html']) {
  test(`${html}: batch renders and saves first account before second finishes`, async () => {
    const ui = uiHarness(html,{[PLATFORMS]:[platform('first',{visitOnly:true}),platform('second',{visitOnly:true})]});
    await ui.init(); const second=deferred();
    ui.setHandler((message,fallback)=>message.type==='checkin'
      ? message.platform.id==='first'
        ? {ok:true,visited:true,lastVisitDate:localToday(),lastVisitedAt:new Date().toISOString(),message:'first complete'}
        : second.promise
      : fallback(message));
    const batch=ui.nodes.get('batchBtn').onclick();
    await waitFor(()=>ui.messages.filter(m=>m.type==='checkin').length===2);
    assert.equal(ui.value('platforms[0].loading'),false);
    assert.equal(ui.value('platforms[0].lastVisitDate'),localToday());
    assert.equal(ui.value('platforms[1].loading'),true);
    assert.match(ui.nodes.get('platformGrid').innerHTML,/今日已访问/);
    assert.equal(ui.store[PLATFORMS][0].lastVisitDate,localToday());
    second.resolve({ok:false,message:'second failed'}); await batch;
  });
}

for (const file of ['popup.html', 'sidebar.html']) {
  test(`${file}: observer stop, progress expiry and final storage results repaint immediately`, async () => {
    const ui = uiHarness(file, {[PLATFORMS]:[platform('a',{visitOnly:true,error:'访问错误'})]});
    await ui.init();
    const receive = ui.ctx.chrome.runtime.onMessage.listeners[0];
    const progress = {type:'visitProgress',id:'a',phase:'visit-session',message:'正在确认登录',stopVersion:0};
    receive(progress,{id:'ui-test'});
    assert.match(ui.nodes.get('platformGrid').innerHTML,/处理中/);
    ui.setStorage({[STOP_VERSION]:1});
    assert.doesNotMatch(ui.nodes.get('platformGrid').innerHTML,/处理中/);
    assert.match(ui.nodes.get('platformGrid').innerHTML,/访问失败/);
    receive({...progress,stopVersion:1},{id:'ui-test'});
    const first = [...ui.timers.values()].find(t=>t.ms===90000);
    receive({...progress,stopVersion:1,message:'读取余额'},{id:'ui-test'});
    first.fn();
    assert.equal(ui.value('currentVisitProgress("a")'),'读取余额','old expiry cannot erase a newer phase');
    const latest = [...ui.timers.values()].find(t=>t.ms===90000);
    latest.fn();
    assert.doesNotMatch(ui.nodes.get('platformGrid').innerHTML,/处理中/);
    assert.doesNotMatch(ui.nodes.get('platformGrid').innerHTML,/data-id="a" disabled/);
    receive({...progress,stopVersion:1},{id:'ui-test'});
    ui.setStorage({[PLATFORMS]:[platform('a',{visitOnly:true,error:'',lastVisitDate:localToday(),taskResultRevision:1})]});
    assert.match(ui.nodes.get('platformGrid').innerHTML,/今日已访问/);
    assert.doesNotMatch(ui.nodes.get('platformGrid').innerHTML,/处理中/);
  });

  test(`${file}: full storage snapshots remove stale account fields without breaking live object references`, async () => {
    const p = platform('a',{visitOnly:true,error:'旧访问错误',accountError:'旧额度错误',lastVisitDate:localToday()});
    const ui=uiHarness(file,{[PLATFORMS]:[p]}); await ui.init();
    ui.value('oldReference = platforms[0]');
    ui.setStorage({[PLATFORMS]:[{id:'a',name:'A',baseUrl:p.baseUrl,authMode:'token',accessToken:p.accessToken,visitOnly:true}]});
    assert.equal(ui.value('oldReference === platforms[0]'),true);
    for (const key of ['account','error','accountError','lastVisitDate','stats']) assert.equal(ui.value(`Object.hasOwn(platforms[0],"${key}")`),false);
    assert.doesNotMatch(ui.nodes.get('platformGrid').innerHTML,/旧访问错误|旧额度错误|今日已访问|访问失败/);
  });

  test(`${file}: a late quota response cannot populate a newly edited account`, async () => {
    const ui=uiHarness(file,{[PLATFORMS]:[platform('a')]}); await ui.init();
    const response=deferred();ui.setHandler((m,f)=>m.type==='account'?response.promise:f(m));
    const pending=ui.value('refreshStats("a",true)');
    await waitFor(()=>ui.messages.some(m=>m.type==='account'));
    ui.setStorage({[PLATFORMS]:[platform('a',{userId:'99',account:null})]});
    response.resolve({ok:true,account:{userId:'12',available:1000000}});await pending;
    assert.equal(ui.value('platforms[0].account'),null);
    assert.equal(ui.store[PLATFORMS][0].userId,'99');
  });
}

for (const file of ['popup.html','sidebar.html']) {
  test(`${file}: per-account logout switch defaults off, persists and does not reset account results`,async()=>{
    const p=platform('logout-choice',{visitOnly:true,userId:'12',lastVisitDate:localToday()});
    const ui=uiHarness(file,{[PLATFORMS]:[p]});await ui.init();
    ui.value('openModal(platforms[0])');
    assert.equal(ui.nodes.get('logoutAfterVisit').checked,false);
    assert.equal(ui.nodes.get('logoutAfterVisitField').style.display,'');
    assert.match(ui.nodes.get('authHint').textContent,/默认不退出账号/);
    ui.nodes.get('logoutAfterVisit').checked=true;
    await ui.nodes.get('platformForm').onsubmit({preventDefault(){}});
    assert.equal(ui.store[PLATFORMS][0].logoutAfterVisit,true);
    assert.equal(ui.store[PLATFORMS][0].account.available,p.account.available);
    assert.equal(ui.store[PLATFORMS][0].lastVisitDate,p.lastVisitDate);
    ui.value('openModal(platforms[0])');assert.equal(ui.nodes.get('logoutAfterVisit').checked,true);
    assert.equal(ui.value('slimFull(platforms[0]).logoutAfterVisit'),true);
    ui.nodes.get('logoutAfterVisit').checked=false;
    await ui.nodes.get('platformForm').onsubmit({preventDefault(){}});
    assert.equal(ui.store[PLATFORMS][0].logoutAfterVisit,false);
    ui.value('openModal()');assert.equal(ui.nodes.get('logoutAfterVisit').checked,false);
    assert.equal(ui.nodes.get('logoutAfterVisitField').style.display,'none');
  });

  test(`${file}: logout choice round-trips exports and imports, accepting only explicit true`,async()=>{
    const ui=uiHarness(file,{[PLATFORMS]:[platform('keep',{visitOnly:true}),platform('exit',{visitOnly:true,logoutAfterVisit:true})]});await ui.init();
    let blob;ui.ctx.URL=class extends URL {static createObjectURL(value){blob=value;return 'blob:test';}static revokeObjectURL(){}};
    ui.value('exportConfig()');const exported=JSON.parse(await blob.text());
    assert.equal(exported[1].logoutAfterVisit,true);
    ui.ctx.importFile={text:async()=>JSON.stringify([...exported,platform('invalid',{visitOnly:true,logoutAfterVisit:'true'})])};
    await ui.value('importConfig(importFile)');
    assert.equal(ui.store[PLATFORMS][0].logoutAfterVisit,false);
    assert.equal(ui.store[PLATFORMS][1].logoutAfterVisit,true);
    assert.equal(ui.store[PLATFORMS][2].logoutAfterVisit,false);
  });
}
