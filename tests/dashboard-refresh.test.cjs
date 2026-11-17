// NewAPI visits refresh the native dashboard once, then verify and save the balance.
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

async function settle() { for (let i = 0; i < 8; i++) await new Promise(setImmediate); }
function manualClock(h) {
  let now = h.run('Date.now()'), next = 1;
  const timers = new Map();
  h.ctx.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  h.ctx.setTimeout = (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + Number(ms) }); return id; };
  h.ctx.clearTimeout = (id) => timers.delete(id);
  return { now: () => now, async advance(ms) {
    const end = now + ms;
    for (;;) {
      await settle();
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0]; timers.delete(id); now = timer.at; timer.fn();
    }
    now = end; await settle();
  } };
}
function visitFixture(authMode = 'cookie', extra = {}) {
  const platform = oauthPlatform({baseUrl:'https://newapi.example.test',authMode,visitOnly:true,
    userId:'12',accessToken:'unused-system-token',loginUsername:'alice@example.com',loginPassword:'unused-password',
    account:{available:10},...extra});
  const h = harness('background.js', {[PLATFORMS]:[platform]});
  h.ctx.platform = platform;
  h.ctx.dashboardRefresh = async (spec) => {
    assert.equal(spec.world, 'MAIN');
    assert.equal(h.tabs.get(spec.target.tabId).url, platform.baseUrl + '/console');
    assert.doesNotMatch(JSON.stringify(spec.args), /unused-/);
    return {ok:true,refreshed:true};
  };
  const requests = [];
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name, 'tabFetchCheckin'); assert.equal(spec.args[1], 'GET');
    assert.ok([platform.baseUrl + '/', platform.baseUrl + '/console'].includes(h.tabs.get(spec.target.tabId).url));
    assert.doesNotMatch(JSON.stringify(spec.args), /unused-/);
    requests.push({tabId:spec.target.tabId,path:spec.args[0]});
    const data = spec.args[0] === '/api/log/self' ? [{prompt_tokens:2,completion_tokens:3}]
      : {id:12,email:'alice@example.com',quota:80,used_quota:2};
    assert.ok(['/api/user/self','/api/log/self'].includes(spec.args[0]));
    return {ok:true,body:{success:true,data}};
  };
  return {h,platform,requests};
}

test('pending native refresh cannot close the page or save a pre-refresh quota', async () => {
  const {h,platform} = visitFixture();
  let releaseRefresh, releaseFinal, refreshed = false, balanceReads = 0;
  const refreshing = new Promise(resolve => { releaseRefresh=resolve; });
  const finalRead = new Promise(resolve => { releaseFinal=resolve; });
  h.ctx.dashboardRefresh = async () => {
    await refreshing;
    refreshed=true;
    return {ok:true,refreshed:true};
  };
  h.ctx.script = async spec => {
    if(spec.args[0]==='/api/log/self')return {ok:true,body:{success:true,data:[{prompt_tokens:2}]}};
    if(!refreshed)return {ok:true,body:{success:true,data:{id:12,quota:20}}};
    if(++balanceReads===2)await finalRead;
    return {ok:true,body:{success:true,data:{id:12,quota:balanceReads===1?80:95}}};
  };
  const remove=h.chrome.tabs.remove;
  h.chrome.tabs.remove=async id=>{
    assert.equal(h.store[PLATFORMS][0].account.available,95);
    assert.equal(h.store[PLATFORMS][0].account.monthlyTokens,2);
    return remove(id);
  };
  const pending=h.run('runCheckin(platform)');await settle();
  assert.equal(h.dashboardRefreshInjections.length,1);assert.equal(h.removed.length,0);
  assert.equal(h.store[PLATFORMS][0].account.available,10);
  releaseRefresh();await settle();
  assert.equal(balanceReads,2);assert.equal(h.removed.length,0);
  assert.equal(h.store[PLATFORMS][0].account.available,80);
  releaseFinal();const result=await pending;
  assert.equal(result.visited,true);assert.equal(result.account.available,95);assert.equal(result.quotaDelta,85);
  assert.equal(h.dashboardRefreshInjections.length,1);assert.equal(h.removed.length,1);assert.equal(h.reloaded.length,0);
});

for (const error of ['missing-button','refresh-failed','unconfirmed']) {
  test(`native ${error} retains the owned page and never publishes a successful visit`, async () => {
    const {h,platform,requests}=visitFixture();
    h.ctx.dashboardRefresh=async()=>error==='unconfirmed'?null:{ok:false,message:error};
    const result=await h.run('runCheckin(platform)');
    assert.equal(result.ok,false);assert.notEqual(result.visited,true);assert.match(result.message,/页面已保留/);
    assert.equal(h.store[PLATFORMS][0].account.available,10);
    assert.equal(h.dashboardRefreshInjections.length,1);assert.equal(h.removed.length,0);assert.equal(h.reloaded.length,0);
    assert.equal(requests.length,1,'only the pre-refresh online identity was requested');
    assert.equal(h.run('visitOnlyOrigins.size'),0);assert.equal(h.run('sessionTokenCache.size'),0);
  });
}

for (const stopAt of ['wait','request']) {
  test(`stopping during native refresh ${stopAt} closes only the owned page and rejects late success`, async () => {
    const {h,platform}=visitFixture();const clock=manualClock(h);
    let release;
    h.ctx.dashboardRefresh=()=>new Promise(resolve=>{release=resolve;});
    h.run('control={...balanceSupplementControl(),lastProgressAt:Date.now()}');
    const pending=h.run('runCheckin(platform,{control})');
    const rejected=assert.rejects(pending,{code:'CHECKIN_CANCELLED'});
    await settle();
    if(stopAt==='request')await clock.advance(5000);
    else await clock.advance(4999);
    h.ctx.control.controller.abort();await rejected;
    assert.equal(h.dashboardRefreshInjections.length,stopAt==='wait'?0:1);
    assert.equal(h.removed.length,1);assert.equal(h.reloaded.length,0);
    if(release)release({ok:true,refreshed:true});await settle();
    assert.equal(h.store[PLATFORMS][0].account.available,10);
  });
}

for (const change of ['foreign-pending','config','deleted']) {
  test(`${change} during the five-second wait prevents the native click`, async () => {
    const {h,platform}=visitFixture();const clock=manualClock(h);
    const pending=h.run('runCheckin(platform)');await settle();
    await clock.advance(4999);
    if(change==='foreign-pending')h.tabs.get(h.created[0].id).pendingUrl='https://other.example.test/';
    else await new Promise(resolve=>h.chrome.storage.local.set({[PLATFORMS]:change==='deleted'?[]:[{...platform,userId:'99'}]},resolve));
    await clock.advance(1);const result=await pending;
    assert.equal(result.ok,false);assert.notEqual(result.visited,true);
    assert.equal(h.dashboardRefreshInjections.length,0);assert.equal(h.reloaded.length,0);
    assert.equal(h.removed.length,0);assert.equal(h.run('visitOnlyOrigins.size'),0);
  });
}

test('leaving and returning to the dashboard invalidates the original five-second wait', async () => {
  const {h,platform}=visitFixture();const clock=manualClock(h);
  const listeners=h.chrome.tabs.onUpdated.listeners.length;
  const pending=h.run('runCheckin(platform)');await settle();
  const tab=h.tabs.get(h.created[0].id);
  await clock.advance(1000);
  tab.url='https://other.example.test/';
  for(const fn of [...h.chrome.tabs.onUpdated.listeners])fn(tab.id,{url:tab.url,status:'loading'},{...tab});
  await settle();
  tab.url=platform.baseUrl+'/console';
  for(const fn of [...h.chrome.tabs.onUpdated.listeners])fn(tab.id,{url:tab.url,status:'complete'},{...tab});
  await clock.advance(4000);
  const result=await pending;
  assert.equal(result.ok,false);assert.match(result.message,/等待.*导航.*失效/);
  assert.equal(h.dashboardRefreshInjections.length,0);assert.equal(h.removed.length,0);
  assert.equal(h.chrome.tabs.onUpdated.listeners.length,listeners);
  assert.equal(h.store[PLATFORMS][0].account.available,10);
});

for (const authMode of ['token','cookie','password']) {
  for (const automatic of [false,true]) {
    test(`${authMode}/${automatic ? 'automatic' : 'manual'}: a loaded dashboard waits five seconds and refreshes once before saving`, async () => {
      const {h,requests} = visitFixture(authMode);
      await settle();
      const clock = manualClock(h), start = clock.now();
      const create = h.chrome.tabs.create;
      h.chrome.tabs.create = (opts) => create({...opts,status:'loading'});
      const update = h.chrome.tabs.update;
      h.chrome.tabs.update = async (id, opts) => {
        if (opts.url?.endsWith('/console')) h.tabs.get(id).status = 'loading';
        return update(id, opts);
      };
      const updatedCount = h.chrome.tabs.onUpdated.listeners.length;
      const pending = h.run(automatic ? 'runAutoCheckin(true,[platform])' : 'runCheckin(platform)');
      await settle();
      assert.equal(h.created.length, 1); assert.equal(requests.length, 0);
      const page = h.tabs.get(h.created[0].id);
      page.status = 'complete';
      for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(page.id, {status:'complete'}, {...page});
      await settle();
      assert.ok(requests.some((request) => request.path === '/api/user/self'));
      assert.equal(requests.some((request) => request.path === '/api/log/self'), false);
      await clock.advance(5000);
      assert.equal(h.dashboardRefreshInjections.length, 0, 'loading time does not count toward the refresh wait');
      page.status = 'complete';
      for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(page.id, {status:'complete'}, {...page});
      await settle();
      await clock.advance(4999);
      assert.equal(h.dashboardRefreshInjections.length, 0); assert.equal(h.removed.length, 0);
      assert.equal(h.store[PLATFORMS][0].account.available, 10);
      await clock.advance(1);
      assert.equal(h.dashboardRefreshInjections.length, 1);
      assert.ok(requests.some((request) => request.path === '/api/log/self'));
      assert.equal(clock.now(), start + 10000);
      const result = await pending;
      assert.equal(automatic ? result.visited === 1 : result.visited, true);
      assert.equal(h.store[PLATFORMS][0].account.available, 80);
      assert.equal(h.store[PLATFORMS][0].account.monthlyTokens, 5);
      assert.ok(requests.every((request) => request.tabId === page.id));
      assert.deepEqual(h.removed, [page.id]);
      const requestCount = requests.length;
      await clock.advance(5000);
      for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(page.id, {status:'complete'}, {...page});
      await settle();
      assert.equal(requests.length, requestCount, 'no delayed or duplicate work');
      assert.equal(h.dashboardRefreshInjections.length, 1); assert.equal(h.reloaded.length, 0);
      assert.equal(h.updates.filter(entry => entry.url).length, 1); assert.equal(h.created.length, 1);
      assert.equal(h.chrome.tabs.onUpdated.listeners.length, updatedCount);
    });
  }
}

test('visit waits for authentication before navigating or refreshing', async () => {
  const {h,requests} = visitFixture();
  const script = h.ctx.script;
  let releaseIdentity;
  const identity = new Promise((resolve) => { releaseIdentity = resolve; });
  h.ctx.script = async (spec) => {
    const result = await script(spec);
    if (requests.length === 1) await identity;
    return result;
  };
  const pending = h.run('runCheckin(platform)');
  await settle();
  assert.equal(requests.length, 1); assert.equal(h.removed.length, 0);
  assert.equal(h.store[PLATFORMS][0].account.available, 10);
  assert.equal(h.updates.length, 0); assert.equal(h.dashboardRefreshInjections.length, 0);
  releaseIdentity();
  const result = await pending;
  assert.equal(result.visited, true); assert.equal(result.account.available, 80);
  assert.equal(h.created.length, 1); assert.equal(h.reloaded.length, 0);
});

test('a pending navigation cannot use the old complete page to begin API work', async () => {
  const {h,platform,requests} = visitFixture();
  await settle();
  const clock = manualClock(h);
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = (opts) => create({...opts,pendingUrl:platform.baseUrl + '/home'});
  const pending = h.run('runCheckin(platform)');
  await settle();
  assert.equal(h.created.length, 1); assert.equal(requests.length, 0); assert.equal(h.removed.length, 0);
  const page = h.tabs.get(h.created[0].id);
  delete page.pendingUrl;
  for (const fn of [...h.chrome.tabs.onUpdated.listeners]) fn(page.id, {status:'complete'}, {...page});
  await settle();
  await clock.advance(5000);
  assert.equal((await pending).visited, true);
  assert.equal(h.reloaded.length, 0); assert.equal(h.updates.filter(entry => entry.url).length, 1);
});

test('stopping a pending direct balance read closes the owned tab and rejects a late response', async () => {
  const {h} = visitFixture();
  const script = h.ctx.script;
  let releaseBalance, reads = 0;
  const balance = new Promise((resolve) => { releaseBalance = resolve; });
  h.ctx.script = async (spec) => {
    const result = await script(spec);
    if (spec.args[0] === '/api/user/self' && ++reads === 2) await balance;
    return result;
  };
  h.run('control = {...balanceSupplementControl(),lastProgressAt:Date.now()}');
  const pending = h.run('runCheckin(platform,{control})');
  await settle();
  assert.equal(reads, 2); assert.equal(h.removed.length, 0);
  h.ctx.control.controller.abort();
  await assert.rejects(pending, {code:'CHECKIN_CANCELLED'});
  assert.equal(h.store[PLATFORMS][0].account.available, 10);
  assert.equal(h.removed.length, 1); assert.equal(h.reloaded.length, 0);
  releaseBalance(); await settle();
  assert.equal(h.store[PLATFORMS][0].account.available, 10);
  assert.equal(h.dashboardRefreshInjections.length, 1);
});

for (const authMode of ['cookie','password']) {
  test(`${authMode}: login completes before one native dashboard refresh`, async () => {
    const {h,platform} = visitFixture(authMode);
    let online = false, loginProbes = 0, submitted = false;
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:404};
      if (spec.func.name === 'tabLogout') return {ok:true};
      if (spec.func.name === 'tabSubmitPasswordLogin') { submitted = true; return {ok:true}; }
      if (spec.func.name === 'tabReadAgentRouterStoredUser') return online ? {id:12} : null;
      assert.equal(spec.func.name, 'tabFetchCheckin');
      if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      assert.equal(spec.args[0], '/api/user/self');
      if (h.tabs.get(spec.target.tabId).url.endsWith('/login')) loginProbes++;
      return online ? {ok:true,body:{success:true,data:{id:12,email:'alice@example.com',quota:80}}} : {ok:false,status:401};
    };
    const pending = h.run('runCheckin(platform)');
    for (let i = 0; i < 20 && loginProbes < 2; i++) await new Promise(setImmediate);
    assert.ok(loginProbes >= 2, '401 must keep waiting for login');
    assert.equal(h.removed.length, 0); assert.equal(h.created.length, 1);
    assert.equal(submitted, authMode === 'password');
    assert.equal(h.tabs.get(h.created[0].id).url, platform.baseUrl + '/login');
    online = true;
    const result = await pending;
    assert.equal(result.visited, true); assert.equal(result.account.available, 80);
    assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/').length, 0);
    assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/console').length, 1);
    assert.equal(h.reloaded.length, 0); assert.equal(h.dashboardRefreshInjections.length, 1);
    assert.equal(h.removed.length, 1);
  });
}

for (const authMode of ['agentrouter_token','agentrouter_linuxdo','password']) {
  test(`${authMode}: Agent Router refreshes once and keeps its dashboard balance compatibility`, async () => {
    const {h,platform} = visitFixture(authMode, {baseUrl:'https://agentrouter.org',visitOnly:false});
    const tab = await h.chrome.tabs.create({url:platform.baseUrl + '/console'});
    h.ctx.tabId = tab.id; h.ctx.identity = {id:12,email:'alice@example.com'};
    let reads = 0;
    h.ctx.script = async (spec) => {
      assert.equal(spec.target.tabId, tab.id);
      if (spec.func.name === 'tabReadAgentRouterDashboard') {
        reads++;
        return {ok:true,body:{success:true,data:{id:12,quota:80,used_quota:2,_accountSource:'dashboard'}}};
      }
      assert.equal(spec.func.name, 'tabFetchCheckin'); assert.equal(spec.args[0], '/api/log/self');
      return {ok:true,body:{success:true,data:[]}};
    };
    const account = await h.run('refreshLoginAccountOnTab(platform,tabId,null,null,identity)');
    assert.equal(account.available, 80); assert.equal(account.source, 'dashboard'); assert.equal(reads, 2);
    assert.equal(h.dashboardRefreshInjections.length, 1); assert.equal(h.reloaded.length, 0);
    assert.equal(h.updates.length, 0); assert.equal(h.created.length, 1);
  });
}

for (const stage of ['balance','final']) {
  test(`visit without a configured user ID rejects account switching during ${stage}`, async () => {
    const {h} = visitFixture('cookie', {userId:''});
    let reads = 0;
    h.ctx.script = async (spec) => {
      if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      reads++;
      const id = reads >= (stage === 'balance' ? 2 : 3) ? 99 : 12;
      return {ok:true,body:{success:true,data:{id,quota:80,used_quota:2}}};
    };
    const result = await h.run('runCheckin(platform)');
    assert.equal(result.ok, false); assert.notEqual(result.visited, true);
    assert.match(result.message, /不一致/);
    assert.equal(h.store[PLATFORMS][0].account.available, stage === 'balance' ? 10 : 80);
    if (stage === 'final') assert.equal(h.store[PLATFORMS][0].account.userId, '12');
    assert.equal(h.removed.length, 0); assert.equal(h.reloaded.length, 0);
    assert.equal(h.dashboardRefreshInjections.length, 1);
  });
}

test('iKuuu cannot enter the NewAPI login/account read flow', async () => {
  const h = harness('background.js');
  h.ctx.platform = {id:'traffic',siteType:'ikuuu',baseUrl:'https://ikuuu.example.test',authMode:'password'};
  await assert.rejects(h.run('refreshLoginAccountOnTab(platform,1)'), /仅适用于 NewAPI/);
  assert.equal(h.created.length, 0);
});

test('dashboard polling does not swallow cancellation from the last injection', async () => {
  const h = harness('background.js');
  const tab = await h.chrome.tabs.create({url:'https://agentrouter.org/console'});
  h.ctx.platform = oauthPlatform(); h.ctx.tabId = tab.id;
  let reads = 0;
  h.ctx.script = async () => { reads++; return h.run('Promise.reject(checkinCancelledError())'); };
  await assert.rejects(h.run('waitAgentRouterAccountOnTab(platform,tabId)'), {code:'CHECKIN_CANCELLED'});
  assert.equal(reads, 1); assert.equal(h.reloaded.length, 0);
});

for (const failure of [404,403,503,'timeout','missing-quota']) {
  test(`post-refresh balance ${failure} uses the same dashboard's matching displayed balance without a second refresh`, async () => {
    const {h,platform} = visitFixture();
    let selfReads = 0, dashboardReads = 0;
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabReadAgentRouterDashboard') {
        dashboardReads++;
        assert.equal(h.tabs.get(spec.target.tabId).url, platform.baseUrl + '/console');
        assert.equal(spec.args[1], '12');
        assert.doesNotMatch(JSON.stringify(spec.args[2]), /"quota"|unused-/);
        return {ok:true,body:{success:true,data:{id:12,quota:95,used_quota:3,_accountSource:'dashboard',
          _dashboardWarning:'displayed balance only'}}};
      }
      assert.equal(spec.func.name, 'tabFetchCheckin');
      if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
      selfReads++;
      if (selfReads === 1) return {ok:true,body:{success:true,data:{id:12,username:'alice',quota:80}}};
      if (failure === 'timeout') return {ok:false,timedOut:true};
      if (failure === 'missing-quota') return {ok:true,body:{success:true,data:{id:12,username:'alice'}}};
      return {ok:false,status:failure,body:{success:false,message:'balance unavailable'}};
    };
    const result = await h.run('runCheckin(platform)');
    assert.equal(result.visited, true); assert.equal(result.account.available, 95);
    assert.equal(result.account.source, 'dashboard'); assert.match(result.account._warn, /displayed balance only/);
    assert.equal(dashboardReads, 2);
    assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/console').length, 1);
    assert.equal(h.created.length, 1); assert.equal(h.reloaded.length, 0); assert.equal(h.removed.length, 1);
    assert.equal(h.dashboardRefreshInjections.length, 1);
    assert.equal(h.store[PLATFORMS][0].account.available, 95);
  });
}

test('dashboard navigation alone is not success; a missing balance keeps the previous saved balance', async () => {
  const {h,platform} = visitFixture();
  let selfReads = 0, dashboardReads = 0;
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabReadAgentRouterDashboard') {
      dashboardReads++; return {ok:false,message:'missing balance'};
    }
    assert.equal(spec.func.name, 'tabFetchCheckin');
    return ++selfReads === 1 ? {ok:true,body:{success:true,data:{id:12,quota:80}}} : {ok:false,status:404};
  };
  const result = await h.run('runCheckin(platform)');
  assert.equal(result.ok, false); assert.notEqual(result.visited, true);
  assert.equal(h.store[PLATFORMS][0].account.available, 10);
  assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/console').length, 1);
  assert.equal(dashboardReads, 5); assert.equal(h.removed.length, 0); assert.equal(h.reloaded.length, 0);
});

for (const failure of ['wrong-user','expired','challenge','cancelled','foreign-page']) {
  test(`${failure} cannot trigger a balance dashboard fallback or publish a successful visit`, async () => {
    const {h,platform} = visitFixture();
    let selfReads = 0;
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:401};
      assert.equal(spec.func.name, 'tabFetchCheckin');
      if (++selfReads === 1) return {ok:true,body:{success:true,data:{id:12,quota:80}}};
      if (failure === 'wrong-user') return {ok:true,body:{success:true,data:{id:99,quota:80}}};
      if (failure === 'expired') return {ok:false,status:401};
      if (failure === 'challenge') return {ok:false,status:403,htmlResponse:true};
      if (failure === 'cancelled') return {ok:false,cancelled:true};
      h.tabs.get(spec.target.tabId).url = 'https://other.example.test/';
      return {ok:false,status:404};
    };
    const result = await h.run('runCheckin(platform)');
    assert.equal(result.ok, false); assert.notEqual(result.visited, true);
    assert.equal(h.updates.filter((entry) => entry.url).length, 1);
    assert.equal(h.store[PLATFORMS][0].account.available, 10);
    assert.equal(h.created.length, 1); assert.equal(h.removed.length, failure === 'cancelled' ? 1 : 0);
  });
}

test('log API failure verifies the same dashboard account and retries only the read', async () => {
  const {h,platform} = visitFixture();
  let logReads = 0;
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name, 'tabFetchCheckin');
    if (spec.args[0] === '/api/log/self') {
      logReads++;
      return logReads === 1 ? {ok:false,status:404} : {ok:true,body:{success:true,data:[{prompt_tokens:3,completion_tokens:4}]}};
    }
    return {ok:true,body:{success:true,data:{id:12,quota:80,used_quota:2}}};
  };
  const result = await h.run('runCheckin(platform)');
  assert.equal(result.visited, true); assert.equal(result.account.monthlyTokens, 7);
  assert.equal(result.account.available, 80); assert.equal(logReads, 2);
  assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/console').length, 1);
  assert.equal(h.reloaded.length, 0); assert.equal(h.dashboardRefreshInjections.length, 1);
});

test('a wrong account after the log fallback cannot receive retried Token statistics', async () => {
  const {h,platform} = visitFixture();
  let logReads = 0, selfReads = 0;
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name, 'tabFetchCheckin');
    if (spec.args[0] === '/api/log/self') { logReads++; return {ok:false,status:404}; }
    const id = ++selfReads >= 3 ? 99 : 12;
    return {ok:true,body:{success:true,data:{id,quota:80}}};
  };
  const result = await h.run('runCheckin(platform)');
  assert.equal(result.ok, false); assert.match(result.message, /不一致/);
  assert.equal(logReads, 1); assert.equal(h.store[PLATFORMS][0].account.userId, '12');
  assert.equal(h.store[PLATFORMS][0].account.monthlyTokens, null);
});

for (const pathname of ['/', '/login']) {
  test(`password login reuses an available native entrance on ${pathname} without same-address navigation`, async () => {
    const {h,platform} = visitFixture('password');
    const tab = await h.chrome.tabs.create({url:platform.baseUrl + pathname});
    h.ctx.taskTab = tab;
    let submitted = 0;
    h.ctx.findSiteLogin = async () => ({ok:true,found:true,allowHome:pathname === '/'});
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:404};
      if (spec.func.name === 'tabLogout') return {ok:true};
      if (spec.func.name === 'tabSubmitPasswordLogin') {
        assert.equal(h.tabs.get(tab.id).url, platform.baseUrl + pathname);
        assert.equal(spec.args[4], pathname === '/'); submitted++; return {ok:true};
      }
      if (spec.func.name === 'tabReadAgentRouterStoredUser') return {id:12};
      assert.equal(spec.func.name, 'tabFetchCheckin');
      return submitted ? {ok:true,body:{success:true,data:{id:12,email:platform.loginUsername,quota:80}}} : {ok:false,status:401};
    };
    const user = await h.run('loginPasswordOnTab(platform,taskTab)');
    assert.equal(user.id, 12); assert.equal(submitted, 1);
    assert.equal(h.updates.some((entry) => entry.url), false); assert.equal(h.reloaded.length, 0);
    assert.equal(h.loginProbeInjections.length, 1);
    assert.doesNotMatch(JSON.stringify(h.loginProbeInjections[0].args), /unused-/);
  });
}

test('an absent pre-login account API enters login once, without reloading that loaded login page', async () => {
  const {h,platform} = visitFixture('password');
  let submitted = false;
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabLogout') return {ok:true};
    if (spec.func.name === 'tabSubmitPasswordLogin') { submitted = true; return {ok:true}; }
    if (spec.func.name === 'tabReadAgentRouterStoredUser') {
      h.tabs.get(spec.target.tabId).url = platform.baseUrl + '/';
      return {id:12};
    }
    assert.equal(spec.func.name, 'tabFetchCheckin');
    if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
    return submitted ? {ok:true,body:{success:true,data:{id:12,email:platform.loginUsername,quota:80}}} : {ok:false,status:404};
  };
  const result = await h.run('runCheckin(platform)');
  assert.equal(result.visited, true); assert.equal(submitted, true);
  assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/login').length, 1);
  assert.equal(h.reloaded.length, 0);
});

test('Cookie login reuses an already redirected login page instead of navigating to it again', async () => {
  const {h,platform} = visitFixture();
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = (opts) => create({...opts,url:platform.baseUrl + '/login'});
  let probes = 0;
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:404};
    assert.equal(spec.func.name, 'tabFetchCheckin');
    if (spec.args[0] === '/api/log/self') return {ok:true,body:{success:true,data:[]}};
    if (++probes === 1) return {ok:false,status:401};
    h.tabs.get(spec.target.tabId).url = platform.baseUrl + '/';
    return {ok:true,body:{success:true,data:{id:12,quota:80}}};
  };
  const result = await h.run('runCheckin(platform)');
  assert.equal(result.visited, true);
  assert.equal(h.updates.some((entry) => entry.url === platform.baseUrl + '/login'), false);
  assert.equal(h.reloaded.length, 0);
});

for (const available of [true,false]) {
  test(`OAuth login ${available ? 'starts from the current homepage' : 'uses the login page only when its interface is missing'}`, async () => {
    const {h,platform} = visitFixture('agentrouter_linuxdo', {baseUrl:'https://agentrouter.org'});
    h.ctx.taskTab = await h.chrome.tabs.create({url:platform.baseUrl + '/'});
    h.ctx.pending = {tabId:h.ctx.taskTab.id,platformId:platform.id,base:platform.baseUrl,origin:platform.baseUrl,
      userId:'12',authMode:platform.authMode,provider:'linuxdo',visitOnly:true,oauthStarted:false,createdAt:h.run('Date.now()')};
    await h.run('updateAgentRouterPending(taskTab.id,pending,null,true)');
    let starts = 0;
    h.ctx.script = async (spec) => {
      assert.equal(spec.func.name,'tabBuildAgentRouterOauthUrl'); starts++;
      if (!available && h.tabs.get(spec.target.tabId).url.endsWith('/')) return {ok:false,loginPageRequired:true};
      return {ok:true,url:'https://connect.linux.do/oauth2/authorize?client_id=client&state=new-round&response_type=code'};
    };
    await h.run('handleAgentRouterReauthTab(taskTab.id,taskTab.url)');
    if (!available) await h.run('handleAgentRouterReauthTab(taskTab.id,"https://agentrouter.org/login")');
    assert.equal(starts,available ? 1 : 2);
    assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/login').length,available ? 0 : 1);
    assert.equal(h.updates.filter((entry) => entry.url?.startsWith('https://connect.linux.do/')).length,1);
    assert.equal(h.store['nacheckin.agentRouterReauth'][h.ctx.taskTab.id].oauthStarted,true);
    assert.equal(h.reloaded.length,0); assert.equal(h.created.length,1);
  });
}

test('a missing OAuth interface at login cannot create an endless login-page reload', async () => {
  const {h,platform} = visitFixture('agentrouter_linuxdo', {baseUrl:'https://agentrouter.org'});
  const tab = await h.chrome.tabs.create({url:platform.baseUrl + '/'});
  h.ctx.taskTab = tab;
  h.ctx.pending = {tabId:tab.id,platformId:platform.id,base:platform.baseUrl,origin:platform.baseUrl,userId:'12',
    authMode:platform.authMode,provider:'linuxdo',visitOnly:true,oauthStarted:false,createdAt:h.run('Date.now()')};
  await h.run('updateAgentRouterPending(taskTab.id,pending,null,true)');
  h.ctx.script = async () => ({ok:false,loginPageRequired:true});
  await h.run('handleAgentRouterReauthTab(taskTab.id,taskTab.url)');
  for (let i=0;i<3;i++) await h.run('handleAgentRouterReauthTab(taskTab.id,"https://agentrouter.org/login")');
  assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/login').length,1);
  assert.equal(h.reloaded.length,0); assert.equal(h.store['nacheckin.agentRouterReauth'][tab.id].oauthStarted,false);
});

test('a failed second log page retries within the original budget without double-counting or losing partial totals', async () => {
  const {h,platform} = visitFixture();
  const logs = Array.from({length:100}, () => ({prompt_tokens:1}));
  const pages = [];
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name,'tabFetchCheckin');
    if (spec.args[0] !== '/api/log/self') return {ok:true,body:{success:true,data:{id:12,quota:80}}};
    pages.push(spec.args[5].p);
    if (pages.length > 2) return {ok:false,status:503};
    return spec.args[5].p === 1 ? {ok:true,body:{success:true,data:logs}} : {ok:false,status:503};
  };
  const result = await h.run('runCheckin(platform)');
  assert.equal(result.visited,true); assert.equal(result.account.monthlyTokens,100);
  assert.equal(result.account.tokensTruncated,true); assert.deepEqual(pages,[1,2,1]);
  assert.equal(h.store[PLATFORMS][0].account.monthlyTokens,100);
});

test('an exhausted Token budget cannot start another request or native refresh', async () => {
  const {h,platform} = visitFixture();
  const clock = manualClock(h);
  let logReads = 0;
  h.ctx.script = async (spec) => {
    assert.equal(spec.func.name,'tabFetchCheckin');
    if (spec.args[0] === '/api/log/self') { logReads++; await clock.advance(20001); return {ok:false,status:503}; }
    return {ok:true,body:{success:true,data:{id:12,quota:80}}};
  };
  const pending = h.run('runCheckin(platform)');
  await settle(); await clock.advance(5000);
  const result = await pending;
  assert.equal(result.visited,true); assert.equal(result.account.monthlyTokens,null); assert.equal(logReads,1);
  assert.equal(h.updates.filter((entry) => entry.url === platform.baseUrl + '/console').length,1);
  assert.equal(h.dashboardRefreshInjections.length,1);
});

for (const error of ['401','challenge','pending-foreign']) {
  test(`log ${error} preserves the saved balance but cannot start dashboard fallback`, async () => {
    const {h} = visitFixture();
    h.ctx.script = async (spec) => {
      if (spec.func.name === 'tabRefreshAuthToken') return {httpOk:false,status:401};
      assert.equal(spec.func.name,'tabFetchCheckin');
      if (spec.args[0] !== '/api/log/self') return {ok:true,body:{success:true,data:{id:12,quota:80}}};
      if (error === 'pending-foreign') h.tabs.get(spec.target.tabId).pendingUrl='https://other.example.test/';
      return {ok:false,status:error === '401' ? 401 : 403,htmlResponse:error === 'challenge'};
    };
    const result = await h.run('runCheckin(platform)');
    assert.equal(result.ok,false); assert.notEqual(result.visited,true);
    assert.equal(h.store[PLATFORMS][0].account.available,80);
    assert.equal(h.updates.filter((entry) => entry.url).length,1); assert.equal(h.removed.length,0);
  });
}
