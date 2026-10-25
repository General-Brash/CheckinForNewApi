// Offline regression suite. No browser profile, real credentials, network or npm dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const PLATFORMS = 'nacheckin.platforms';
const PENDING = 'nacheckin.agentRouterReauth';
const passwordPlatform = (extra = {}) => ({ id: 'pw', name: 'Password', baseUrl: 'https://anyrouter.top', authMode: 'password', loginUsername: 'alice@example.com', loginPassword: ' secret with spaces ', userId: '12', ...extra });
const oauthPlatform = (extra = {}) => ({ id: 'ld', name: 'Linux DO', baseUrl: 'https://agentrouter.org', authMode: 'agentrouter_linuxdo', userId: '12', ...extra });
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter((x) => x !== fn); } });
// Match Chrome's JSON-only injection boundary; the old mock accepted undefined/holes.
function assertScriptArgsJSON(args) {
  for (let index = 0; index < (args || []).length; index++) {
    JSON.stringify(args[index], (_key, value) => {
      if (["undefined", "function", "symbol", "bigint"].includes(typeof value) ||
          (typeof value === "number" && !Number.isFinite(value))) {
        throw new TypeError("Error at property 'args': Error at index " + index + ": Value is unserializable.");
      }
      return value;
    });
  }
}
function harness(file, initial = {}) {
  // Legacy auth regressions opt out of queue pacing; dedicated interval tests explicitly enable it.
  const store = structuredClone({ ...initial, 'nacheckin.settings': { checkinIntervalSeconds: 0, ...(initial['nacheckin.settings'] || {}) } });
  const tabs = new Map();
  const created = [], removed = [], updates = [], reloaded = [], injections = [], noticeInjections = [], messages = [];
  let tabId = 1;
  const NativeDate = Date;
  let clockNow = NativeDate.now();
  let nextTimerId = 1;
  const scheduledTimers = new Map();
  class HarnessDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clockNow])); }
    static now() { return clockNow; }
  }
  const scheduleTimeout = (fn, ms) => {
    const id = nextTimerId++;
    const delay = Math.max(0, Number(ms) || 0);
    const timer = { fn, due: clockNow + delay };
    scheduledTimers.set(id, timer);
    if (delay < 10000) {
      const run = () => {
        if (!scheduledTimers.has(id)) return;
        scheduledTimers.delete(id);
        clockNow = Math.max(clockNow, timer.due);
        fn();
      };
      if (delay === 800 || delay === 1200) setImmediate(run); else queueMicrotask(run);
    }
    return id;
  };
  const clearScheduledTimeout = (id) => scheduledTimers.delete(id);
  async function advanceClock(ms) {
    clockNow += Math.max(0, Number(ms) || 0);
    for (;;) {
      const due = [...scheduledTimers.entries()].filter(([, timer]) => timer.due <= clockNow).sort((a, b) => a[1].due - b[1].due);
      if (!due.length) break;
      for (const [id, timer] of due) {
        if (!scheduledTimers.delete(id)) continue;
        clockNow = Math.max(clockNow, timer.due);
        timer.fn();
      }
      await Promise.resolve();
      await new Promise(setImmediate);
    }
  }
  const chrome = {
    storage: { onChanged: event(), local: {
      get(keys, cb) { const out = {}; for (const key of typeof keys === 'string' ? [keys] : keys) out[key] = structuredClone(store[key]); cb(out); },
      set(values, cb) { const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: store[key], newValue: structuredClone(value) }; store[key] = structuredClone(value); } for (const fn of chrome.storage.onChanged.listeners) fn(changes, 'local'); if (cb) cb(); },
    } },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async query({url}) { return [...tabs.values()].filter((t) => t.url.startsWith(url.slice(0, -1))); },
      async create(opts) { const tab = { id: tabId++, status: 'complete', ...opts }; tabs.set(tab.id, tab); created.push(tab); return {...tab}; },
      async get(id) { if (!tabs.has(id)) throw new Error('no tab'); return {...tabs.get(id)}; },
      async update(id, opts) {
        if (!tabs.has(id)) throw new Error('no tab');
        Object.assign(tabs.get(id), opts); updates.push({ id, ...opts });
        if (opts.url && ['/', '/console'].includes(new URL(opts.url).pathname)) setImmediate(() => {
          const tab = tabs.get(id);
          if (tab && tab.status === 'complete') for (const fn of chrome.tabs.onUpdated.listeners) fn(id, {status:'complete'}, {...tab});
        });
        return {...tabs.get(id)};
      },
      async reload(id, opts) {
        if (!tabs.has(id)) throw new Error('no tab'); reloaded.push({id,...opts});
        // Existing fixture hooks also observe same-document reload navigation.
        const url = tabs.get(id).url;
        await chrome.tabs.update(id, {url});
        if (!['/', '/console'].includes(new URL(url).pathname)) setImmediate(() => {
          const tab = tabs.get(id);
          if (tab && tab.status === 'complete') for (const fn of chrome.tabs.onUpdated.listeners) fn(id, {status:'complete'}, {...tab});
        });
      },
      async remove(id) { removed.push(id); tabs.delete(id); },
    },
    scripting: { async executeScript(spec) {
      assertScriptArgsJSON(spec.args);
      // The legacy DOM fixtures have no announcement; keep those preparatory scripts separate
      // from identity/quota/auth assertions. Real announcement DOM behavior has its own suite.
      if (spec.func.name === 'tabDismissSiteNotice') { noticeInjections.push(spec); return [{ result: { ok: true, dismissed: false } }]; }
      injections.push(spec); return [{ result: await ctx.script(spec) }];
    } },
    runtime: { id: 'extension-id', onMessage: event(), onStartup: event(), onInstalled: event(), getURL(p) { return 'chrome-extension://extension-id/' + p; }, getManifest() {return JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));}, sendMessage(msg, cb) { messages.push(msg); if (msg.type === 'getCapabilities') cb({ok:true,authBuild:ctx.NACheckinAuth.build,authModes:[...ctx.NACheckinAuth.modes],version:chrome.runtime.getManifest().version}); else if (msg.type === 'savePlatforms') chrome.storage.local.set({[PLATFORMS]:msg.platforms}, () => cb({ok:true})); else cb({ok: true}); } },
    notifications: { onButtonClicked: event(), create() {}, async clear() {} },
    alarms: { onAlarm: event(), async clear() {}, create() {} },
    action: { onClicked: event() },
    sidePanel: { async setPanelBehavior() {} },
  };
  const ctx = vm.createContext({
    importScripts(file) {vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx,{filename:file});},
    chrome, console, URL, URLSearchParams, Date: HarnessDate, Blob, AbortController, crypto: require('node:crypto').webcrypto, Promise,
    // Restored OAuth flows now carry a cancellation token even without a foreground queue task.
    window: { events: new Map(),
      addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); },
      removeEventListener(name, fn) { this.events.get(name)?.delete(fn); },
      dispatchEvent(event) { for (const fn of this.events.get(event.type) || []) fn(event); },
    },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    // Advance polling without wall-clock waits; long tab timeout not needed for complete mocks.
    setTimeout: scheduleTimeout, clearTimeout: clearScheduledTimeout,
    script: async () => null,
    fetch: async () => { throw new Error('Unexpected network request'); },
  });
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  if (file === 'popup.js') { vm.runInContext(fs.readFileSync(path.join(root,'auth-config.js'),'utf8'),ctx,{filename:'auth-config.js'}); source = source.replace(/\ninit\(\);\s*$/, ''); }
  vm.runInContext(source, ctx, { filename: file });
  return { ctx, chrome, store, tabs, created, removed, updates, reloaded, injections, noticeInjections, messages, advanceClock, run: (code) => vm.runInContext(code, ctx) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function linuxDoAuthorizeUrl(overrides = {}) {
  const params = new URLSearchParams({ client_id: 'dynamic-client-id', state: 'round-state', response_type: 'code', ...overrides });
  return 'https://connect.linux.do/oauth2/authorize?' + params.toString();
}
function approvalAnchor(options = {}) {
  const o = { href: '/oauth2/approve/dynamic-token', text: '允许', primary: true, inActions: true, hasHref: true,
    visible: true, disabled: false, ariaDisabled: null, target: '', parentElement: null, style: {}, clicks: 0, ...options };
  return {
    tagName: 'A', isConnected: o.isConnected !== false, disabled: o.disabled, target: o.target, hidden: o.hidden === true, inert: o.inert === true, parentElement: o.parentElement, textContent: o.text,
    matches(selector) { return selector === '.oauth-actions a.btn-pill-primary[href]' && o.primary && o.inActions && o.hasHref; },
    getAttribute(name) { return name === 'href' ? (o.hasHref ? o.href : null) : name === 'aria-disabled' ? o.ariaDisabled : null; },
    getClientRects() { return o.visible ? [{ width: 120, height: 32 }] : []; },
    getBoundingClientRect() { return o.visible ? { width: 120, height: 32 } : { width: 0, height: 0 }; },
    click() { o.clicks++; }, _options: o,
  };
}
function installLinuxDoApprovalFixture(h, url, anchors) {
  const parsed = new URL(url);
  h.ctx.location = { href: url, origin: parsed.origin };
  h.ctx.document = { querySelectorAll(selector) {
    assert.equal(selector, '.oauth-actions a.btn-pill-primary[href]');
    return anchors.filter((anchor) => anchor.matches(selector));
  } };
  h.ctx.getComputedStyle = (anchor) => ({ display: 'inline-flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto', ...anchor._options.style });
}
async function settleBackgroundEvents() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}
async function startLinuxDoApprovalFlow(options = {}) {
  const stamp = Date.now();
  const platform = oauthPlatform({ reauthPending: true, reauthStartedAt: stamp });
  const h = harness('background.js', { [PLATFORMS]: [platform] });
  await settleBackgroundEvents();
  const tab = await h.chrome.tabs.create({ url: options.url || linuxDoAuthorizeUrl() });
  const pending = { tabId: tab.id, platformId: platform.id, origin: platform.baseUrl, base: platform.baseUrl,
    userId: platform.userId, authMode: options.authMode || platform.authMode, provider: options.provider || 'linuxdo',
    oauthStarted: true, oauthState: options.oauthState || 'round-state', oauthClientId: options.oauthClientId || 'dynamic-client-id',
    approveClickStarted: false, createdAt: stamp };
  h.ctx.pending = pending;
  await h.run('updateAgentRouterPending(pending.tabId,pending,null,true)');
  h.ctx.script = async (spec) => spec.func(...(spec.args || []));
  return { h, tab, pending, platform };
}
async function fireTabUpdated(h, tab, url = tab.url) {
  const current = await h.chrome.tabs.update(tab.id, { url });
  for (const listener of h.chrome.tabs.onUpdated.listeners) listener(tab.id, { status: 'complete', url }, current);
  await settleBackgroundEvents();
}
async function fireOAuthAlarm(h) {
  for (const listener of h.chrome.alarms.onAlarm.listeners) listener({ name: 'nacheckin.oauth' });
  await settleBackgroundEvents();
}
function uiHarness(html = 'popup.html') {
  // Nodes derive from real HTML: missing fields/options fail instead of creating invented nodes.
  const source = fs.readFileSync(path.join(root, html), 'utf8');
  const nodes = new Map();
  for (const match of source.matchAll(/id="([^"]+)"/g)) {
    const classes = new Set();
    nodes.set(match[1], { value: '', style: {}, dataset: {}, checked: false, required: false, disabled: false,
      textContent: '', innerHTML: '', className: '', events: {}, attributes: {}, setAttribute(k,v) {this.attributes[k]=v;}, getAttribute(k) {return this.attributes[k]||null;}, focus() {}, click() {},
      addEventListener(name, fn) { this.events[name] = fn; }, querySelectorAll() { return []; },
      classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); }, toggle() {} },
    });
  }
  const h = harness('popup.js');
  const toasts = [];
  h.ctx.document = { getElementById(id) { return nodes.get(id) || null; }, createElement() { return { click() {} }; }, querySelector() { return null; }, addEventListener() {}, body: { classList: { contains() { return true; }, add() {} } }, documentElement: {getAttribute() {return 'dark';}, setAttribute() {}} };
  h.ctx.window = { matchMedia() { return { matches: false }; } };
  h.ctx.location = { search: '' };
  h.ctx.localStorage = { getItem() { return null; }, setItem() {} };
  h.ctx.CSS = { escape: (s) => s };
  h.ctx.toastCapture = (text) => toasts.push(text);
  h.run('toast = toastCapture');
  nodes.get('authMode').value = 'token';
  nodes.get('keepAliveFormat').value = 'chat';
  return { ...h, nodes, toasts, source };
}

for (const html of ['popup.html', 'sidebar.html']) {
  test(`${html}: add/edit and all five auth field combinations`, () => {
    const h = uiHarness(html);
    h.run('openModal()');
    const expected = { token: [true,false,false], cookie: [false,false,false], password: [false,true,false], agentrouter_token: [false,false,true], agentrouter_linuxdo: [false,false,true] };
    for (const [mode, [token, password, userId]] of Object.entries(expected)) {
      assert.match(h.source, new RegExp(`value="${mode}"`));
      h.nodes.get('authMode').value = mode;
      h.run('toggleAuthFields()');
      assert.equal(h.nodes.get('accessToken').required, token);
      assert.equal(h.nodes.get('loginPassword').required, password);
      assert.equal(h.nodes.get('loginUsername').required, password);
      assert.equal(h.nodes.get('userId').required, userId);
      assert.equal(h.nodes.get('accessTokenField').style.display === 'none', !token);
      assert.equal(h.nodes.get('loginPasswordField').style.display === 'none', !password);
    }
    h.ctx.input = passwordPlatform();
    h.run('openModal(input)');
    assert.equal(h.nodes.get('loginPassword').value, ' secret with spaces ');
  });
}
test('username trims, password stays exact, non-password messages omit credentials', () => {
  const h = uiHarness(); h.run('openModal()');
  h.nodes.get('authMode').value = 'password'; h.nodes.get('loginUsername').value = ' alice@example.com '; h.nodes.get('loginPassword').value = ' secret ';
  assert.equal(h.run('formData().loginUsername'), 'alice@example.com');
  assert.equal(h.run('formData().loginPassword'), ' secret ');
  h.ctx.input = passwordPlatform({authMode:'cookie', accessToken:'old-token'});
  const output = h.run('slim(input)');
  assert.equal('loginPassword' in output, false); assert.equal(output.accessToken, '');
});
test('export omits password for every mode; import ignores file password and warns', async () => {
  const h = uiHarness();
  let blob; h.ctx.URL = { createObjectURL(b) { blob = b; return 'blob:fake'; }, revokeObjectURL() {} };
  h.ctx.input = [passwordPlatform(), passwordPlatform({id:'legacy',authMode:'cookie'})];
  h.run('platforms = input; exportConfig()');
  const output = JSON.parse(await blob.text());
  assert.ok(output.every((p) => !('loginPassword' in p))); assert.ok(!(await blob.text()).includes('secret with spaces'));
  h.ctx.file = { async text() { return JSON.stringify([passwordPlatform({loginUsername:' alice@example.com ',loginPassword:'injected'})]); } };
  await h.run('importConfig(file)');
  assert.equal(h.store[PLATFORMS][0].loginPassword, ''); assert.equal(h.store[PLATFORMS][0].loginUsername,'alice@example.com');
  assert.ok(h.toasts.some((t) => t.includes('补填密码')));
});
test('front/back validations support new modes and reject unsafe/missing fields', () => {
  for (const file of ['background.js','popup.js']) {
    const h = file === 'popup.js' ? uiHarness() : harness(file);
    for (const p of [passwordPlatform(), oauthPlatform(), oauthPlatform({authMode:'agentrouter_token'}), passwordPlatform({loginPassword:'  '})]) { h.ctx.input = p; assert.doesNotThrow(() => h.run('validatePlatform(input)')); }
    for (const p of [passwordPlatform({baseUrl:'http://anyrouter.top'}), passwordPlatform({baseUrl:'https://u:p@anyrouter.top'}), passwordPlatform({loginPassword:''}), passwordPlatform({loginUsername:' '}), oauthPlatform({userId:''}), oauthPlatform({userId:'bad'}), passwordPlatform({authMode:'invalid'})]) { h.ctx.input=p; assert.throws(() => h.run('validatePlatform(input)')); }
  }
});
test('password form opens email option, sends React events and keeps exact password', async () => {
  const h = harness('background.js');
  const attrs = {}; let visible = false, submitted = false; const events=[];
  class Input { get value() {return this._value;} set value(v) {this._value=v;} getClientRects() {return [1];} dispatchEvent(e) { events.push(e.type); } }
  const user=new Input(), password=new Input();
  const button={type:'submit',getClientRects(){return [1];}, getAttribute(){return null;}, click(){submitted=true;}};
  const form={addEventListener(name,fn){this.guard=fn;}, getAttribute(k){return attrs[k]||null;}, querySelectorAll(sel){return sel.includes('button')?[button]:[user];}};
  password.form=form;
  const reveal={textContent:'使用邮箱或用户名进行登录',getClientRects(){return [1];},click(){visible=true;}};
  h.ctx.HTMLInputElement=Input; h.ctx.Event=class {constructor(type){this.type=type;}};
  h.ctx.location={origin:'https://anyrouter.top',protocol:'https:',pathname:'/login',href:'https://anyrouter.top/login'};
  h.ctx.document={querySelectorAll(sel){return sel==='button'?[reveal]:visible?[password]:[];}};
  const out=await h.run('tabSubmitPasswordLogin("https://anyrouter.top", " alice@example.com ", " secret ")');
  assert.equal(out.ok,true); assert.equal(submitted,true); let prevented=false; form.guard({submitter:button,preventDefault(){prevented=true;}}); assert.equal(prevented,true); assert.equal(user.value,'alice@example.com'); assert.equal(password.value,' secret '); assert.deepEqual(events,['input','change','input','change']);
  attrs.action='https://evil.example/login'; user.value=''; password.value=''; submitted=false;
  const denied=await h.run('tabSubmitPasswordLogin("https://anyrouter.top", "alice", "secret")');
  assert.equal(denied.ok,false); assert.equal(password.value,''); assert.equal(submitted,false);
});
test('password form refuses wrong origin/path before touching any input', async () => {
  const h=harness('background.js'); h.ctx.location={origin:'https://connect.linux.do',protocol:'https:',pathname:'/login'};
  h.ctx.document={querySelectorAll(){throw new Error('Must not touch inputs');}};
  assert.equal((await h.run('tabSubmitPasswordLogin("https://anyrouter.top","alice","secret")')).ok,false);
  h.ctx.location={origin:'https://anyrouter.top',protocol:'https:',pathname:'/register'};
  assert.equal((await h.run('tabSubmitPasswordLogin("https://anyrouter.top","alice","secret")')).ok,false);
});
test('password orchestration validates online identity, uses form and closes only owned success tab', async () => {
  const h=harness('background.js'); h.ctx.input=passwordPlatform();
  let submitted=false;
  h.ctx.script=async (spec) => {
    if(spec.func.name==='tabRefreshAuthToken') return {httpOk:false,status:404};
    if(spec.func.name==='tabFetchCheckin') return submitted?{ok:true,body:{success:true,data:{id:12,email:'alice@example.com'}}}:{ok:false,status:401};
    if(spec.func.name==='tabLogout') return {ok:true};
    if(spec.func.name==='tabSubmitPasswordLogin') {assert.equal(spec.args[2],' secret with spaces '); submitted=true; return {ok:true};}
    if(spec.func.name==='tabReadAgentRouterStoredUser') return {id:12,checked_in:true};
    throw new Error(spec.func.name);
  };
  const user=await h.run('ensurePasswordSession(input)');
  assert.equal(user.id,12); assert.equal(user._freshLogin,true); assert.equal(h.removed.length,1);
  assert.equal(h.store[PENDING],undefined); assert.ok(h.injections.some((x)=>x.func.name==='tabSubmitPasswordLogin'&&x.world==='MAIN'));
});
test('password form failure preserves active login page, returns no credentials', async () => {
  const h=harness('background.js'); h.ctx.input=passwordPlatform();
  h.ctx.script=async ({func}) => func.name==='tabLogout'?{ok:true}:func.name==='tabSubmitPasswordLogin'?{ok:false,message:'验证码未完成'}:{ok:false,status:401};
  await assert.rejects(h.run('ensurePasswordSession(input)'),/验证码/);
  assert.equal(h.removed.length,0); assert.equal([...h.tabs.values()][0].active,true); assert.equal(JSON.stringify(h.store).includes('secret'),false);
});
for(const provider of ['linuxdo','github']) {
  test(`${provider} OAuth uses dynamic client/state and correct provider URL`,async()=>{
    const h=harness('background.js'); const requests=[],local=new Map();
    h.ctx.location={origin:'https://agentrouter.org'}; h.ctx.localStorage={getItem(k){return local.get(k)||null;},setItem(k,v){local.set(k,v);}};
    h.ctx.fetch=async (url,opts)=>{requests.push({url,opts});return {ok:true,async json(){return url==='/api/status'?{success:true,data:{linuxdo_client_id:'dynamic-linux-client',github_client_id:'dynamic-github-client'}}:{success:true,data:'csrf & state'};}};};
    const out=await h.run(`tabBuildAgentRouterOauthUrl('${provider}','https://agentrouter.org')`); const url=new URL(out.url);
    assert.equal(out.ok,true); assert.equal(url.origin,provider==='linuxdo'?'https://connect.linux.do':'https://github.com');
    assert.equal(url.searchParams.get('state'),'csrf & state'); assert.equal(url.searchParams.get('client_id'),`dynamic-${provider==='linuxdo'?'linux':'github'}-client`);
    assert.equal(url.searchParams.get(provider==='linuxdo'?'response_type':'scope'),provider==='linuxdo'?'code':'user:email');
    assert.ok(requests[1].url.includes('mode=login')); assert.ok(requests.every((r)=>r.opts.credentials==='include')); assert.equal(local.get('oauth_mode'),'login');
  });
}
test('pending is not a checkin success in UI or automatic summary',async()=>{
  const h=uiHarness(); h.ctx.input=oauthPlatform(); h.run('platforms=[input]');
  const original=h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage=(msg,cb)=>msg.type==='checkin'?cb({ok:true,reauthRequired:true,pending:true,reauthStartedAt:Date.now(),message:'等待登录'}):original(msg,cb);
  await h.run('checkin(input.id)'); assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today,true); assert.equal(h.run('status(platforms[0])[0]'),'等待登录');
  const bg=harness('background.js',{[PLATFORMS]:[oauthPlatform()]});
  bg.run('runCheckin=async()=>({ok:true,reauthRequired:true,pending:true,reauthStartedAt:Date.now(),message:"等待登录"})');
  const summary=await bg.run('runAutoCheckin(true)'); assert.equal(summary.ok,0); assert.equal(summary.fail,1); assert.equal(summary.pending,0); assert.notEqual(bg.store[PLATFORMS][0].stats?.checked_in_today,true);
});
test('Linux DO approval injection uses the real DOM function and fails closed', async () => {
  const h = harness('background.js');
  const cases = [
    { name: 'valid approve anchor', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor()], click: true },
    { name: 'decline anchor', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ primary: false, href: '/oauth2/decline/dynamic-token' })] },
    { name: 'disguised text', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ text: '允许继续' })] },
    { name: 'decline endpoint in primary-looking link', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ href: '/oauth2/decline/dynamic-token' })] },
    { name: 'external endpoint', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ href: 'https://evil.example/oauth2/approve/token' })] },
    { name: 'hidden candidate', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ visible: false })] },
    { name: 'disabled candidate', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ disabled: true })] },
    { name: 'aria-disabled candidate', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ ariaDisabled: 'true' })] },
    { name: 'duplicate candidates', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor(), approvalAnchor()] },
    { name: 'hidden duplicate candidate', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor(), approvalAnchor({ visible: false })] },
    { name: 'new tab target', url: linuxDoAuthorizeUrl(), anchors: [approvalAnchor({ target: '_blank' })] },
    { name: 'wrong state', url: linuxDoAuthorizeUrl({ state: 'another-round' }), anchors: [approvalAnchor()] },
    { name: 'wrong client id', url: linuxDoAuthorizeUrl({ client_id: 'another-client' }), anchors: [approvalAnchor()] },
    { name: 'wrong response type', url: linuxDoAuthorizeUrl({ response_type: 'token' }), anchors: [approvalAnchor()] },
    { name: 'duplicate state parameter', url: linuxDoAuthorizeUrl() + '&state=round-state', anchors: [approvalAnchor()] },
    { name: 'wrong provider domain', url: linuxDoAuthorizeUrl().replace('https://connect.linux.do', 'https://github.com'), anchors: [approvalAnchor()] },
    { name: 'wrong scheme', url: linuxDoAuthorizeUrl().replace('https:', 'http:'), anchors: [approvalAnchor()] },
    { name: 'wrong path', url: linuxDoAuthorizeUrl().replace('/oauth2/authorize', '/oauth2/other'), anchors: [approvalAnchor()] },
  ];
  let fetches = 0;
  h.ctx.fetch = async () => { fetches++; throw new Error('network must not be used'); };
  for (const scenario of cases) {
    installLinuxDoApprovalFixture(h, scenario.url, scenario.anchors);
    const result = await h.run('tabClickLinuxDoApprove("round-state", "dynamic-client-id")');
    assert.equal(result.clicked, scenario.click === true, scenario.name);
    assert.equal(scenario.anchors.reduce((sum, anchor) => sum + anchor._options.clicks, 0), scenario.click ? 1 : 0, scenario.name);
  }
  assert.equal(fetches, 0);
});
test('pending Linux DO tab approval clicks once on retriable events and does not mark check-in', async () => {
  const { h, tab } = await startLinuxDoApprovalFlow();
  const anchor = approvalAnchor();
  installLinuxDoApprovalFixture(h, tab.url, [anchor]);
  await fireTabUpdated(h, tab, tab.url);
  assert.equal(anchor._options.clicks, 1);
  assert.equal(h.injections.filter((spec) => spec.func.name === 'tabClickLinuxDoApprove').length, 1);
  let pending = (await h.run('getAgentRouterPending()'))[tab.id];
  assert.equal(pending.approveClickStarted, true);
  assert.equal(h.store[PLATFORMS][0].reauthPending, true);
  assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today, true);

  // A duplicate URL event and later alarm cannot click the same authorization twice.
  await fireTabUpdated(h, tab, tab.url);
  await fireOAuthAlarm(h);
  assert.equal(anchor._options.clicks, 1);
  assert.equal(h.injections.filter((spec) => spec.func.name === 'tabClickLinuxDoApprove').length, 1);
  assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today, true);

  // A matching URL in another tab is not owned by this pending task.
  const other = await h.chrome.tabs.create({ url: tab.url });
  await fireTabUpdated(h, other, other.url);
  assert.equal(anchor._options.clicks, 1);
  assert.equal(h.injections.filter((spec) => spec.func.name === 'tabClickLinuxDoApprove').length, 1);
});
test('Linux DO approval scan can retry after no button and rejects mismatched pending context', async () => {
  {
    const { h, tab } = await startLinuxDoApprovalFlow();
    installLinuxDoApprovalFixture(h, tab.url, []);
    await fireTabUpdated(h, tab, tab.url);
    const firstWait = (await h.run('getAgentRouterPending()'))[tab.id];
    assert.equal(firstWait.approveClickStarted, false);
    assert.equal(h.store[PLATFORMS][0].reauthPending, true);
    const noisyUrl = new URL(tab.url);
    noisyUrl.searchParams.set('tracking', 'unrelated'); noisyUrl.hash = 'client-fragment';
    await fireTabUpdated(h, tab, noisyUrl.href);
    const afterNoise = (await h.run('getAgentRouterPending()'))[tab.id];
    assert.equal(afterNoise.lastProgressAt, firstWait.lastProgressAt, 'irrelevant URL noise is not OAuth progress');
    assert.equal(afterNoise.approvalWaitUntil, firstWait.approvalWaitUntil, 'irrelevant URL noise does not restart the 1500 ms authorization buffer');
    const anchor = approvalAnchor();
    installLinuxDoApprovalFixture(h, tab.url, [anchor]);
    await fireOAuthAlarm(h);
    assert.equal(anchor._options.clicks, 1);
    assert.equal((await h.run('getAgentRouterPending()'))[tab.id].approveClickStarted, true);
  }
  const invalid = [
    { name: 'wrong state', options: { url: linuxDoAuthorizeUrl({ state: 'wrong' }) } },
    { name: 'wrong client id', options: { url: linuxDoAuthorizeUrl({ client_id: 'wrong' }) } },
    { name: 'wrong provider', options: { provider: 'github', authMode: 'agentrouter_token' } },
    { name: 'wrong domain', options: { url: linuxDoAuthorizeUrl().replace('https://connect.linux.do', 'https://evil.example') } },
    { name: 'wrong path', options: { url: linuxDoAuthorizeUrl().replace('/oauth2/authorize', '/oauth2/other') } },
  ];
  for (const scenario of invalid) {
    const { h, tab } = await startLinuxDoApprovalFlow(scenario.options);
    const anchor = approvalAnchor();
    installLinuxDoApprovalFixture(h, tab.url, [anchor]);
    await fireTabUpdated(h, tab, tab.url);
    assert.equal(anchor._options.clicks, 0, scenario.name);
    assert.equal(h.injections.filter((spec) => spec.func.name === 'tabClickLinuxDoApprove').length, 0, scenario.name);
    assert.equal(h.store[PLATFORMS][0].reauthPending, true, scenario.name);
    assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today, true, scenario.name);
  }
});
test('reauth callback marks success only on matching account and strict checked_in true',async()=>{
  for(const login of [{ok:true,userId:'12',checkedIn:true},{ok:true,userId:'12',checkedIn:false},{ok:false,userMismatch:true,userId:'99',checkedIn:true}]) {
    const h=harness('background.js',{[PLATFORMS]:[oauthPlatform()]}); await new Promise(setImmediate);
    const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
    h.ctx.pending={tabId:tab.id,platformId:'ld',origin:'https://agentrouter.org',base:'https://agentrouter.org',userId:'12',authMode:'agentrouter_linuxdo',provider:'linuxdo',oauthStarted:true,createdAt:Date.now(),oauthState:'s'};
    await h.run('updateAgentRouterPending(pending.tabId,pending,null,true)'); h.ctx.script=async({func})=>['tabFetchAgentRouterAccount','tabReadAgentRouterDashboard'].includes(func.name)?{ok:true,body:{success:true,data:{id:login.userMismatch?99:12,quota:50,used_quota:2}}}:func.name==='tabFetchCheckin'?{ok:true,body:{success:true,data:[]}}:login;
    await h.run('handleAgentRouterReauthTab(pending.tabId,"https://agentrouter.org/oauth/linuxdo?code=c&state=s")');
    const saved=h.store[PLATFORMS][0]; assert.equal(saved.stats?.checked_in_today===true,login.ok&&login.checkedIn===true);
    assert.equal(saved.reauthPending,false); assert.equal(Object.keys(h.store[PENDING]).length,0);
    assert.equal(h.removed.length,login.ok&&login.checkedIn===true?1:0);
  }
  const h=harness('background.js'); h.ctx.localStorage={getItem(){return JSON.stringify({id:12,checked_in:'false'});}};
  assert.equal(h.run('tabCheckAgentRouterLogin("12").checkedIn'),false);
});
test('OAuth launch logs out and stays pending; Linux DO and legacy GitHub preserved',async()=>{
  for(const mode of ['agentrouter_linuxdo','agentrouter_token']){
    const p=oauthPlatform({authMode:mode}); const h=harness('background.js',{[PLATFORMS]:[p]}); await new Promise(setImmediate);
    h.ctx.input=p;
    h.ctx.script=async ({func,args})=>{
      if(func.name==='tabReadAgentRouterStoredUser')return {id:12,checked_in:false};
      if(func.name==='tabLogout')return {ok:true};
      if(func.name==='tabBuildAgentRouterOauthUrl')return {ok:true,url:args[0]==='linuxdo'?'https://connect.linux.do/oauth2/authorize?client_id=dynamic-linux-client&state=s&response_type=code':'https://github.com/login/oauth/authorize?state=s'};
      return {ok:false};
    };
    const r=await h.run('runCheckin(input,{reauth:true})'); assert.equal(r.pending,true); assert.equal(r.reauthRequired,true); assert.equal(r.outcome,'pending'); assert.ok(!r.message.includes('签到成功'));
    const pending=Object.values(h.store[PENDING])[0]; assert.equal(pending.provider,mode==='agentrouter_linuxdo'?'linuxdo':'github'); assert.equal(pending.platformId,p.id); if(mode==='agentrouter_linuxdo') assert.equal(pending.oauthClientId,'dynamic-linux-client'); assert.equal('loginPassword' in pending,false);
    assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today,true);
  }
});
test('pending map concurrent writes preserve both flows; legacy record migrates',async()=>{
  const h=harness('background.js'); await new Promise(setImmediate);
  await h.run('Promise.all([updateAgentRouterPending(1,{tabId:1,origin:"https://a.example"},null,true), updateAgentRouterPending(2,{tabId:2,origin:"https://b.example"},null,true)])');
  assert.deepEqual(Object.keys(h.store[PENDING]),['1','2']); await h.run('updateAgentRouterPending(1,null)'); assert.deepEqual(Object.keys(h.store[PENDING]),['2']);
  h.store[PENDING]={tabId:7,githubClicked:true}; assert.equal((await h.run('getAgentRouterPending()'))[7].provider,'github');
});
test('same-origin operations queue across failures without blocking other sites',async()=>{
  const h=harness('background.js');const order=[];let release;const gate=new Promise((r)=>release=r);h.ctx.input=oauthPlatform();
  h.ctx.first=async()=>{order.push('first');await gate;order.push('end');throw new Error('expected');};h.ctx.second=async()=>{order.push('second');};h.ctx.other=async()=>order.push('other');
  const a=h.run('withPlatformSession(input,first)').catch(()=>{});const b=h.run('withPlatformSession(input,second)');const c=h.run('withPlatformSession({...input,baseUrl:"https://other.example"},other)');
  await c;assert.deepEqual(order,['first','other']);release();await Promise.all([a,b]);assert.deepEqual(order,['first','other','end','second']);
});
test('non-token keepalive never uses stale token/password and never sends a request without API key',async()=>{
  const h=harness('background.js');let requests=0;h.ctx.fetch=async()=>{requests++;throw new Error('unexpected');};
  for(const mode of ['cookie','password','agentrouter_token','agentrouter_linuxdo']){
    h.ctx.input=passwordPlatform({authMode:mode,accessToken:'stale-token',keepAlive:{enabled:true}});
    assert.equal((await h.run('runKeepAliveCall(input)')).ok,false);assert.equal((await h.run('listKeepAliveModels(input)')).ok,false);
  }assert.equal(requests,0);
});
test('same-origin tab fetches refuse foreign endpoints before fetching',async()=>{
  const h=harness('background.js');h.ctx.location={origin:'https://anyrouter.top'};
  assert.equal((await h.run('tabFetchCheckin("https://evil.example/api","GET")')).ok,false);
  assert.equal((await h.run('tabGetPerfJson("https://evil.example/api",null,"secret-token")')).httpOk,false);
  assert.equal(h.run('isAgentRouterReauthMode({authMode:"cookie",baseUrl:"https://evil.example/agentrouter.org"})'),false);
});
test('completed OAuth outcome survives a late pending snapshot save in both UI and SW',async()=>{
  const completed=oauthPlatform({reauthPending:false,reauthStartedAt:10,reauthCompletedAt:20,stats:{checked_in_today:true},statsDate:'2026-10-03',message:'已确认',account:{available:99}});
  const stale=oauthPlatform({reauthPending:true,reauthStartedAt:10,message:'等待登录'});
  for(const file of ['background.js','popup.js']){
    const h=file==='popup.js'?uiHarness():harness(file);h.store[PLATFORMS]=[completed];h.ctx.input=stale;
    if(file==='popup.js'){h.run('platforms=[input]');await h.run('savePlatforms()');}else await h.run('savePlatforms([input])');
    assert.equal(h.store[PLATFORMS][0].reauthPending,false);assert.equal(h.store[PLATFORMS][0].message,'已确认');assert.equal(h.store[PLATFORMS][0].stats.checked_in_today,true);
  }
});
test('message bus rejects website callers, accepts extension page',async()=>{
  const h=harness('background.js');let out;const listener=h.chrome.runtime.onMessage.listeners[0];
  assert.equal(listener({type:'getSettings'},{id:'extension-id',url:'https://evil.example'},(r)=>out=r),false);assert.equal(out.ok,false);
  await new Promise((resolve)=>listener({type:'getSettings'},{id:'extension-id',url:'chrome-extension://extension-id/popup.html'},(r)=>{out=r;resolve();}));assert.equal(out.ok,true);
});
test('model list discards earlier cross-account response',async()=>{
  const h=uiHarness();h.ctx.input=[oauthPlatform({id:'a'}),oauthPlatform({id:'b'})];h.run('platforms=input');h.nodes.get('modelModal').classList.add('open');
  const replies=new Map();const original=h.chrome.runtime.sendMessage;h.chrome.runtime.sendMessage=(msg,cb)=>msg.type==='getCapabilities'?original(msg,cb):replies.set(msg.platform.id,cb);h.run('modelState.platformId="a"');
  const a=h.run('loadModelInsight()');h.run('modelState.platformId="b"');const b=h.run('loadModelInsight()');await new Promise(setImmediate);
  replies.get('b')({ok:true,rows:[{model:'B'}]});await b;replies.get('a')({ok:true,rows:[{model:'A'}]});await a;assert.equal(h.run('modelState.rows[0].model'),'B');
});
test('form rechecks changed action and rejects button GET override',async()=>{
  for(const scenario of ['changed-action','button-get']){
    const h=harness('background.js'); const attrs={method:'post'};let clicked=false;
    class Input {get value(){return this._value;} set value(v){this._value=v;} getClientRects(){return [1];} dispatchEvent(){if(scenario==='changed-action')attrs.action='https://evil.example/post';}}
    const user=new Input(),pass=new Input();
    const submit={type:'submit',getClientRects(){return [1];},getAttribute(k){return scenario==='button-get'&&k==='formmethod'?'get':null;},click(){clicked=true;}};
    const form={addEventListener(){},getAttribute(k){return attrs[k]||null;},querySelectorAll(sel){return sel.includes('button')?[submit]:[user];}};pass.form=form;
    h.ctx.HTMLInputElement=Input;h.ctx.Event=class {constructor(type){this.type=type;}};h.ctx.location={origin:'https://anyrouter.top',protocol:'https:',pathname:'/login',href:'https://anyrouter.top/login'};h.ctx.document={querySelectorAll(){return [pass];}};
    const r=await h.run('tabSubmitPasswordLogin("https://anyrouter.top","alice","secret")');assert.equal(r.ok,false);assert.equal(clicked,false);
  }
});
test('OAuth refuses wrong-state, unobserved callback and invalid online session',async()=>{
  for(const scenario of ['wrong-state','no-callback','expired-session','missing-expected-state']){
    const stamp=Date.now();const p=oauthPlatform({reauthPending:true,reauthStartedAt:stamp});const h=harness('background.js',{[PLATFORMS]:[p]});await new Promise(setImmediate);
    const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
    h.ctx.pending={tabId:tab.id,platformId:p.id,origin:p.baseUrl,base:p.baseUrl,userId:p.userId,authMode:p.authMode,provider:'linuxdo',oauthStarted:true,oauthState:scenario==='missing-expected-state'?'':'expected-state',createdAt:stamp};
    await h.run('updateAgentRouterPending(pending.tabId,pending,null,true)');h.ctx.script=async({func})=>func.name==='tabFetchAgentRouterAccount'?{ok:false,status:401}:{ok:true,userId:'12',checkedIn:true};
    const url=scenario==='no-callback'?'https://agentrouter.org/console':`https://agentrouter.org/oauth/linuxdo?code=c&state=${scenario==='wrong-state'?'wrong':'expected-state'}`;
    h.ctx.url=url;await h.run('handleAgentRouterReauthTab(pending.tabId,url)');assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today,true);assert.equal(h.removed.length,0);assert.equal(Object.keys(h.store[PENDING]).length,1);
  }
});
test('old timeout/close outcome cannot supersede a newer reauth generation',async()=>{
  const h=harness('background.js',{[PLATFORMS]:[oauthPlatform({reauthPending:true,reauthStartedAt:200,message:'new flow'})]});h.ctx.old={platformId:'ld',authMode:'agentrouter_linuxdo',origin:'https://agentrouter.org',userId:'12',provider:'linuxdo',createdAt:100};
  await h.run('saveAgentRouterLoginOutcome(old,null,"old flow closed")');assert.equal(h.store[PLATFORMS][0].reauthPending,true);assert.equal(h.store[PLATFORMS][0].message,'new flow');assert.equal(h.store[PLATFORMS][0].reauthCompletedAt,undefined);
});
test('concurrent callback mutations retain every platform confirmation',async()=>{
  const a=oauthPlatform({id:'a',reauthStartedAt:100,reauthPending:true});const b=oauthPlatform({id:'b',baseUrl:'https://other.example',reauthStartedAt:100,reauthPending:true});
  const h=harness('background.js',{[PLATFORMS]:[a,b]});h.ctx.pa={platformId:'a',authMode:a.authMode,origin:a.baseUrl,userId:a.userId,createdAt:100};h.ctx.pb={...h.ctx.pa,platformId:'b',origin:b.baseUrl};
  await h.run('Promise.all([saveAgentRouterLoginOutcome(pa,{ok:true,checkedIn:true},"A confirmed"),saveAgentRouterLoginOutcome(pb,{ok:true,checkedIn:true},"B confirmed")])');
  assert.ok(h.store[PLATFORMS].every((p)=>p.stats.checked_in_today&&p.reauthPending===false));assert.deepEqual(h.store[PLATFORMS].map((p)=>p.message),['A confirmed','B confirmed']);
});
test('OAuth alarm retries slow callbacks and expires abandoned flows',async()=>{
  const h=harness('background.js');let seen=[];h.ctx.seen=seen;h.run('handleAgentRouterReauthTab=async(id,url)=>seen.push({id,url})');await new Promise(setImmediate);
  const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});h.ctx.pending={tabId:tab.id};await h.run('updateAgentRouterPending(pending.tabId,pending,null,true)');
  for(const listener of h.chrome.alarms.onAlarm.listeners)listener({name:'nacheckin.oauth'});await new Promise(setImmediate);assert.equal(seen.length,1);assert.equal(seen[0].id,tab.id);
  const expired=harness('background.js',{[PLATFORMS]:[oauthPlatform({reauthPending:true,reauthStartedAt:100})]});await new Promise(setImmediate);expired.ctx.pending={tabId:9,platformId:'ld',origin:'https://agentrouter.org',authMode:'agentrouter_linuxdo',userId:'12',provider:'linuxdo',createdAt:100};await expired.run('updateAgentRouterPending(9,pending,null,true)');await expired.run('handleAgentRouterReauthTab(9,"https://connect.linux.do/oauth2/authorize")');assert.equal(expired.store[PLATFORMS][0].reauthPending,false);assert.match(expired.store[PLATFORMS][0].message,/连续 60 秒无有效进展/);assert.equal(Object.keys(expired.store[PENDING]).length,0);
});
test('duplicate imported IDs are replaced before state synchronization',async()=>{
  const h=uiHarness();h.ctx.file={async text(){return JSON.stringify([passwordPlatform(),passwordPlatform({loginUsername:'bob@example.com'})]);}};await h.run('importConfig(file)');
  const list=h.store[PLATFORMS];assert.equal(new Set(list.map((p)=>p.id)).size,2);assert.notEqual(h.run('platforms[0]===platforms[1]'),true);assert.equal(list[0].loginUsername,'alice@example.com');assert.equal(list[1].loginUsername,'bob@example.com');
});
test('original token and cookie checkin paths remain intact',async()=>{
  const h=harness('background.js');const requests=[];h.ctx.input={baseUrl:'https://token.example',authMode:'token',accessToken:'access',userId:'12'};
  const bodyFor = (pathname) => ({success:true,data:pathname === '/api/log/self' ? [] : pathname === '/api/user/self' ? {id:12,quota:50} : {stats:{checked_in_today:true}}});
  h.ctx.fetch=async(url,opts)=>{requests.push({url,opts});return{ok:true,async json(){return bodyFor(new URL(url).pathname);},async text(){return JSON.stringify(bodyFor(new URL(url).pathname));}};};
  const token=await h.run('runCheckin(input,{reauth:true})');assert.equal(token.ok,true);assert.equal(token.account.available,50);
  const request = requests[0];assert.equal(request.opts.headers.Authorization,'Bearer access');assert.equal(request.opts.credentials,'omit');assert.equal(new URL(request.url).pathname,'/api/user/checkin');
  h.ctx.input={baseUrl:'https://cookie.example',authMode:'cookie'};const paths=[];h.ctx.script=async(spec)=>{assert.equal(spec.func.name,'tabFetchCheckin');paths.push(spec.args[0]);return{ok:true,body:bodyFor(spec.args[0])};};
  const cookie=await h.run('runCheckin(input,{reauth:true})');assert.equal(cookie.ok,true);assert.equal(paths[0],'/api/user/checkin');assert.equal(cookie.account.available,50);
});
test('password account and model reader share authenticated same-origin session preparation',async()=>{
  const h=harness('background.js');let prepared=0;h.ctx.prepared=()=>{prepared++;return{id:12};};h.ctx.input=passwordPlatform();h.run('ensurePasswordSession=prepared');h.ctx.script=async(spec)=>spec.func.name==='tabGetPerfJson'?{httpOk:true,status:200,body:{success:true,data:[]}}:{ok:true,body:{success:true,data:{id:12,quota:30}}};
  const account=await h.run('callApi(input,"/api/user/self","GET")');assert.equal(account.data.id,12);const models=await h.run('withInsightReader(input,read=>read("/api/models"))');assert.equal(models.ok,true);assert.equal(prepared,2);
});

for(const html of ['popup.html','sidebar.html']) {
  test(`${html}: complete initialization leaves manually selected auth intact`,async()=>{
    const h=uiHarness(html);await h.run('init()');h.nodes.get('authMode').value='agentrouter_linuxdo';h.nodes.get('baseUrl').value='https://agentrouter.org';
    if(h.nodes.get('baseUrl').events.input)h.nodes.get('baseUrl').events.input();assert.equal(h.nodes.get('authMode').value,'agentrouter_linuxdo');h.nodes.get('addBtn').onclick();assert.equal(h.nodes.get('modal').classList.contains('open'),true);
  });
}
function bridgeExtension(ui, bg) {
  ui.chrome.storage.local = bg.chrome.storage.local;
  bg.chrome.storage.onChanged.listeners.push(...ui.chrome.storage.onChanged.listeners);
  const listener = bg.chrome.runtime.onMessage.listeners[0];
  ui.chrome.runtime.sendMessage = (msg, cb) => {
    ui.messages.push(structuredClone(msg));
    listener(structuredClone(msg), { id: bg.chrome.runtime.id, url: bg.chrome.runtime.getURL('popup.html') }, cb);
  };
  bg.ctx.script = async ({func, args}) => {
    if (['tabFetchAgentRouterAccount','tabReadAgentRouterDashboard'].includes(func.name)) return { ok: true, body: { success: true, data: { id: 12, username: 'alice', quota: 30, used_quota: 2 } } };
    if (func.name === 'tabFetchCheckin') return { ok: true, body: { success: true, data: [] } };
    if (func.name === 'tabReadAgentRouterStoredUser') return { id: 12, username: 'alice', checked_in: false };
    if (func.name === 'tabCheckAgentRouterLogin') return {ok:true,userId:'12',checkedIn:true};
    if (func.name === 'tabLogout') return { ok: true };
    if (func.name === 'tabBuildAgentRouterOauthUrl') return { ok: true, url: args[0] === 'linuxdo' ? 'https://connect.linux.do/oauth2/authorize?state=s&client_id=dynamic-client&response_type=code' : 'https://github.com/login/oauth/authorize?state=s' };
    throw new Error('Unexpected script: ' + func.name);
  };
}
for (const html of ['popup.html', 'sidebar.html']) {
  for (const mode of ['agentrouter_linuxdo', 'agentrouter_token']) {
    test(`${html}/${mode}: real UI detection, save and checkin messages share token-free OAuth chain`, async () => {
      const ui = uiHarness(html), bg = harness('background.js');
      await new Promise(setImmediate);
      bridgeExtension(ui, bg);
      await ui.run('init();');
      ui.run('openModal();');
      ui.nodes.get('authMode').value = mode;
      ui.nodes.get('authMode').onchange();
      ui.nodes.get('name').value = 'Test account';
      ui.nodes.get('baseUrl').value = 'https://agentrouter.org/';
      ui.nodes.get('userId').value = '12';
      ui.nodes.get('accessToken').value = '';
      await ui.nodes.get('testBtn').onclick();
      assert.match(ui.nodes.get('connectionStatus').textContent, /连接成功/);
      await ui.nodes.get('platformForm').onsubmit({preventDefault(){}, submitter:{disabled:false}});
      assert.equal(bg.store[PLATFORMS].length, 1);
      assert.equal(bg.store[PLATFORMS][0].authMode, mode);
      assert.equal(bg.store[PLATFORMS][0].accessToken, '');
      assert.ok(!bg.created.some((tab) => tab.url.endsWith('/login'))); // Detection/save must not log out or start OAuth.
      assert.ok(ui.messages.filter((msg) => msg.type === 'test').every((msg) => msg.platform.authMode === mode && !msg.platform.accessToken));
      for (const batch of [false,true]) {
        const running = ui.run(batch ? 'checkin(platforms[0].id,{batch:true})' : 'checkin(platforms[0].id)');
        await settleBackgroundEvents();
        const pending = Object.values(bg.store[PENDING])[0];
        assert.equal(pending.provider, mode === 'agentrouter_linuxdo' ? 'linuxdo' : 'github');
        assert.equal(bg.store[PLATFORMS][0].reauthPending, true);
        assert.equal(ui.run('platforms[0].loading'), true, 'queued task is not complete merely because its login page opened');
        const callback = pending.origin + '/oauth/' + pending.provider + '?code=c&state=' + pending.oauthState;
        bg.tabs.get(pending.tabId).url = pending.origin + '/console';
        bg.ctx.callbackTabId = pending.tabId; bg.ctx.callbackUrl = callback;
        await bg.run('handleAgentRouterReauthTab(callbackTabId,callbackUrl)');
        await running;
        assert.equal(bg.store[PLATFORMS][0].stats.checked_in_today, true);
        assert.equal(bg.store[PLATFORMS][0].account.available, 30);
        assert.deepEqual(bg.store[PENDING], {});
      }
      assert.ok(ui.messages.some((msg) => msg.type === 'checkin' && msg.batch === true));
    });
  }
}
test('old/partial backend is detected before submitting OAuth mode or credentials', async () => {
  for (const variant of ['old', 'missing-mode', 'wrong-build']) {
    const h = uiHarness(); await h.run('init();');h.run('openModal();');
    h.nodes.get('authMode').value = 'agentrouter_linuxdo'; h.nodes.get('authMode').onchange();
    h.nodes.get('baseUrl').value = 'https://agentrouter.org/'; h.nodes.get('userId').value = '12';
    const outgoing=[];
    h.chrome.runtime.sendMessage=(msg,cb)=>{
      outgoing.push(msg);
      cb(variant==='old'?{ok:false,message:'未知请求'}:{ok:true,authBuild:variant==='wrong-build'?'old':h.ctx.NACheckinAuth.build,authModes:['token','cookie','agentrouter_token']});
    };
    await assert.rejects(h.run('testConnection()'), /重新加载/);
    assert.match(h.nodes.get('connectionStatus').textContent, /界面与后台版本不一致/);
    assert.doesNotMatch(h.nodes.get('connectionStatus').textContent, /请填写访问令牌/);
    assert.ok(outgoing.every((msg)=>msg.type==='getCapabilities'&&!msg.platform));
  }
});
test('late token error cannot overwrite a newly selected Linux DO connection result', async () => {
  const h=uiHarness(); await h.run('init();');h.run('openModal();');
  h.nodes.get('baseUrl').value='https://agentrouter.org/';h.nodes.get('userId').value='12';h.nodes.get('accessToken').value='old-token';
  const original=h.chrome.runtime.sendMessage;let oldReply;
  h.chrome.runtime.sendMessage=(msg,cb)=>{
    if(msg.type==='getCapabilities')return original(msg,cb);
    if(msg.type==='test'&&msg.platform.authMode==='token')oldReply=cb;
    else cb({ok:true,message:'Linux DO session valid'});
  };
  const old=h.run('testConnection()').catch((e)=>e.message);await new Promise(setImmediate);
  h.nodes.get('authMode').value='agentrouter_linuxdo';h.nodes.get('authMode').onchange();
  assert.equal(h.nodes.get('testBtn').disabled,false);
  await h.run('testConnection()');oldReply({ok:false,message:'请填写访问令牌'});
  assert.match(await old,/配置已变更/);
  assert.match(h.nodes.get('connectionStatus').textContent,/Linux DO session valid/);
  assert.doesNotMatch(h.nodes.get('connectionStatus').textContent,/请填写访问令牌/);
});
test('save validates locally without sending an account test', async () => {
  const h=uiHarness(); await h.run('init();'); h.run('openModal();');
  h.nodes.get('name').value='Test account'; h.nodes.get('baseUrl').value='https://agentrouter.org/';
  h.nodes.get('userId').value='12'; h.nodes.get('accessToken').value='old-token';
  await h.nodes.get('platformForm').onsubmit({preventDefault(){},submitter:{disabled:false}});
  assert.equal(h.run('platforms.length'),1);
  assert.ok(h.messages.some(msg=>msg.type==='savePlatforms'));
  assert.ok(!h.messages.some(msg=>msg.type==='test'));
  assert.equal(h.run('platforms[0].account'),null);
});
test('invalid Agent Router ID cannot pass detection through account fallback', async () => {
  const h=harness('background.js');let injections=0;h.ctx.script=async()=>{injections++;return{ok:true,body:{success:true,data:{id:12}}};};
  for(const mode of ['agentrouter_token','agentrouter_linuxdo']){
    h.ctx.input=oauthPlatform({authMode:mode,userId:''});
    const result=await h.run('runStats(input)');assert.equal(result.ok,false);assert.match(result.message,/数字用户ID/);
  }
  assert.equal(injections,0);
});
test('shared auth configuration loads before UI and worker exposes matching capability build', async () => {
  for(const html of ['popup.html','sidebar.html']) {
    const source=fs.readFileSync(path.join(root,html),'utf8');assert.ok(source.indexOf('src="auth-config.js"')>=0);assert.ok(source.indexOf('src="auth-config.js"')<source.indexOf('src="popup.js"'));
  }
  const h=harness('background.js');const listener=h.chrome.runtime.onMessage.listeners[0];
  const capabilities=await new Promise((resolve)=>listener({type:'getCapabilities'},{id:h.chrome.runtime.id,url:h.chrome.runtime.getURL('sidebar.html')},resolve));
  assert.equal(capabilities.authBuild,'1.7.14-auth-v15');assert.equal(capabilities.version,'1.7.14');assert.ok(capabilities.authModes.includes('agentrouter_linuxdo'));assert.ok(capabilities.authModes.includes('agentrouter_token'));
});

// Visit-only preserves login and account reads; only the check-in operation is skipped.
const visitPlatform = (extra = {}) => passwordPlatform({visitOnly: true, ...extra});
function forbidSiteRequests(h) {
  const counts = {fetch: 0, script: 0};
  h.ctx.fetch = async () => { counts.fetch++; throw new Error('Forbidden visit-only fetch'); };
  h.ctx.script = async () => { counts.script++; throw new Error('Forbidden visit-only injection'); };
  return counts;
}
function allowVisitReads(h, user = {id: 12, username: 'alice', email: 'alice@example.com', quota: 50, used_quota: 2}) {
  const counts = forbidSiteRequests(h);
  counts.identity = 0; counts.logs = 0; counts.logouts = 0;
  h.ctx.script = async (spec) => {
    counts.script++;
    if (spec.func.name === "tabLogout") { counts.logouts++; return {ok:true}; }
    if (spec.func.name === 'tabReadAgentRouterDashboard') {
      counts.identity++;return {ok:true,body:{success:true,data:user}};
    }
    assert.equal(spec.func.name, 'tabFetchCheckin');
    assert.equal(spec.args[1], 'GET');
    if (spec.args[0] === '/api/user/self') {
      counts.identity++;
      return {ok: true, body: {success: true, data: user}};
    }
    assert.equal(spec.args[0], '/api/log/self');
    counts.logs++;
    return {ok: true, body: {success: true, data: []}};
  };
  return counts;
}
function assertNoSiteRequests(h, counts) {
  if ('identity' in counts) {
    assert.equal(counts.fetch, 0);
    assert.equal(counts.script, counts.identity + counts.logs + counts.logouts, 'only identity/account/log reads and logout are allowed');
    assert.equal(h.injections.length, counts.script);
  } else {
    assert.deepEqual(counts, {fetch: 0, script: 0});
    assert.equal(h.injections.length, 0);
  }
}
for (const html of ['popup.html', 'sidebar.html']) {
  test(`${html}: visit-only preserves detection, account refresh, models and keepalive preferences`, async () => {
    const ui = uiHarness(html), bg = harness('background.js');
    bridgeExtension(ui, bg);
    const counts = allowVisitReads(bg);
    await ui.run('init();'); ui.run('openModal();');
    ui.nodes.get('name').value = 'Visit';
    ui.nodes.get('baseUrl').value = 'https://anyrouter.top/login?next=private';
    ui.nodes.get('authMode').value = 'password'; ui.nodes.get('authMode').onchange();
    ui.nodes.get('loginUsername').value = ' alice@example.com ';
    ui.nodes.get('loginPassword').value = ' secret ';
    ui.nodes.get('keepAliveEnabled').checked = true; ui.nodes.get('keepAliveKey').value = 'api-key';
    ui.nodes.get('visitOnly').checked = true; ui.nodes.get('visitOnly').onchange();
    assert.equal(ui.nodes.get('keepAliveEnabled').checked, true);
    assert.equal(ui.nodes.get('keepAliveEnabled').disabled, false);
    assert.equal(ui.nodes.get('testBtn').textContent, '检测连接');
    const config = await ui.run('testConnection()');
    assert.equal(config.ok, true); assert.equal(config.account.available, 50);
    assert.equal(config.configOnly, undefined); assert.ok(counts.identity > 0);
    await ui.nodes.get('platformForm').onsubmit({preventDefault() {}, submitter: {disabled: false}});
    assert.equal(bg.store[PLATFORMS][0].visitOnly, true);
    assert.equal(bg.store[PLATFORMS][0].keepAlive.enabled, true);
    ui.run('openModal(platforms[0])'); assert.equal(ui.nodes.get('visitOnly').checked, true);
    const before = bg.created.length;
    await ui.run('checkin(platforms[0].id)');
    assert.equal(bg.created.length, before + 1);
    assert.equal(bg.created.at(-1).url, 'https://anyrouter.top/');
    assert.ok(!bg.tabs.has(bg.created.at(-1).id));
    assert.equal(ui.run('platforms[0].lastVisitDate === todayStr()'), true);
    assert.notEqual(ui.run('platforms[0].stats.checked_in_today'), true);
    assert.equal(ui.run('platforms[0].account.available'), 50);
    assert.equal(ui.nodes.get('checkedPlatforms').textContent, 0);
    assert.match(ui.nodes.get('platformGrid').innerHTML, /今日已访问/);
    assert.match(ui.nodes.get('platformGrid').innerHTML, /立即访问/);
    assert.match(ui.nodes.get('platformGrid').innerHTML, /data-action="stats"/);
    if (html === 'popup.html') assert.match(ui.nodes.get('platformGrid').innerHTML, /data-action="models"/);
    const reads = counts.identity;
    await ui.run('refreshAll()'); assert.ok(counts.identity > reads);
    assertNoSiteRequests(bg, counts);
    ui.nodes.get('authMode').value = 'cookie'; ui.nodes.get('authMode').onchange();
    assert.equal(ui.nodes.get('visitOnly').checked, true);
    assert.equal(ui.run('formData().visitOnly'), true);
    assert.equal(ui.nodes.get('keepAliveEnabled').disabled, false);
    assert.equal(ui.nodes.get('keepAliveEnabled').checked, true);
  });
}
test('visit-only export/import preserves the option without exporting or importing passwords', async () => {
  const h = uiHarness();
  let blob;
  h.ctx.URL = {createObjectURL(b) {blob = b; return 'blob:test';}, revokeObjectURL() {}};
  h.ctx.input = [visitPlatform()]; h.run('platforms=input;exportConfig()');
  const exported = JSON.parse(await blob.text());
  assert.equal(exported[0].visitOnly, true); assert.equal('loginPassword' in exported[0], false);
  h.ctx.file = {async text() {return JSON.stringify([visitPlatform(), passwordPlatform({id: 'cookie', authMode: 'cookie', visitOnly: true})]);}};
  await h.run('importConfig(file)');
  assert.equal(h.store[PLATFORMS][0].visitOnly, true);
  assert.equal(h.store[PLATFORMS][0].loginPassword, '');
  assert.equal(h.store[PLATFORMS][1].visitOnly, true);
});
test('visit-only opens and closes one new home tab, preserving existing user tabs', async () => {
  const h = harness('background.js'), counts = allowVisitReads(h);
  const existing = await h.chrome.tabs.create({url:'https://anyrouter.top/',active:true});
  h.ctx.input = visitPlatform({baseUrl:'https://anyrouter.top/api/user/checkin?danger=1'});
  const result = await h.run('runCheckin(input,{reauth:true})');
  assert.equal(result.ok, true); assert.equal(result.visited, true); assert.equal(result.data, null);
  assert.equal(h.created.length, 2); assert.equal(h.created[1].url, 'https://anyrouter.top/');
  assert.deepEqual(h.removed, [h.created[1].id]); assert.ok(h.tabs.has(existing.id));
  assertNoSiteRequests(h, counts);
});
test('visit-only waits for page load and cleans listeners; timeout/closed page do not claim success', async () => {
  for (const mode of ['loaded', 'timeout', 'closed', 'browser-error', 'close-fails']) {
    const h = harness('background.js'), counts = allowVisitReads(h);
    await settleBackgroundEvents();
    const updatedCount = h.chrome.tabs.onUpdated.listeners.length, removedCount = h.chrome.tabs.onRemoved.listeners.length;
    const originalCreate = h.chrome.tabs.create;
    h.chrome.tabs.create = async (opts) => {
      const tab = await originalCreate(opts);
      if (h.created.length > 1) return tab;
      if (mode === 'browser-error') h.tabs.get(tab.id).url = 'chrome-error://chromewebdata/';
      else if (mode !== 'close-fails') h.tabs.get(tab.id).status = 'loading';
      return h.tabs.get(tab.id);
    };
    let timeout;
    h.ctx.setTimeout = (fn, ms) => { if (ms === 30000) timeout = fn; return 1; };
    if (mode === 'close-fails') h.chrome.tabs.remove = async () => { throw new Error('cannot close tab'); };
    h.ctx.input = visitPlatform();
    const running = h.run('runCheckin(input)'); await new Promise(setImmediate);
    const tab = h.created[0];
    if (mode === 'loaded') {
      assert.equal(h.removed.length, 0);
      h.tabs.get(tab.id).status = 'complete';
      for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(tab.id, {status:'complete'}, h.tabs.get(tab.id));
    } else if (mode === 'timeout') timeout();
    else if (mode === 'closed') {
      h.tabs.delete(tab.id);
      for (const fn of [...h.chrome.tabs.onRemoved.listeners]) fn(tab.id);
    }
    const result = await running;
    assert.equal(result.ok, mode === 'loaded' || mode === 'close-fails', mode);
    if (mode !== 'loaded' && mode !== 'close-fails') assert.notEqual(result.visited, true, mode);
    if (mode === 'close-fails') assert.match(result.message, /关闭失败/);
    assert.equal(h.chrome.tabs.onUpdated.listeners.length, updatedCount, mode);
    assert.equal(h.chrome.tabs.onRemoved.listeners.length, removedCount, mode);
    assert.equal(h.tabs.has(tab.id), mode === 'close-fails', mode);
    if (mode !== 'close-fails') assert.ok(h.removed.includes(tab.id), mode);
    assertNoSiteRequests(h, counts);
  }
});
test('visit-only blocks only check-in calls while normal login and reads remain available', async () => {
  const h = harness('background.js'), counts = allowVisitReads(h); h.ctx.input = visitPlatform();
  for (const call of [
    'callCheckin(input,"GET")', 'callCheckin(input,"POST")',
    'runTurnstileCheckin(input)', 'callViaTab(input,input.baseUrl,"POST")',
    'callViaTabRaw(input,input.baseUrl,"/api/user/checkin","GET")', 'callApiPath(input,"/api/user/checkin","POST")',
    'callApi(input,"/api/user/checkin","POST")', 'rawGetJson(input,"/api/user/checkin")',
    'assertApiAllowed(input,"/api/user/%63heckin/?month=2026-10")',
  ]) await assert.rejects(h.run(call), /仅访问/, call);
  assert.equal(h.created.length, 0); assert.equal(counts.script, 0);
  assert.equal((await h.run('ensurePasswordSession(input)')).id, 12);
  assert.equal((await h.run('fetchAccount(input)')).available, 50);
  assert.equal((await h.run('callApi(input,"/api/user/self","GET")')).data.id, 12);
  const result = await h.run('runStats(input)');
  assert.equal(result.ok, true); assert.equal(result.account.available, 50); assert.equal(result.configOnly, undefined);
  assert.equal(await h.run('withInsightReader(input,()=>"read-only-models-available")'), 'read-only-models-available');
  assert.equal(await h.run('runKeepAliveCall(input)'), null);
  assertNoSiteRequests(h, counts);
});
test('visit-only preflight/batch/auto tasks never call check-in and use a separate daily marker', async () => {
  const p = visitPlatform({keepAlive:{enabled:false},stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); const counts = allowVisitReads(h);
  h.ctx.input = p;
  assert.equal((await h.run('findUncheckedPlatforms([input])')).length, 1);
  assert.equal(h.created.length, 0);
  const batch = await h.run('runBatchCheckinOne({id:input.id})');
  assert.equal(batch.visited, true); assert.equal(h.created.length, 1);
  const summary = await h.run('runAutoCheckin(true, [input])');
  assert.equal(summary.visited, 1); assert.equal(summary.ok, 0); assert.equal(summary.fail, 0);
  assert.equal(summary.list[0].kind, 'visited');
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
  assert.equal(h.store[PLATFORMS][0].statsDate, undefined);
  assert.equal(h.store[PLATFORMS][0].lastCheckinAt, undefined);
  assert.equal(h.store[PLATFORMS][0].lastVisitDate, h.run('todayStr()'));
  const before = h.created.length;
  assert.equal((await h.run('(async()=>collectAutoTodo(await getPlatforms()))()')).length, 0);
  await h.run('(async()=>runAutoCheckin(true, await getPlatforms()))()');
  assert.equal(h.created.length, before);
  // Old check-in cache must not suppress an as-yet-unvisited visit-only platform.
  h.ctx.input = visitPlatform({id:'legacy-cache', stats:{checked_in_today:true}, statsDate:h.run('todayStr()')});
  assert.equal((await h.run('findUncheckedPlatforms([input])')).length, 1);
  assertNoSiteRequests(h, counts);
});
test('saved visit-only config blocks stale UI requests that omitted the flag', async () => {
  const p = visitPlatform(), h = harness('background.js', {[PLATFORMS]:[p]}); const counts = allowVisitReads(h);
  const listener = h.chrome.runtime.onMessage.listeners[0];
  const request = (type) => new Promise((resolve) => listener({type,platform:passwordPlatform()}, {id:h.chrome.runtime.id,url:h.chrome.runtime.getURL('popup.html')}, resolve));
  assert.equal((await request('checkin')).visited, true);
  assert.equal((await request('account')).ok, true);
  assert.equal((await request('stats')).account.available, 50);
  assertNoSiteRequests(h, counts);
});
test('visit-only flag invalidates pending connection checks and accepts all auth modes', () => {
  const ui = uiHarness();
  ui.ctx.a = visitPlatform(); ui.ctx.b = passwordPlatform();
  assert.equal(ui.run('sameConnectionConfig(a,b)'), false);
  for (const file of ['popup.js', 'background.js']) {
    const h = file === 'popup.js' ? ui : harness(file);
    for (const authMode of ['token','cookie','password','agentrouter_token','agentrouter_linuxdo']) {
      h.ctx.input = passwordPlatform({authMode, visitOnly:true, accessToken:'system-token'});
      assert.doesNotThrow(() => h.run('validatePlatform(input)'));
      assert.equal(h.run('isVisitOnly(input)'), true);
    }
  }
});
test('Linux DO durable click reservation prevents duplicates when injection results are lost', async () => {
  const {h, tab} = await startLinuxDoApprovalFlow();
  const anchor = approvalAnchor(); installLinuxDoApprovalFixture(h,tab.url,[anchor]);
  const execute = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async (spec) => { await execute(spec); throw new Error('lost result after click'); };
  await fireTabUpdated(h,tab,tab.url);
  assert.equal(anchor._options.clicks,1);
  assert.equal(h.store[PENDING][tab.id].approveClickStarted,true);
  h.chrome.scripting.executeScript = execute;
  await fireOAuthAlarm(h);
  assert.equal(anchor._options.clicks,1);
  assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today,true);
});
test('Linux DO queues state reads as well as writes so delayed old snapshots cannot click twice', async () => {
  const {h, tab} = await startLinuxDoApprovalFlow();
  const anchor = approvalAnchor(); installLinuxDoApprovalFixture(h,tab.url,[anchor]);
  const originalGet = h.chrome.storage.local.get;
  let release, delayed = false;
  h.chrome.storage.local.get = (keys,cb) => {
    if (keys === PENDING && !delayed) {
      delayed = true;
      originalGet(keys,(snapshot) => { release = () => cb(snapshot); });
    } else originalGet(keys,cb);
  };
  h.ctx.tabId = tab.id; h.ctx.tabUrl = tab.url;
  const first = h.run('handleAgentRouterReauthTab(tabId,tabUrl)');
  await new Promise(setImmediate);
  const second = h.run('handleAgentRouterReauthTab(tabId,tabUrl)');
  await new Promise(setImmediate);
  assert.equal(anchor._options.clicks,0);
  release(); await Promise.all([first,second]);
  assert.equal(anchor._options.clicks,1);
  assert.equal(h.store[PENDING][tab.id].approveClickStarted,true);
});
test('Linux DO never clicks if durable reservation fails to save', async () => {
  const {h,tab} = await startLinuxDoApprovalFlow();
  const anchor = approvalAnchor(); installLinuxDoApprovalFixture(h,tab.url,[anchor]);
  const originalSet = h.chrome.storage.local.set;
  h.chrome.storage.local.set = (values,cb) => {
    if (values[PENDING]?.[tab.id]?.approveClickStarted === true) {
      h.chrome.runtime.lastError = {message:'storage full'};
      try {cb();} finally {delete h.chrome.runtime.lastError;}
    } else originalSet(values,cb);
  };
  h.ctx.tabId = tab.id; h.ctx.tabUrl = tab.url;
  for (let i=0;i<2;i++) await assert.rejects(h.run('handleAgentRouterReauthTab(tabId,tabUrl)'),/storage full/);
  assert.equal(anchor._options.clicks,0); assert.equal(h.injections.length,0);
  assert.equal(h.store[PENDING][tab.id].approveClickStarted,false);
  h.chrome.storage.local.set = originalSet;
  await h.run('handleAgentRouterReauthTab(tabId,tabUrl)');
  assert.equal(anchor._options.clicks,1);
});
test('queued automatic preflight and task re-read newly-enabled visit-only before any requests', async () => {
  const original = passwordPlatform({keepAlive:{enabled:true,key:'api-key'},stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[original]}); const counts = allowVisitReads(h);
  let release; const gate = new Promise((resolve)=>release=resolve);
  h.ctx.input = original; h.ctx.hold = async()=>gate;
  const blocker = h.run('withPlatformSession(input,hold)');
  await new Promise(setImmediate);
  const preflight = h.run('findUncheckedPlatforms([input])');
  const automatic = h.run('runAutoCheckin(true,[input])');
  await new Promise(setImmediate);
  const latest = visitPlatform({keepAlive:{enabled:false},stats:{checked_in_today:false}});
  await new Promise((resolve)=>h.chrome.storage.local.set({[PLATFORMS]:[latest]},resolve));
  assert.equal(h.created.length,0); release();
  await blocker;
  const todo = await preflight, summary = await automatic;
  assert.equal(todo.length,1); assert.equal(todo[0].visitOnly,true);
  assert.equal(summary.visited,1); assert.equal(summary.ok,0); assert.equal(summary.aliveOk,0);
  assert.equal(h.created.length,1); assert.equal(h.removed.length,1);
  assert.equal(h.store[PLATFORMS][0].visitOnly,true);
  assert.equal(h.store[PLATFORMS][0].keepAlive.enabled,false);
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today,false);
  await assert.rejects(h.run('callCheckin(input,"POST")'),/仅访问/);
  assertNoSiteRequests(h,counts);
});
test('visit completion after another UI disables visit-only never marks check-in or refreshes accounts', async () => {
  const ui = uiHarness(); await ui.run('init()');
  ui.ctx.input = visitPlatform({stats:{checked_in_today:false}});
  ui.run('platforms=[input];render()');
  const send = ui.chrome.runtime.sendMessage; let complete;
  ui.chrome.runtime.sendMessage = (msg,cb) => {
    if (msg.type === 'checkin') {ui.messages.push(msg);complete=cb;}
    else send(msg,cb);
  };
  const running = ui.run('checkin(input.id)'); await new Promise(setImmediate);
  ui.chrome.storage.local.set({[PLATFORMS]:[passwordPlatform({visitOnly:false,stats:{checked_in_today:false}})]},()=>{});
  complete({ok:true,visited:true,data:null,message:'访问完成',lastVisitDate:ui.run('todayStr()'),lastVisitedAt:new Date().toISOString()});
  await running;
  assert.equal(ui.run('platforms[0].visitOnly'),false);
  assert.equal(ui.run('platforms[0].stats.checked_in_today'),false);
  assert.equal(ui.nodes.get('checkedPlatforms').textContent,0);
  assert.ok(!ui.messages.some((msg)=>msg.type==='account'));
});
test('automatic visit result cannot overwrite a config changed while its page was loading', async () => {
  const initial = visitPlatform({stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[initial]});const counts=allowVisitReads(h);
  const create=h.chrome.tabs.create;
  h.chrome.tabs.create=async(opts)=>{const tab=await create(opts);h.tabs.get(tab.id).status='loading';return h.tabs.get(tab.id);};
  h.ctx.input=initial;const running=h.run('runAutoCheckin(true,[input])');await new Promise(setImmediate);
  const latest=passwordPlatform({visitOnly:false,stats:{checked_in_today:false}});
  await new Promise((resolve)=>h.chrome.storage.local.set({[PLATFORMS]:[latest]},resolve));
  const tab=h.created[0];h.tabs.get(tab.id).status='complete';
  for(const fn of [...h.chrome.tabs.onUpdated.listeners])fn(tab.id,{status:'complete'},h.tabs.get(tab.id));
  const summary=await running;
  assert.equal(summary.visited,1);assert.equal(summary.ok,0);
  assert.equal(h.store[PLATFORMS][0].visitOnly,false);
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today,false);
  assert.equal(h.store[PLATFORMS][0].lastVisitDate,undefined);
  assertNoSiteRequests(h,counts);
});
test('Linux DO callback arriving during approval remains queued and retains this-round evidence', async () => {
  const {h,tab,pending} = await startLinuxDoApprovalFlow();
  const anchor=approvalAnchor();installLinuxDoApprovalFixture(h,tab.url,[anchor]);
  let release;const gate=new Promise((resolve)=>release=resolve);
  h.ctx.script=async(spec)=>{
    if(spec.func.name==='tabClickLinuxDoApprove'){const result=spec.func(...spec.args);await gate;return result;}
    return {ok:false};
  };
  h.ctx.tabId=tab.id;h.ctx.authorizeUrl=tab.url;
  const approval=h.run('handleAgentRouterReauthTab(tabId,authorizeUrl)');await new Promise(setImmediate);
  assert.equal(anchor._options.clicks,1);
  const callback=pending.origin+'/oauth/linuxdo?code=fake-code&state=round-state';
  await h.chrome.tabs.update(tab.id,{url:callback});h.ctx.callbackUrl=callback;
  const observed=h.run('handleAgentRouterReauthTab(tabId,callbackUrl)');
  release();await Promise.all([approval,observed]);
  assert.equal(h.store[PENDING][tab.id].callbackSeen,true);
  assert.equal(anchor._options.clicks,1);
  assert.notEqual(h.store[PLATFORMS][0].stats?.checked_in_today,true);
});

for (const html of ['popup.html', 'sidebar.html']) {
  test(`${html}: visit-only is available and persists across all five auth modes`, async () => {
    const ui = uiHarness(html);
    await ui.run('init()'); ui.run('openModal()');
    ui.nodes.get('visitOnly').checked = true; ui.nodes.get('visitOnly').onchange();
    for (const authMode of ['token','cookie','password','agentrouter_token','agentrouter_linuxdo']) {
      ui.nodes.get('authMode').value = authMode; ui.nodes.get('authMode').onchange();
      assert.equal(ui.nodes.get('visitOnlyField').style.display, '');
      assert.equal(ui.nodes.get('visitOnly').checked, true);
      assert.equal(ui.run('formData().visitOnly'), true);
      assert.equal(ui.nodes.get('testBtn').textContent, '检测连接');
      ui.ctx.input = visitPlatform({authMode, accessToken:'token'});
      ui.run('openModal(input)');
      assert.equal(ui.nodes.get('visitOnly').checked, true);
      assert.doesNotMatch(ui.nodes.get('authHint').textContent, /不主动登录/);
    }
  });
}
for (const authMode of ['token','cookie','password','agentrouter_token','agentrouter_linuxdo']) {
  test(`${authMode}: an authenticated visit checks identity before closing and never checks in`, async () => {
    const platform = visitPlatform({authMode, accessToken:'must-not-be-used', stats:{checked_in_today:false}});
    const h = harness('background.js', {[PLATFORMS]:[platform]});
    const counts = allowVisitReads(h);
    h.ctx.input = platform;
    const result = await h.run('runCheckin(input)');
    assert.equal(result.visited, true);
    assert.equal(h.created.length, 1); assert.equal(h.removed.length, 1);
    assert.ok(counts.identity >= 2);
    assertNoSiteRequests(h, counts);
    assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
    assert.equal(h.store[PLATFORMS][0].lastCheckinAt, undefined);
    assert.ok(h.injections.every((spec) => !JSON.stringify(spec.args).includes('must-not-be-used')));
  });
}
test('visit-only password login keeps its sole page open until fresh online identity and home are confirmed', async () => {
  const p = visitPlatform({stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
  let submitted = false, online = false, release;
  const loginFinished = new Promise((resolve) => {release = resolve;});
  h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:404};
    assert.equal(h.removed.length, 0);
    if (spec.func.name === 'tabFetchCheckin') {
      if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      assert.equal(spec.args[0], '/api/user/self'); assert.equal(spec.args[1], 'GET');
      return online ? {ok:true,body:{success:true,data:{id:12,email:'alice@example.com',quota:50,used_quota:2}}} : {ok:false,status:401};
    }
    if (spec.func.name === 'tabLogout') return {ok:true};
    if (spec.func.name === 'tabSubmitPasswordLogin') {
      submitted = true; assert.equal(spec.args[2], p.loginPassword); return {ok:true};
    }
    if (spec.func.name === 'tabReadAgentRouterStoredUser') {
      await loginFinished; return {id:12,checked_in:true};
    }
    assert.fail(`Unexpected injection: ${spec.func.name}`);
  };
  const running = h.run('runBatchCheckinOne(input)'); await new Promise(setImmediate);
  assert.equal(submitted, true); assert.equal(h.removed.length, 0);
  assert.equal(h.created.length, 1); assert.match(h.tabs.get(h.created[0].id).url, /\/login$/);
  online = true; release();
  const result = await running;
  assert.equal(result.visited, true); assert.equal(h.removed.length, 1);
  assert.equal(h.updates.at(-1).url, 'https://anyrouter.top/');
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
  assert.equal(h.store[PLATFORMS][0].lastCheckinAt, undefined);
});
test('visit-only password failure logs out and closes without a visit marker', async () => {
  const h = harness('background.js'); h.ctx.input = visitPlatform();
  h.ctx.script = async ({func}) => func.name === 'tabLogout' ? {ok:true} :
    func.name === 'tabSubmitPasswordLogin' ? {ok:false,message:'验证码未完成'} : {ok:false,status:401};
  const result = await h.run('runCheckin(input)');
  assert.equal(result.ok, false); assert.match(result.message, /验证码/);
  assert.equal(result.visited, undefined); assert.equal(result.lastVisitDate, undefined);
  assert.equal(h.created.length, 1); assert.equal(h.removed.length, 1);
  assert.equal(h.tabs.has(h.created[0].id), false);
});
for (const authMode of ['cookie','token']) {
  test(`${authMode}: visit-only waits for manual web login instead of accepting a token or loaded page`, async () => {
    const h = harness('background.js'); h.ctx.input = visitPlatform({authMode, accessToken:'not-a-web-session'});
    let release, attempts = 0;
    const manualLogin = new Promise((resolve) => {release = resolve;});
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:404};
      assert.equal(spec.func.name, 'tabFetchCheckin');
      if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      assert.equal(spec.args[0], '/api/user/self');
      if (++attempts === 1) return {ok:false,status:401};
      await manualLogin;
      return {ok:true,body:{success:true,data:{id:12,quota:50}}};
    };
    const running = h.run('runCheckin(input)'); await new Promise(setImmediate);
    assert.equal(h.removed.length, 0); assert.equal(h.created.length, 1);
    assert.equal(h.tabs.get(h.created[0].id).url, 'https://anyrouter.top/login');
    release();
    const result = await running;
    assert.equal(result.visited, true); assert.equal(h.removed.length, 1);
    assert.equal(h.updates.at(-1).url, 'https://anyrouter.top/');
  });
}
test('a stale cached user, online 401 or wrong account cannot complete a visit', async () => {
  for (const kind of ['cached-only','wrong-user','different-origin','redirect-during-probe']) {
    const h = harness('background.js'); h.ctx.input = visitPlatform({authMode:'cookie'});
    h.ctx.script = async (spec) => {
      assert.equal(spec.func.name, 'tabFetchCheckin');
      if (kind === 'cached-only') return {ok:false,status:401,body:{data:{id:12,quota:50}}};
      if (kind === 'redirect-during-probe') h.tabs.get(spec.target.tabId).url = 'https://evil.example/';
      return {ok:true,body:{success:true,data:{id:kind === 'wrong-user' ? 99 : 12}}};
    };
    if (kind === 'different-origin') {
      const create = h.chrome.tabs.create;
      h.chrome.tabs.create = async (opts) => {const tab = await create(opts); h.tabs.get(tab.id).url = 'https://evil.example/'; return tab;};
    }
    const result = await h.run('runCheckin(input)');
    assert.equal(result.ok, false, kind); assert.equal(result.visited, undefined, kind);
    assert.ok(h.removed.includes(h.created[0].id), kind); assert.equal(h.tabs.has(h.created[0].id), false, kind);
  }
});
for (const [provider, authMode] of [['github','agentrouter_token'],['linuxdo','agentrouter_linuxdo'],['github','cookie']]) {
  for (const validState of [true,false]) {
    test(`${authMode}: visit-only OAuth ${validState ? 'closes only after a matching callback and online login' : 'rejects a wrong-state callback'}`, async () => {
      const p = oauthPlatform({authMode,visitOnly:true,stats:{checked_in_today:false}});
      const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
      let authenticated = validState, oauthStarted = false, logouts = 0;
      const update = h.chrome.tabs.update;
      h.chrome.tabs.update = async (id, opts) => {
        const result = await update(id, opts);
        if (opts.url && new URL(opts.url).origin !== p.baseUrl) {
          assert.equal(h.removed.length, 0);
          oauthStarted = true;
          const pending = h.store[PENDING][id];
          assert.equal(pending.visitOnly, true); assert.equal(pending.oauthState, 'visit-state');
          const callback = `${p.baseUrl}/oauth/${provider}?code=auth-code&state=${validState ? 'visit-state' : 'wrong-state'}`;
          authenticated = true;
          h.tabs.get(id).url = callback;
          for (const fn of h.chrome.tabs.onUpdated.listeners) fn(id, {url:callback}, h.tabs.get(id));
          h.tabs.get(id).url = p.baseUrl + '/console';
        }
        return result;
      };
      h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:404};
        assert.equal(h.removed.length, 0);
        if (spec.func.name === 'tabFetchCheckin') {
          if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      assert.equal(spec.args[0], '/api/user/self'); assert.equal(spec.args[1], 'GET');
          return authenticated ? {ok:true,body:{success:true,data:{id:12,checked_in:true,quota:50}}} : {ok:false,status:401};
        }
        if (spec.func.name === 'tabReadAgentRouterDashboard') {
          return authenticated ? {ok:true,body:{success:true,data:{id:12,quota:50}}} : {ok:false};
        }
        if (spec.func.name === 'tabLogout') { logouts++; authenticated = false; return {ok:true}; }
        if (spec.func.name === 'tabBuildAgentRouterOauthUrl') {
          assert.equal(spec.args[0], provider);
          const url = new URL(provider === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://connect.linux.do/oauth2/authorize');
          url.search = new URLSearchParams({state:'visit-state',client_id:'visit-client',response_type:'code'}).toString();
          return {ok:true,url:url.href};
        }
        assert.fail(`Unexpected OAuth visit injection ${spec.func.name}`);
      };
      const result = await h.run('runBatchCheckinOne(input)');
      assert.equal(logouts, 1); assert.equal(oauthStarted, true); assert.equal(result.ok, validState);
      assert.equal(result.visited === true, validState);
      assert.equal(h.created.length, 1); assert.equal(h.removed.length, 1);
      assert.deepEqual(h.store[PENDING], {});
      assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
      assert.equal(h.store[PLATFORMS][0].lastCheckinAt, undefined);
      if (validState) {assert.equal(h.reloaded.length, 1); assert.equal(h.updates.at(-1).url, p.baseUrl + '/console');}
    });
  }
}
test('same-origin visit tasks reserve their login lifecycle before asynchronous checks', async () => {
  const h = harness('background.js'); const counts = allowVisitReads(h); h.ctx.input = visitPlatform();
  const results = await h.run('Promise.all([runCheckin(input), runCheckin(input)])');
  assert.equal(results.filter((r) => r.visited).length, 1);
  assert.equal(h.created.length, 1); assert.equal(h.removed.length, 1);
  assert.match(results.find((r) => !r.ok).message, /其他访问或登录任务/);
  assertNoSiteRequests(h, counts);
  assert.equal(h.run('visitOnlyOrigins.size'), 0);
});
test('visit-only rechecks shared account immediately before closing its owned page', async () => {
  const h = harness('background.js'); h.ctx.input = visitPlatform({authMode:'cookie'});
  let probe = 0;
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name, 'tabFetchCheckin');
    return {ok:true,body:{success:true,data:{id:++probe === 1 ? 12 : 99}}};
  };
  const result = await h.run('runCheckin(input)');
  assert.equal(result.ok, false); assert.match(result.message, /不一致/);
  assert.equal(result.visited, undefined); assert.equal(h.removed.length, 1);
  assert.equal(h.tabs.has(h.created[0].id), false);
  assert.equal(h.run('visitOnlyOrigins.size'), 0);
});

test('visit-only refreshes once and publishes fresh quota and monthly tokens before closing', async () => {
  const p = visitPlatform({authMode:'cookie',account:{available:100,used:5,monthlyTokens:99},stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
  const existing = await h.chrome.tabs.create({url:'https://anyrouter.top/console',active:true});
  let refreshed = false, refreshes = 0; const requests = [];
  const update = h.chrome.tabs.update;
  h.chrome.tabs.update = async (id, opts) => {
    if (opts.url === 'https://anyrouter.top/') {refreshes++; refreshed = true;}
    return update(id, opts);
  };
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name, 'tabFetchCheckin'); assert.equal(spec.args[1], 'GET');
    assert.equal(h.removed.length, 0);
    requests.push({tabId:spec.target.tabId,path:spec.args[0],refreshed});
    if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[{prompt_tokens:12,completion_tokens:8}]}};
    assert.equal(spec.args[0], '/api/user/self');
    return {ok:true,body:{success:true,data:{id:12,quota:refreshed ? 180 : 100,used_quota:7,request_count:3}}};
  };
  const remove = h.chrome.tabs.remove;
  h.chrome.tabs.remove = async (id) => {
    assert.equal(h.store[PLATFORMS][0].account.available, 180);
    assert.equal(h.store[PLATFORMS][0].account.monthlyTokens, 20);
    assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
    await remove(id);
  };
  const result = await h.run('runCheckin(input)');
  assert.equal(result.visited, true); assert.equal(refreshes, 1);
  assert.equal(result.account.available, 180); assert.equal(result.account.used, 7);
  assert.equal(result.account.monthlyTokens, 20); assert.equal(result.quotaDelta, 80);
  assert.equal(h.created.length, 2); assert.deepEqual(h.removed, [h.created[1].id]);
  assert.ok(h.tabs.has(existing.id));
  assert.ok(requests.every((r) => r.tabId === h.created[1].id));
  assert.ok(requests.some((r) => r.refreshed && r.path === '/api/user/self'));
  assert.equal(h.store[PLATFORMS][0].lastCheckinAt, undefined);
});
test('visit-only preserves password re-login for callback-triggered sites even with a valid old session', async () => {
  const p = visitPlatform({baseUrl:'https://agentrouter.org',account:{available:100},stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
  let submitted = false, refreshed = false, logouts = 0, refreshes = 0;
  const update = h.chrome.tabs.update;
  h.chrome.tabs.update = async (id, opts) => {
    if (opts.url === p.baseUrl + '/') {assert.equal(submitted, true); refreshed = true; refreshes++;}
    return update(id, opts);
  };
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabFetchCheckin') {
      if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      assert.equal(spec.args[0], '/api/user/self');
      return {ok:true,body:{success:true,data:{id:12,email:'alice@example.com',quota:refreshed ? 200 : 100}}};
    }
    if (spec.func.name === 'tabLogout') {logouts++; return {ok:true};}
    if (spec.func.name === 'tabSubmitPasswordLogin') {submitted = true; return {ok:true};}
    if (spec.func.name === 'tabReadAgentRouterStoredUser') return submitted ? {id:12,checked_in:true} : null;
    assert.fail(spec.func.name);
  };
  const result = await h.run('runCheckin(input,{reauth:true})');
  assert.equal(result.visited, true); assert.equal(result.account.available, 200);
  assert.equal(logouts, 1); assert.equal(submitted, true); assert.equal(refreshes, 1);
  assert.equal(h.created.length, 1); assert.equal(h.removed.length, 1);
  assert.equal(h.store[PLATFORMS][0].account.available, 200);
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
});
test('unchanged and zero quota close normally; missing or invalid latest quota still closes without logout', async () => {
  for (const quota of [50,0,null,'invalid',true,' ']) {
    const p = visitPlatform({authMode:'cookie',account:{available:quota === 0 ? 0 : 50}});
    const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
    allowVisitReads(h, {id:12,quota});
    const result = await h.run('runCheckin(input)');
    const valid = quota === 50 || quota === 0;
    assert.equal(result.ok, valid, String(quota));
    assert.equal(result.visited === true, valid, String(quota));
    assert.equal(h.removed.length, 1, String(quota));
    if (valid) {assert.equal(result.account.available, quota); assert.equal(result.quotaDelta, 0);}
    else {assert.equal(h.tabs.has(h.created[0].id), false); assert.equal(h.store[PLATFORMS][0].account.available, 50);}
  }
});
test('normal log-read failure does not discard freshly refreshed quota or prevent closing', async () => {
  const p = visitPlatform({authMode:'cookie',account:{available:100}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name, 'tabFetchCheckin');
    if (spec.args[0] === '/api/log/self') return {ok:false,body:{success:false,message:'日志权限不足'}};
    assert.equal(spec.args[0], '/api/user/self');
    return {ok:true,body:{success:true,data:{id:12,quota:130}}};
  };
  const result = await h.run('runCheckin(input)');
  assert.equal(result.visited, true); assert.equal(result.account.available, 130);
  assert.equal(result.account.monthlyTokens, null); assert.match(result.account._warn, /本月Token接口不可用/);
  assert.equal(h.removed.length, 1);
});
test('visit-only retains enabled keepalive in batch and automatic tasks without implicitly enabling it', async () => {
  for (const enabled of [false,true]) {
    const p = visitPlatform({keepAlive:{enabled,key:'dedicated-api-key',model:'configured-model'}});
    const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
    const counts = allowVisitReads(h); let calls = 0;
    h.ctx.keepaliveCapture = async (format,url,key,model) => {
      calls++; assert.equal(key, 'dedicated-api-key'); assert.equal(model, 'configured-model');
      return {ok:true,model};
    };
    h.run('attemptKeepAlive = keepaliveCapture');
    const batch = await h.run('runBatchCheckinOne(input)');
    assert.equal(batch.visited, true); assert.equal(calls, enabled ? 1 : 0);
    const summary = await h.run('runAutoCheckin(true,[input])');
    assert.equal(summary.visited, 1); assert.equal(summary.aliveFail, 0);
    assert.equal(calls, enabled ? 1 : 0);
    if (enabled) assert.equal(h.store[PLATFORMS][0].keepAlive.lastDate, h.run("todayStr()"));
    assert.equal(h.store[PLATFORMS][0].keepAlive.enabled, enabled);
    assertNoSiteRequests(h, counts);
  }
});
test('visit result for changed credentials cannot overwrite a different account in UI or storage', async () => {
  const ui = uiHarness(); await ui.run('init()');
  ui.ctx.input = visitPlatform({account:{available:100}}); ui.run('platforms=[input];render()');
  let complete; const send = ui.chrome.runtime.sendMessage;
  ui.chrome.runtime.sendMessage = (msg, cb) => msg.type === 'checkin' ? complete = cb : send(msg, cb);
  const running = ui.run('checkin(input.id)'); await new Promise(setImmediate);
  ui.chrome.storage.local.set({[PLATFORMS]:[visitPlatform({userId:'99',loginUsername:'bob@example.com',account:{available:999}})]},()=>{});
  complete({ok:true,visited:true,account:{available:200},lastVisitDate:ui.run('todayStr()'),message:'old account result'});
  await running;
  assert.equal(ui.run('platforms[0].userId'), '99');
  assert.equal(ui.run('platforms[0].account.available'), 999);
  assert.equal(ui.run('platforms[0].lastVisitDate'), undefined);
  assert.equal(ui.run('platforms[0].loading'), false);
});
test('visit-only normal model read dispatch remains available and check-in aliases stay blocked', async () => {
  const h = harness('background.js'); h.ctx.input = visitPlatform({authMode:'token',accessToken:'system-token'});
  let reads = 0;
  h.ctx.fetch = async (url) => {
    assert.equal(new URL(url).pathname, '/api/status'); reads++;
    return {ok:true,status:200,headers:{get(){return 'application/json';}},async text(){return JSON.stringify({success:true,data:{version:'test'}});}};
  };
  const result = await h.run('withInsightReader(input,read=>read("/api/status"))');
  assert.equal(result.ok, true); assert.equal(reads, 1);
  h.ctx.input = visitPlatform({checkinPath:'/custom/checkin'});
  await assert.rejects(h.run('callApi(input,"/custom/checkin","POST")'), /仅访问/);
  h.ctx.input = visitPlatform({checkinPath:'/api/user/self',triggerSelf:true});
  await assert.doesNotReject(h.run('assertApiAllowed(input,"/api/user/self")'));
});
test('visit-only waits for its one refresh to complete before reading final quota', async () => {
  const p = visitPlatform({authMode:'cookie'}), h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
  const counts = allowVisitReads(h); const update = h.chrome.tabs.update;
  h.chrome.tabs.update = async (id, opts) => {
    const tab = await update(id, opts);
    if (opts.url === 'https://anyrouter.top/') h.tabs.get(id).status = 'loading';
    return tab;
  };
  const running = h.run('runCheckin(input)'); await new Promise(setImmediate);
  assert.equal(counts.identity, 1); assert.equal(h.removed.length, 0);
  const tab = h.created[0]; h.tabs.get(tab.id).status = 'complete';
  for (const fn of h.chrome.tabs.onUpdated.listeners) fn(tab.id, {status:'complete'}, h.tabs.get(tab.id));
  const result = await running;
  assert.equal(result.visited, true); assert.equal(result.account.available, 50);
  assert.equal(h.updates.filter((x) => x.url === 'https://anyrouter.top/').length, 1);
  assert.equal(h.removed.length, 1); assertNoSiteRequests(h, counts);
});
test('failure to publish fresh account data still logs out and closes', async () => {
  const p = visitPlatform({authMode:'cookie',account:{available:10}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p; allowVisitReads(h);
  h.chrome.storage.local.set = (values, cb) => {
    h.chrome.runtime.lastError = {message:'存储写入失败'};
    cb(); delete h.chrome.runtime.lastError;
  };
  const result = await h.run('runCheckin(input)');
  assert.equal(result.ok, false); assert.match(result.message, /存储写入失败/);
  assert.equal(result.visited, undefined); assert.equal(h.removed.length, 1);
  assert.equal(h.tabs.has(h.created[0].id), false);
  assert.equal(h.store[PLATFORMS][0].account.available, 10);
  assert.equal(h.run('visitOnlyOrigins.size'), 0);
});

function sharedAgentSession(h, initialUserId = 11, options = {}) {
  const users = {github:11, linuxdo:22};
  let currentUserId = initialUserId;
  const logins = [], logouts = [], reads = [];
  const user = () => currentUserId == null ? null : {id:currentUserId, username:'user-' + currentUserId,
    quota:currentUserId * 100, used_quota:currentUserId, checked_in:true};
  const update = h.chrome.tabs.update;
  const finish = async (tabId, provider, overrideUserId) => {
    const pending = h.store[PENDING] && h.store[PENDING][tabId];
    assert.ok(pending, 'callback must belong to an owned pending tab');
    currentUserId = overrideUserId ?? users[provider];
    const callback = pending.origin + '/oauth/' + provider + '?code=code-' + tabId + '&state=' + pending.oauthState;
    await update(tabId, {url:callback});
    for (const fn of h.chrome.tabs.onUpdated.listeners) fn(tabId, {url:callback}, h.tabs.get(tabId));
    await update(tabId, {url:pending.origin + '/console'});
  };
  h.chrome.tabs.update = async (tabId, opts) => {
    const result = await update(tabId, opts);
    if (opts.url && /^https:\/\/(github\.com|connect\.linux\.do)\//.test(opts.url)) {
      const pending = h.store[PENDING][tabId];
      logins.push({tabId, provider:pending.provider, platformId:pending.platformId, userId:pending.userId});
      assert.equal(currentUserId, null, 'target-site session must be logged out before changing provider');
      if (!options.manual) await finish(tabId, pending.provider, options.callbackUserId);
    }
    return result;
  };
  h.ctx.script = async (spec) => {
    const name = spec.func.name;
    if (name === 'tabRefreshAuthToken') return {httpOk:false,status:404};
    if (name === 'tabReadAgentRouterStoredUser') return user();
    if (name === 'tabLogout') {logouts.push(currentUserId); currentUserId = null; return {ok:true};}
    if (name === 'tabBuildAgentRouterOauthUrl') {
      const provider = spec.args[0];
      const url = new URL(provider === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://connect.linux.do/oauth2/authorize');
      url.search = new URLSearchParams({client_id:'dynamic-client-id',state:'round-' + spec.target.tabId + '-' + provider,response_type:'code'}).toString();
      return {ok:true,url:url.href};
    }
    if (name === 'tabFetchCheckin') {
      const path = spec.args[0];
      assert.ok(['/api/user/self','/api/log/self'].includes(path), 'visit must not call check-in');
      if (path === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      reads.push({tabId:spec.target.tabId, expected:spec.args[3], actual:currentUserId});
      return currentUserId == null ? {ok:false,status:401,body:{success:false,message:'未登录'}} : {ok:true,body:{success:true,data:user()}};
    }
    if (['tabFetchAgentRouterAccount','tabReadAgentRouterDashboard'].includes(name)) {
      const configured = String(spec.args[name === 'tabReadAgentRouterDashboard' ? 1 : 0]);
      if (currentUserId != null && configured !== String(currentUserId)) return {userMismatch:true,actualUserId:String(currentUserId),configuredUserId:configured};
      return currentUserId == null ? {ok:false,status:401,message:'未登录'} : {ok:true,body:{success:true,data:user()}};
    }
    if (name === 'tabCheckAgentRouterLogin') {
      const configured = String(spec.args[0]);
      if (currentUserId == null) return {ok:false};
      const matches = configured === String(currentUserId);
      return {ok:matches,userMismatch:!matches,userId:String(currentUserId),checkedIn:true,
        account:{available:currentUserId * 100,used:currentUserId,displayName:'user-' + currentUserId}};
    }
    assert.fail('Unexpected shared-session script ' + name);
  };
  return {logins,logouts,reads,finish,get userId(){return currentUserId;}};
}
for (const visitOnly of [true,false]) {
  test(`different GitHub/Linux DO accounts can switch the shared site session safely (${visitOnly ? 'visit' : 'checkin'})`, async () => {
    const github = oauthPlatform({id:'github-11',authMode:'agentrouter_token',userId:'11',visitOnly,stats:{checked_in_today:false}});
    const linux = oauthPlatform({id:'linux-22',userId:'22',visitOnly,stats:{checked_in_today:false}});
    const h = harness('background.js', {[PLATFORMS]:[github,linux]}); h.ctx.github = github; h.ctx.linux = linux;
    const shared = sharedAgentSession(h, 11);
    const summary = await h.run('runAutoCheckin(true,[linux,github])'); await settleBackgroundEvents();
    assert.deepEqual(shared.logins.map((p)=>p.provider), ['linuxdo','github']);
    assert.deepEqual(shared.logins.map((p)=>p.userId), ['22','11']);
    assert.deepEqual(shared.logouts, [11,22]);
    assert.equal(shared.userId, 11); assert.equal(summary.fail, 0);
    assert.equal(h.store[PLATFORMS].find((p)=>p.id === github.id).account.available, 1100);
    assert.equal(h.store[PLATFORMS].find((p)=>p.id === linux.id).account.available, 2200);
    for (const p of h.store[PLATFORMS]) assert.equal(p.stats.checked_in_today, !visitOnly);
    if (visitOnly) assert.equal(summary.visited, 2);
    assert.deepEqual(h.store[PENDING], {});
  });
  test(`detecting another OAuth account does not reuse the current account or require its session (${visitOnly ? 'visit' : 'checkin'})`, async () => {
    const github = oauthPlatform({id:'github-11',authMode:'agentrouter_token',userId:'11',visitOnly});
    const linux = oauthPlatform({id:'linux-22',userId:'22',visitOnly});
    const h = harness('background.js', {[PLATFORMS]:[github,linux]}); h.ctx.input = linux;
    const shared = sharedAgentSession(h, 11);
    const result = await h.run('runStats(input)');
    assert.equal(result.ok, true); assert.equal(result.needsLogin, true); assert.equal(result.configOnly, true);
    assert.equal(result.account, undefined); assert.equal(shared.userId, 11);
    assert.equal(shared.logouts.length, 0); assert.equal(shared.logins.length, 0);
  });
}

test('pending GitHub authorization completes before Linux DO can replace the shared session', async () => {
  const github = oauthPlatform({id:'github-11',authMode:'agentrouter_token',userId:'11',stats:{checked_in_today:false}});
  const linux = oauthPlatform({id:'linux-22',userId:'22',stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[github,linux]}); h.ctx.github = github; h.ctx.linux = linux;
  const shared = sharedAgentSession(h, 11, {manual:true});
  const first = await h.run('runCheckin(github,{reauth:true})');
  assert.equal(first.pending, true);
  const firstPending = structuredClone(Object.values(h.store[PENDING])[0]);
  const polls = [];
  const scheduleTimeout = h.ctx.setTimeout;
  h.ctx.setTimeout = (fn, ms) => {
    if (ms === 1200) { polls.push(fn); return 1; }
    return scheduleTimeout(fn, ms); // Keep the distinct 1500 ms callback-settle buffer live.
  };
  const second = h.run('runCheckin(linux,{reauth:true})'); await new Promise(setImmediate);
  assert.equal(shared.logins.length, 1); assert.deepEqual(shared.logouts, [11]);
  assert.equal(Object.values(h.store[PENDING])[0].platformId, github.id);
  assert.equal(Object.values(h.store[PENDING])[0].oauthState, firstPending.oauthState);
  assert.ok(polls.length > 0);
  await shared.finish(firstPending.tabId, 'github'); await settleBackgroundEvents();
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, true);
  polls.shift()();
  const result = await second;
  assert.equal(result.pending, true);
  assert.deepEqual(shared.logins.map((p)=>p.provider), ['github','linuxdo']);
  assert.deepEqual(shared.logouts, [11,11]);
  const next = Object.values(h.store[PENDING])[0];
  assert.equal(next.platformId, linux.id); assert.equal(next.userId, '22'); assert.notEqual(next.oauthState, firstPending.oauthState);
  h.ctx.tabId = next.tabId; h.ctx.staleUrl = firstPending.origin + '/oauth/github?code=stale&state=' + firstPending.oauthState;
  await h.run('handleAgentRouterReauthTab(tabId,staleUrl)');
  assert.notEqual(h.store[PENDING][next.tabId].callbackSeen, true);
  await shared.finish(next.tabId, 'linuxdo'); await settleBackgroundEvents();
  assert.equal(h.store[PLATFORMS][1].stats.checked_in_today, true);
  assert.equal(h.store[PLATFORMS][0].account.available, 1100);
  assert.equal(h.store[PLATFORMS][1].account.available, 2200);
  assert.deepEqual(h.store[PENDING], {});
});

test('pending reuse requires the same platform, provider, user ID, auth mode and visit purpose', () => {
  const p = oauthPlatform({id:'linux-22',userId:'22'}); const h = harness('background.js'); h.ctx.input = p;
  h.ctx.pending = {platformId:p.id,authMode:p.authMode,provider:'linuxdo',userId:'22',visitOnly:false};
  assert.equal(h.run('sameOauthTask(pending,input)'), true);
  for (const change of [{id:'other-platform'},{userId:'11'},{authMode:'agentrouter_token'},{visitOnly:true}]) {
    h.ctx.input = {...p,...change}; assert.equal(h.run('sameOauthTask(pending,input)'), false);
  }
});
for (const visitOnly of [true,false]) {
  test(`a wrong account returned by Linux DO is rejected after OAuth, not accepted as the old GitHub user (${visitOnly ? 'visit' : 'checkin'})`, async () => {
    const linux = oauthPlatform({id:'linux-22',userId:'22',visitOnly,stats:{checked_in_today:false}});
    const h = harness('background.js', {[PLATFORMS]:[linux]}); h.ctx.input = linux;
    const shared = sharedAgentSession(h, 11, {callbackUserId:11});
    const result = await h.run('runCheckin(input,{reauth:true})');
    await Promise.all([...h.run('agentRouterReauthQueues.values()')]);
    assert.deepEqual(shared.logins.map((p)=>p.provider), ['linuxdo']);
    assert.deepEqual(shared.logouts, [11]);
    assert.notEqual(result.visited, true);
    assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
    assert.equal(h.store[PLATFORMS][0].account, undefined);
    if (visitOnly) assert.equal(result.ok, false);
    else assert.match(h.store[PLATFORMS][0].error, /不一致/);
  });
}
for (const html of ['popup.html','sidebar.html']) {
  test(`${html}: a second OAuth account can be saved without copying the first account or claiming a verified session`, async () => {
    const github = oauthPlatform({id:'github-11',authMode:'agentrouter_token',userId:'11',account:{available:1100},stats:{checked_in_today:true}});
    const ui = uiHarness(html), bg = harness('background.js', {[PLATFORMS]:[github]});
    bridgeExtension(ui, bg); const shared = sharedAgentSession(bg, 11);
    await ui.run('init()'); ui.run('openModal()');
    ui.nodes.get('name').value = 'Linux DO 22'; ui.nodes.get('baseUrl').value = 'https://agentrouter.org';
    ui.nodes.get('authMode').value = 'agentrouter_linuxdo'; ui.nodes.get('authMode').onchange(); ui.nodes.get('userId').value = '22';
    const detection = await ui.run('testConnection()');
    assert.equal(detection.needsLogin, true); assert.doesNotMatch(ui.nodes.get('connectionStatus').textContent, /连接成功/);
    await ui.nodes.get('platformForm').onsubmit({preventDefault(){},submitter:{disabled:false}});
    const rows = bg.store[PLATFORMS]; assert.equal(rows.length, 2);
    assert.equal(rows[0].account.available, 1100); assert.equal(rows[0].stats.checked_in_today, true);
    assert.equal(rows[1].userId, '22'); assert.equal(rows[1].account, null);
    assert.notEqual(rows[1].stats.checked_in_today, true);
    assert.ok(ui.toasts.some((text)=>text.includes('尚未验证登录')));
    assert.equal(shared.userId, 11); assert.equal(shared.logins.length, 0); assert.equal(shared.logouts.length, 0);
  });
}
function installAccountXhr(h, reply) {
  const local = new Map([['user', JSON.stringify({id:11,quota:1100,used_quota:11,checked_in:true})]]);
  h.ctx.localStorage = {getItem(k){return local.get(k)||null;},setItem(k,v){local.set(k,v);}};
  h.ctx.XMLHttpRequest = class {
    open(){} setRequestHeader(){} getResponseHeader(){return 'application/json';}
    send(){this.status=reply.status;this.responseText=JSON.stringify(reply.body);this.responseURL='https://agentrouter.org/api/user/self';queueMicrotask(()=>this.onload());}
  };
  return local;
}
test('strict Agent Router identity reads never substitute a previous cached balance or accept a different live account', async () => {
  const h = harness('background.js');
  const local = installAccountXhr(h, {status:200,body:{success:true,data:{id:11,quota:0,used_quota:0}}});
  const strict = await h.run('tabFetchAgentRouterAccount("11",true)');
  assert.equal(strict.ok, true); assert.equal(strict.body.data.quota, 0); assert.equal(strict.usedCachedAccount, undefined);
  assert.equal(JSON.parse(local.get('user')).quota, 1100);
  const legacy = await h.run('tabFetchAgentRouterAccount("11")');
  assert.equal(legacy.usedCachedAccount, true); assert.equal(legacy.body.data.quota, 1100);
  const otherLocal = installAccountXhr(h, {status:200,body:{success:true,data:{id:22,quota:2200}}});
  const mismatch = await h.run('tabFetchAgentRouterAccount("11",true)');
  assert.equal(mismatch.userMismatch, true); assert.equal(mismatch.actualUserId, '22');
  assert.equal(JSON.parse(otherLocal.get('user')).id, 11);
});
test('cached user data and a 401 or missing live ID cannot pass OAuth connection detection', async () => {
  for (const reply of [{status:401,body:{success:false,message:'未登录'}},{status:200,body:{success:true,data:{quota:1100}}}]) {
    const h = harness('background.js'); h.ctx.input = oauthPlatform({authMode:'agentrouter_token',userId:'11'});
    installAccountXhr(h, reply);
    h.ctx.script = async (spec) => {assert.equal(spec.func.name, 'tabFetchAgentRouterAccount'); assert.equal(spec.args[1], true); return spec.func(...spec.args);};
    const result = await h.run('runStats(input)');
    assert.equal(result.configOnly, true); assert.equal(result.needsLogin, true); assert.equal(result.account, undefined);
  }
});

test('a stale GitHub localStorage identity does not block Linux DO after the live session has switched', async () => {
  const h = harness('background.js');
  const local = installAccountXhr(h, {status:200,body:{success:true,data:{id:22,quota:2200,used_quota:22}}});
  const headers = []; h.ctx.XMLHttpRequest.prototype.setRequestHeader = (key,value) => headers.push([key,value]);
  const result = await h.run('tabFetchAgentRouterAccount("22",true)');
  assert.equal(result.ok, true); assert.equal(result.body.data.id, 22); assert.equal(result.body.data.quota, 2200);
  assert.ok(headers.some(([key,value])=>key === 'New-API-User' && value === '22'));
  assert.equal(JSON.parse(local.get('user')).id, 11);
});
test('OAuth waits for stale previous-account localStorage to update instead of rejecting an already-correct live session', async () => {
  const p = oauthPlatform({id:'linux-22',userId:'22',reauthPending:true,reauthStartedAt:Date.now(),stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); await settleBackgroundEvents();
  const tab = await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  h.ctx.pending = {tabId:tab.id,platformId:p.id,authMode:p.authMode,origin:p.baseUrl,userId:p.userId,provider:'linuxdo',oauthStarted:true,oauthState:'state-linux',createdAt:p.reauthStartedAt};
  await h.run('updateAgentRouterPending(pending.tabId,pending,null,true)'); let cachedReads = 0;
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabCheckAgentRouterLogin') return ++cachedReads === 1 ?
      {ok:false,userMismatch:true,userId:'11',checkedIn:true} : {ok:true,userId:'22',checkedIn:true,account:{available:999}};
    if (spec.func.name === 'tabFetchCheckin') {assert.equal(spec.args[0], '/api/log/self'); return {ok:true,body:{success:true,data:[]}};}
    assert.equal(spec.func.name, h.reloaded.length ? 'tabReadAgentRouterDashboard' : 'tabFetchAgentRouterAccount');
    if (!h.reloaded.length) assert.equal(spec.args[1], true);
    return {ok:true,body:{success:true,data:{id:22,quota:2200,used_quota:22}}};
  };
  await h.run('handleAgentRouterReauthTab(pending.tabId,"https://agentrouter.org/oauth/linuxdo?code=c&state=state-linux")');
  assert.equal(cachedReads, 2); assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, true);
  assert.equal(h.store[PLATFORMS][0].account.available, 2200);
  assert.deepEqual(h.store[PENDING], {}); assert.deepEqual(h.removed, [tab.id]);
});
test('a cached correct identity cannot hide a different live account or keep the OAuth lease stuck', async () => {
  const p = oauthPlatform({id:'linux-22',userId:'22',reauthPending:true,reauthStartedAt:Date.now(),stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); await settleBackgroundEvents();
  const tab = await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  h.ctx.pending = {tabId:tab.id,platformId:p.id,authMode:p.authMode,origin:p.baseUrl,userId:p.userId,provider:'linuxdo',oauthStarted:true,oauthState:'state-linux',createdAt:p.reauthStartedAt};
  await h.run('updateAgentRouterPending(pending.tabId,pending,null,true)');
  h.ctx.script = async (spec) => spec.func.name === 'tabCheckAgentRouterLogin' ?
    {ok:true,userId:'22',checkedIn:true,account:{available:2200}} : {ok:true,body:{success:true,data:{id:11,quota:1100}}};
  await h.run('handleAgentRouterReauthTab(pending.tabId,"https://agentrouter.org/oauth/linuxdo?code=c&state=state-linux")');
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
  assert.equal(h.store[PLATFORMS][0].reauthPending, false); assert.match(h.store[PLATFORMS][0].error, /不一致/);
  assert.equal(h.store[PLATFORMS][0].account, undefined); assert.deepEqual(h.store[PENDING], {});
  assert.ok(h.tabs.has(tab.id));
});
test('another OAuth config can be detected while the first authorizes without disturbing that pending flow', async () => {
  const github = oauthPlatform({id:'github-11',authMode:'agentrouter_token',userId:'11'});
  const linux = oauthPlatform({id:'linux-22',userId:'22'});
  const h = harness('background.js', {[PLATFORMS]:[github,linux]}); h.ctx.github = github; h.ctx.linux = linux;
  const shared = sharedAgentSession(h, 11, {manual:true});
  await h.run('runCheckin(github,{reauth:true})');
  const before = structuredClone(h.store[PENDING]);
  const result = await h.run('runStats(linux)');
  assert.equal(result.configOnly, true); assert.equal(result.needsLogin, true);
  assert.equal(shared.logins.length, 1); assert.deepEqual(h.store[PENDING], before);
});
test('an old check-in callback cannot mark success after the platform switches to visit-only', async () => {
  const p = oauthPlatform({visitOnly:true,stats:{checked_in_today:false}});
  const h = harness('background.js', {[PLATFORMS]:[p]});
  h.ctx.pending = {platformId:p.id,authMode:p.authMode,origin:p.baseUrl,userId:p.userId,provider:'linuxdo',createdAt:Date.now(),visitOnly:false};
  await h.run('saveAgentRouterLoginOutcome(pending,{ok:true,checkedIn:true,account:{available:999}},"old check-in")');
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
  assert.equal(h.store[PLATFORMS][0].account, undefined); assert.equal(h.store[PLATFORMS][0].lastCheckinAt, undefined);
});

async function ownedCallbackFixture(authMode = 'agentrouter_linuxdo', extra = {}) {
  const stamp = Date.now();
  const p = oauthPlatform({authMode,reauthPending:true,reauthStartedAt:stamp,account:{available:10},stats:{checked_in_today:false},...extra});
  const h = harness('background.js', {[PLATFORMS]:[p]});
  await settleBackgroundEvents();
  const tab = await h.chrome.tabs.create({url:p.baseUrl + '/console',active:true});
  const pending = {tabId:tab.id,platformId:p.id,authMode:p.authMode,origin:p.baseUrl,base:p.baseUrl,userId:p.userId,
    provider:authMode === 'agentrouter_token' ? 'github' : 'linuxdo',oauthStarted:true,oauthState:'current-round',createdAt:stamp};
  h.ctx.pending = pending;
  await h.run('updateAgentRouterPending(pending.tabId,pending,null,true)');
  const callback = p.baseUrl + '/oauth/' + pending.provider + '?code=current-code&state=current-round';
  h.ctx.callback = callback;
  return {h,p,tab,pending,callback};
}
for (const mode of ['agentrouter_token','agentrouter_linuxdo']) {
  test(`${mode}: a transient old live account during OAuth is retried, then the original tab is refreshed and quota saved before close`, async () => {
    const {h,p,tab} = await ownedCallbackFixture(mode);
    let reads = 0, refreshed = false;
    const reload = h.chrome.tabs.reload;
    h.chrome.tabs.reload = async (id, opts) => {
      assert.equal(id, tab.id); assert.equal(reads, 3); refreshed = true;
      return reload(id, opts);
    };
    h.ctx.script = async (spec) => {
      assert.equal(spec.target.tabId, tab.id); assert.equal(h.removed.length, 0);
      if (spec.func.name === 'tabCheckAgentRouterLogin') return {ok:true,userId:p.userId,checkedIn:true,account:{available:9999}};
      if (spec.func.name === 'tabFetchCheckin') {
        assert.equal(spec.args[0], '/api/log/self'); assert.equal(refreshed, true);
        return {ok:true,body:{success:true,data:[{prompt_tokens:12,completion_tokens:8}]}};
      }
      assert.equal(spec.func.name, refreshed ? 'tabReadAgentRouterDashboard' : 'tabFetchAgentRouterAccount');
      if (!refreshed) assert.equal(spec.args[1], true);
      if (!refreshed && ++reads < 3) return {userMismatch:true,actualUserId:'99',configuredUserId:p.userId};
      return {ok:true,body:{success:true,data:{id:Number(p.userId),quota:refreshed ? 180 : 100,used_quota:7}}};
    };
    const remove = h.chrome.tabs.remove;
    h.chrome.tabs.remove = async (id) => {
      const saved = h.store[PLATFORMS][0];
      assert.equal(saved.account.available, 180); assert.equal(saved.account.monthlyTokens, 20);
      assert.equal(saved.stats.checked_in_today, true); assert.equal(saved.error, '');
      await remove(id);
    };
    await h.run('handleAgentRouterReauthTab(pending.tabId,callback)');
    assert.equal(h.reloaded.length, 1); assert.equal(h.reloaded[0].bypassCache, true);
    assert.equal(h.created.length, 1); assert.deepEqual(h.removed, [tab.id]);
    assert.deepEqual(h.store[PENDING], {});
    await settleBackgroundEvents();
    assert.equal(h.created.length, 1, 'completion must not reopen an account-reader page');
  });
}
test('an authenticated self response on /oauth is not enough to interrupt the frontend callback', async () => {
  const {h,tab,callback} = await ownedCallbackFixture();
  h.tabs.get(tab.id).url = callback;
  h.ctx.script = async ({func}) => func.name === 'tabCheckAgentRouterLogin'
    ? {ok:true,userId:'12',checkedIn:true}
    : func.name === 'tabFetchCheckin' ? {ok:true,body:{success:true,data:[]}}
    : {ok:true,body:{success:true,data:{id:12,quota:80}}};
  await h.run('handleAgentRouterReauthTab(pending.tabId,callback)');
  assert.equal(h.reloaded.length, 0); assert.equal(h.updates.length, 0); assert.equal(h.removed.length, 0);
  assert.equal(h.store[PENDING][tab.id].callbackSeen, true);
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
  h.tabs.get(tab.id).url = 'https://agentrouter.org/console';
  await h.run('handleAgentRouterReauthTab(pending.tabId,"https://agentrouter.org/console")');
  assert.equal(h.reloaded.length, 1); assert.deepEqual(h.removed, [tab.id]);
});
test('a completed OAuth login updates quota even when the callback did not confirm check-in', async () => {
  const {h,tab} = await ownedCallbackFixture();
  h.ctx.script = async ({func}) => func.name === 'tabCheckAgentRouterLogin'
    ? {ok:true,userId:'12',checkedIn:false}
    : func.name === 'tabFetchCheckin' ? {ok:true,body:{success:true,data:[]}}
    : {ok:true,body:{success:true,data:{id:12,quota:80,used_quota:2}}};
  await h.run('handleAgentRouterReauthTab(pending.tabId,callback)');
  assert.equal(h.store[PLATFORMS][0].account.available, 80);
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
  assert.equal(h.reloaded.length, 1); assert.equal(h.removed.length, 0);
  assert.equal(h.tabs.get(tab.id).active, true); assert.deepEqual(h.store[PENDING], {});
});
for (const failure of ['missing-quota','wrong-account','session-expired']) {
  test(`OAuth refresh ${failure} retains the original page and does not substitute cached quota`, async () => {
    const {h,tab} = await ownedCallbackFixture();
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabCheckAgentRouterLogin') return {ok:true,userId:'12',checkedIn:true,account:{available:9999}};
      if (spec.func.name === 'tabFetchCheckin') return {ok:true,body:{success:true,data:[]}};
      assert.equal(spec.func.name, h.reloaded.length ? 'tabReadAgentRouterDashboard' : 'tabFetchAgentRouterAccount');
      if (!h.reloaded.length) return {ok:true,body:{success:true,data:{id:12,quota:100}}};
      if (failure === 'session-expired') return {ok:false,status:401};
      if (failure === 'wrong-account') return {userMismatch:true,actualUserId:'99'};
      return {ok:true,body:{success:true,data:{id:12}}};
    };
    await h.run('handleAgentRouterReauthTab(pending.tabId,callback)');
    assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, true);
    assert.equal(h.store[PLATFORMS][0].account.available, 10);
    assert.match(h.store[PLATFORMS][0].message, /额度刷新失败/);
    assert.equal(h.removed.length, 0); assert.equal(h.created.length, 1);
    assert.equal(h.tabs.get(tab.id).active, true); assert.deepEqual(h.store[PENDING], {});
  });
}
test('an OAuth account changed in settings is not used to refresh the old callback tab', async () => {
  const {h,tab,p} = await ownedCallbackFixture();
  h.chrome.storage.local.set({[PLATFORMS]:[{...p,userId:'99',account:{available:999}}]},()=>{});
  h.ctx.script = async ({func}) => func.name === 'tabCheckAgentRouterLogin'
    ? {ok:true,userId:'12',checkedIn:true}
    : {ok:true,body:{success:true,data:{id:12,quota:100}}};
  await h.run('handleAgentRouterReauthTab(pending.tabId,callback)');
  assert.equal(h.reloaded.length, 0); assert.equal(h.removed.length, 0); assert.ok(h.tabs.has(tab.id));
  assert.equal(h.store[PLATFORMS][0].account.available, 999); assert.deepEqual(h.store[PENDING], {});
});
for (const html of ['popup.html','sidebar.html']) {
  test(`${html}: run-now visit updates quota without a post-close account request or reopened tab`, async () => {
    const p = visitPlatform({authMode:'cookie',account:{available:10},stats:{checked_in_today:false}});
    const bg = harness('background.js', {[PLATFORMS]:[p]}), ui = uiHarness(html);
    bridgeExtension(ui, bg); allowVisitReads(bg, {id:12,quota:80,used_quota:2});
    await ui.run('init()');
    await ui.nodes.get('runNowBtn').onclick();
    await settleBackgroundEvents();
    assert.equal(bg.created.length, 1); assert.deepEqual(bg.removed, [bg.created[0].id]);
    assert.equal(bg.reloaded.length, 1); assert.equal(bg.store[PLATFORMS][0].account.available, 80);
    assert.equal(ui.run('platforms[0].account.available'), 80);
    assert.equal(ui.messages.filter((msg)=>msg.type === 'account').length, 0);
    assert.equal(ui.nodes.get('runNowBtn').disabled, false);
  });
  test(`${html}: manual check-in uses the returned fresh quota and does not reopen a stats page`, async () => {
    const ui = uiHarness(html);
    ui.ctx.input = {id:'token-12',name:'Token',baseUrl:'https://token.example',authMode:'token',accessToken:'system-token',userId:'12',account:{available:10}};
    ui.run('platforms=[input];render()');
    const send = ui.chrome.runtime.sendMessage;
    ui.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg.type !== 'checkin') return send(msg, cb);
      ui.messages.push(msg); cb({ok:true,message:'签到成功',data:{stats:{checked_in_today:true}},account:{available:80,used:2,monthlyTokens:20}});
    };
    await ui.run('checkin("token-12")');
    assert.equal(ui.store[PLATFORMS][0].account.available, 80);
    assert.equal(ui.store[PLATFORMS][0].stats.checked_in_today, true);
    assert.equal(ui.messages.filter((msg)=>msg.type === 'account').length, 0);
  });
}
test('automatic token check-in stores post-check-in quota even without an open UI', async () => {
  const p = {id:'token-12',name:'Token',baseUrl:'https://token.example',authMode:'token',accessToken:'system-token',userId:'12',account:{available:10}};
  const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
  const requests = [];
  h.ctx.fetch = async (url, opts) => {
    const pathname = new URL(url).pathname; requests.push({pathname,method:opts.method});
    const body = {success:true,data:pathname === '/api/log/self' ? [{prompt_tokens:12,completion_tokens:8}] :
      pathname === '/api/user/self' ? {id:12,quota:80,used_quota:2} : {stats:{checked_in_today:true}}};
    return {ok:true,async json(){return body;},async text(){return JSON.stringify(body);}};
  };
  const summary = await h.run('runAutoCheckin(true,[input])');
  assert.equal(summary.ok, 1); assert.equal(summary.fail, 0);
  assert.equal(h.store[PLATFORMS][0].account.available, 80);
  assert.equal(h.store[PLATFORMS][0].account.monthlyTokens, 20);
  assert.ok(requests.some((r)=>r.pathname === '/api/user/self'));
  assert.equal(h.created.length, 0);
});
test('a slow OAuth authorization does not consume the visit account-mismatch grace period', async () => {
  const {h,p,tab} = await ownedCallbackFixture('agentrouter_linuxdo', {visitOnly:true});
  h.ctx.input = p;
  h.store[PENDING][tab.id].visitOnly = true;
  let polls = 0, probes = 0;
  h.ctx.setTimeout = (fn, ms) => {
    if (ms === 800) setImmediate(() => {
      if (++polls === 15) h.store[PENDING][tab.id].callbackSeen = true;
      fn();
    });
    return 0;
  };
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name, 'tabFetchCheckin'); assert.equal(spec.args[0], '/api/user/self');
    return {ok:true,body:{success:true,data:{id:++probes < 3 ? 99 : 12,quota:80}}};
  };
  const user = await h.run('waitVisitSession(input,pending.tabId,true)');
  assert.equal(user.id, 12); assert.equal(probes, 3); assert.ok(polls >= 17);
  assert.equal(h.removed.length, 0); assert.equal(h.store[PLATFORMS][0].error, undefined);
});

for (const status of [0,401,403,500]) {
  test(`Agent Router failed account request HTTP ${status} is not a user-ID mismatch`, async () => {
    const h = harness('background.js');
    installAccountXhr(h, {status,body:{success:false,message:'request failed'}});
    if (!status) h.ctx.XMLHttpRequest.prototype.send = function(){this.status=0;queueMicrotask(()=>this.onerror());};
    const result = await h.run('tabFetchAgentRouterAccount("272149",true)');
    assert.equal(result.ok, false); assert.equal(result.status, status);
    assert.notEqual(result.userMismatch, true); assert.equal(result.actualUserId, undefined);
    assert.equal(result.cachedUser, null);
  });
}
for (const id of [false,true,'false',null,undefined]) {
  test(`Agent Router invalid online identity ${String(id)} is not accepted or reported as another account`, async () => {
    const h = harness('background.js');
    installAccountXhr(h, {status:200,body:{success:true,data:{id,quota:80}}});
    const result = await h.run('tabFetchAgentRouterAccount("272149",true)');
    assert.equal(result.ok, false); assert.equal(result.invalidIdentity, true); assert.notEqual(result.userMismatch, true);
    h.ctx.body = {data:{id,quota:80}};
    assert.doesNotThrow(()=>h.run('verifyConfiguredUser({userId:"272149"},body)'));
  });
}
for (const mode of ['agentrouter_linuxdo','agentrouter_token']) {
  test(`${mode}: after login the refreshed dashboard supplies quota without any additional self XHR`, async () => {
    const {h,p,tab} = await ownedCallbackFixture(mode, {userId:mode === 'agentrouter_linuxdo' ? '272149' : '427285'});
    const local = installDashboardDom(h, {id:Number(p.userId),balance:'$227.04',used:'$2,022.29'});
    let xhrReads = 0, refreshReads = 0;
    h.ctx.XMLHttpRequest = class {
      open(){} setRequestHeader(){} getResponseHeader(){return 'application/json';}
      send(){
        assert.equal(h.reloaded.length, 0, 'post-refresh quota must not request the WAF-blocked self endpoint');
        xhrReads++;this.status=200;this.responseText=JSON.stringify({success:true,data:{id:Number(p.userId),quota:100}});
        queueMicrotask(()=>this.onload());
      }
    };
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabFetchCheckin') return {ok:true,body:{success:true,data:[{prompt_tokens:12,completion_tokens:8}]}};
      if (spec.func.name === 'tabReadAgentRouterDashboard') {
        assert.equal(h.reloaded.length, 1);assert.equal(spec.target.tabId,tab.id);
        if (++refreshReads < 3) return {ok:false,message:'看板仍在加载'};
      }
      return spec.func(...(spec.args || []));
    };
    await h.run('handleAgentRouterReauthTab(pending.tabId,callback)');
    const saved = h.store[PLATFORMS][0];
    assert.equal(saved.stats.checked_in_today, true);assert.equal(saved.error, '');
    assert.equal(saved.account.available,113520000);assert.equal(saved.account.used,1011145000);
    assert.equal(saved.account.monthlyTokens,20);assert.equal(saved.account.source,'dashboard');
    assert.equal(saved.account.availableDisplay,'$227.04');assert.match(saved.account._warn,/精度以页面为准/);
    assert.equal(xhrReads,1);assert.equal(refreshReads,4);
    assert.equal(h.reloaded.length,1);assert.deepEqual(h.removed,[tab.id]);
    assert.equal(JSON.parse(local.get('user')).quota,999999999, 'cached raw quota must not be used or overwritten');
  });
}

function backgroundRequest(h, message) {
  const listener = h.chrome.runtime.onMessage.listeners[0];
  return new Promise((resolve)=>listener(structuredClone(message), {id:h.chrome.runtime.id,url:h.chrome.runtime.getURL('popup.html')}, resolve));
}
const queueToken = (id, extra = {}) => ({id,name:id,authMode:'token',baseUrl:'https://' + id + '.example',accessToken:'system-token',userId:'12',account:{available:10},...extra});
test('manual and automatic check-ins across different origins share a single FIFO queue and save each result before the next starts', async () => {
  const a = queueToken('a'), b = queueToken('b'), c = queueToken('c');
  const h = harness('background.js', {[PLATFORMS]:[a,b,c]}); await settleBackgroundEvents();
  let releaseA, releaseB;
  const gateA = new Promise((resolve)=>releaseA=resolve), gateB = new Promise((resolve)=>releaseB=resolve);
  const order = [];
  h.ctx.perform = async (p) => {
    order.push(p.id + ':start');
    if (p.id === 'a') await gateA;
    if (p.id === 'b') {
      assert.equal(h.store[PLATFORMS][0].account.available, 80);
      await gateB;
    }
    if (p.id === 'c') assert.equal(h.store[PLATFORMS][1].error, 'expected failure');
    order.push(p.id + ':end');
    return p.id === 'b' ? {ok:false,message:'expected failure'} :
      {ok:true,message:'签到成功',data:{stats:{checked_in_today:true}},account:{available:80,monthlyTokens:20}};
  };
  h.run('runCheckin=perform'); h.ctx.input = c;
  const first = backgroundRequest(h, {type:'checkin',platform:a});
  const second = backgroundRequest(h, {type:'checkin',platform:b});
  const automatic = h.run('runAutoCheckin(true,[input])');
  await settleBackgroundEvents(); assert.deepEqual(order, ['a:start']);
  releaseA(); assert.equal((await first).ok, true);
  await settleBackgroundEvents(); assert.deepEqual(order, ['a:start','a:end','b:start']);
  releaseB(); assert.equal((await second).ok, false);
  const summary = await automatic;
  assert.equal(summary.ok, 1); assert.equal(summary.pending, 0);
  assert.deepEqual(order, ['a:start','a:end','b:start','b:end','c:start','c:end']);
  assert.equal(h.store[PLATFORMS][2].account.available, 80);
});
test('the global queue waits for OAuth quota saving and actual tab close before a different origin can check in', async () => {
  const github = oauthPlatform({id:'github-11',authMode:'agentrouter_token',userId:'11',stats:{checked_in_today:false}});
  const token = queueToken('later');
  const h = harness('background.js', {[PLATFORMS]:[github,token]}); await settleBackgroundEvents();
  const shared = sharedAgentSession(h, 11, {manual:true});
  let releaseQuota, releaseClose, closeStarted;
  const quotaGate = new Promise((resolve)=>releaseQuota=resolve);
  const closeGate = new Promise((resolve)=>releaseClose=resolve);
  const closing = new Promise((resolve)=>closeStarted=resolve);
  const script = h.ctx.script;
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabReadAgentRouterDashboard') await quotaGate;
    return script(spec);
  };
  const requests = [];
  h.ctx.fetch = async (url) => {
    const pathname = new URL(url).pathname; requests.push(pathname);
    assert.equal(h.store[PLATFORMS][0].account.available, 1100);
    const body = {success:true,data:pathname === '/api/log/self' ? [] : pathname === '/api/user/self' ? {id:12,quota:80} : {stats:{checked_in_today:true}}};
    return {ok:true,async json(){return body;},async text(){return JSON.stringify(body);}};
  };
  const first = backgroundRequest(h, {type:'checkin',platform:github});
  const second = backgroundRequest(h, {type:'checkin',platform:token});
  await settleBackgroundEvents();
  const pending = Object.values(h.store[PENDING])[0];
  assert.equal(shared.logins.length, 1); assert.equal(requests.length, 0);
  const remove = h.chrome.tabs.remove;
  h.chrome.tabs.remove = async (id) => {
    if (id === pending.tabId) {closeStarted(); await closeGate;}
    await remove(id);
  };
  await shared.finish(pending.tabId, 'github'); await settleBackgroundEvents();
  assert.equal(h.reloaded.length, 1); assert.equal(requests.length, 0);
  releaseQuota(); await closing;
  assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, true);
  assert.equal(h.store[PLATFORMS][0].account.available, 1100);
  assert.equal(requests.length, 0, 'saved outcome alone does not release the queue while the tab is still closing');
  releaseClose();
  const completed = await first;
  assert.equal(completed.ok, true); assert.equal(completed.reauthRequired, false); assert.equal(completed.account.available, 1100);
  assert.equal((await second).ok, true); assert.ok(requests.includes('/api/user/checkin'));
  assert.deepEqual(h.store[PENDING], {}); assert.ok(!h.tabs.has(pending.tabId));
});
for (const interruption of ['closed','timeout']) {
  test(`OAuth ${interruption} releases the queue as failure, retains safety, and lets the next task run`, async () => {
    const github = oauthPlatform({id:'github-11',authMode:'agentrouter_token',userId:'11',stats:{checked_in_today:false}});
    const next = queueToken('after');
    const h = harness('background.js', {[PLATFORMS]:[github,next]}); await settleBackgroundEvents();
    sharedAgentSession(h, 11, {manual:true});
    h.ctx.fetch = async (url) => {
      const pathname = new URL(url).pathname;
      const body = {success:true,data:pathname === '/api/log/self' ? [] : pathname === '/api/user/self' ? {id:12,quota:80} : {stats:{checked_in_today:true}}};
      return {ok:true,async json(){return body;},async text(){return JSON.stringify(body);}};
    };
    const first = backgroundRequest(h, {type:'checkin',platform:github});
    const second = backgroundRequest(h, {type:'checkin',platform:next});
    await settleBackgroundEvents(); const pending = Object.values(h.store[PENDING])[0];
    if (interruption === 'closed') await h.chrome.tabs.remove(pending.tabId);
    else h.ctx.Date = class extends Date {static now(){return Date.now() + 7 * 60 * 1000;}};
    const result = await first;
    assert.equal(result.ok, false); assert.equal(result.pending, false); assert.equal(result.reauthRequired, false);
    assert.match(result.message, interruption === 'closed' ? /已关闭/ : /连续 60 秒无有效进展/);
    if (interruption === 'timeout') assert.equal(result.code, 'CHECKIN_IDLE_TIMEOUT');
    assert.equal((await second).ok, true); assert.deepEqual(h.store[PENDING], {});
    assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
    assert.equal(h.store[PLATFORMS][1].account.available, 80);
    if (interruption === 'timeout') assert.ok(h.tabs.has(pending.tabId), 'timeout does not close a page needing user interaction');
  });
}
for (const html of ['popup.html','sidebar.html']) {
  test(`${html}: batch dispatch waits for each task instead of Promise.all`, async () => {
    const ui = uiHarness(html); ui.ctx.input = [queueToken('a'),queueToken('b')]; ui.run('platforms=input');
    const order = []; let release;
    const gate = new Promise((resolve)=>release=resolve);
    ui.ctx.action = async (id) => {order.push(id + ':start');if(id === 'a')await gate;order.push(id + ':end');};
    const running = ui.run('runBatch(action)'); await settleBackgroundEvents();
    assert.deepEqual(order, ['a:start']);release();await running;
    assert.deepEqual(order, ['a:start','a:end','b:start','b:end']);
  });
}
test('task identity compares only credentials relevant to the auth mode, ignoring omitted empty OAuth password fields', () => {
  const h = harness('background.js');
  h.ctx.saved = oauthPlatform({loginUsername:'',loginPassword:'',accessToken:''});
  h.ctx.message = oauthPlatform();
  assert.equal(h.run('sameTaskConfig(saved,message)'), true);
  h.ctx.message = oauthPlatform({userId:'99'}); assert.equal(h.run('sameTaskConfig(saved,message)'), false);
  h.ctx.saved = passwordPlatform(); h.ctx.message = passwordPlatform({loginPassword:'changed'});
  assert.equal(h.run('sameTaskConfig(saved,message)'), false);
  h.ctx.saved = queueToken('a'); h.ctx.message = queueToken('a',{accessToken:'different-token'});
  assert.equal(h.run('sameTaskConfig(saved,message)'), false);
});
test('a task whose credentials change while queued is cancelled without logging in or overwriting the new account', async () => {
  const a = queueToken('a'), b = queueToken('b');
  const h = harness('background.js', {[PLATFORMS]:[a,b]}); await settleBackgroundEvents();
  let release; const gate = new Promise((resolve)=>release=resolve); const starts = [];
  h.ctx.perform = async (p) => {starts.push(p.id);if(p.id === 'a')await gate;return {ok:true,message:'签到成功',account:{available:80}};};
  h.run('runCheckin=perform');
  const first = backgroundRequest(h, {type:'checkin',platform:a});
  const waiting = backgroundRequest(h, {type:'checkin',platform:b});
  await settleBackgroundEvents(); assert.deepEqual(starts, ['a']);
  h.chrome.storage.local.set({[PLATFORMS]:[h.store[PLATFORMS][0],{...b,userId:'99',account:{available:999}}]},()=>{});
  release(); await first; const cancelled = await waiting;
  assert.equal(cancelled.ok, false); assert.match(cancelled.message, /配置已变更/);
  assert.deepEqual(starts, ['a']); assert.equal(h.store[PLATFORMS][1].account.available, 999);
  assert.equal(h.store[PLATFORMS][1].error, undefined);
});
test('a fresh worker queue waits for an already-persisted OAuth task instead of starting the next check-in', async () => {
  const {h,p,tab,callback} = await ownedCallbackFixture();
  const next = queueToken('resumed');
  h.chrome.storage.local.set({[PLATFORMS]:[p,next]},()=>{});
  let quotaReady, releaseQuota;
  const started = new Promise((resolve)=>quotaReady=resolve), gate = new Promise((resolve)=>releaseQuota=resolve);
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabCheckAgentRouterLogin') return {ok:true,userId:'12',checkedIn:true};
    if (['tabFetchAgentRouterAccount','tabReadAgentRouterDashboard'].includes(spec.func.name)) {
      if (spec.func.name === 'tabReadAgentRouterDashboard') {quotaReady();await gate;}
      return {ok:true,body:{success:true,data:{id:12,quota:180}}};
    }
    assert.equal(spec.args[0], '/api/log/self'); return {ok:true,body:{success:true,data:[]}};
  };
  let requests = 0;
  h.ctx.perform = async () => {requests++;assert.equal(h.store[PLATFORMS][0].account.available,180);return {ok:true,message:'签到成功',account:{available:80}};};
  h.run('runCheckin=perform');
  const waiting = backgroundRequest(h, {type:'checkin',platform:next});
  await settleBackgroundEvents(); assert.equal(requests, 0);
  h.tabs.get(tab.id).url = p.baseUrl + '/console';
  for (const fn of h.chrome.tabs.onUpdated.listeners) fn(tab.id, {url:callback}, h.tabs.get(tab.id));
  await started; assert.equal(requests, 0);releaseQuota();
  assert.equal((await waiting).ok, true);assert.equal(requests, 1);
  assert.deepEqual(h.store[PENDING], {}); assert.ok(!h.tabs.has(tab.id));
});

// Minimal DOM shaped like the supplied Agent Router screenshot, including visibility/loading.
function installDashboardDom(h, options = {}) {
  const o = {id:12,username:'linuxdo_272149',balance:'$227.04',used:'$2,022.29',requests:'14,590',unit:'500000',currency:'true',...options};
  const local = new Map([['user',JSON.stringify({id:o.id,username:o.username,checked_in:true,quota:999999999})],['quota_per_unit',o.unit],['display_in_currency',o.currency]]);
  const el = (text, extra = {}) => ({textContent:text,children:[],getClientRects(){return this.hidden?[]:[{width:10,height:10}];},...extra});
  const labels = [['当前余额',o.balance],['历史消耗',o.used],['请求次数',o.requests]].map(([label,value])=>el(label,{nextElementSibling:el(value,{hidden:o.hiddenValue})}));
  const card = el('账户数据', {getAttribute(name){return name==='aria-busy' && o.busy?'true':null;},querySelector(){return o.skeleton?{}:null;},querySelectorAll(){return labels;}});
  h.ctx.location={origin:'https://agentrouter.org',pathname:o.pathname || '/console'};
  h.ctx.document={readyState:o.readyState || 'complete',querySelectorAll(selector){return selector==='.semi-card'?[card]:[el(o.shownUsername || o.username)];}};
  h.ctx.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});
  h.ctx.localStorage={getItem(k){return local.get(k)??null;},setItem(k,v){local.set(k,v);}};
  return local;
}
for (const [balance, expected, extras] of [
  ['$227.04',113520000,{}],['$0.00',0,{}],['$1,234.56',617280000,{}],['$-1.25',-625000,{}],
  ['$227.04',22704000,{unit:'100000'}],['113.5M',113500000,{currency:'false'}],['1,234',1234,{currency:'false'}],
]) {
  test(`dashboard DOM parses displayed ${balance} without using cached quota`,async()=>{
    const h=harness('background.js');installDashboardDom(h,{balance,...extras});
    const r=await h.run('tabReadAgentRouterDashboard("https://agentrouter.org","12")');
    assert.equal(r.ok,true);assert.equal(r.body.data.quota,expected);assert.equal(r.body.data._accountSource,'dashboard');
    assert.equal(r.body.data.request_count,14590);
  });
}
for (const options of [{balance:'—'},{balance:'$NaN'},{balance:'$1,23'},{balance:'$1.2M'},{balance:'¥227.04'},
  {balance:'0.00'},{unit:''},{unit:'0'},{busy:true},{skeleton:true},{hiddenValue:true},{readyState:'loading'},
  {pathname:'/login'},{shownUsername:'other-user'}]) {
  test(`dashboard DOM rejects loading, missing, ambiguous or wrong-identity values ${JSON.stringify(options)}`,async()=>{
    const h=harness('background.js');installDashboardDom(h,options);
    const r=await h.run('tabReadAgentRouterDashboard("https://agentrouter.org","12")');
    assert.equal(r.ok,false);assert.equal(r.body,undefined);
  });
}
test('dashboard DOM rejects a different numeric user ID or origin',async()=>{
  const h=harness('background.js');installDashboardDom(h,{id:99});
  const wrong=await h.run('tabReadAgentRouterDashboard("https://agentrouter.org","12")');
  assert.equal(wrong.userMismatch,true);assert.equal(wrong.actualUserId,'99');
  assert.equal((await h.run('tabReadAgentRouterDashboard("https://other.example","99")')).ok,false);
});
test('dashboard polling stops after exactly five failed reads without self XHR or another refresh',async()=>{
  const h=harness('background.js');const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  h.ctx.p=oauthPlatform();h.ctx.tabId=tab.id;let reads=0;
  h.ctx.script=async spec=>{assert.equal(spec.func.name,'tabReadAgentRouterDashboard');reads++;return {ok:false,message:'仍在加载'};};
  await assert.rejects(h.run('waitAgentRouterAccountOnTab(p,tabId)'),/5 次/);
  assert.equal(reads,5);assert.equal(h.reloaded.length,0);assert.equal(h.removed.length,0);
});
test('a login landing on the token page navigates to the dashboard in the same tab before reading balance',async()=>{
  const h=harness('background.js');const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console/token'});
  h.ctx.p=oauthPlatform();h.ctx.tabId=tab.id;
  const update=h.chrome.tabs.update;
  h.chrome.tabs.update=async(id,opts)=>{const out=await update(id,opts);if(opts.url?.endsWith('/console'))setImmediate(()=>{
    for(const fn of h.chrome.tabs.onUpdated.listeners)fn(id,{status:'complete'},out);
  });return out;};
  h.ctx.script=async spec=>{
    assert.equal(spec.target.tabId,tab.id);assert.equal(h.tabs.get(tab.id).url,'https://agentrouter.org/console');
    if(spec.func.name==='tabReadAgentRouterDashboard')return {ok:true,body:{success:true,data:{id:12,quota:80,_accountSource:'dashboard',_availableDisplay:'$0.00016'}}};
    assert.equal(spec.func.name,'tabFetchCheckin');assert.equal(spec.args[0],'/api/log/self');
    return {ok:true,body:{success:true,data:[]}};
  };
  const result=await h.run('refreshLoginAccountOnTab(p,tabId)');
  assert.equal(result.available,80);assert.equal(h.created.length,1);assert.equal(h.reloaded.length,0);
  assert.equal(h.updates.filter(x=>x.url?.endsWith('/console')).length,1);
});

test('dashboard polling retries an initial double-zero balance and returns the later displayed amounts',async()=>{
  const h=harness('background.js');const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  h.ctx.p=oauthPlatform();h.ctx.tabId=tab.id;let reads=0;
  h.ctx.script=async spec=>{
    assert.equal(spec.func.name,'tabReadAgentRouterDashboard');reads++;
    installDashboardDom(h,reads<3?{balance:'$0.00',used:'$0.00'}:{balance:'$227.04',used:'$2,022.29'});
    return spec.func(...spec.args);
  };
  const user=await h.run('waitAgentRouterAccountOnTab(p,tabId)');
  assert.equal(reads,3);assert.equal(user.quota,113520000);assert.equal(user.used_quota,1011145000);
  assert.equal(h.reloaded.length,0);
});
for (const [balance,used] of [['$0.00','$2,022.29'],['$227.04','$0.00']]) {
  test(`dashboard polling accepts one zero without requiring both balances to be positive: ${balance}/${used}`,async()=>{
    const h=harness('background.js');const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
    h.ctx.p=oauthPlatform();h.ctx.tabId=tab.id;installDashboardDom(h,{balance,used});let reads=0;
    h.ctx.script=async spec=>{reads++;return spec.func(...spec.args);};
    const user=await h.run('waitAgentRouterAccountOnTab(p,tabId)');
    assert.equal(reads,1);assert.equal(user.quota,balance==='$0.00'?0:113520000);
    assert.equal(user.used_quota,used==='$0.00'?0:1011145000);
  });
}
test('dashboard double-zero detection does not treat a missing used amount as numeric zero',async()=>{
  const h=harness('background.js');const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  h.ctx.p=oauthPlatform();h.ctx.tabId=tab.id;installDashboardDom(h,{balance:'$0.00',used:'—'});
  h.ctx.script=async spec=>spec.func(...spec.args);
  const user=await h.run('waitAgentRouterAccountOnTab(p,tabId)');
  assert.equal(user.quota,0);assert.equal(user.used_quota,null);
});
for (const mode of ['agentrouter_linuxdo','agentrouter_token']) {
  for (const failureStage of ['initial-read','final-verification']) {
    test(`${mode}: persistent double-zero during ${failureStage} preserves the last confirmed snapshot and page without claiming completion`,async()=>{
      const {h,p,tab}=await ownedCallbackFixture(mode);let domReads=0;
      h.ctx.script=async spec=>{
        if(spec.func.name==='tabCheckAgentRouterLogin')return {ok:true,userId:p.userId,checkedIn:true};
        if(spec.func.name==='tabFetchAgentRouterAccount')return {ok:true,body:{success:true,data:{id:Number(p.userId),quota:100,used_quota:10}}};
        if(spec.func.name==='tabFetchCheckin')return {ok:true,body:{success:true,data:[]}};
        assert.equal(spec.func.name,'tabReadAgentRouterDashboard');domReads++;
        const initialValid=failureStage==='final-verification'&&domReads===1;
        installDashboardDom(h,{id:Number(p.userId),balance:initialValid?'$227.04':'$0.00',used:initialValid?'$2,022.29':'$0.00'});
        return spec.func(...spec.args);
      };
      await h.run('handleAgentRouterReauthTab(pending.tabId,callback)');
      const saved=h.store[PLATFORMS][0];
      assert.equal(domReads,failureStage==='initial-read'?5:6);
      assert.equal(saved.account.available,failureStage === "final-verification" ? 227.04 * 500000 : 10);
      if (failureStage === "final-verification") assert.ok(saved.account.updatedAt, "partial balance is explicitly timestamped");
      assert.equal(saved.reauthAccountUpdated,false);
      assert.equal(saved.stats.checked_in_today,true,'a failed balance read must not revoke confirmed check-in');
      assert.match(saved.message,/已尝试 5 次/);assert.match(saved.message,/可用余额和已用余额都为 0/);
      assert.doesNotMatch(saved.message,/看板余额已更新/);
      assert.equal(h.removed.length,0);assert.equal(h.tabs.get(tab.id).active,true);
      assert.deepEqual(h.store[PENDING],{});
    });
  }
}

// Account GET recovery must survive document replacement without replaying writes.
async function accountReadFixture() {
  const h = harness('background.js');
  const p = visitPlatform({authMode: 'cookie', loginUsername: '', loginPassword: ''});
  h.ctx.input = p;
  const tab = await h.chrome.tabs.create({url: 'https://anyrouter.top/console', active: false});
  h.ctx.tabId = tab.id;
  allowVisitReads(h, {id: 12, quota: 180, used_quota: 7});
  const baseline = [h.chrome.tabs.onUpdated.listeners.length, h.chrome.tabs.onRemoved.listeners.length];
  const assertCleanup = () => {
    assert.deepEqual([h.chrome.tabs.onUpdated.listeners.length, h.chrome.tabs.onRemoved.listeners.length], baseline);
    assert.equal(h.created.length, 1, 'reuse the same user-owned tab');
    assert.equal(h.removed.length, 0, 'never close a user-owned tab');
  };
  return {h, p, tab, assertCleanup};
}

test('account refresh waits for the replacement document and recovers a removed main frame on the same tab', async () => {
  const {h, tab, assertCleanup} = await accountReadFixture();
  const success = h.ctx.script;
  const setTimeout = h.ctx.setTimeout;
  h.ctx.setTimeout = (fn, ms) => ms === 200 ? setImmediate(fn) : setTimeout(fn, ms);
  let attempts = 0;
  h.ctx.script = async spec => {
    if (spec.args[0] === '/api/user/self') {
      attempts++;
      assert.equal(h.tabs.get(tab.id).status, 'complete', 'no fetch while the replacement page is loading');
      assert.equal(spec.args[7], 'https://anyrouter.top');
      if (attempts === 1) {
        h.tabs.get(tab.id).status = 'loading';
        for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(tab.id, {status: 'loading'});
        setImmediate(() => {
          h.tabs.get(tab.id).status = 'complete';
          for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(tab.id, {status: 'complete'});
        });
        throw new Error('Frame with ID 0 was removed.');
      }
    }
    return success(spec);
  };
  const account = await h.run('fetchAccount(input, "2026-10")');
  assert.equal(account.available, 180);
  assert.equal(account.used, 7);
  assert.equal(attempts, 2);
  assert.ok(h.injections.every(spec => spec.target.tabId === tab.id));
  assertCleanup();
});

test('visit-only log reads recover a removed document using the owned task tab', async () => {
  const {h, tab, assertCleanup} = await accountReadFixture();
  const success = h.ctx.script;
  let attempts = 0;
  h.ctx.script = async spec => {
    if (++attempts === 1) throw new Error('The document was unloaded.');
    return success(spec);
  };
  const body = await h.run('readVisitApi(input, tabId, "/api/log/self", {p: 1})');
  assert.equal(body.success, true);
  assert.equal(attempts, 2);
  assert.ok(h.injections.every(spec => spec.target.tabId === tab.id && spec.world === 'MAIN'));
  assertCleanup();
});

test('account recovery discards a response if its document navigated even when injection resolved', async () => {
  const {h, tab, assertCleanup} = await accountReadFixture();
  let attempts = 0;
  h.ctx.script = async () => {
    attempts++;
    if (attempts === 1) {
      for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(tab.id, {status: 'loading'});
      for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(tab.id, {status: 'complete'});
    }
    return {ok: true, body: {success: true, data: {id: 12, quota: attempts === 1 ? 100 : 180, used_quota: 7}}};
  };
  const body = await h.run('callViaTabRaw(input, input.baseUrl, "/api/user/self", "GET")');
  assert.equal(body.data.quota, 180);
  assert.equal(attempts, 2);
  assertCleanup();
});

test('persistent frame removal stops after three total attempts and releases event listeners', async () => {
  const {h, assertCleanup} = await accountReadFixture();
  let attempts = 0;
  h.ctx.script = async () => { attempts++; throw new Error('Frame with ID 0 was removed.'); };
  await assert.rejects(h.run('callViaTabRaw(input, input.baseUrl, "/api/user/self", "GET")'), /Frame with ID 0 was removed/);
  assert.equal(attempts, 3);
  assertCleanup();
});

for (const scenario of ['closed', 'cross-origin', 'pending-cross-origin', 'login']) {
  test(`account recovery stops instead of reissuing requests after ${scenario}`, async () => {
    const {h, tab, assertCleanup} = await accountReadFixture();
    let attempts = 0;
    h.ctx.script = async () => {
      attempts++;
      if (scenario === 'closed') {
        h.tabs.delete(tab.id);
        for (const fn of [...h.chrome.tabs.onRemoved.listeners]) fn(tab.id);
      } else if (scenario === 'cross-origin') h.tabs.get(tab.id).url = 'https://other.example.test/console';
      else if (scenario === 'pending-cross-origin') h.tabs.get(tab.id).pendingUrl = 'https://other.example.test/console';
      else h.tabs.get(tab.id).url = 'https://anyrouter.top/login';
      throw new Error('Frame with ID 0 was removed.');
    };
    await assert.rejects(h.run('callViaTabRaw(input, input.baseUrl, "/api/user/self", "GET")'), /已关闭|其他站点|登录或授权页/);
    assert.equal(attempts, 1);
    assertCleanup();
  });
}

test('account reads reject a page that never finishes loading without treating the wait timeout as success', async () => {
  const {h, tab, assertCleanup} = await accountReadFixture();
  h.tabs.get(tab.id).status = 'loading';
  await assert.rejects(h.run('callViaTabRaw(input, input.baseUrl, "/api/user/self", "GET")'), /账户页面加载超时/);
  assert.equal(h.injections.length, 0);
  assertCleanup();
});

for (const failure of ['permission', 'http']) {
  test(`account recovery does not retry ${failure} failures`, async () => {
    const {h, assertCleanup} = await accountReadFixture();
    let attempts = 0, refreshes = 0;
    h.ctx.script = async spec => {
      if (spec.func.name === 'tabRefreshAuthToken') { refreshes++; return {httpOk:false,status:404}; }
      attempts++;
      if (failure === 'permission') throw new Error('Cannot access contents of the page.');
      return {ok: false, status: 401, body: {success: false, message: '请重新登录'}};
    };
    await assert.rejects(h.run('callViaTabRaw(input, input.baseUrl, "/api/user/self", "GET")'), /Cannot access|请重新登录/);
    assert.equal(attempts, 1);
    assert.equal(refreshes, failure === 'http' ? 1 : 0);
    assertCleanup();
  });
}

for (const [method, reqPath] of [['POST', '/api/user/self'], ['GET', '/api/user/checkin'], ['POST', '/api/user/checkin']]) {
  test(`removed-frame recovery never replays ${method} ${reqPath}`, async () => {
    const {h, assertCleanup} = await accountReadFixture();
    h.ctx.input.visitOnly = false;
    let attempts = 0;
    h.ctx.script = async () => { attempts++; throw new Error('Frame with ID 0 was removed.'); };
    h.ctx.reqPath = reqPath; h.ctx.method = method;
    await assert.rejects(h.run('callViaTabRaw(input, input.baseUrl, reqPath, method)'), /Frame with ID 0 was removed/);
    assert.equal(attempts, 1);
    assertCleanup();
  });
}

test('account recovery preserves cancellation, does not retry or start subsequent log requests', async () => {
  const {h, assertCleanup} = await accountReadFixture();
  h.ctx.control = {stopVersion: 0, token: 'read-stop', controller: new AbortController(),
    lastProgressAt: h.run('Date.now()'), waitingToStart: false, pageTabIds: new Set(), pageWorlds: new Map()};
  let attempts = 0;
  h.ctx.script = async spec => {
    attempts++;
    assert.equal(spec.args[6], 'read-stop');
    assert.equal(spec.args[7], 'https://anyrouter.top');
    h.ctx.control.controller.abort();
    throw new Error('Frame with ID 0 was removed.');
  };
  await assert.rejects(h.run('fetchAccount(input, "2026-10", null, null, control)'), error => error.code === 'CHECKIN_CANCELLED');
  assert.equal(attempts, 1);
  assert.equal(h.ctx.control.pageTabIds.size, 0);
  assertCleanup();
});

test('a replacement page logged in as another configured user cannot publish that user quota', async () => {
  const {h, assertCleanup} = await accountReadFixture();
  let attempts = 0;
  h.ctx.script = async () => {
    if (++attempts === 1) throw new Error('Frame with ID 0 was removed.');
    return {ok: true, body: {success: true, data: {id: 13, quota: 999, used_quota: 7}}};
  };
  await assert.rejects(h.run('fetchAccount(input, "2026-10")'), error => error.code === 'ACCOUNT_MISMATCH');
  assert.equal(attempts, 2);
  assertCleanup();
});

test('the injected account read guards the actual document origin before sending a request', async () => {
  const h = harness('background.js');
  h.ctx.location = {origin: 'https://other.example.test'};
  let requests = 0;
  h.ctx.fetch = async () => { requests++; throw new Error('must not request the other site'); };
  const result = await h.run('tabFetchCheckin("/api/user/self", "GET", null, "12", "New-Api-User", null, "", "https://anyrouter.top")');
  assert.equal(result.ok, false);
  assert.match(result.body.message, /其他站点/);
  assert.equal(requests, 0);
});

test('account refresh normalizes a configured login path to the site homepage when creating its read tab', async () => {
  const h = harness('background.js');
  h.ctx.input = visitPlatform({authMode: 'cookie', baseUrl: 'https://anyrouter.top/login?next=private'});
  allowVisitReads(h);
  const account = await h.run('fetchAccount(input, "2026-10")');
  assert.equal(account.available, 50);
  assert.ok(h.created.every(tab => tab.url === 'https://anyrouter.top/'));
  assert.equal(h.removed.length, h.created.length);
});

test('an independently restored OAuth outcome clears the quota error and stale UI snapshots cannot bring it back', async () => {
  const p = oauthPlatform({reauthPending: true, reauthStartedAt: 100, accountError: '此前额度刷新失败', account: {available: 10}});
  const h = harness('background.js', {[PLATFORMS]: [p]});
  h.ctx.pending = {platformId: p.id, authMode: p.authMode, origin: p.baseUrl, userId: p.userId, createdAt: 100};
  h.ctx.stale = structuredClone(p);
  await h.run('saveAgentRouterLoginOutcome(pending, {ok: true, checkedIn: false, account: {available: 180}}, "登录成功，额度已更新")');
  assert.equal(h.store[PLATFORMS][0].account.available, 180);
  assert.equal(h.store[PLATFORMS][0].accountError, '');
  assert.equal(h.store[PLATFORMS][0].reauthAccountUpdated, true);
  await h.run('savePlatforms([stale])');
  assert.equal(h.store[PLATFORMS][0].accountError, '');
  assert.equal(h.store[PLATFORMS][0].account.available, 180);
});

test('visit-only publishes fresh quota and clears old quota errors before closing its task tab', async () => {
  const p = visitPlatform({authMode: 'cookie', accountError: '此前额度刷新失败'});
  const h = harness('background.js', {[PLATFORMS]: [p]});
  h.ctx.input = p;
  allowVisitReads(h, {id: 12, quota: 180, used_quota: 7});
  const remove = h.chrome.tabs.remove;
  h.chrome.tabs.remove = async id => {
    assert.equal(h.store[PLATFORMS][0].accountError, '');
    assert.equal(h.store[PLATFORMS][0].account.available, 180);
    return remove(id);
  };
  const result = await h.run('runVisitOnly(input, {reauth: false})');
  assert.equal(result.visited, true);
  assert.equal(h.removed.length, 1);
});

function accountSerializationControl(h) {
  return {stopVersion: 0, token: 'serialize-stop', controller: new AbortController(),
    lastProgressAt: h.run('Date.now()'), waitingToStart: false, pageTabIds: new Set(), pageWorlds: new Map()};
}

test('serialization: password login session probe supplies a serializable empty query before the stop token', async () => {
  const {h, p, tab} = await accountReadFixture();
  h.ctx.input = {...p, authMode: 'password', loginUsername: 'alice@example.com', loginPassword: 'secret'};
  h.ctx.taskTab = tab;
  h.ctx.control = accountSerializationControl(h);
  allowVisitReads(h, {id: 12, email: 'alice@example.com', quota: 180, used_quota: 7});
  const user = await h.run('loginPasswordOnTab(input, taskTab, false, control)');
  assert.equal(user.id, 12);
  const args = h.injections.find(spec => spec.func.name === 'tabFetchCheckin').args;
  assert.equal(args.length, 7);
  assert.equal(args[5], null);
  assert.equal(args[6], 'serialize-stop');
  assert.ok(Array.from({length: args.length}, (_, i) => Object.hasOwn(args, i)).every(Boolean));
  assert.equal(h.ctx.control.pageTabIds.size, 0);
});

test('serialization: an explicitly undefined optional query is normalized even without a task control', async () => {
  const {h} = await accountReadFixture();
  const result = await h.run('executeCheckinScript({target: {tabId}, func: tabFetchCheckin, args: ["/api/user/self", "GET", null, "12", "New-Api-User", undefined]})');
  assert.equal(result[0].result.ok, true);
  assert.equal(h.injections.at(-1).args[5], null);
});

test('serialization: account recovery can append origin to a short argument array without undefined or holes', async () => {
  const {h} = await accountReadFixture();
  const result = await h.run('executeAccountReadOnTab(input, {target: {tabId}, func: tabFetchCheckin, args: ["/api/user/self", "GET", null, "12", "New-Api-User"]})');
  assert.equal(result[0].result.ok, true);
  const args = h.injections.at(-1).args;
  assert.equal(args[5], null);
  assert.equal(args[6], null);
  assert.equal(args[7], 'https://anyrouter.top');
  assert.ok(Array.from({length: args.length}, (_, i) => Object.hasOwn(args, i)).every(Boolean));
});

test('serialization: the browser mock rejects nested unsupported arguments instead of silently accepting them', async () => {
  const {h} = await accountReadFixture();
  await assert.rejects(h.run('executeCheckinScript({target: {tabId}, func: tabFetchCheckin, args: ["/api/user/self", "GET", null, "12", "New-Api-User", {invalid: () => 1}]})'), /index 5: Value is unserializable/);
});

for (const response of [
  {ok:false,status:403,body:{success:false,message:'permission denied'}},
  {ok:true,status:200,htmlResponse:true,body:{success:false,message:'challenge'}},
  {ok:true,status:200,body:{success:true,data:{quota:50}}},
]) {
  test(`visit probe preserves ${response.status}/${!!response.htmlResponse} failure without cleanup logout or reload`, async () => {
    const p = visitPlatform(); const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
    h.ctx.script = async (spec) => { if (spec.func.name === 'tabLogout') return {ok:true}; assert.equal(spec.func.name,'tabFetchCheckin'); return response; };
    const result = await h.run('runCheckin(input)');
    assert.equal(result.ok,false); assert.match(result.message,/账户接口/); assert.doesNotMatch(result.message,/60 秒/);
    assert.equal(h.reloaded.length,0); assert.equal(h.removed.length,1);
    assert.equal(h.updates.some(x => x.url && /login/.test(x.url)),false);
    assert.equal(h.injections.length,1);
  });
}
test('password session network/permission failures do not log out the existing browser account', async () => {
  const p=visitPlatform();const h=harness('background.js');h.ctx.input=p;
  h.ctx.taskTab=await h.chrome.tabs.create({url:p.baseUrl+'/'});
  h.ctx.script=async spec=>{assert.equal(spec.func.name,'tabFetchCheckin');return {ok:false,status:503,body:{message:'temporarily unavailable'}};};
  await assert.rejects(h.run('loginPasswordOnTab(input,taskTab)'),/503.*temporarily unavailable/);
  assert.equal(h.updates.length,0);
});
test('post-refresh expired login fails immediately instead of polling until idle timeout',async()=>{
  const p=visitPlatform({authMode:'cookie'});const h=harness('background.js');h.ctx.input=p;let reads=0;
  h.ctx.script=async spec=>spec.func.name === 'tabLogout' ? {ok:true} : spec.func.name === 'tabRefreshAuthToken' ? {httpOk:false,status:401} : ++reads===1?{ok:true,body:{success:true,data:{id:12,quota:50}}}:{ok:false,status:401};
  const result=await h.run('runCheckin(input)');
  assert.equal(result.ok,false);assert.match(result.message,/401.*失效/);assert.equal(reads,2);assert.equal(h.reloaded.length,1);assert.equal(h.removed.length,1);
});
test('confirmed balance is saved before a stalled log, whose 20-second budget does not fail the visit',async()=>{
  const p=visitPlatform({authMode:'cookie',account:{available:10}});const h=harness('background.js',{[PLATFORMS]:[p]});h.ctx.input=p;
  let started=false;let release;const stalled=new Promise(r=>{release=r;});
  h.ctx.script=async spec=>{
    if(spec.args[0]==='/api/log/self'){started=true;return stalled;}
    return {ok:true,body:{success:true,data:{id:12,quota:130,used_quota:7}}};
  };
  const running=h.run('runCheckin(input)');
  for(let i=0;i<15&&!started;i++)await new Promise(setImmediate);
  assert.equal(started,true);assert.equal(h.store[PLATFORMS][0].account.available,130);
  assert.ok(h.store[PLATFORMS][0].account.updatedAt);assert.equal(h.removed.length,0);
  await h.advanceClock(20001);
  const result=await running;
  assert.equal(result.visited,true);assert.equal(result.account.available,130);assert.equal(result.account.monthlyTokens,null);
  assert.match(result.message,/本月Token接口不可用/);assert.equal(h.reloaded.length,1);assert.equal(h.removed.length,1);
  release({ok:true,body:{success:true,data:[{prompt_tokens:999}]}});await new Promise(setImmediate);
  assert.equal(h.store[PLATFORMS][0].account.monthlyTokens,null,'late response cannot publish tokens');
});
test('manual account refresh also bounds logs and preserves the already read quota',async()=>{
  const h=harness('background.js');h.ctx.input=visitPlatform({authMode:'cookie'});
  h.run('slowLog=()=>new Promise(()=>{})');
  const running=h.run('fetchAccount(input,"2026-10",{id:12,quota:80},slowLog)');
  await new Promise(setImmediate);await h.advanceClock(20001);
  const account=await running;assert.equal(account.available,80);assert.equal(account.monthlyTokens,null);assert.match(account._warn,/Token接口不可用/);
});
test('user cancellation during log reading is not downgraded into visit success',async()=>{
  const h=harness('background.js');h.ctx.input=visitPlatform({authMode:'cookie'});h.ctx.control=accountSerializationControl(h);
  h.run('slowLog=()=>new Promise(()=>{})');
  const running=h.run('fetchAccount(input,"2026-10",{id:12,quota:80},slowLog,control)');
  const rejected=assert.rejects(running,e=>e.code==='CHECKIN_CANCELLED');
  await new Promise(setImmediate);h.ctx.control.controller.abort();await rejected;
});
test('page loading waits stop immediately and do not treat timeout as loaded',async()=>{
  const h=harness('background.js');const tab=await h.chrome.tabs.create({url:'https://example.test/',status:'loading'});h.ctx.tabId=tab.id;h.ctx.control=accountSerializationControl(h);
  const running=h.run('waitVisitComplete(tabId,null,control)');const rejected=assert.rejects(running,e=>e.code==='CHECKIN_CANCELLED');
  h.ctx.control.controller.abort();await rejected;
  const loading=h.run('waitTabComplete(tabId)');const timedOut=assert.rejects(loading,/加载超时/);await h.advanceClock(12001);await timedOut;
});
test('token visit-only jobs take the same origin session lock as cookie accounts',async()=>{
  const h=harness('background.js');h.ctx.input=visitPlatform({authMode:'token',accessToken:'dummy'});
  h.run('order=[];gate=new Promise(resolve=>{release=resolve});first=withPlatformSession(input,async()=>{order.push("token");await gate;});second=withPlatformSession({...input,authMode:"cookie"},async()=>order.push("cookie"))');
  await new Promise(setImmediate);assert.deepEqual(plain(h.run('order')),['token']);
  h.run('release()');await h.run('Promise.all([first,second])');assert.deepEqual(plain(h.run('order')),['token','cookie']);
});

test('initial visit document replacement retries the probe instead of entering login',async()=>{
  const p=visitPlatform({authMode:'cookie'});const h=harness('background.js');h.ctx.input=p;let reads=0;
  h.ctx.script=async spec=>{
    if(spec.args[0]==='/api/log/self')return {ok:true,body:{success:true,data:[]}};
    if(++reads===1)throw new Error('Frame with ID 0 was removed.');
    return {ok:true,body:{success:true,data:{id:12,quota:50}}};
  };
  const result=await h.run('runCheckin(input)');assert.equal(result.visited,true);
  assert.equal(h.updates.some(x=>x.url&&/login/.test(x.url)),false);assert.equal(h.reloaded.length,1);assert.equal(h.created.length,1);
});
test('stopping before the scheduled refresh prevents navigation from starting',async()=>{
  const h=harness('background.js');const tab=await h.chrome.tabs.create({url:'https://example.test/'});h.ctx.tabId=tab.id;h.ctx.control=accountSerializationControl(h);
  const pending=h.run('waitVisitComplete(tabId,()=>chrome.tabs.reload(tabId),control)');
  const rejected=assert.rejects(pending,e=>e.code==='CHECKIN_CANCELLED');h.ctx.control.controller.abort();await rejected;await new Promise(setImmediate);
  assert.equal(h.reloaded.length,0);
});

test('visit cleanup ignores cancellation, closes owned page and preserves failure', async () => {
  const h = harness('background.js'); h.ctx.input = visitPlatform({logoutAfterVisit:true});
  h.ctx.control = accountSerializationControl(h);
  let logouts = 0;
  h.ctx.script = async spec => {
    if (spec.func.name === 'tabLogout') {
      logouts++; assert.equal(spec.args[0], ''); assert.equal(spec.args[1], 'https://anyrouter.top');
      assert.equal(h.run('visitOnlyOrigins.has("https://anyrouter.top")'), true);
      return {ok:true};
    }
    h.ctx.control.controller.abort();
    return {ok:false,cancelled:true};
  };
  await assert.rejects(h.run('runVisitOnly(input, {}, control)'), {code:'CHECKIN_CANCELLED'});
  assert.equal(logouts, 1); assert.deepEqual(h.removed, [h.created[0].id]);
  assert.equal(h.run('visitOnlyOrigins.size'), 0);
});

test('cleanup logout failure still closes and successful balance is saved before logout', async () => {
  const p = visitPlatform({logoutAfterVisit:true}); const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input=p;
  allowVisitReads(h); const read = h.ctx.script;
  h.ctx.script = async spec => {
    if (spec.func.name !== 'tabLogout') return read(spec);
    assert.equal(h.store[PLATFORMS][0].account.available, 50);
    throw new Error('logout offline');
  };
  const result = await h.run('runCheckin(input)');
  assert.equal(result.visited, true); assert.match(result.message,/退出账号失败.*logout offline/);
  assert.deepEqual(h.removed, [h.created[0].id]);
});

test('cleanup never logs out an OAuth provider and bounds a stalled logout', async () => {
  const h = harness('background.js'); h.ctx.input=visitPlatform({logoutAfterVisit:true});
  const tab = await h.chrome.tabs.create({url:'https://github.com/login'}); h.ctx.tabId=tab.id;
  h.ctx.script = async spec => {
    assert.equal(new URL(h.tabs.get(spec.target.tabId).url).origin, 'https://anyrouter.top');
    return new Promise(()=>{});
  };
  const running = h.run('cleanupVisitSession(input,tabId)');
  await new Promise(setImmediate); await h.advanceClock(15001);
  assert.match(await running,/退出请求超时/);
  assert.equal(h.created.length,2); assert.equal(h.removed.length,2);
});

test('keepalive request budget includes response body and task cancellation', async () => {
  for (const cancel of [false, true]) {
    const h = harness('background.js'); h.ctx.control = accountSerializationControl(h);
    let aborted = false;
    h.ctx.fetch = async (_url, {signal}) => ({ok:true,status:200,text:()=>new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));});
    })});
    const running = h.run('keepAliveFetch("https://example.test/v1/chat/completions",{},control)');
    const rejected = assert.rejects(running, cancel ? {code:'CHECKIN_CANCELLED'} : /15 秒/);
    await new Promise(setImmediate);
    if (cancel) h.ctx.control.controller.abort(); else await h.advanceClock(15001);
    await rejected; assert.equal(aborted,true);
  }
});

test('visit idle errors identify the actual phase and never claim a checkin endpoint failure', () => {
  const h = harness('background.js');
  const error = h.run('checkinIdleError({visitOnly:true,stageLabel:"读取余额"})');
  assert.match(error.message,/仅访问.*未调用签到接口.*读取余额/);
  assert.doesNotMatch(error.message,/保留页面/);
});

function modernSessionFixture(options = {}) {
  const p=visitPlatform({authMode:'cookie',baseUrl:'https://modern.example.test',userId:'12',logoutAfterVisit:options.logoutAfterVisit===true});
  const h=harness('background.js',{[PLATFORMS]:[p]});h.ctx.input=p;
  const requests=[];
  h.ctx.localStorage={getItem(){return null;},removeItem(){}};
  h.ctx.script=async spec=>{
    const page=h.tabs.get(spec.target.tabId);
    h.ctx.location={origin:new URL(page.url).origin,href:page.url};
    return spec.func(...(spec.args||[]));
  };
  h.ctx.fetch=async (url,init)=>{
    const pathname=new URL(url,h.ctx.location.origin).pathname;
    requests.push({pathname,...init});
    const response=(status,body)=>({ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(body)});
    if(pathname==='/api/user/auth/refresh') {
      if(options.refresh) return options.refresh(response,init);
      return response(200,{success:true,data:{access_token:'session-only-secret',access_expires_at:Math.floor(h.run('Date.now()')/1000)+900,session:{sid:'live-sid'}}});
    }
    if(pathname==='/api/user/auth/logout') {
      assert.equal(init.method,'POST');assert.equal(init.headers['X-Auth-Session'],'live-sid');
      assert.equal(init.headers.Authorization,'Bearer session-only-secret');
      if (!options.userId) assert.equal(h.store[PLATFORMS][0].account.available,900);
      return response(200,{success:true});
    }
    if(pathname==='/api/user/logout') return response(404,{success:false});
    if(init.headers.Authorization!=='Bearer session-only-secret') return response(401,{success:false,message:'missing dashboard credential'});
    if(pathname==='/api/user/self') return response(200,{success:true,data:{id:options.userId||12,quota:900,used_quota:50}});
    if(pathname==='/api/log/self') return response(200,{success:true,data:[]});
    throw new Error('Unexpected request '+pathname);
  };
  return {h,p,requests};
}

test('modern Cookie visit authenticates with refresh/Bearer, saves quota then uses SID-protected logout',async()=>{
  const {h,requests}=modernSessionFixture({logoutAfterVisit:true});
  const result=await h.run('runCheckin(input)');
  assert.equal(result.visited,true);assert.equal(result.account.available,900);
  assert.doesNotMatch(result.message,/需要登录|未确认|失败/);
  assert.equal(requests.filter(r=>r.pathname==='/api/user/auth/refresh').length,1,'reuse one token across self, logs and final verification');
  assert.equal(requests.filter(r=>r.pathname==='/api/user/auth/logout').length,1);
  assert.ok(requests.every(r=>r.pathname!=='/api/user/checkin'));
  assert.equal(h.reloaded.length,1);assert.equal(h.created.length,1);assert.equal(h.removed.length,1);
  assert.equal(h.run('sessionTokenCache.size'),0);
  assert.doesNotMatch(JSON.stringify(h.store)+JSON.stringify(h.messages),/session-only-secret|live-sid/);
});

test('modern session online identity cannot overwrite another configured account',async()=>{
  const {h}=modernSessionFixture({userId:99});
  const result=await h.run('runCheckin(input)');
  assert.equal(result.ok,false);assert.match(result.message,/不一致|不匹配/);
  assert.equal(h.store[PLATFORMS][0].account,undefined);
});

test('refresh network errors and 401 HTML challenges are not treated as a pending login',async()=>{
  const {h}=modernSessionFixture({refresh:()=>{throw new Error('offline');}});
  const tab=await h.chrome.tabs.create({url:'https://modern.example.test/'});h.ctx.tabId=tab.id;
  await assert.rejects(h.run('readVisitSession(input,tabId,true,false)'),/offline/);
  assert.throws(()=>h.run('sessionProbeUser({ok:false,status:401,htmlResponse:true},true)'),{code:'SESSION_CHALLENGE'});
});

test('session refresh is origin-bound and aborts while waiting for its response body',async()=>{
  const {h,requests}=modernSessionFixture({refresh:(_response,init)=>({ok:true,status:200,headers:{get:()=> 'application/json'},text:()=>new Promise((resolve,reject)=>{
    init.signal.addEventListener('abort',()=>reject(new Error('aborted')));
  })})});
  h.ctx.location={origin:'https://other.example.test'};
  const foreign=await h.run('tabRefreshAuthToken("https://modern.example.test")');
  assert.equal(foreign.status,403);assert.equal(requests.length,0);
  const tab=await h.chrome.tabs.create({url:'https://modern.example.test/'});h.ctx.tabId=tab.id;h.ctx.control=accountSerializationControl(h);
  const pending=h.run('readVisitSession(input,tabId,true,false,control)');
  const rejected=assert.rejects(pending,{code:'CHECKIN_CANCELLED'});
  await new Promise(setImmediate);h.ctx.control.controller.abort();await rejected;
  assert.equal(h.run('sessionTokenCache.size'),0);assert.equal(h.ctx.control.pageTabIds.size,0);
});

test('newer visit and balance state survives stale whole-list saves, while explicit import resets it',async()=>{
  const p=visitPlatform({authMode:'cookie',account:null,error:'旧访问错误'});
  const h=harness('background.js',{[PLATFORMS]:[p]});h.ctx.input=p;h.ctx.stale=structuredClone(p);
  await h.run('persistCheckinResult(input,{ok:true,visited:true,message:"访问完成",lastVisitDate:todayStr(),account:{userId:"12",available:900}},null,null)');
  const revision=h.store[PLATFORMS][0].stateRevision;
  h.ctx.stale.name='renamed';await h.run('savePlatforms([stale])');
  assert.equal(h.store[PLATFORMS][0].name,'renamed');assert.equal(h.store[PLATFORMS][0].account.available,900);
  assert.equal(h.store[PLATFORMS][0].error,'');assert.equal(h.store[PLATFORMS][0].lastVisitDate,h.run('todayStr()'));
  assert.equal(h.store[PLATFORMS][0].stateRevision,revision);
  await h.run('savePlatforms([stale],true)');assert.equal(h.store[PLATFORMS][0].account,null);
  assert.ok(h.store[PLATFORMS][0].stateRevision>revision);
});

test('modern expired session does not block fresh password login at legacy logout',async()=>{
  const {h}=modernSessionFixture({refresh:(response)=>response(401,{success:false,message:'session expired'})});
  h.ctx.input={...h.ctx.input,authMode:'password',loginUsername:'alice@example.com',loginPassword:'secret'};
  const tab=await h.chrome.tabs.create({url:h.ctx.input.baseUrl+'/'});h.ctx.taskTab=tab;
  const realScript=h.ctx.script;let submitted=false;
  h.ctx.script=async spec=>{
    if(spec.func.name==='tabSubmitPasswordLogin') {submitted=true;return {ok:false,message:'fixture: reached login form'};}
    return realScript(spec);
  };
  await assert.rejects(h.run('loginPasswordOnTab(input,taskTab)'),/fixture: reached login form/);
  assert.equal(submitted,true);assert.equal(h.updates.at(-1).url,h.ctx.input.baseUrl+'/login');
});

test('logout fallback cannot treat a refresh permission error as logged out',async()=>{
  const {h}=modernSessionFixture({refresh:(response)=>response(403,{success:false,message:'permission denied'})});
  const tab=await h.chrome.tabs.create({url:h.ctx.input.baseUrl+'/'});h.ctx.tabId=tab.id;
  const result=await h.run('executeCheckinScript({target:{tabId},func:tabLogout,args:["",input.baseUrl]})');
  assert.equal(result[0].result.ok,false);
});

for (const authMode of ['token','cookie','password','agentrouter_token','agentrouter_linuxdo']) {
  test(`${authMode}: old visit configs default to keeping the login while closing only the owned page`,async()=>{
    const p=visitPlatform({authMode,accessToken:'not-a-web-session'});
    const h=harness('background.js',{[PLATFORMS]:[p]});h.ctx.input=p;
    const original=await h.chrome.tabs.create({url:p.baseUrl+'/console'});
    const counts=allowVisitReads(h);
    const result=await h.run('runCheckin(input,{reauth:false})');
    assert.equal(result.visited,true);assert.equal(counts.logouts,0);
    assert.match(result.message,/未主动退出账号/);assert.doesNotMatch(result.message,/已退出账号|退出账号未确认/);
    assert.deepEqual(h.removed,[h.created[1].id]);assert.equal(h.tabs.has(original.id),true);
    assert.equal(h.run('visitOnlyOrigins.size'),0);assert.equal(h.store[PLATFORMS][0].account.available,50);
  });
}

test('disabled logout never creates a cleanup tab, even when the task page is gone or on OAuth',async()=>{
  for(const gone of [false,true]) {
    const h=harness('background.js');h.ctx.input=visitPlatform();
    const tab=await h.chrome.tabs.create({url:'https://github.com/login'});h.ctx.tabId=tab.id;
    if(gone) h.tabs.delete(tab.id);
    h.run('sessionTokenCache.set("https://anyrouter.top#tab:"+tabId,{token:"ephemeral",expiresAt:Date.now()+100000})');
    h.ctx.script=()=>assert.fail('no server/logout injection is allowed');
    assert.equal(await h.run('cleanupVisitSession(input,tabId)'),'');
    assert.equal(h.created.length,1);assert.equal(h.run('sessionTokenCache.size'),0);
  }
});

test('default logout policy preserves cancellation and still releases the page and lock',async()=>{
  const h=harness('background.js');h.ctx.input=visitPlatform();h.ctx.control=accountSerializationControl(h);
  h.ctx.script=async spec=>{
    assert.notEqual(spec.func.name,'tabLogout');
    h.ctx.control.controller.abort();return {ok:false,cancelled:true};
  };
  await assert.rejects(h.run('runVisitOnly(input,{},control)'),{code:'CHECKIN_CANCELLED'});
  assert.deepEqual(h.removed,[h.created[0].id]);assert.equal(h.run('visitOnlyOrigins.size'),0);
});

test('modern Bearer visit defaults to no server logout but still discards extension token cache',async()=>{
  const {h,requests}=modernSessionFixture();
  const result=await h.run('runCheckin(input)');
  assert.equal(result.visited,true);assert.match(result.message,/未主动退出账号/);
  assert.equal(requests.filter(r=>r.pathname.includes('logout')).length,0);
  assert.equal(h.removed.length,1);assert.equal(h.run('sessionTokenCache.size'),0);
  assert.doesNotMatch(JSON.stringify(h.store),/session-only-secret|live-sid/);
});
