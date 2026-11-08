// Exercise native NewAPI refresh across sites without a browser profile or network.
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
fixture._compile(source.slice(0, boundary) + '\nmodule.exports = { harness, oauthPlatform, PLATFORMS };', filename);
const { harness, oauthPlatform, PLATFORMS } = fixture.exports;

async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }
function refreshFixture(options = {}) {
  const origin = options.origin || 'https://agentrouter.org';
  const platform = oauthPlatform({ baseUrl: origin, siteType: 'newapi', authMode: options.authMode || 'agentrouter_linuxdo', account: { available: 10 } });
  const h = harness('background.js', { [PLATFORMS]: [platform] });
  let now = h.run('Date.now()'), nextTimer = 1;
  const timers = new Map();
  h.ctx.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  h.ctx.setTimeout = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + Number(ms) }); return id; };
  h.ctx.clearTimeout = (id) => timers.delete(id);
  const clock = { async advance(ms) {
    const end = now + ms;
    for (;;) {
      await settle();
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0]; timers.delete(id); now = timer.at; timer.fn();
    }
    now = end; await settle();
  } };
  const local = new Map([['user', JSON.stringify({ id: 12, username: 'alice', quota: 999999 })]]);
  h.ctx.localStorage = { getItem(key) { return local.get(key) ?? null; } };
  h.ctx.location = { origin, pathname: '/console' };
  h.ctx.getComputedStyle = (el) => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' });
  const requests = [];
  class XHR {
    constructor() { this.events = new Map(); this.status = 0; }
    open(method, url) { this.method = method; this.url = url; }
    send() { requests.push(this); }
    addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(handler); }
    removeEventListener(type, handler) { this.events.get(type)?.delete(handler); }
    respond(body = { success: true, data: [] }, status = 200) {
      this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      if (this.onload) this.onload();
      for (const listener of this.events.get('loadend') || []) listener();
    }
  }
  h.ctx.XMLHttpRequest = XHR;
  const original = { open: XHR.prototype.open, send: XHR.prototype.send };
  const element = (extra = {}) => ({ isConnected: true, getClientRects() { return this.hidden ? [] : [{}]; }, ...extra });
  const refreshIcon = element();
  const button = element({ clicks: 0, disabled: false, loading: false,
    classList: {contains(name) { return name === 'semi-button-loading' && button.semiLoading; }},
    getAttribute(name) { return name === 'aria-disabled' ? String(!!this.ariaDisabled) : null; },
    querySelector(selector) { return selector.includes('aria-label="refresh"') ? refreshIcon : this.loading ? {} : null; },
    click() {
      this.clicks++;
      this.loading = true;
      const xhr = new XHR();
      const requestPath = options.admin ? '/api/data/' : '/api/data/self/';
      xhr.open('GET', (options.noTrailingSlash ? requestPath.slice(0, -1) : requestPath) + '?start_timestamp=1&end_timestamp=2&default_time=hour');
      xhr.onload = () => h.ctx.setTimeout(() => { this.loading = false; }, 500);
      xhr.send();
      const uptime = new XHR(); uptime.open('GET', '/api/uptime/status'); uptime.send();
    },
  });
  const search = element({ clicks: 0, querySelector() { return null; }, getAttribute() { return null; }, click() { this.clicks++; } });
  const heading = element({ textContent: 'Good morning, alice', parentElement: { querySelectorAll() { return [search, button]; } } });
  const headings = [heading];
  h.ctx.document = { readyState: 'complete', querySelectorAll(selector) { assert.equal(selector, 'h1, h2, h3'); return headings; } };
  const cleanup = () => {
    assert.equal(XHR.prototype.open, original.open);
    assert.equal(XHR.prototype.send, original.send);
    assert.equal(timers.size, 0);
    assert.equal(h.ctx.window.events.get('nacheckin:checkin-stop')?.size || 0, 0);
    assert.equal(h.ctx.window.events.get('pagehide')?.size || 0, 0);
    assert.ok(requests.every((xhr) => !xhr.events.get('loadend')?.size));
  };
  h.ctx.expectedOrigin = origin;
  const run = () => h.run('tabRefreshNewApiDashboard(expectedOrigin, "12", "round")');
  return { h, platform, clock, local, requests, button, search, heading, headings, run, cleanup, XHR };
}

for (const admin of [false, true]) {
  test(`native ${admin ? 'admin' : 'user'} refresh waits for this click's GET and rendering without navigation`, async () => {
    const f = refreshFixture({ admin });
    let done = false;
    const pending = f.run().then((result) => { done = true; return result; });
    assert.equal(f.button.clicks, 1); assert.equal(f.search.clicks, 0);
    assert.equal(f.requests.length, 2);
    await f.clock.advance(2000);
    assert.equal(done, false, 'old nonzero balance and an elapsed delay do not confirm refresh');
    f.requests[1].respond();
    await f.clock.advance(100);
    assert.equal(done, false, 'uptime response cannot confirm the statistics refresh');
    f.requests[0].respond();
    await f.clock.advance(400);
    assert.equal(done, false, 'wait for the native loading state to finish');
    await f.clock.advance(100);
    assert.equal((await pending).ok, true);
    assert.equal(f.button.clicks, 1); assert.equal(f.h.reloaded.length, 0); assert.equal(f.h.updates.length, 0);
    assert.equal(JSON.parse(f.local.get('user')).quota, 999999, 'no synthetic cached balance update');
    f.cleanup();
  });
}

for (const origin of ['https://anyrouter.top', 'https://newapi.example.test', 'https://newapi.example.test:8443']) {
  test(`native dashboard refresh is not restricted to Agent Router: ${origin}`, async () => {
    const f = refreshFixture({origin,noTrailingSlash:true});
    const pending = f.run();
    assert.equal(f.button.clicks, 1);
    f.requests[0].respond(); await f.clock.advance(500);
    assert.equal((await pending).ok, true);
    assert.equal(f.h.reloaded.length, 0); assert.equal(f.h.updates.length, 0);
    f.cleanup();
  });
}

test('modern NewAPI uses verified online identity without localStorage.user and recognizes a Lucide refresh button', async () => {
  const f = refreshFixture({origin:'https://modern.example.test'});
  f.local.delete('user');
  f.button.querySelector = (selector) => selector.includes('svg.lucide-refresh-cw') ? {} : f.button.loading ? {} : null;
  f.h.ctx.identity = {id:12,username:'alice'};
  const pending = f.h.run('tabRefreshNewApiDashboard(expectedOrigin,"12","round",identity)');
  assert.equal(f.button.clicks, 1);
  f.requests[0].respond(); await f.clock.advance(500);
  assert.equal((await pending).ok, true); assert.equal(f.local.has('user'), false);
  f.cleanup();
});

test('Semi UI loading class without disabled prevents early completion', async () => {
  const f = refreshFixture({origin:'https://newapi.example.test'});
  const pending = f.run(); let completed = false; pending.then(() => {completed = true;});
  f.button.semiLoading = true;
  f.requests[0].respond(); await f.clock.advance(600);
  assert.equal(f.button.disabled, false); assert.equal(f.button.loading, false);
  assert.equal(completed, false); assert.equal(f.button.clicks, 1);
  f.button.semiLoading = false; await f.clock.advance(100);
  assert.equal((await pending).ok, true); f.cleanup();
});

test('an unrelated refresh button outside the greeting cannot be clicked', async () => {
  const f = refreshFixture({origin:'https://newapi.example.test'});
  const unrelated = {...f.button,clicks:0};
  f.headings.push({...f.heading,textContent:'Service status',parentElement:{querySelectorAll(){return [unrelated];}}});
  const pending = f.run();
  assert.equal(f.button.clicks, 1); assert.equal(unrelated.clicks, 0);
  f.requests[0].respond(); await f.clock.advance(500);
  assert.equal((await pending).ok, true); f.cleanup();
});

for (const [status, body] of [[403, {success:false}], [200, {success:false,data:[]}], [200, '<html>challenge</html>'], [200, {success:true,data:{}}]]) {
  test(`refresh failure ${status}/${JSON.stringify(body)} cannot confirm old visible data`, async () => {
    const f = refreshFixture(); const pending = f.run();
    f.requests[0].respond(body, status);
    const result = await pending;
    assert.equal(result.ok, false); assert.match(result.message, /接口请求失败/);
    // The site's rendering timer is not owned by the extension.
    await f.clock.advance(500);
    assert.equal(f.button.clicks, 1); assert.equal(f.h.reloaded.length, 0);
    f.cleanup();
  });
}

test('an absent, hidden or disabled header button waits for mount and clicks only once', async () => {
  for (const state of ['absent', 'hidden', 'disabled', 'ariaDisabled', 'loading']) {
    const f = refreshFixture();
    if (state === 'absent') f.headings.length = 0; else f.button[state] = true;
    const pending = f.run(); await f.clock.advance(500);
    assert.equal(f.button.clicks, 0, state);
    if (state === 'absent') f.headings.push(f.heading); else f.button[state] = false;
    await f.clock.advance(100);
    assert.equal(f.button.clicks, 1, state);
    f.requests[0].respond(); await f.clock.advance(500);
    assert.equal((await pending).ok, true); f.cleanup();
  }
});

test('refresh timeout never repeats a click or falls back to reload', async () => {
  for (const missing of [false, true]) {
    const f = refreshFixture(); if (missing) f.headings.length = 0;
    const pending = f.run(); await f.clock.advance(15000);
    const result = await pending;
    assert.equal(result.ok, false); assert.match(result.message, missing ? /未找到可用/ : /15 秒/);
    assert.equal(f.button.clicks, missing ? 0 : 1); assert.equal(f.h.reloaded.length, 0);
    f.cleanup();
  }
});

test('refresh refuses wrong origin, identity and ambiguous header buttons', async () => {
  for (const state of ['origin', 'identity', 'ambiguous', 'username']) {
    const f = refreshFixture();
    if (state === 'origin') f.h.ctx.location.origin = 'https://github.com';
    if (state === 'identity') f.local.set('user', JSON.stringify({id:99,username:'alice'}));
    if (state === 'ambiguous') f.headings.push({ ...f.heading, parentElement: {querySelectorAll(){return [{...f.button}];}} });
    if (state === 'username') f.heading.textContent = 'Good morning, other-user';
    const pending = f.run(); if (state === 'username') await f.clock.advance(15000);
    assert.equal((await pending).ok, false); assert.equal(f.button.clicks, 0);
    f.cleanup();
  }
});

test('stop and navigation during refresh cannot produce a late success or click', async () => {
  for (const state of ['stop-before', 'stop-waiting', 'stop-after', 'navigation', 'identity']) {
    const f = refreshFixture();
    if (state === 'stop-before') f.h.ctx.window.__nacheckinCancelledCheckinToken = 'round';
    if (state === 'stop-waiting') f.button.disabled = true;
    const pending = f.run();
    if (state.startsWith('stop-')) f.h.run('tabCancelCheckinPage("round")');
    if (state === 'navigation') f.h.ctx.location.origin = 'https://github.com';
    if (state === 'identity') f.local.set('user', JSON.stringify({id:99,username:'alice'}));
    await f.clock.advance(100);
    const result = await pending;
    assert.equal(result.ok, false);
    if (state.startsWith('stop-')) assert.equal(result.cancelled, true);
    if (f.requests.length) { f.requests[0].respond(); await f.clock.advance(500); }
    assert.equal(f.button.clicks, ['stop-before','stop-waiting'].includes(state) ? 0 : 1);
    f.cleanup();
  }
});

test('leaving a page for BFCache cleans request hooks before timers freeze', async () => {
  const f = refreshFixture(); const pending = f.run();
  f.h.ctx.window.dispatchEvent({type:'pagehide',persisted:true});
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.message, /页面已离开/);
  assert.equal(f.button.clicks, 1); f.cleanup();
});

test('a removed greeting row cannot escape cleanup or trigger a stale button', async () => {
  const f = refreshFixture(); f.heading.parentElement = null;
  const pending = f.run(); await f.clock.advance(15000);
  assert.equal((await pending).ok, false); assert.equal(f.button.clicks, 0); f.cleanup();
});

test('a synchronous native request failure cannot leave a poll timer behind', async () => {
  const f = refreshFixture();
  const click = f.button.click;
  f.button.click = function () { click.call(this); f.requests[0].respond({success:false}, 403); };
  const result = await f.run();
  assert.equal(result.ok, false); await f.clock.advance(500); f.cleanup();
});

test('login refresh uses the same tab and propagates failure without publishing quota', async () => {
  const f = refreshFixture({origin:'https://newapi.example.test',authMode:'cookie'});
  const tab = await f.h.chrome.tabs.create({url:'https://newapi.example.test/console'});
  f.h.ctx.platform = f.platform; f.h.ctx.tabId = tab.id;
  f.h.ctx.dashboardRefresh = async (spec) => { assert.equal(spec.world,'MAIN'); return spec.func(...spec.args); };
  f.h.ctx.script = async () => { assert.fail('no balance or logs after a failed refresh'); };
  const pending = f.h.run('refreshLoginAccountOnTab(platform,tabId)');
  await settle();
  assert.equal(f.requests.length, 2);
  f.requests[0].respond({success:false}, 403);
  await assert.rejects(pending, /看板刷新接口请求失败/);
  await f.clock.advance(500);
  assert.equal(f.h.store[PLATFORMS][0].account.available, 10);
  assert.equal(f.h.reloaded.length, 0); assert.equal(f.h.created.length, 1); assert.equal(f.h.removed.length, 0);
  f.cleanup();
});

for (const authMode of ['token','cookie','password','agentrouter_token','agentrouter_linuxdo']) {
  test(`${authMode}: every NewAPI login flow calls native refresh once before reading balance`, async () => {
    const origin = 'https://newapi.example.test';
    const platform = oauthPlatform({siteType:'newapi',authMode,baseUrl:origin,userId:'12',accessToken:'unused-system-token',loginUsername:'alice',loginPassword:'unused-password',account:{available:10}});
    const h = harness('background.js', {[PLATFORMS]:[platform]});
    const tab = await h.chrome.tabs.create({url:origin + '/console'});
    h.ctx.platform = platform; h.ctx.tabId = tab.id; h.ctx.identity = {id:12,username:'alice',quota:999999};
    let reads = 0;
    h.ctx.dashboardRefresh = async (spec) => {
      assert.equal(spec.target.tabId, tab.id); assert.equal(spec.world,'MAIN');
      assert.equal(spec.args[0], origin); assert.equal(spec.args[1], '12');
      assert.deepEqual(JSON.parse(JSON.stringify(spec.args[3])), {id:12,username:'alice',display_name:''});
      assert.doesNotMatch(JSON.stringify(spec.args), /999999|unused-/);
      assert.equal(reads, 0); return {ok:true};
    };
    h.ctx.readUser = async () => { reads++; assert.equal(h.dashboardRefreshInjections.length, 1); return {id:12,username:'alice',quota:80,used_quota:2}; };
    h.ctx.script = async (spec) => {
      assert.equal(spec.target.tabId, tab.id); assert.equal(spec.args[0], '/api/log/self');
      return {ok:true,body:{success:true,data:[{prompt_tokens:2,completion_tokens:3}]}};
    };
    const account = await h.run('refreshLoginAccountOnTab(platform,tabId,readUser,null,identity)');
    assert.equal(account.available, 80); assert.equal(account.monthlyTokens, 5);
    assert.equal(h.store[PLATFORMS][0].account.available, 80); assert.equal(reads, 2);
    assert.equal(h.dashboardRefreshInjections.length, 1); assert.equal(h.reloaded.length, 0); assert.equal(h.updates.length, 0);
    assert.equal(h.created.length, 1);
  });
}

test('iKuuu cannot enter the NewAPI native dashboard refresh flow', async () => {
  const h = harness('background.js');
  h.ctx.platform = {id:'traffic',siteType:'ikuuu',baseUrl:'https://ikuuu.example.test',authMode:'password'};
  await assert.rejects(h.run('refreshLoginAccountOnTab(platform,1)'), /仅适用于 NewAPI/);
  assert.equal(h.dashboardRefreshInjections.length, 0); assert.equal(h.created.length, 0);
});

test('dashboard polling does not swallow a cancellation returned by the last injection', async () => {
  const h = harness('background.js');
  const tab = await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  h.ctx.platform = oauthPlatform(); h.ctx.tabId = tab.id;
  let reads = 0;
  h.ctx.script = async () => { reads++; return h.run('Promise.reject(checkinCancelledError())'); };
  await assert.rejects(h.run('waitAgentRouterAccountOnTab(platform,tabId)'), {code:'CHECKIN_CANCELLED'});
  assert.equal(reads, 1); assert.equal(h.reloaded.length, 0);
});

test('worker stop token reaches the native MAIN-world wait and rejects its stale continuation', async () => {
  const f = refreshFixture();
  const tab = await f.h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  f.h.ctx.tabId = tab.id;
  f.h.ctx.dashboardRefresh = async (spec) => { assert.equal(spec.world, 'MAIN'); assert.equal(spec.args[2], 'round'); return spec.func(...spec.args); };
  f.h.ctx.script = async (spec) => spec.func(...spec.args);
  f.h.run('control = {stopVersion:0,token:"round",waitingToStart:true,controller:new AbortController(),pageTabIds:new Set(),pageWorlds:new Map()}');
  const pending = f.h.run('executeCheckinScript({target:{tabId},world:"MAIN",func:tabRefreshNewApiDashboard,args:["https://agentrouter.org","12"]},control)');
  await settle(); assert.equal(f.button.clicks, 1);
  f.h.run('control.controller.abort(); broadcastCheckinPageStop(control)');
  await assert.rejects(pending, {code:'CHECKIN_CANCELLED'});
  f.requests[0].respond(); await f.clock.advance(500);
  assert.equal(f.h.run('control.pageTabIds.size'), 0); assert.equal(f.h.reloaded.length, 0);
  f.cleanup();
});
