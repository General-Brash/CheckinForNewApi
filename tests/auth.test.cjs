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
function harness(file, initial = {}) {
  const store = structuredClone(initial);
  const tabs = new Map();
  const created = [], removed = [], updates = [], injections = [], messages = [];
  let tabId = 1;
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
      async update(id, opts) { if (!tabs.has(id)) throw new Error('no tab'); Object.assign(tabs.get(id), opts); updates.push({ id, ...opts }); return {...tabs.get(id)}; },
      async remove(id) { removed.push(id); tabs.delete(id); },
    },
    scripting: { async executeScript(spec) { injections.push(spec); return [{ result: await ctx.script(spec) }]; } },
    runtime: { id: 'extension-id', onMessage: event(), onStartup: event(), onInstalled: event(), getURL(p) { return 'chrome-extension://extension-id/' + p; }, getManifest() {return JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));}, sendMessage(msg, cb) { messages.push(msg); if (msg.type === 'getCapabilities') cb({ok:true,authBuild:ctx.NACheckinAuth.build,authModes:[...ctx.NACheckinAuth.modes],version:'1.7.5'}); else if (msg.type === 'savePlatforms') chrome.storage.local.set({[PLATFORMS]:msg.platforms}, () => cb({ok:true})); else cb({ok: true}); } },
    notifications: { onButtonClicked: event(), create() {}, async clear() {} },
    alarms: { onAlarm: event(), async clear() {}, create() {} },
    action: { onClicked: event() },
    sidePanel: { async setPanelBehavior() {} },
  };
  const ctx = vm.createContext({
    importScripts(file) {vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx,{filename:file});},
    chrome, console, URL, URLSearchParams, Date, Blob, crypto: require('node:crypto').webcrypto, Promise,
    // Advance polling without wall-clock waits; long tab timeout not needed for complete mocks.
    setTimeout(fn, ms) { if (ms < 10000) queueMicrotask(fn); return 0; }, clearTimeout() {},
    script: async () => null,
    fetch: async () => { throw new Error('Unexpected network request'); },
  });
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  if (file === 'popup.js') { vm.runInContext(fs.readFileSync(path.join(root,'auth-config.js'),'utf8'),ctx,{filename:'auth-config.js'}); source = source.replace(/\ninit\(\);\s*$/, ''); }
  vm.runInContext(source, ctx, { filename: file });
  return { ctx, chrome, store, tabs, created, removed, updates, injections, messages, run: (code) => vm.runInContext(code, ctx) };
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
  await h.run('updateAgentRouterPending(pending.tabId,pending)');
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
  const summary=await bg.run('runAutoCheckin(true)'); assert.equal(summary.ok,0); assert.equal(summary.fail,0); assert.equal(summary.pending,1); assert.notEqual(bg.store[PLATFORMS][0].stats?.checked_in_today,true);
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
    assert.equal((await h.run('getAgentRouterPending()'))[tab.id].approveClickStarted, false);
    assert.equal(h.store[PLATFORMS][0].reauthPending, true);
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
    await h.run('updateAgentRouterPending(pending.tabId,pending)'); h.ctx.script=async({func})=>func.name==='tabFetchAgentRouterAccount'?{ok:true,body:{success:true,data:{id:login.userMismatch?99:12}}}:login;
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
  await h.run('Promise.all([updateAgentRouterPending(1,{tabId:1,origin:"https://a.example"}), updateAgentRouterPending(2,{tabId:2,origin:"https://b.example"})])');
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
    await h.run('updateAgentRouterPending(pending.tabId,pending)');h.ctx.script=async({func})=>func.name==='tabFetchAgentRouterAccount'?{ok:false,status:401}:{ok:true,userId:'12',checkedIn:true};
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
  const tab=await h.chrome.tabs.create({url:'https://agentrouter.org/console'});h.ctx.pending={tabId:tab.id};await h.run('updateAgentRouterPending(pending.tabId,pending)');
  for(const listener of h.chrome.alarms.onAlarm.listeners)listener({name:'nacheckin.oauth'});await new Promise(setImmediate);assert.equal(seen.length,1);assert.equal(seen[0].id,tab.id);
  const expired=harness('background.js',{[PLATFORMS]:[oauthPlatform({reauthPending:true,reauthStartedAt:100})]});await new Promise(setImmediate);expired.ctx.pending={tabId:9,platformId:'ld',origin:'https://agentrouter.org',authMode:'agentrouter_linuxdo',userId:'12',provider:'linuxdo',createdAt:100};await expired.run('updateAgentRouterPending(9,pending)');await expired.run('handleAgentRouterReauthTab(9,"https://connect.linux.do/oauth2/authorize")');assert.equal(expired.store[PLATFORMS][0].reauthPending,false);assert.match(expired.store[PLATFORMS][0].message,/超时/);assert.equal(Object.keys(expired.store[PENDING]).length,0);
});
test('duplicate imported IDs are replaced before state synchronization',async()=>{
  const h=uiHarness();h.ctx.file={async text(){return JSON.stringify([passwordPlatform(),passwordPlatform({loginUsername:'bob@example.com'})]);}};await h.run('importConfig(file)');
  const list=h.store[PLATFORMS];assert.equal(new Set(list.map((p)=>p.id)).size,2);assert.notEqual(h.run('platforms[0]===platforms[1]'),true);assert.equal(list[0].loginUsername,'alice@example.com');assert.equal(list[1].loginUsername,'bob@example.com');
});
test('original token and cookie checkin paths remain intact',async()=>{
  const h=harness('background.js');let request;h.ctx.input={baseUrl:'https://token.example',authMode:'token',accessToken:'access',userId:'12'};h.ctx.fetch=async(url,opts)=>{request={url,opts};return{ok:true,async json(){return{success:true,data:{stats:{checked_in_today:true}}};}};};
  const token=await h.run('runCheckin(input,{reauth:true})');assert.equal(token.ok,true);assert.equal(request.opts.headers.Authorization,'Bearer access');assert.equal(request.opts.credentials,'omit');assert.equal(new URL(request.url).pathname,'/api/user/checkin');
  h.ctx.input={baseUrl:'https://cookie.example',authMode:'cookie'};h.ctx.script=async(spec)=>{assert.equal(spec.func.name,'tabFetchCheckin');assert.equal(spec.args[0],'/api/user/checkin');return{ok:true,body:{success:true,data:{stats:{checked_in_today:true}}}};};const cookie=await h.run('runCheckin(input,{reauth:true})');assert.equal(cookie.ok,true);
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
    if (func.name === 'tabFetchAgentRouterAccount') return { ok: true, body: { success: true, data: { id: 12, username: 'alice', quota: 30, used_quota: 2 } } };
    if (func.name === 'tabFetchCheckin') return { ok: true, body: { success: true, data: [] } };
    if (func.name === 'tabReadAgentRouterStoredUser') return { id: 12, username: 'alice', checked_in: false };
    if (func.name === 'tabLogout') return { ok: true };
    if (func.name === 'tabBuildAgentRouterOauthUrl') return { ok: true, url: args[0] === 'linuxdo' ? 'https://connect.linux.do/oauth2/authorize?state=s&response_type=code' : 'https://github.com/login/oauth/authorize?state=s' };
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
      await ui.run('checkin(platforms[0].id);');
      const pending = Object.values(bg.store[PENDING])[0];
      assert.equal(pending.provider, mode === 'agentrouter_linuxdo' ? 'linuxdo' : 'github');
      assert.equal(bg.store[PLATFORMS][0].reauthPending, true);
      assert.notEqual(bg.store[PLATFORMS][0].stats.checked_in_today, true);
      await ui.run('checkin(platforms[0].id, {batch:true});');
      assert.ok(ui.messages.some((msg) => msg.type === 'checkin' && msg.batch === true));
      assert.equal(Object.values(bg.store[PENDING])[0].provider, pending.provider);
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
test('save cannot reuse detection success from a different auth mode', async () => {
  const h=uiHarness();await h.run('init();');h.run('openModal();');
  h.nodes.get('name').value='Test account';h.nodes.get('baseUrl').value='https://agentrouter.org/';h.nodes.get('userId').value='12';h.nodes.get('accessToken').value='old-token';
  const original=h.chrome.runtime.sendMessage;let reply;
  h.chrome.runtime.sendMessage=(msg,cb)=>msg.type==='test'?(reply=cb):original(msg,cb);
  const saving=h.nodes.get('platformForm').onsubmit({preventDefault(){},submitter:{disabled:false}});await new Promise(setImmediate);
  h.nodes.get('authMode').value='agentrouter_linuxdo';h.nodes.get('authMode').onchange();reply({ok:true,data:null});await saving;
  assert.equal(h.run('platforms.length'),0);assert.ok(!h.messages.some((msg)=>msg.type==='savePlatforms'));assert.ok(h.toasts.some((msg)=>msg.includes('配置已变更')));
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
  assert.equal(capabilities.authBuild,'1.7.5-auth-v6');assert.equal(capabilities.version,'1.7.5');assert.ok(capabilities.authModes.includes('agentrouter_linuxdo'));assert.ok(capabilities.authModes.includes('agentrouter_token'));
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
  counts.identity = 0; counts.logs = 0;
  h.ctx.script = async (spec) => {
    counts.script++;
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
    assert.equal(counts.script, counts.identity + counts.logs, 'only identity/account/log reads are allowed');
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
    assert.equal(result.ok, mode === 'loaded', mode);
    if (mode !== 'loaded') assert.notEqual(result.visited, true, mode);
    assert.equal(h.chrome.tabs.onUpdated.listeners.length, updatedCount, mode);
    assert.equal(h.chrome.tabs.onRemoved.listeners.length, removedCount, mode);
    assert.equal(h.tabs.has(tab.id), mode !== 'loaded' && mode !== 'closed', mode);
    if (mode !== 'loaded') assert.equal(h.removed.length, 0, mode);
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
test('visit-only password failure leaves login page active without a visit marker', async () => {
  const h = harness('background.js'); h.ctx.input = visitPlatform();
  h.ctx.script = async ({func}) => func.name === 'tabLogout' ? {ok:true} :
    func.name === 'tabSubmitPasswordLogin' ? {ok:false,message:'验证码未完成'} : {ok:false,status:401};
  const result = await h.run('runCheckin(input)');
  assert.equal(result.ok, false); assert.match(result.message, /验证码/);
  assert.equal(result.visited, undefined); assert.equal(result.lastVisitDate, undefined);
  assert.equal(h.created.length, 1); assert.equal(h.removed.length, 0);
  assert.equal(h.tabs.get(h.created[0].id).active, true);
});
for (const authMode of ['cookie','token']) {
  test(`${authMode}: visit-only waits for manual web login instead of accepting a token or loaded page`, async () => {
    const h = harness('background.js'); h.ctx.input = visitPlatform({authMode, accessToken:'not-a-web-session'});
    let release, attempts = 0;
    const manualLogin = new Promise((resolve) => {release = resolve;});
    h.ctx.script = async (spec) => {
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
    assert.equal(h.removed.length, 0, kind); assert.equal(h.tabs.get(h.created[0].id).active, true, kind);
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
        }
        return result;
      };
      h.ctx.script = async (spec) => {
        assert.equal(h.removed.length, 0);
        if (spec.func.name === 'tabFetchCheckin') {
          if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      assert.equal(spec.args[0], '/api/user/self'); assert.equal(spec.args[1], 'GET');
          return authenticated ? {ok:true,body:{success:true,data:{id:12,checked_in:true,quota:50}}} : {ok:false,status:401};
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
      assert.equal(h.created.length, 1); assert.equal(h.removed.length, validState ? 1 : 0);
      assert.deepEqual(h.store[PENDING], {});
      assert.equal(h.store[PLATFORMS][0].stats.checked_in_today, false);
      assert.equal(h.store[PLATFORMS][0].lastCheckinAt, undefined);
      if (validState) assert.equal(h.updates.at(-1).url, p.baseUrl + '/');
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
  assert.equal(result.visited, undefined); assert.equal(h.removed.length, 0);
  assert.equal(h.tabs.get(h.created[0].id).active, true);
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
test('unchanged and zero quota close normally; missing or invalid latest quota preserves the page', async () => {
  for (const quota of [50,0,null,'invalid',true,' ']) {
    const p = visitPlatform({authMode:'cookie',account:{available:quota === 0 ? 0 : 50}});
    const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p;
    allowVisitReads(h, {id:12,quota});
    const result = await h.run('runCheckin(input)');
    const valid = quota === 50 || quota === 0;
    assert.equal(result.ok, valid, String(quota));
    assert.equal(result.visited === true, valid, String(quota));
    assert.equal(h.removed.length, valid ? 1 : 0, String(quota));
    if (valid) {assert.equal(result.account.available, quota); assert.equal(result.quotaDelta, 0);}
    else {assert.equal(h.tabs.get(h.created[0].id).active, true); assert.equal(h.store[PLATFORMS][0].account.available, 50);}
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
test('failure to publish fresh account data leaves the temporary page open', async () => {
  const p = visitPlatform({authMode:'cookie',account:{available:10}});
  const h = harness('background.js', {[PLATFORMS]:[p]}); h.ctx.input = p; allowVisitReads(h);
  h.chrome.storage.local.set = (values, cb) => {
    h.chrome.runtime.lastError = {message:'存储写入失败'};
    cb(); delete h.chrome.runtime.lastError;
  };
  const result = await h.run('runCheckin(input)');
  assert.equal(result.ok, false); assert.match(result.message, /存储写入失败/);
  assert.equal(result.visited, undefined); assert.equal(h.removed.length, 0);
  assert.equal(h.tabs.get(h.created[0].id).active, true);
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
    if (name === 'tabFetchAgentRouterAccount') {
      const configured = String(spec.args[0]);
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
  h.ctx.setTimeout = (fn, ms) => {if (ms === 800) polls.push(fn); return 1;};
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
    const result = await h.run('runCheckin(input,{reauth:true})'); await settleBackgroundEvents();
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
  await h.run('updateAgentRouterPending(pending.tabId,pending)'); let cachedReads = 0;
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabCheckAgentRouterLogin') return ++cachedReads === 1 ?
      {ok:false,userMismatch:true,userId:'11',checkedIn:true} : {ok:true,userId:'22',checkedIn:true,account:{available:999}};
    assert.equal(spec.func.name, 'tabFetchAgentRouterAccount'); assert.equal(spec.args[1], true);
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
  await h.run('updateAgentRouterPending(pending.tabId,pending)');
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
