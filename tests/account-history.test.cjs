// Offline history regressions. Backend integration tests use the real service-worker
// message/visit paths with only the network and Chrome APIs mocked; no real account is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const AccountHistory = require('../account-history.js');
const HistoryView = require('../history-view.js');

function loadAuthFixturePrefix() {
  const filename = path.join(__dirname, 'auth.test.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const boundary = source.indexOf("\nfor (const html of ['popup.html'");
  assert.notEqual(boundary, -1, 'auth fixture test boundary must remain discoverable');
  const fixture = new Module(filename, module);
  fixture.filename = filename;
  fixture.paths = Module._nodeModulePaths(path.dirname(filename));
  fixture._compile(source.slice(0, boundary) + '\nmodule.exports = { harness, PLATFORMS };\n', filename);
  return fixture.exports;
}

const { harness, PLATFORMS } = loadAuthFixturePrefix();
const HISTORY_KEY = AccountHistory.STORAGE_KEY;
const DAY_MS = 24 * 60 * 60 * 1000;
const plain = (value) => JSON.parse(JSON.stringify(value));

function platform(id, extra = {}) {
  return {
    id,
    name: id,
    baseUrl: 'https://history.example/',
    authMode: 'token',
    accessToken: 'secret-token-must-never-enter-history',
    userId: '12',
    ...extra,
  };
}

function sendBackgroundMessage(h, message) {
  const listener = h.chrome.runtime.onMessage.listeners[0];
  assert.equal(typeof listener, 'function', 'background message listener is installed');
  const sender = { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('popup.html') };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('background message timed out: ' + message.type)), 5000);
    listener(message, sender, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function installApi(h, options = {}) {
  const requests = [];
  h.ctx.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const userId = String(init.headers && init.headers['New-Api-User'] || '12');
    const apiPath = url.pathname.replace(/^\/deploy(?=\/)/, '');
    let body;
    if (apiPath === '/api/user/self') {
      body = options.failSelf
        ? { success: false, message: 'synthetic offline failure' }
        : { success: true, data: {
          id: userId,
          quota: userId === '13' ? 0 : 1250000,
          used_quota: userId === '13' ? 0 : 250000,
          quota_per_unit: 500000,
        } };
    } else if (apiPath === '/api/log/self') {
      body = { success: true, data: options.logs || [] };
    } else if (apiPath === '/api/user/checkin') {
      body = { success: true, message: 'synthetic check-in success', data: { stats: { checked_in_today: true } } };
    } else {
      throw new Error('unexpected offline fixture request: ' + url.pathname);
    }
    return {
      ok: true,
      status: 200,
      headers: { get() { return 'application/json'; } },
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  };
  return requests;
}

function sample(at, values = {}) {
  return {
    at,
    balance: 0,
    used: 0,
    monthlyTokens: 0,
    month: '2026-10',
    truncated: false,
    ...values,
  };
}

test('CommonJS and global contract, API-instance identity, live snapshot fallback, and secret-free config isolation', () => {
  assert.equal(globalThis.AccountHistory, AccountHistory);
  assert.equal(AccountHistory.STORAGE_KEY, 'nacheckin.accountHistory');
  assert.equal(AccountHistory.CURRENT_VERSION, 1);
  assert.deepEqual(plain(AccountHistory.createEmptyHistory(1234)), { version: 1, startedAt: 1234, accounts: {} });

  const a = platform('first', { baseUrl: 'HTTPS://EXAMPLE.invalid:443/path///?secret=query#fragment', userId: ' 42 ', account: { userId: '99' } });
  const b = platform('second', { baseUrl: 'https://example.invalid/path/?another=secret#private', userId: 42 });
  const otherPath = platform('other-path', { baseUrl: 'https://example.invalid/another/path/', userId: 42 });
  assert.equal(AccountHistory.identityFor(a), 'https://example.invalid/path|user:42');
  assert.equal(AccountHistory.identityFor(a), AccountHistory.identityFor(b), 'host case, trailing slashes, query, and fragment do not split an API instance');
  assert.notEqual(AccountHistory.identityFor(a), AccountHistory.identityFor(otherPath), 'deployment paths identify distinct API instances');
  assert.equal(AccountHistory.identityFor(platform('port', { baseUrl: 'https://example.invalid:8443/path/', userId: 42 })),
    'https://example.invalid:8443/path|user:42', 'non-default ports remain part of the site identity');

  const accountSnapshot = platform('snapshot', { baseUrl: 'https://example.invalid/deploy/', userId: 'invalid', account: { userId: ' 43 ' } });
  assert.equal(AccountHistory.identityFor(accountSnapshot), 'https://example.invalid/deploy|user:43', 'a confirmed account snapshot is the fallback when config userId is invalid');
  assert.equal(AccountHistory.identityFor({ ...a, userId: ' 42 ' }), 'https://example.invalid/path|user:42', 'valid configured userId takes precedence over cached account data');
  assert.equal(AccountHistory.identityFor(platform('credential-url', { baseUrl: 'https://user:password@example.invalid/path', userId: 42 })), null,
    'URLs containing embedded credentials are rejected');

  const noId = platform('config-one', { userId: null });
  const noIdOther = platform('config-two', { userId: null });
  assert.notEqual(AccountHistory.identityFor(noId), AccountHistory.identityFor(noIdOther), 'missing reliable IDs are isolated by config ID');
  assert.equal(AccountHistory.identityFor({ ...noId, id: 'safe-config', userId: 'not-a-user-id', token: 'private-token', loginPassword: 'private-password' }),
    'https://history.example|config:safe-config');
  const identities = [AccountHistory.identityFor(a), AccountHistory.identityFor(noId)];
  assert.equal(identities.some((identity) => /secret|password|token|query|fragment/i.test(identity)), false);
  assert.equal(AccountHistory.identityFor({ id: 'x', baseUrl: 'https://example.invalid', userId: 'a'.repeat(70) }),
    'https://example.invalid|config:x');
});

test('history sanitizer accepts only canonical path-aware identities without credentials or URL secrets', () => {
  const now = Date.now();
  const canonical = 'https://example.invalid/deploy/api|user:42';
  const rejected = [
    'https://user:password@example.invalid/deploy/api|user:42',
    'https://example.invalid/deploy/api?token=secret|user:42',
    'https://example.invalid/deploy/api#private|user:42',
    'https://example.invalid/deploy/api/|user:42',
    'https://EXAMPLE.invalid/deploy/api|user:42',
    'https://example.invalid:443/deploy/api|user:42',
  ];
  const accounts = { valid: { identity: canonical, samples: [sample(now)] } };
  rejected.forEach((identity, index) => { accounts['invalid-' + index] = { identity, samples: [sample(now)] }; });
  const sanitized = AccountHistory.sanitizeHistory({ version: 1, startedAt: now, accounts }, now);
  assert.deepEqual(Object.keys(sanitized.accounts), ['valid'], 'stored identities must use the same canonical instance rules as newly generated identities');
  assert.equal(JSON.stringify(sanitized).includes('secret'), false);
  assert.equal(JSON.stringify(sanitized).includes('private'), false);
});

test('samples preserve zeros, replace changed identity, scrub legacy secret identities, and enforce retention/caps', () => {
  const now = Date.now();
  const identity = 'https://history.example|user:12';
  let history = AccountHistory.createEmptyHistory(now - 1000);
  history = AccountHistory.appendSample(history, 'acct', identity, sample(now - 10), now);
  assert.deepEqual(history.accounts.acct.samples[0], sample(now - 10), 'zero balance, usage, and token count are values, not missing data');
  history = AccountHistory.appendSample(history, 'acct', 'https://history.example|user:13', sample(now), now);
  assert.equal(history.accounts.acct.identity, 'https://history.example|user:13');
  assert.deepEqual(history.accounts.acct.samples, [sample(now)], 'identity change starts a separate history');

  const contaminated = {
    version: 1,
    startedAt: now - 1000,
    accounts: {
      legacy: { identity: 'https://history.example|token:deadbeef', samples: [sample(now - 1)] },
      raw: { identity: 'https://history.example|deadbeef', samples: [sample(now - 1)] },
    },
  };
  const scrubbed = AccountHistory.sanitizeHistory(contaminated, now);
  assert.deepEqual(scrubbed.accounts, {}, 'legacy token-fragment identity rows are dropped rather than migrated');
  const olderVersion = AccountHistory.sanitizeHistory({
    version: 0,
    startedAt: now - 1000,
    accounts: { old: { identity, samples: [sample(now - 1)] } },
  }, now);
  assert.deepEqual(olderVersion.accounts, {}, 'samples from an unsupported history version are not imported');
  assert.equal(olderVersion.startedAt, now);

  assert.deepEqual(AccountHistory.createSample({
    available: Number.NaN, used: '0', monthlyTokens: -1, quotaPerUnit: 0,
  }, '2026-10', now), {
    at: now, balance: null, used: null, monthlyTokens: null, month: '2026-10', truncated: false,
  }, 'missing or invalid numbers become null while zero remains valid');
  assert.equal(AccountHistory.createSample({
    available: 0, used: 0, monthlyTokens: 0, quotaPerUnit: 500000, tokensTruncated: true,
  }, '2026-10', now).truncated, true);

  const cappedInput = AccountHistory.createEmptyHistory(now - 100 * DAY_MS);
  const count = AccountHistory.MAX_SAMPLES_PER_ACCOUNT + 30;
  const oneAccount = {
    identity,
    samples: [
      sample(now - 36 * DAY_MS),
      ...Array.from({ length: count }, (_, index) => sample(now - count + index)),
    ],
  };
  cappedInput.accounts.one = oneAccount;
  const perAccountBounded = AccountHistory.sanitizeHistory(cappedInput, now);
  assert.equal(perAccountBounded.accounts.one.samples.length, AccountHistory.MAX_SAMPLES_PER_ACCOUNT);
  assert.equal(perAccountBounded.accounts.one.samples.some((item) => item.at < now - 35 * DAY_MS), false);

  const bulk = {};
  for (let i = 0; i < 11; i++) {
    const id = 'acct-' + i;
    bulk[id] = {
      identity: 'https://history.example|config:' + id,
      samples: Array.from({ length: 500 }, (_, index) => sample(now - 500 + index)),
    };
  }
  cappedInput.accounts = bulk;
  const bounded = AccountHistory.sanitizeHistory(cappedInput, now);
  const total = Object.values(bounded.accounts).reduce((sum, entry) => sum + entry.samples.length, 0);
  assert.ok(total <= AccountHistory.MAX_SAMPLES_GLOBAL, 'global history size is bounded');
});

test('real background QUOTA refresh writes only its live response and removes unsafe prior history', async () => {
  const oldAt = Date.now() - DAY_MS;
  const oldHistory = {
    version: 1,
    startedAt: oldAt,
    accounts: { legacy: { identity: 'https://history.example|deadbeef', samples: [sample(oldAt)] } },
  };
  const saved = platform('quota', { account: { available: 999999, used: 1 } });
  const h = harness('background.js', { [PLATFORMS]: [saved], [HISTORY_KEY]: oldHistory });
  const requests = installApi(h, { logs: [] });

  const response = await sendBackgroundMessage(h, { type: 'account', platform: saved, month: '2026-10' });
  assert.equal(response.ok, true);
  assert.ok(requests.some((request) => request.url.pathname === '/api/user/self'));
  assert.ok(requests.some((request) => request.url.pathname === '/api/log/self'));
  const history = h.store[HISTORY_KEY];
  assert.equal(history.version, 1);
  assert.deepEqual(Object.keys(history.accounts), ['quota']);
  assert.equal(history.startedAt, history.accounts.quota.samples[0].at, 'tracking starts at the first retained live sample');
  assert.equal(history.accounts.quota.identity, 'https://history.example|user:12');
  assert.deepEqual(history.accounts.quota.samples[0], {
    at: history.accounts.quota.samples[0].at,
    balance: 2.5,
    used: 0.5,
    monthlyTokens: 0,
    month: '2026-10',
    truncated: false,
  });
  assert.ok(history.accounts.quota.samples[0].at >= history.startedAt);
  assert.equal(JSON.stringify(history).includes(saved.accessToken), false);
  assert.equal(JSON.stringify(history).includes('deadbeef'), false);
});

test('real no-userId quota refresh identity is readable after its live account snapshot is saved', async () => {
  const saved = platform('snapshot-fallback', {
    userId: '',
    baseUrl: 'https://history.example/deploy/',
    account: { userId: '99', available: 999999, used: 1 },
  });
  const h = harness('background.js', { [PLATFORMS]: [saved] });
  installApi(h, { logs: [] });

  const response = await sendBackgroundMessage(h, { type: 'account', platform: saved, month: '2026-10' });
  assert.equal(response.ok, true);
  assert.equal(response.account.userId, '12');
  const liveHistory = h.store[HISTORY_KEY];
  assert.equal(liveHistory.accounts['snapshot-fallback'].identity, 'https://history.example/deploy|user:12',
    'the fresh online account ID overrides an older cached account ID');
  assert.equal(JSON.stringify(liveHistory).includes('secret-token-must-never-enter-history'), false);
  assert.equal(JSON.stringify(liveHistory).includes('query'), false);
  assert.equal(JSON.stringify(liveHistory).includes('fragment'), false);

  const stored = h.store[PLATFORMS][0];
  await sendBackgroundMessage(h, {
    type: 'savePlatforms',
    platforms: [{ ...stored, account: { ...response.account } }],
  });
  const updated = h.store[PLATFORMS][0];
  const now = Date.now() + 1;
  const series = HistoryView.collectSeries(h.store[HISTORY_KEY], [updated], { now });
  assert.equal(series.length, 1);
  assert.equal(series[0].identity, liveHistory.accounts['snapshot-fallback'].identity);
  assert.equal(series[0].samples.length, 1);
  const view = HistoryView.buildViewModel(h.store[HISTORY_KEY], [updated], { now, days: 7 });
  assert.equal(view.series.length, 1);
  assert.equal(view.inRangeSamples.length, 1);
  assert.equal(view.latestBalance.value, 2.5);
});

test('parallel real QUOTA refreshes serialize history read-modify-write operations', async () => {
  const saved = platform('parallel');
  const h = harness('background.js', { [PLATFORMS]: [saved] });
  installApi(h, { logs: [] });
  let clock = Date.now();
  h.ctx.Date.now = () => ++clock;
  const originalSet = h.chrome.storage.local.set;
  let activeHistoryWrites = 0;
  let maxConcurrentHistoryWrites = 0;
  h.chrome.storage.local.set = (values, callback) => {
    if (!Object.prototype.hasOwnProperty.call(values, HISTORY_KEY)) return originalSet(values, callback);
    activeHistoryWrites++;
    maxConcurrentHistoryWrites = Math.max(maxConcurrentHistoryWrites, activeHistoryWrites);
    setImmediate(() => originalSet(values, () => {
      activeHistoryWrites--;
      if (callback) callback();
    }));
  };

  const responses = await Promise.all([
    sendBackgroundMessage(h, { type: 'account', platform: saved, month: '2026-10' }),
    sendBackgroundMessage(h, { type: 'account', platform: saved, month: '2026-10' }),
  ]);
  assert.deepEqual(responses.map((response) => response.ok), [true, true]);
  assert.equal(maxConcurrentHistoryWrites, 1, 'the async storage writes are serialized');
  assert.equal(h.store[HISTORY_KEY].accounts.parallel.samples.length, 2, 'neither concurrent sample is lost');
});

test('changed or deleted configs serialize history invalidation against stale asynchronous samples', async () => {
  const original = platform('race', { userId: '', account: null });
  const h = harness('background.js', { [PLATFORMS]: [original] });
  const unverifiedAccount = { userId: null, available: 500, used: 100, quotaPerUnit: 100, monthlyTokens: 3 };
  const initialWrite = h.run(`recordAccountHistorySample(${JSON.stringify(original)}, ${JSON.stringify(unverifiedAccount)}, '2026-10')`);
  assert.equal(await initialWrite, true);
  assert.equal(h.store[HISTORY_KEY].accounts.race.identity, 'https://history.example|config:race');

  const canonicalized = { ...original, baseUrl: 'HTTPS://HISTORY.EXAMPLE:443/' };
  await h.run(`savePlatforms(${JSON.stringify([canonicalized])})`);
  assert.equal(Object.hasOwn(h.store[HISTORY_KEY].accounts, 'race'), true,
    'canonical-equivalent host case/default-port/trailing-slash saves do not clear history');

  // Pause a stale task after it has read the old config, then save changed credentials.
  const originalGet = h.chrome.storage.local.get;
  let releasePlatformRead;
  let signalPlatformRead;
  const platformReadStarted = new Promise((resolve) => { signalPlatformRead = resolve; });
  let blockPlatformRead = true;
  h.chrome.storage.local.get = (keys, callback) => {
    if (blockPlatformRead && keys === PLATFORMS) {
      blockPlatformRead = false;
      const snapshot = structuredClone(h.store[PLATFORMS]);
      releasePlatformRead = () => callback({ [PLATFORMS]: snapshot });
      signalPlatformRead();
      return;
    }
    originalGet(keys, callback);
  };
  const staleWrite = h.run(`recordAccountHistorySample(${JSON.stringify(canonicalized)}, ${JSON.stringify(unverifiedAccount)}, '2026-10')`);
  await platformReadStarted;
  const changed = { ...canonicalized, accessToken: 'different-account-token' };
  const saveChanged = h.run(`savePlatforms(${JSON.stringify([changed])})`);
  for (let i = 0; i < 100 && h.store[PLATFORMS][0].accessToken !== changed.accessToken; i++) {
    await new Promise(setImmediate);
  }
  assert.equal(h.store[PLATFORMS][0].accessToken, changed.accessToken, 'the new config is committed before history invalidation completes');
  releasePlatformRead();
  assert.equal(await staleWrite, true, 'the delayed operation was already authorized against its captured old config');
  await saveChanged;
  assert.deepEqual(h.store[HISTORY_KEY].accounts, {}, 'serialized invalidation removes the sample written by the in-flight old task');

  h.chrome.storage.local.get = originalGet;
  assert.equal(await h.run(`recordAccountHistorySample(${JSON.stringify(canonicalized)}, ${JSON.stringify(unverifiedAccount)}, '2026-10')`), false,
    'a task starting after the credential change cannot use the old config');
  assert.deepEqual(h.store[HISTORY_KEY].accounts, {});

  const currentWrite = h.run(`recordAccountHistorySample(${JSON.stringify(changed)}, ${JSON.stringify(unverifiedAccount)}, '2026-10')`);
  assert.equal(await currentWrite, true);
  assert.equal(Object.hasOwn(h.store[HISTORY_KEY].accounts, 'race'), true);
  await h.run(`savePlatforms(${JSON.stringify([changed])}, true)`);
  assert.deepEqual(h.store[HISTORY_KEY].accounts, {}, 'an explicit import/reset clears histories even when config credentials match');
  assert.equal(await h.run(`recordAccountHistorySample(${JSON.stringify(changed)}, ${JSON.stringify(unverifiedAccount)}, '2026-10')`), true,
    'the saved current config remains able to record new live data after import reset');
  await h.run('savePlatforms([])');
  assert.deepEqual(h.store[HISTORY_KEY].accounts, {}, 'deleting a config clears its history');
  assert.equal(await h.run(`recordAccountHistorySample(${JSON.stringify(changed)}, ${JSON.stringify(unverifiedAccount)}, '2026-10')`), false,
    'a delayed task cannot recreate history after its config was deleted');
  assert.deepEqual(h.store[HISTORY_KEY].accounts, {});
});

test('real check-in and automatic batch result paths sample online account data', async () => {
  const manual = platform('manual', { userId: '12' });
  const automatic = platform('automatic', { userId: '13' });
  const h = harness('background.js', {
    [PLATFORMS]: [manual, automatic],
    'nacheckin.settings': { autoEnabled: false, notify: false, checkinIntervalSeconds: 0 },
  });
  const requests = installApi(h, { logs: [{ prompt_tokens: 0, completion_tokens: 0 }] });

  const checkin = await sendBackgroundMessage(h, { type: 'checkin', platform: manual });
  assert.equal(checkin.ok, true, JSON.stringify(checkin));
  assert.ok(h.store[HISTORY_KEY].accounts.manual.samples.length >= 1);
  assert.deepEqual({
    balance: h.store[HISTORY_KEY].accounts.manual.samples[0].balance,
    used: h.store[HISTORY_KEY].accounts.manual.samples[0].used,
    monthlyTokens: h.store[HISTORY_KEY].accounts.manual.samples[0].monthlyTokens,
  }, { balance: 2.5, used: 0.5, monthlyTokens: 0 });

  const auto = await sendBackgroundMessage(h, { type: 'autoRun' });
  assert.equal(auto.ok, true, JSON.stringify(auto));
  assert.equal(auto.summary.total, 2);
  assert.equal(auto.summary.fail, 0);
  assert.equal(h.store[HISTORY_KEY].accounts.automatic.samples.length, 1);
  assert.equal(h.store[HISTORY_KEY].accounts.automatic.identity, 'https://history.example|user:13');
  assert.equal(h.store[HISTORY_KEY].accounts.automatic.samples[0].balance, 0, 'a live zero balance remains a valid sample');
  assert.equal(h.store[HISTORY_KEY].accounts.automatic.samples[0].used, 0);
  assert.ok(requests.filter((request) => request.url.pathname === '/api/user/checkin').length >= 2);
});

test('visit account refresh samples fresh data on the real visit refresh path', async () => {
  const visited = platform('visit', { authMode: 'cookie', visitOnly: true, accessToken: '', userId: '12' });
  const h = harness('background.js', { [PLATFORMS]: [visited] });
  h.ctx.visitPlatform = visited;
  h.ctx.script = async (spec) => {
    if (spec.func.name === 'tabFetchCheckin') {
      return { ok: true, body: { success: true, data: [] } };
    }
    return { ok: true };
  };
  const tab = await h.chrome.tabs.create({ url: 'https://history.example/', active: false });
  h.ctx.visitTabId = tab.id;

  const account = await h.run(`refreshLoginAccountOnTab(visitPlatform, visitTabId,
    () => ({ id: 12, quota: 0, used_quota: 0, quota_per_unit: 500000 }), null)`);
  assert.equal(account.available, 0);
  assert.equal(h.store[HISTORY_KEY].accounts.visit.samples.length, 1);
  assert.deepEqual({
    balance: h.store[HISTORY_KEY].accounts.visit.samples[0].balance,
    used: h.store[HISTORY_KEY].accounts.visit.samples[0].used,
    monthlyTokens: h.store[HISTORY_KEY].accounts.visit.samples[0].monthlyTokens,
  }, { balance: 0, used: 0, monthlyTokens: 0 });
});

test('failed live quota request never samples cached platform account; history write failure does not fail check-in', async () => {
  const cached = platform('failed', { account: { available: 4500000, used: 123 } });
  const failedRefresh = harness('background.js', { [PLATFORMS]: [cached] });
  installApi(failedRefresh, { failSelf: true });
  const failed = await sendBackgroundMessage(failedRefresh, { type: 'account', platform: cached, month: '2026-10' });
  assert.equal(failed.ok, false);
  assert.equal(failedRefresh.store[HISTORY_KEY], undefined, 'cached account data is not imported after online failure');

  const checkinPlatform = platform('history-write-fails');
  const h = harness('background.js', { [PLATFORMS]: [checkinPlatform] });
  installApi(h);
  const originalSet = h.chrome.storage.local.set;
  h.chrome.storage.local.set = (values, callback) => {
    if (Object.prototype.hasOwnProperty.call(values, HISTORY_KEY)) {
      h.chrome.runtime.lastError = { message: 'synthetic local storage failure' };
      callback();
      h.chrome.runtime.lastError = null;
      return;
    }
    originalSet(values, callback);
  };
  const checkin = await sendBackgroundMessage(h, { type: 'checkin', platform: checkinPlatform });
  assert.equal(checkin.ok, true, 'history persistence is best-effort and cannot fail the actual check-in');
  assert.equal(h.store[HISTORY_KEY], undefined);
});
