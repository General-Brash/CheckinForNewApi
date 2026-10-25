// Focused control-plane regressions against the real background service-worker code.
// The shared auth harness is compiled only through its fixture declarations; none of its tests run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadAuthFixturePrefix() {
  const filename = path.join(__dirname, 'auth.test.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const boundary = source.indexOf("\nfor (const html of ['popup.html'");
  assert.notEqual(boundary, -1, 'auth fixture test boundary must remain discoverable');
  const fixture = new Module(filename, module);
  fixture.filename = filename;
  fixture.paths = Module._nodeModulePaths(path.dirname(filename));
  fixture._compile(source.slice(0, boundary) + `\nmodule.exports = { harness, PLATFORMS, PENDING, oauthPlatform, settleBackgroundEvents };\n`, filename);
  return fixture.exports;
}

const { harness, PLATFORMS, PENDING } = loadAuthFixturePrefix();
const STOP_VERSION = 'nacheckin.checkinStopVersion';
const LAST_AUTO = 'nacheckin.lastAuto';
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
async function eventually(predicate, message) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail(message || 'condition did not become true');
}
function sendStopMessage(h) {
  const listener = h.chrome.runtime.onMessage.listeners[0];
  assert.equal(typeof listener, 'function', 'background message listener is installed');
  const sender = { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('popup.html') };
  return new Promise((resolve, reject) => {
    try {
      const keepAlive = listener({ type: 'stopCheckin' }, sender, resolve);
      assert.equal(keepAlive, true, 'stop message keeps the response channel open');
    } catch (error) { reject(error); }
  });
}

// No network is used: fetch is replaced with a local, signal-aware promise in each test.
test('stopCheckin bypasses the active abortable request, cancels queued work, and permits a new generation', async () => {
  const h = harness('background.js', { [STOP_VERSION]: 0 });
  const requestStarted = deferred();
  const urls = [];
  let firstAbortCount = 0;
  h.ctx.fetch = (input, init = {}) => {
    urls.push(String(input));
    if (String(input).includes('/active')) {
      requestStarted.resolve();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          firstAbortCount++;
          reject(new Error('synthetic fetch aborted'));
        }, { once: true });
      });
    }
    return Promise.resolve({ ok: true, status: 200, url: String(input) });
  };

  const active = h.run(`enqueueCheckinTask(null, (_, control) => checkinFetch('https://offline.invalid/active', {}, control))`);
  await requestStarted.promise;
  h.ctx.queuedTaskRan = false;
  const queued = h.run(`enqueueCheckinTask(null, async () => { queuedTaskRan = true; return 'unexpected'; })`);
  await h.run('checkinEnqueueQueue'); // Ensure the queued task captured the old stop version.

  const stopped = await sendStopMessage(h);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopVersion, 1);
  assert.equal(h.store[STOP_VERSION], 1);
  assert.equal(firstAbortCount, 1, 'the actual AbortController signal reaches the in-flight fetch');
  await assert.rejects(active, (error) => error.code === 'CHECKIN_CANCELLED');
  await assert.rejects(queued, (error) => error.code === 'CHECKIN_CANCELLED');
  assert.equal(h.ctx.queuedTaskRan, false, 'queued callback never starts under the stopped generation');

  const next = await h.run(`enqueueCheckinTask(null, (_, control) => checkinFetch('https://offline.invalid/new-generation', {}, control))`);
  assert.equal(next.url, 'https://offline.invalid/new-generation');
  assert.deepEqual(urls, ['https://offline.invalid/active', 'https://offline.invalid/new-generation']);
});

test('auto check-in stops before enqueueing remaining platforms and does not convert cancellation into failure', async () => {
  const platforms = [
    { id: 'one', name: 'One', baseUrl: 'https://one.invalid', authMode: 'token', accessToken: 'offline-token-1' },
    { id: 'two', name: 'Two', baseUrl: 'https://two.invalid', authMode: 'token', accessToken: 'offline-token-2' },
  ];
  const h = harness('background.js', { [PLATFORMS]: platforms, [STOP_VERSION]: 0 });
  const requestStarted = deferred();
  const requested = [];
  h.ctx.fetch = (input, init = {}) => {
    requested.push(String(input));
    requestStarted.resolve();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('synthetic fetch aborted')), { once: true });
    });
  };
  h.ctx.autoPlatforms = platforms;
  const autoRun = h.run('runAutoCheckin(true, autoPlatforms)');
  await requestStarted.promise;
  const stopped = await sendStopMessage(h);
  assert.equal(stopped.stopVersion, 1);

  let cancellation;
  try { await autoRun; } catch (error) { cancellation = error; }
  assert.ok(cancellation, 'the stopped auto run rejects instead of producing a regular-failure summary');
  assert.equal(cancellation.code, 'CHECKIN_CANCELLED');
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/one\.invalid\/api\/user\/checkin$/);
  assert.equal(h.store[LAST_AUTO], undefined, 'a cancelled run does not persist a summary counting the stop as a failure');
  h.ctx.cancelledAutoError = cancellation;
  const response = plain(h.run('errorResponse(cancelledAutoError, "fallback")'));
  assert.equal(response.cancelled, true);
  assert.equal(response.code, 'CHECKIN_CANCELLED');
  assert.equal(response.ok, false);
});

test('stopping removes pending OAuth state, preserves its tab and prevents a late success callback from writing', async () => {
  const createdAt = Date.now();
  const platform = {
    id: 'oauth', name: 'OAuth', baseUrl: 'https://agentrouter.org', authMode: 'agentrouter_token', userId: '12',
    reauthPending: true, reauthStartedAt: createdAt, message: 'waiting', error: '',
    stats: { checked_in_today: false, marker: 'before-stop' }, statsDate: '2026-10-04',
    account: { available: 123, used: 45 }, lastCheckinAt: '2026-10-03T12:00:00.000Z',
  };
  const h = harness('background.js', { [PLATFORMS]: [platform], [STOP_VERSION]: 0 });
  const tab = await h.chrome.tabs.create({ url: 'https://agentrouter.org/login', active: true });
  h.ctx.pendingForTest = {
    tabId: tab.id, base: platform.baseUrl, origin: platform.baseUrl, platformId: platform.id,
    userId: platform.userId, authMode: platform.authMode, provider: 'github', oauthStarted: true,
    oauthState: 'late-state', createdAt, stopVersion: 0, token: 'old-operation-token',
    lastProgressAt: Date.now(), phase: 'oauth-launched',
  };
  await h.run('updateAgentRouterPending(pendingForTest.tabId, pendingForTest, null, true)');

  const stopped = await sendStopMessage(h);
  assert.equal(stopped.stopVersion, 1);
  // stopCheckin intentionally does not wait for tab/storage cleanup; await the same cleanup operation here.
  await h.run('cleanupStoppedOauthTasks(1)');
  assert.deepEqual(plain(await h.run('getAgentRouterPending()')), {});

  const afterCleanup = structuredClone(h.store[PLATFORMS][0]);
  await h.run(`processAgentRouterReauthTab(${tab.id}, 'https://agentrouter.org/oauth/github?state=late-state&code=late-code')`);
  const afterLateCallback = h.store[PLATFORMS][0];
  assert.equal(afterLateCallback.reauthPending, false);
  assert.equal(afterLateCallback.reauthCompletedAt, undefined);
  assert.deepEqual(afterLateCallback.stats, afterCleanup.stats);
  assert.deepEqual(afterLateCallback.account, afterCleanup.account);
  assert.equal(afterLateCallback.lastCheckinAt, afterCleanup.lastCheckinAt);
  assert.equal(h.removed.length, 0, 'cancellation preserves the user-owned OAuth page');
  assert.ok(h.tabs.has(tab.id));
});

test('only real progress resets the 60-second idle deadline; idle cleanup returns an explicit non-pending error', async () => {
  const platform = {
    id: 'idle-oauth', name: 'Idle OAuth', baseUrl: 'https://agentrouter.org', authMode: 'agentrouter_token', userId: '12',
    reauthPending: true, stats: { checked_in_today: false, marker: 'preserve' }, account: { available: 91, used: 9 },
  };
  const h = harness('background.js', { [PLATFORMS]: [platform], [STOP_VERSION]: 0 });
  const tab = await h.chrome.tabs.create({ url: 'https://agentrouter.org/login', active: true });
  h.ctx.idlePlatform = platform;
  h.ctx.idleTabId = tab.id;
  const requestStarted = deferred();
  h.ctx.fetch = (_input, init = {}) => {
    requestStarted.resolve();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('synthetic idle abort')), { once: true });
    });
  };
  const task = h.run(`enqueueCheckinTask(idlePlatform, async (p, control) => {
    idleControl = control;
    markCheckinProgress(control, 'oauth-waiting');
    const stamp = Date.now();
    const pending = { tabId: idleTabId, base: p.baseUrl, origin: new URL(p.baseUrl).origin, platformId: p.id,
      userId: String(p.userId), authMode: p.authMode, provider: 'github', oauthStarted: true, oauthState: 'expected-state',
      createdAt: stamp, stopVersion: control.stopVersion, token: control.token,
      lastProgressAt: control.lastProgressAt, phase: 'oauth-waiting' };
    await updateAgentRouterPending(idleTabId, pending, null, true);
    await processAgentRouterReauthTab(idleTabId, 'https://agentrouter.org/oauth/github?state=wrong-state&code=invalid');
    return checkinFetch('https://offline.invalid/hanging-operation', {}, control);
  })`);
  const taskOutcome = task.then((value) => ({ value }), (error) => ({ error }));
  await requestStarted.promise;

  const firstProgressAt = h.run('idleControl.lastProgressAt');
  const pendingBeforeInvalidCallback = (await h.run('getAgentRouterPending()'))[tab.id];
  await h.advanceClock(1000);
  h.run("markCheckinProgress(idleControl, 'oauth-waiting')");
  await h.run(`processAgentRouterReauthTab(${tab.id}, 'https://agentrouter.org/oauth/github?state=wrong-state&code=invalid-again')`);
  assert.equal(h.run('idleControl.lastProgressAt'), firstProgressAt, 'duplicate phase and invalid callback do not reset the control deadline');
  assert.equal((await h.run('getAgentRouterPending()'))[tab.id].lastProgressAt, pendingBeforeInvalidCallback.lastProgressAt);

  await h.advanceClock(1000);
  h.run("markCheckinProgress(idleControl, 'oauth-confirmed-progress', true)");
  const trustedProgressAt = h.run('idleControl.lastProgressAt');
  assert.ok(trustedProgressAt > firstProgressAt, 'trusted progress advances the deadline');
  h.run("markCheckinProgress(idleControl, 'oauth-confirmed-progress')");
  assert.equal(h.run('idleControl.lastProgressAt'), trustedProgressAt, 'repeated trusted phase without new progress is inert');

  await h.advanceClock(59999);
  assert.equal(h.run('idleControl.controller.signal.aborted'), false);
  await h.advanceClock(1);
  const outcome = await taskOutcome;
  const idleError = outcome.error;
  assert.ok(idleError);
  assert.equal(idleError.code, 'CHECKIN_IDLE_TIMEOUT');
  assert.equal(h.run('idleControl.controller.signal.aborted'), true);
  h.ctx.idleErrorForResponse = idleError;
  const response = plain(h.run('errorResponse(idleErrorForResponse, "fallback")'));
  assert.equal(response.ok, false);
  assert.equal(response.pending, false);
  assert.equal(response.reauthRequired, false);
  assert.equal(response.cancelled, false);
  assert.equal(response.code, 'CHECKIN_IDLE_TIMEOUT');
  assert.deepEqual(plain(await h.run('getAgentRouterPending()')), {});
  assert.equal(h.store[PLATFORMS][0].stats.marker, 'preserve');
  assert.deepEqual(h.store[PLATFORMS][0].account, platform.account);
  assert.equal(h.removed.length, 0, 'idle timeout preserves the OAuth page');
});

test('page-world stop broadcast aborts a hanging response body before stale code can continue', async () => {
  const h = harness('background.js', { [STOP_VERSION]: 0 });
  const tab = await h.chrome.tabs.create({ url: 'https://page.invalid/checkin', active: true });
  const listeners = new Map();
  const receivedStopTokens = [];
  h.ctx.location = { origin: 'https://page.invalid', href: 'https://page.invalid/checkin' };
  h.ctx.window = {
    __nacheckinCancelledCheckinToken: '',
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      if (event.type === 'nacheckin:checkin-stop') receivedStopTokens.push(event.detail);
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return true;
    },
  };
  h.ctx.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  const bodyStarted = deferred();
  const bodyAborted = deferred();
  h.ctx.fetch = (_input, init = {}) => Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: () => new Promise((resolve, reject) => {
      bodyStarted.resolve();
      init.signal.addEventListener('abort', () => {
        bodyAborted.resolve();
        reject(new Error('synthetic response body aborted'));
      }, { once: true });
    }),
  });
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabFetchCheckin') {
      assert.equal(spec.world, 'MAIN');
      assert.equal(spec.args[6], h.ctx.pageControl.token);
      return await spec.func(...spec.args);
    }
    if (spec.func.name === 'tabCancelCheckinPage') {
      assert.equal(spec.world, 'MAIN', 'broadcast reuses the page world that owns the request');
      assert.equal(spec.args[0], h.ctx.pageControl.token, 'broadcast is scoped to this operation token');
      return await spec.func(...spec.args);
    }
    throw new Error(`unexpected injected function: ${spec.func.name}`);
  };
  h.ctx.pageTabId = tab.id;
  h.ctx.staleContinuationRan = false;
  const active = h.run(`enqueueCheckinTask(null, async (_, control) => {
    pageControl = control;
    const result = await executeCheckinScript({ target: { tabId: pageTabId }, world: 'MAIN', func: tabFetchCheckin,
      args: ['/api/user/checkin', 'POST', null, '12', null, null] }, control);
    staleContinuationRan = true;
    return result;
  })`);
  await bodyStarted.promise;

  const token = h.ctx.pageControl.token;
  const stopped = await sendStopMessage(h);
  assert.equal(stopped.stopVersion, 1);
  await bodyAborted.promise;
  await assert.rejects(active, (error) => error.code === 'CHECKIN_CANCELLED');
  assert.deepEqual(receivedStopTokens, [token]);
  assert.equal(h.ctx.window.__nacheckinCancelledCheckinToken, token);
  assert.equal(h.ctx.staleContinuationRan, false, 'the old executeScript continuation is rejected before it can act');

  const takeover = await h.run(`enqueueCheckinTask(null, async () => 'new-operation-ran')`);
  assert.equal(takeover, 'new-operation-ran');
  assert.equal(h.removed.length, 0);
  assert.ok(h.tabs.has(tab.id), 'the page remains open for the user');
});
