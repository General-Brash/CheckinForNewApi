// Offline regressions of the real announcement DOM code and global queue pacing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const filename = path.join(__dirname, 'auth.test.cjs');
const source = fs.readFileSync(filename, 'utf8');
const boundary = source.indexOf("\nfor (const html of ['popup.html'");
assert.notEqual(boundary, -1);
const fixture = new Module(filename, module);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(path.dirname(filename));
fixture._compile(source.slice(0, boundary) + '\nmodule.exports = { harness, PLATFORMS };', filename);
const { harness, PLATFORMS } = fixture.exports;
const SETTINGS = 'nacheckin.settings';
const FINISHED = 'nacheckin.checkinFinishedAt';
const plain = (value) => JSON.parse(JSON.stringify(value));
const p = (id) => ({ id, name: id, baseUrl: `https://${id}.invalid`, authMode: 'token', accessToken: 'offline-token' });
async function settle() { for (let i = 0; i < 8; i++) await new Promise(setImmediate); }
async function eventually(predicate) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('expected state did not become visible');
}
function manualClock(h) {
  let now = h.run('Date.now()'), next = 1;
  const timers = new Map();
  h.ctx.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  h.ctx.setTimeout = (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + Number(ms) }); return id; };
  h.ctx.clearTimeout = (id) => timers.delete(id);
  return { timers, now: () => now, async advance(ms) {
    const end = now + ms;
    for (;;) {
      await settle();
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0]; timers.delete(id); now = Math.max(now, timer.at); timer.fn();
    }
    now = end; await settle();
  } };
}
function queueHarness(settings, extra = {}) {
  const platforms = [p('first'), p('second'), p('third')];
  const h = harness('background.js', { [PLATFORMS]: platforms, ...extra });
  if (settings === undefined) delete h.store[SETTINGS]; else h.store[SETTINGS] = settings;
  const clock = manualClock(h);
  h.ctx.inputs = platforms;
  h.ctx.starts = [];
  return { h, clock, run: (index, version = 0) => h.run(`enqueueCheckinTask(inputs[${index}], async (platform) => {
    starts.push({ id: platform.id, at: Date.now() }); return platform.id;
  }, ${version})`) };
}

test('missing and legacy settings get 60 seconds; valid values persist and invalid values reset', async () => {
  const { h } = queueHarness();
  assert.equal((await h.run('getSettings()')).checkinIntervalSeconds, 60);
  h.store[SETTINGS] = { notify: false, autoTime: '09:30' };
  assert.equal((await h.run('getSettings()')).checkinIntervalSeconds, 60);
  assert.equal((await h.run('getSettings()')).notify, false);
  for (const value of [0, 15, 3600, '120']) {
    h.ctx.settingsInput = { notify: false, checkinIntervalSeconds: value };
    await h.run('saveSettings(settingsInput)');
    assert.equal(h.store[SETTINGS].checkinIntervalSeconds, Number(value));
    assert.equal(h.store[SETTINGS].notify, false);
  }
  for (const value of ['', null, true, -1, 1.5, 3601, Infinity, 'oops']) {
    h.ctx.settingsInput = { checkinIntervalSeconds: value };
    await h.run('saveSettings(settingsInput)');
    assert.equal(h.store[SETTINGS].checkinIntervalSeconds, 60);
  }
});

test('default global spacing: first starts immediately, next waits 60 seconds after completion, no trailing wait', async () => {
  const { h, clock, run } = queueHarness();
  const start = clock.now();
  await run(0);
  assert.equal(h.ctx.starts[0].at, start);
  const second = run(1);
  await eventually(() => clock.timers.size > 0);
  assert.equal(h.run('activeCheckinControl.phase'), 'queued', 'intentional spacing does not start idle watchdog');
  await clock.advance(59999);
  assert.equal(h.ctx.starts.length, 1);
  await clock.advance(1);
  assert.equal(await second, 'second');
  assert.equal(h.ctx.starts[1].at - h.ctx.starts[0].at, 60000);
  assert.equal(h.store[FINISHED], clock.now());
  assert.equal(clock.timers.size, 0, 'no trailing delay or idle timer remains');
});

for (const seconds of [0, 15, 120]) {
  test(`custom ${seconds}s spacing applies across domains and is not a 60-second idle timeout`, async () => {
    const { h, clock, run } = queueHarness({ checkinIntervalSeconds: seconds });
    await run(0);
    const second = run(1);
    await settle();
    if (seconds) {
      await clock.advance(seconds * 1000 - 1);
      assert.equal(h.ctx.starts.length, 1);
      await clock.advance(1);
    }
    await second;
    assert.equal(h.ctx.starts[1].at - h.ctx.starts[0].at, seconds * 1000);
    assert.equal(clock.timers.size, 0);
  });
}

test('spacing starts after async save/close completion, not at request start', async () => {
  const { h, clock, run } = queueHarness({ checkinIntervalSeconds: 15 });
  let finish;
  h.ctx.closePage = new Promise((resolve) => { finish = resolve; });
  const first = h.run('enqueueCheckinTask(inputs[0], async () => { starts.push({at:Date.now()}); await closePage; return true; }, 0)');
  await eventually(() => h.ctx.starts.length === 1);
  const second = run(1);
  await clock.advance(5000);
  assert.equal(h.store[FINISHED], undefined);
  finish(); await first;
  const completedAt = h.store[FINISHED];
  await clock.advance(14999); assert.equal(h.ctx.starts.length, 1);
  await clock.advance(1); await second;
  assert.equal(h.ctx.starts[1].at - completedAt, 15000);
});

test('stop interrupts spacing immediately, cancels queued platforms, and does not extend the cooldown', async () => {
  const { h, clock, run } = queueHarness();
  await run(0);
  const finished = h.store[FINISHED];
  const second = run(1).then(() => null, (e) => e);
  const third = run(2).then(() => null, (e) => e);
  await eventually(() => clock.timers.size > 0);
  await clock.advance(10000);
  const stopped = await h.run('stopCheckinNow()');
  assert.equal(stopped.stopVersion, 1);
  assert.equal((await second).code, 'CHECKIN_CANCELLED');
  assert.equal((await third).code, 'CHECKIN_CANCELLED');
  assert.equal(h.store[FINISHED], finished);
  assert.equal(clock.timers.size, 0);
  await clock.advance(90000); assert.equal(h.ctx.starts.length, 1);
  assert.equal(await run(2, 1), 'third', 'new generation can run');
});

test('persisted completion time keeps the remaining gap after a worker restart', async () => {
  const previous = Date.now() - 10000;
  const { h, clock, run } = queueHarness({ checkinIntervalSeconds: 60 }, { [FINISHED]: previous });
  const remaining = previous + 60000 - clock.now();
  const pending = run(0); await settle();
  await clock.advance(remaining - 1); assert.equal(h.ctx.starts.length, 0);
  await clock.advance(1); await pending;
  assert.equal(h.ctx.starts[0].at, previous + 60000);
});

for (const automatic of [false, true]) {
  test(`${automatic ? 'scheduled' : 'immediate'} automatic run uses the same queue interval`, async () => {
    const { h, clock } = queueHarness({ checkinIntervalSeconds: 15, autoEnabled: automatic, notify: false });
    h.run(`runCheckin = async (platform) => { starts.push({ id:platform.id, at:Date.now() }); return {ok:true,message:'offline success'}; }`);
    const batch = h.run(`runAutoCheckin(${!automatic}, inputs.slice(0,2), 0)`);
    await eventually(() => h.ctx.starts.length === 1 && h.store[FINISHED] !== undefined);
    await clock.advance(14999); assert.equal(h.ctx.starts.length, 1);
    await clock.advance(1);
    const summary = await batch;
    assert.equal(summary.ok, 2);
    assert.equal(h.ctx.starts[1].at - h.ctx.starts[0].at, 15000);
    assert.equal(clock.timers.size, 0);
  });
}

function noticeDOM(h, buttons = []) {
  const clock = manualClock(h), observers = new Set(), listeners = new Map();
  let queries = 0;
  const dom = { connected: true, visible: true };
  const dialog = { get isConnected() { return dom.connected; }, getClientRects() { return dom.visible ? [{}] : []; }, style: {} };
  const nodes = buttons.map((config) => ({ ...config, clicks: 0, isConnected: true, disabled: !!config.disabled,
    getClientRects() { return this.hidden || !dom.visible ? [] : [{}]; }, style: {},
    getAttribute(name) { return name === 'aria-disabled' && this.ariaDisabled ? 'true' : null; },
    closest() { return dialog; },
    click() { this.clicks++; if (this.close !== false) { dom.visible = false; notify(); } },
  }));
  const notify = () => { for (const observer of [...observers]) observer.fn(); };
  const document = { documentElement: {}, querySelectorAll(selector) {
    queries++; const id = selector.match(/data-testid="([^"]+)"/)[1]; return nodes.filter((n) => n.id === id && !n.notMounted);
  } };
  h.ctx.document = document;
  h.ctx.location = { origin: 'https://site.invalid' };
  h.ctx.getComputedStyle = (node) => node.style;
  h.ctx.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() { observers.add(this); } disconnect() { observers.delete(this); } };
  h.ctx.window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); } };
  return { clock, nodes, dom, queries: () => queries, observers, listeners, notify,
    stop(token) { h.ctx.window.__nacheckinCancelledCheckinToken = token; for (const fn of listeners.get('nacheckin:checkin-stop') || []) fn({ detail:token }); },
    run: (token = '') => { h.ctx.noticeToken = token; return h.run("tabDismissSiteNotice('https://site.invalid', noticeToken)"); } };
}
const TODAY = 'notice-dialog-close-today', CLOSE = 'notice-dialog-close';

test('notice prioritizes Today, and only after the dialog is gone is preparation complete', async () => {
  const h = harness('background.js');
  const d = noticeDOM(h, [{ id:TODAY, close:false }, { id:CLOSE }]);
  let done = false;
  const pending = d.run().then((result) => { done = true; return result; });
  await settle(); assert.equal(d.nodes[0].clicks, 1); assert.equal(d.nodes[1].clicks, 0); assert.equal(done, false);
  await d.clock.advance(1000); assert.equal(done, false);
  d.dom.visible = false; d.notify();
  assert.deepEqual(plain(await pending), { ok:true, dismissed:true });
  assert.equal(d.observers.size, 0); assert.equal(d.clock.timers.size, 0);
});
for (const unavailable of [{ hidden:true }, { disabled:true }, { ariaDisabled:true }]) {
  test(`notice falls back to its dedicated Close when Today is unavailable (${JSON.stringify(unavailable)})`, async () => {
    const h = harness('background.js'), d = noticeDOM(h, [{ id:TODAY, ...unavailable }, { id:CLOSE }]);
    assert.equal((await d.run()).dismissed, true);
    assert.equal(d.nodes[0].clicks, 0); assert.equal(d.nodes[1].clicks, 1);
  });
}
test('missing notices and unrelated Close buttons are ignored with a bounded wait on every preparation', async () => {
  const h = harness('background.js'), d = noticeDOM(h, [{ id:'delete-dialog-close' }, { id:'oauth-allow' }]);
  const first = d.run(); await d.clock.advance(1200);
  assert.deepEqual(plain(await first), { ok:true, dismissed:false });
  const second = d.run(); await d.clock.advance(1200); await second;
  assert.equal(d.nodes.every((node) => !node.clicks), true);
  assert.equal(d.clock.timers.size, 0); assert.equal(d.observers.size, 0);
});
test('a late-mounted SPA notice is closed before preparation returns', async () => {
  const h = harness('background.js'), d = noticeDOM(h, [{ id:TODAY, notMounted:true }]);
  const result = d.run(); await d.clock.advance(500);
  d.nodes[0].notMounted = false; d.notify();
  assert.equal((await result).dismissed, true); assert.equal(d.nodes[0].clicks, 1);
});
test('a notice that refuses to close fails explicitly without repeated clicks', async () => {
  const h = harness('background.js'), d = noticeDOM(h, [{ id:TODAY, close:false }]);
  const result = d.run(); await d.clock.advance(1200);
  assert.equal((await result).ok, false); assert.equal(d.nodes[0].clicks, 1); assert.equal(d.observers.size, 0);
});
test('notice origin and cancellation guards prevent clicks and clean observers/timers', async () => {
  const h = harness('background.js'), d = noticeDOM(h, [{ id:TODAY, notMounted:true }]);
  h.ctx.location.origin = 'https://connect.linux.do';
  assert.equal((await d.run()).ok, false); assert.equal(d.queries(), 0);
  h.ctx.location.origin = 'https://site.invalid';
  const result = d.run('stop-token'); await settle(); d.stop('stop-token');
  assert.equal((await result).cancelled, true);
  d.nodes[0].notMounted = false; d.notify(); await d.clock.advance(5000);
  assert.equal(d.nodes[0].clicks, 0); assert.equal(d.observers.size, 0); assert.equal(d.clock.timers.size, 0);
  assert.equal((await d.run('stop-token')).cancelled, true);
});

test('actual Cookie check-in and password session probe run after announcement dismissal', async () => {
  for (const mode of ['cookie', 'password']) {
    const platform = { id:'site', baseUrl:'https://site.invalid', authMode:mode, loginUsername:'alice', userId:'12' };
    const h = harness('background.js', { [PLATFORMS]:[platform] });
    const d = noticeDOM(h, [{ id:TODAY }]);
    const tab = await h.chrome.tabs.create({ url:platform.baseUrl, active:false });
    const order = [];
    h.chrome.scripting.executeScript = async (spec) => {
      order.push(spec.func.name);
      if (spec.func.name === 'tabDismissSiteNotice') return [{ result:await spec.func(...spec.args) }];
      assert.equal(d.nodes[0].clicks, 1); assert.equal(d.dom.visible, false);
      return [{ result:{ ok:true, body:{ success:true, data:{ id:'12', username:'alice', stats:{} } } } }];
    };
    h.ctx.platformInput = platform; h.ctx.tabInput = tab;
    if (mode === 'cookie') await h.run("callViaTab(platformInput, platformInput.baseUrl, 'POST', null, {})");
    else await h.run('loginPasswordOnTab(platformInput, tabInput)');
    assert.deepEqual(order.slice(0,2), ['tabDismissSiteNotice', 'tabFetchCheckin']);
  }
});

test('SPA announcement mounting after an earlier empty check is still observed', async () => {
  const h = harness('background.js'), d = noticeDOM(h, [{ id:TODAY, notMounted:true }]);
  const first = d.run(); await d.clock.advance(1200); assert.equal((await first).dismissed, false);
  const afterLogin = d.run(); await d.clock.advance(500);
  d.nodes[0].notMounted = false; d.notify();
  assert.equal((await afterLogin).dismissed, true); assert.equal(d.nodes[0].clicks, 1);
});

test('a restored OAuth callback does not attach its idle watchdog to the next task cooldown', async () => {
  const { h, clock, run } = queueHarness({ checkinIntervalSeconds:120 });
  await run(0);
  const second = run(1); await eventually(() => clock.timers.size > 0);
  const tab = await h.chrome.tabs.create({ url:'https://github.com/login/oauth/authorize', active:true });
  h.ctx.pendingInput = { tabId:tab.id, base:'https://agentrouter.org', origin:'https://agentrouter.org', platformId:null,
    provider:'github', oauthStarted:true, oauthState:'restored-state', stopVersion:0, token:'restored-token',
    createdAt:clock.now(), lastProgressAt:clock.now(), phase:'oauth-launched' };
  await h.run('updateAgentRouterPending(pendingInput.tabId, pendingInput, null, true)');
  await h.run(`processAgentRouterReauthTab(${tab.id}, 'https://agentrouter.org/oauth/github?state=restored-state&code=restored-code')`);
  assert.equal(h.run('activeCheckinControl.idleTimer'), null);
  assert.equal(h.run('activeCheckinControl.phase'), 'queued');
  h.store['nacheckin.agentRouterReauth'] = {};
  await clock.advance(90000);
  h.run("assertCheckinActive(); markCheckinProgress(undefined, 'unsolicited-progress', true)");
  assert.equal(h.run('activeCheckinControl.idleTimer'), null);
  assert.equal(h.ctx.starts.length, 1);
  await clock.advance(30000); await second;
  assert.equal(h.ctx.starts[1].at - h.ctx.starts[0].at, 120000);
});

test('a delayed stop-version storage callback cannot abort a newly-started generation', async () => {
  const { h, run } = queueHarness({ checkinIntervalSeconds:0 });
  const first = h.run('enqueueCheckinTask(inputs[0], async (_, control) => { starts.push({id:"old"}); return wait(60000, control); }, 0)')
    .then(() => null, (error) => error);
  await eventually(() => h.ctx.starts.length === 1);
  const originalSet = h.chrome.storage.local.set;
  let releaseStopWrite;
  h.chrome.storage.local.set = (values, callback) => {
    if (Object.hasOwn(values, 'nacheckin.checkinStopVersion')) originalSet(values, () => { releaseStopWrite = callback; });
    else originalSet(values, callback);
  };
  const stopped = h.run('stopCheckinNow()');
  await eventually(() => typeof releaseStopWrite === 'function');
  assert.equal((await first).code, 'CHECKIN_CANCELLED');
  let finishNew;
  h.ctx.newAction = new Promise((resolve) => { finishNew = resolve; });
  const second = h.run('enqueueCheckinTask(inputs[1], async () => { starts.push({id:"new"}); return newAction; }, 1)');
  await eventually(() => h.ctx.starts.length === 2);
  releaseStopWrite(); await stopped;
  assert.equal(h.run('activeCheckinControl.stopVersion'), 1);
  assert.equal(h.run('activeCheckinControl.controller.signal.aborted'), false);
  finishNew('new-completed'); assert.equal(await second, 'new-completed');
});

test('restored OAuth announcement observation has its own cancellation token and preserves the page on stop', async () => {
  const h = harness('background.js'), d = noticeDOM(h, [{ id:TODAY, notMounted:true }]);
  const tab = await h.chrome.tabs.create({ url:'https://site.invalid/console', active:false });
  h.ctx.restoredPending = { tabId:tab.id, base:'https://site.invalid', origin:'https://site.invalid', platformId:null,
    provider:'github', oauthStarted:true, oauthState:'restored', stopVersion:0, token:'restored-operation',
    createdAt:d.clock.now(), lastProgressAt:d.clock.now(), phase:'oauth-launched' };
  await h.run('updateAgentRouterPending(restoredPending.tabId, restoredPending, null, true)');
  h.chrome.scripting.executeScript = async (spec) => {
    assert.ok(['tabDismissSiteNotice', 'tabCancelCheckinPage'].includes(spec.func.name), 'no subsequent login/read action after stop');
    return [{ result:await spec.func(...(spec.args || [])) }];
  };
  const callback = h.run(`processAgentRouterReauthTab(${tab.id}, 'https://site.invalid/console')`).then(() => null, (error) => error);
  await eventually(() => d.observers.size === 1);
  assert.equal(h.run('detachedOauthControls.size'), 1);
  await h.run('stopCheckinNow()');
  assert.equal((await callback).code, 'CHECKIN_CANCELLED');
  assert.equal(d.observers.size, 0); assert.equal(d.clock.timers.size, 0);
  assert.equal(h.run('detachedOauthControls.size'), 0);
  d.nodes[0].notMounted = false; d.notify(); await d.clock.advance(5000);
  assert.equal(d.nodes[0].clicks, 0); assert.equal(h.removed.length, 0); assert.ok(h.tabs.has(tab.id));
});

test('completion of a restored prior OAuth task begins a fresh interval before the queued action', async () => {
  const { h, clock, run } = queueHarness({ checkinIntervalSeconds:60 });
  h.store['nacheckin.agentRouterReauth'] = { 99:{ tabId:99, createdAt:clock.now() } };
  h.run(`waitForPendingOauth = async () => { recoveredAt = Date.now(); await setStore({[KEY_AGENTROUTER_REAUTH]:{}}); }`);
  const first = run(0);
  await eventually(() => h.ctx.recoveredAt !== undefined);
  await clock.advance(59999); assert.equal(h.ctx.starts.length, 0);
  await clock.advance(1); await first;
  assert.equal(h.ctx.starts[0].at - h.ctx.recoveredAt, 60000);
  assert.equal(clock.timers.size, 0);
});

test('consecutive log preparation skips empty SPA waits but still closes a newly visible notice',async()=>{
  const h=harness('background.js'),d=noticeDOM(h,[{id:TODAY,notMounted:true}]);
  const first=await h.run('tabDismissSiteNotice("https://site.invalid","",false)');
  assert.equal(first.dismissed,false);assert.equal(d.clock.timers.size,0);
  d.nodes[0].notMounted=false;
  const second=await h.run('tabDismissSiteNotice("https://site.invalid","",false)');
  assert.equal(second.dismissed,true);assert.equal(d.nodes[0].clicks,1);assert.equal(d.observers.size,0);
});
