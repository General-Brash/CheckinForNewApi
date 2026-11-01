// Offline tests for history aggregation; no browser profile, credentials, or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HistoryView = require('../history-view.js');
const AccountHistory = require('../account-history.js');

const DAY = 24 * 60 * 60 * 1000;
const root = path.resolve(__dirname, '..');
function platform(id, name, token, extra = {}) {
  return { id, name, baseUrl: 'https://history.example.test', token, userId: '12', ...extra };
}
function sample(at, balance, used, monthlyTokens, month = '2026-10', truncated = false) {
  return { at, balance, used, monthlyTokens, month, truncated };
}
function history(startedAt, accounts) {
  return { version: 1, startedAt, accounts };
}
function identity(config) {
  return AccountHistory.identityFor(config);
}

class MockElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = Object.create(null);
    this.textContent = '';
    this.clientWidth = 390;
    this.listeners = Object.create(null);
    this.value = undefined;
    this.isConnected = false;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    child.isConnected = this.isConnected;
    if (this.tagName === 'select' && this.value === undefined) this.value = child.value;
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  focus() { this.ownerDocument.activeElement = this; }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
  querySelector(selector) {
    const matches = (node) => selector.startsWith('.')
      ? node.className === selector.slice(1)
      : node.tagName === selector.toLowerCase();
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this);
  }
}

function mockDocument() {
  const doc = {
    createElement(tag) { return new MockElement(tag, this); },
    createElementNS(_namespace, tag) { return new MockElement(tag, this); },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body = doc.createElement('body');
  doc.body.isConnected = true;
  return doc;
}

function deepText(node) {
  return `${node.textContent || ''}${node.children.map(deepText).join('')}`;
}

function descendants(node, predicate) {
  return node.children.flatMap((child) => [ ...(predicate(child) ? [child] : []), ...descendants(child, predicate) ]);
}

function hasClass(node, name) {
  return (node.className || node.getAttribute('class') || '').split(/\s+/).includes(name);
}

function localTime(day, hour = 12, minute = 0, second = 0) {
  return new Date(2026, 9, day, hour, minute, second).getTime();
}

test('uses the fixed v1 schema and rejects data from before collection started', () => {
  const now = 100 * DAY;
  const valid = history(now - 3 * DAY, {
    a: { identity: 'one', samples: [sample(now - 4 * DAY, 99, 99, 99), sample(now - 2 * DAY, 0, 0, 0)] },
  });
  const normalized = HistoryView.normalizeHistory(valid, now);
  assert.equal(normalized.accounts.a.samples.length, 1);
  assert.deepEqual(normalized.accounts.a.samples[0], sample(now - 2 * DAY, 0, 0, 0));
  assert.deepEqual(HistoryView.normalizeHistory({ version: 2, startedAt: now, accounts: {} }, now).accounts, {});
  assert.deepEqual(HistoryView.normalizeHistory({ version: 1, accounts: {} }, now).accounts, {});
});

test('summarizes latest values once per identity, not by summing historical samples', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const a = platform('a', 'Primary', 'same-token');
  const duplicate = platform('a-copy', 'Alias', 'same-token');
  const b = platform('b', 'Zero balance', 'different-token', { userId: '13' });
  const idA = identity(a), idB = identity(b);
  const at1 = now - 2 * DAY, at2 = now - DAY;
  const data = history(now - 10 * DAY, {
    a: { identity: idA, samples: [sample(at1, 8, 10, 100), sample(at2, 4, 12, 110)] },
    'a-copy': { identity: idA, samples: [sample(at1 + 1000, 8, 10, 100), sample(at2 + 1000, 4, 12, 110)] },
    b: { identity: idB, samples: [sample(at2, 0, 0, 0)] },
  });
  const model = HistoryView.buildViewModel(data, [a, duplicate, b], { now, days: 7 });
  assert.equal(model.series.length, 2);
  assert.equal(model.series.find((entry) => entry.identity === idA).duplicateConfigs, 1);
  assert.equal(model.latestBalance.value, 4);
  assert.equal(model.latestBalance.known, 2);
  assert.equal(model.used.total, 2);
  assert.equal(model.tokens.total, 10);
  assert.equal(model.balancePoints.at(-1).value, 4);
});

test('keeps zero valid, ignores stale config identities, and labels missing values', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const config = platform('a', 'Zero', 'current-token');
  const oldConfig = platform('a', 'Zero', 'old-token', { userId: '13' });
  const id = identity(config);
  const data = history(now - DAY, {
    a: { identity: id, samples: [sample(now - 1000, 0, 0, 0)] },
    removed: { identity: 'removed', samples: [sample(now - 1000, 90, 90, 90)] },
  });
  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  assert.equal(model.latestBalance.value, 0);
  assert.equal(model.used.total, null, 'a single cumulative sample is not usage');
  assert.equal(model.tokens.total, null, 'a single monthly counter is not token usage');
  const mismatched = HistoryView.collectSeries(data, [oldConfig], { now });
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].samples.length, 0, 'a new identity never inherits the previous identity snapshot');
  const missing = HistoryView.normalizeHistory(history(now - DAY, {
    a: { identity: id, samples: [{ at: now - 1000, balance: null, used: null, monthlyTokens: null, month: null, truncated: false }] },
  }), now);
  assert.equal(missing.accounts.a.samples[0].balance, null);
  assert.equal(HistoryView.formatCurrency(0), '$0.0000');
  assert.equal(HistoryView.formatCurrency(null), '—');
});

test('keeps real same-identity counter changes inside the 60-second duplicate window', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const config = platform('a', 'Account', 'token');
  const id = identity(config);
  const data = history(now - DAY, {
    a: { identity: id, samples: [sample(now - 30_000, 12, 20, 80), sample(now, 11, 25, 85)] },
  });

  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  assert.equal(model.series[0].samples.length, 2, 'nearby snapshots with changed values are not duplicates');
  assert.equal(model.used.total, 5, 'the first sample remains available as the used-counter baseline');
  assert.equal(model.tokens.total, 5);
});

test('merges only identical nearby samples and retains the first comparison baseline', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const config = platform('a', 'Account', 'token');
  const id = identity(config);
  const firstAt = now - 90_000;
  const repeated = sample(firstAt, 12, 20, 80);
  const data = history(now - DAY, {
    a: { identity: id, samples: [repeated, sample(firstAt + 30_000, 12, 20, 80), sample(now, 11, 23, 83)] },
  });

  const series = HistoryView.collectSeries(data, [config], { now });
  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  assert.equal(series[0].samples.length, 2);
  assert.equal(series[0].samples[0].at, firstAt, 'deduplication keeps the earliest identical baseline');
  assert.equal(model.used.total, 3);
});

test('renders a width-matched readable chart, keeps endpoint dates inside, and breaks lines at counter gaps', () => {
  const doc = mockDocument();
  const container = doc.createElement('div');
  container.clientWidth = 390;
  const points = [
    { at: Date.UTC(2026, 9, 1), value: 10 },
    { at: Date.UTC(2026, 9, 3), value: 14, breakBefore: true },
    { at: Date.UTC(2026, 9, 5), value: 18 },
  ];
  HistoryView.renderChart(container, points, '可比较片段', HistoryView.formatNumber, '无可比较数据', {
    axisFormatter: (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value),
    footnote: '仅可比较片段之和，不代表完整区间消耗。',
  });

  const svg = container.children.find((child) => child.tagName === 'svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 390 214');
  const paths = svg.children.filter((child) => child.tagName === 'path');
  assert.equal(paths.length, 2, 'a counter discontinuity starts a new line segment');
  const dateLabels = svg.children.filter((child) => child.tagName === 'text' && child.attributes.class === 'history-axis-label' && child.attributes.y === '204');
  assert.equal(dateLabels[0].getAttribute('text-anchor'), 'start');
  assert.equal(dateLabels.at(-1).getAttribute('text-anchor'), 'end');
  assert.match(container.children.at(-1).textContent, /不代表完整区间消耗/);

  const css = fs.readFileSync(path.join(root, 'history-view.css'), 'utf8');
  assert.match(css, /\.history-axis-label\{[^}]*font-size:11px/);
});

test('uninterrupted counter samples still render as one connected line', () => {
  const doc = mockDocument();
  const container = doc.createElement('div');
  HistoryView.renderChart(container, [
    { at: 1, value: 1 },
    { at: 2, value: 2 },
    { at: 3, value: 3 },
  ], '连续走势', HistoryView.formatNumber, '暂无数据');
  assert.equal(container.children[0].children.filter((child) => child.tagName === 'path').length, 1);
});

test('refreshes local history changes and ignores an older in-flight read', async () => {
  const previousDocument = global.document;
  const previousChrome = global.chrome;
  const doc = mockDocument();
  const reads = [];
  const changeListeners = new Set();
  global.document = doc;
  global.chrome = {
    storage: {
      local: { get: (key, callback) => reads.push({ key, callback }) },
      onChanged: {
        addListener: (listener) => changeListeners.add(listener),
        removeListener: (listener) => changeListeners.delete(listener),
      },
    },
  };

  try {
    const config = platform('a', 'Account', 'token');
    const id = identity(config);
    const now = Date.now();
    const makeHistory = (balance) => history(now - DAY, {
      a: { identity: id, samples: [sample(now - 1000, balance, 1, 1)] },
    });
    HistoryView.open([config]);
    assert.equal(reads.length, 1);
    const listener = [...changeListeners][0];
    listener({ [HistoryView.STORAGE_KEY]: { newValue: makeHistory(2) } }, 'local');
    assert.equal(reads.length, 2, 'a local history write triggers a fresh read');

    reads[1].callback({ [HistoryView.STORAGE_KEY]: makeHistory(2), 'nacheckin.platforms': [config] });
    await new Promise((resolve) => setImmediate(resolve));
    reads[0].callback({ [HistoryView.STORAGE_KEY]: makeHistory(1), 'nacheckin.platforms': [config] });
    await new Promise((resolve) => setImmediate(resolve));
    const summary = doc.body.querySelector('.history-summary');
    assert.match(deepText(summary), /\$2\.0000/);
    assert.doesNotMatch(deepText(summary), /\$1\.0000/);

    HistoryView.close();
    assert.equal(changeListeners.size, 0, 'closing the panel removes its storage listener');
  } finally {
    HistoryView.close();
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('never infers usage from a balance decrease; used is a non-negative cumulative difference', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const config = platform('a', 'Account', 'token');
  const id = identity(config);
  const data = history(now - 5 * DAY, {
    a: { identity: id, samples: [
      sample(now - 3 * DAY, 100, 25, 200),
      sample(now - 2 * DAY, 60, 31, 210),
      sample(now - DAY, 55, 29, 205),
      sample(now - 1000, 50, 35, 215),
    ] },
  });
  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  assert.equal(model.used.total, 12, '6 before reset plus 6 after reset; the negative used reset is a break');
  assert.equal(model.used.breaks, 1);
  assert.equal(model.used.points[1].breakBefore, true, 'the first post-reset delta starts a separate chart segment');
  assert.equal(model.tokens.total, 20, 'token rollback does not create negative usage');
  assert.equal(model.tokens.breaks, 1);
  assert.equal(model.balancePoints.at(-1).value, 50);
});

test('does not calculate Token usage across month boundaries or truncated snapshots', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const config = platform('a', 'Account', 'token');
  const id = identity(config);
  const data = history(now - 5 * DAY, {
    a: { identity: id, samples: [
      sample(now - 3 * DAY, 10, 3, 900, '2026-09'),
      sample(now - 2 * DAY, 9, 4, 2, '2026-10'),
      sample(now - DAY, 8, 5, 20, '2026-10', true),
      sample(now - 1000, 7, 6, 23, '2026-10'),
    ] },
  });
  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  assert.equal(model.tokens.monthBoundaries, 1);
  assert.equal(model.tokens.truncatedComparisons, 2);
  assert.equal(model.tokens.total, null);
});

test('starts a new Token chart segment after a month boundary', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const config = platform('a', 'Account', 'token');
  const id = identity(config);
  const data = history(now - 10 * DAY, {
    a: { identity: id, samples: [
      sample(Date.UTC(2026, 8, 29), 10, 3, 100, '2026-09'),
      sample(Date.UTC(2026, 8, 30), 9, 4, 110, '2026-09'),
      sample(Date.UTC(2026, 9, 1), 8, 5, 2, '2026-10'),
      sample(Date.UTC(2026, 9, 2), 7, 6, 8, '2026-10'),
    ] },
  });

  const model = HistoryView.buildViewModel(data, [config], { now, days: 30 });
  assert.deepEqual(model.tokens.points.map((point) => point.breakBefore), [false, true]);
  assert.equal(model.tokens.total, 16);
});

test('respects the 7/30 day window and makes stale or absent identities explicit', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const recent = platform('recent', 'Recent', 'recent-token');
  const stale = platform('stale', 'Stale', 'stale-token', { userId: '13' });
  const missing = platform('missing', 'No samples', 'missing-token', { userId: '14' });
  const recentId = identity(recent), staleId = identity(stale);
  const data = history(now - 40 * DAY, {
    recent: { identity: recentId, samples: [sample(now - 10 * DAY, 5, 1, 1), sample(now - DAY, 4, 2, 2)] },
    stale: { identity: staleId, samples: [sample(now - 20 * DAY, 3, 4, 5)] },
  });
  const seven = HistoryView.buildViewModel(data, [recent, stale, missing], { now, days: 7 });
  const thirty = HistoryView.buildViewModel(data, [recent, stale, missing], { now, days: 30 });
  assert.equal(seven.inRangeSamples.length, 1);
  assert.equal(thirty.inRangeSamples.length, 3);
  assert.equal(seven.latestBalance.stale, 1);
  assert.equal(seven.balancePoints.at(-1).stale, 1);
  assert.equal(seven.balancePoints.at(-1).missing, 1, 'configured identities with no samples stay visible as missing');
  assert.equal(seven.latestBalance.totalSeries, 3);
  assert.equal(seven.latestBalance.missing, 1);
});

test('read-only chart source has no network API, writes, or task triggers', () => {
  const source = fs.readFileSync(path.join(root, 'history-view.js'), 'utf8');
  assert.match(source, /chrome\.storage\.local/);
  assert.match(source, /storage\.get\(\[STORAGE_KEY, PLATFORMS_KEY\]/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|storage\.local\.set/);
  assert.doesNotMatch(source, /data-action="checkin"|type:\s*["']checkin["']/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('both extension views reference the local stylesheet and have a single bottom chart button', () => {
  for (const file of ['popup.html', 'sidebar.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, new Set(ids).size, `${file} must not contain duplicate ids`);
    assert.match(html, /href="history-view\.css"/);
    assert.match(html, /<footer[^>]*>[\s\S]*id="historyBtn(?:Sidebar)?"/);
  }
});

test('an open chart follows saved account identities and reads fresh configs when reopened', async () => {
  const previousDocument = global.document;
  const previousChrome = global.chrome;
  const doc = mockDocument();
  const changes = new Set();
  const platformKey = 'nacheckin.platforms';
  const old = platform('live', 'Old identity', 'token', { userId: '', account: { userId: '99' } });
  const fresh = { ...old, name: 'Verified account', account: { userId: '12' } };
  const now = Date.now();
  const store = {
    [platformKey]: [old],
    [HistoryView.STORAGE_KEY]: history(now - DAY, {
      live: { identity: identity(fresh), samples: [sample(now - 1, 7, 1, 2)] },
    }),
  };
  global.document = doc;
  global.chrome = { storage: {
    local: { get(keys, callback) {
      callback(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]])));
    } },
    onChanged: { addListener: (fn) => changes.add(fn), removeListener: (fn) => changes.delete(fn) },
  } };
  const flush = () => new Promise(setImmediate);
  try {
    HistoryView.open([old]);
    await flush();
    const period = doc.body.querySelector('.history-controls').children[1].querySelector('select');
    period.value = '7';
    store[platformKey] = [fresh];
    for (const fn of changes) fn({ [platformKey]: { newValue: [fresh] } }, 'local');
    await flush();
    assert.match(deepText(doc.body.querySelector('.history-summary')), /\$7\.0000/);
    const select = doc.body.querySelector('select');
    assert.deepEqual(select.children.map((option) => option.value), ['all', 'site:https://history.example.test', identity(fresh)]);
    assert.match(deepText(select), /Verified account/);
    assert.equal(period.value, '7');
    select.value = identity(fresh);
    for (const fn of changes) fn({ [HistoryView.STORAGE_KEY]: {} }, 'local');
    await flush();
    assert.equal(select.value, identity(fresh), 'a history-only update preserves the selected account');
    HistoryView.close();
    HistoryView.open([old]);
    await flush();
    assert.match(deepText(doc.body.querySelector('.history-summary')), /\$7\.0000/,
      'opening the panel reads the saved configs, not only the caller snapshot');
    store[platformKey] = [];
    for (const fn of changes) fn({ [platformKey]: { newValue: [] } }, 'local');
    await flush();
    assert.doesNotMatch(deepText(doc.body.querySelector('.history-summary')), /\$7\.0000/);
    assert.deepEqual(doc.body.querySelector('select').children.map((option) => option.value), ['all']);
  } finally {
    HistoryView.close();
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
    if (previousChrome === undefined) delete global.chrome; else global.chrome = previousChrome;
  }
});

test('groups daily totals by canonical website and takes each identity only once', () => {
  const now = localTime(29, 18);
  const a = platform('a', 'Account A', 'token-a');
  const alias = platform('alias', 'Alias A', 'token-a', { baseUrl: 'https://HISTORY.example.test:443/' });
  const b = platform('b', 'Account B', 'token-b', { userId: '13' });
  const other = platform('other', 'Other deployment', 'token-c', { baseUrl: 'https://history.example.test/deploy/' });
  const data = history(localTime(20), {
    a: { identity: identity(a), samples: [sample(localTime(28, 9), 8, 1, 10), sample(localTime(28, 16), 10, 2, 20)] },
    alias: { identity: identity(alias), samples: [sample(localTime(28, 16) + 1000, 10, 2, 20)] },
    b: { identity: identity(b), samples: [sample(localTime(28, 10), 4, 3, 30)] },
    other: { identity: identity(other), samples: [sample(localTime(28, 10), 90, 4, 40)] },
  });
  const model = HistoryView.buildViewModel(data, [a, alias, b, other], { now, days: 7 });
  assert.equal(model.bySite, true);
  assert.equal(model.sites.length, 2, 'deployment paths remain separate websites');
  assert.equal(model.charts.balance.length, 2);
  const site = model.charts.balance.find((entry) => entry.key === 'https://history.example.test');
  assert.equal(site.accountCount, 2, 'aliases of one verified identity are not additional accounts');
  assert.equal(site.points.at(-2).value, 14, 'uses the last read of each account, not the sum of its samples');
  assert.equal(site.points.at(-2).missing, 0);
  assert.equal(site.points.at(-1).value, 14);
  assert.equal(site.points.at(-1).uncollected, 2, 'yesterday\'s known total is not today\'s collection');
  assert.equal(model.charts.balance[1].points.at(-2).value, 90);
});

test('drilling into a website exposes separate account curves and scopes all summaries', () => {
  const now = localTime(29, 18);
  const a = platform('a', 'Account A', 'token-a');
  const b = platform('b', 'Account B', 'token-b', { userId: '13' });
  const c = platform('c', 'Other site', 'token-c', { baseUrl: 'https://other.example.test' });
  const data = history(localTime(20), Object.fromEntries([a, b, c].map((config, index) => [config.id, {
    identity: identity(config), samples: [sample(localTime(28), 10 + index, index, 10), sample(localTime(29), 12 + index, index + 2, 15)],
  }])));
  const model = HistoryView.buildViewModel(data, [a, b, c], { now, days: 7, site: a.baseUrl });
  assert.equal(model.bySite, false);
  assert.equal(model.selectedSite, a.baseUrl);
  assert.deepEqual(model.charts.balance.map((entry) => entry.key), [identity(a), identity(b)]);
  assert.ok(model.charts.balance.every((entry) => entry.kind === 'account'));
  assert.equal(model.latestBalance.value, 25);
  assert.equal(model.used.total, 4);
  assert.equal(model.tokens.total, 10);
  assert.ok(model.inRangeSamples.every(({ account }) => account.siteKey === a.baseUrl));
  const account = HistoryView.buildViewModel(data, [a, b, c], { now, days: 7, identity: identity(b) });
  assert.equal(account.charts.balance.length, 1);
  assert.equal(account.latestBalance.value, 13);
});

test('marks missing calendar days independently of snapshot age and keeps a real zero valid', () => {
  const now = localTime(29, 18);
  const a = platform('a', 'Account A', 'token-a');
  const b = platform('b', 'Account B', 'token-b', { userId: '13' });
  const data = history(localTime(20), {
    a: { identity: identity(a), samples: [
      sample(localTime(24), 10, 2, 100), sample(localTime(26), 0, 3, 110),
      sample(localTime(27), 5, 4, 120), sample(localTime(28), 6, 5, 130),
    ] },
    b: { identity: identity(b), samples: Array.from({ length: 7 }, (_, index) => sample(localTime(23 + index, 11), 19 + index, index, index * 10)) },
  });
  const model = HistoryView.buildViewModel(data, [a, b], { now, days: 7, site: a.baseUrl });
  const points = model.charts.balance.find((entry) => entry.key === identity(a)).points;
  assert.equal(points[0].value, null, 'no earlier snapshot is invented from future observations');
  assert.equal(points[0].missing, 1);
  assert.equal(points[2].at, localTime(25, 0));
  assert.equal(points[2].value, 10, 'the last confirmed value only locates the missing marker');
  assert.equal(points[2].observed, false);
  assert.equal(points[2].missing, 1);
  assert.equal(points[3].value, 0);
  assert.equal(points[3].missing, 0, 'zero is a real collection, not an absent value');
  assert.equal(points.at(-1).missing, 1);
  assert.equal(points.at(-1).stale, 0, 'a sample less than 36 hours old can still miss today');
  const overview = HistoryView.buildViewModel(data, [a, b], { now, days: 7 });
  const today = overview.charts.balance[0].points.at(-1);
  assert.equal(today.value, 31);
  assert.equal(today.known, 2);
  assert.equal(today.missing, 1);
  assert.deepEqual(today.missingLabels, ['Account A']);
});

test('retains raw observation dates when identical reads straddle midnight', () => {
  const now = localTime(29, 0, 0, 20);
  const config = platform('a', 'Account', 'token');
  const data = history(localTime(27), {
    a: { identity: identity(config), samples: [
      sample(localTime(28, 23, 59, 50), 7, 2, 3), sample(localTime(29, 0, 0, 10), 7, 2, 3),
      sample(now + 1000, 999, 999, 999),
    ] },
  });
  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  assert.equal(model.series[0].samples.length, 2, 'cross-midnight observations retain a comparable zero delta');
  assert.equal(model.series[0].observations.length, 2);
  const points = model.charts.balance[0].points;
  assert.equal(points.at(-2).missing, 0);
  assert.equal(points.at(-1).missing, 0, 'today\'s real same-value read is not lost');
  assert.equal(points.at(-1).value, 7, 'future readings never participate');
  assert.equal(model.used.total, 0);
  assert.equal(model.tokens.total, 0);
  assert.equal(model.charts.used[0].points.at(-1).missing, 0);
  assert.equal(model.charts.tokens[0].points.at(-1).missing, 0);
});

test('a real same-value observation at the calendar window start remains visible', () => {
  const now = localTime(29, 18);
  const config = platform('a', 'Account', 'token');
  const data = history(localTime(1), {
    a: { identity: identity(config), samples: [
      sample(localTime(22, 23, 59, 50), 7, 100, 100), sample(localTime(23, 0, 0, 10), 7, 100, 100),
    ] },
  });
  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  assert.equal(model.hasInRangeSamples, true);
  assert.equal(model.inRangeSamples.length, 1);
  assert.equal(model.charts.balance[0].points[0].observed, true);
  assert.equal(model.charts.balance[0].points[0].missing, 0);
  const doc = mockDocument();
  const container = doc.createElement('div');
  HistoryView.renderChart(container, [], '额度总和', HistoryView.formatCurrency, '暂无数据', { series: model.charts.balance });
  assert.equal(descendants(container, (node) => node.tagName === 'circle').length, 7);
});

test('same-value reads across midnight preserve zero Used and Token changes after an earlier increase', () => {
  const now = localTime(29, 0, 0, 20);
  const config = platform('a', 'Account', 'token');
  const data = history(localTime(20), {
    a: { identity: identity(config), samples: [
      sample(localTime(28), 7, 90, 90), sample(localTime(28, 23, 59, 50), 7, 100, 100),
      sample(localTime(29, 0, 0, 10), 7, 100, 100),
    ] },
  });
  const model = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  for (const metric of ['used', 'tokens']) {
    assert.equal(model[metric].total, 10);
    assert.equal(model[metric].points.at(-1).value, 0);
    assert.equal(model.charts[metric][0].points.at(-1).value, 10);
    assert.equal(model.charts[metric][0].points.at(-1).observed, true);
    assert.equal(model.charts[metric][0].points.at(-1).missing, 0);
  }
});

test('uses exactly 7 or 30 local calendar days, including today and excluding the prior day', () => {
  const now = localTime(29, 18);
  const config = platform('a', 'Account', 'token');
  const data = history(localTime(1), {
    a: { identity: identity(config), samples: [sample(localTime(22, 23, 59, 59), 10, 1, 1), sample(localTime(23, 0), 11, 2, 2)] },
  });
  const seven = HistoryView.buildViewModel(data, [config], { now, days: 7 });
  const thirty = HistoryView.buildViewModel(data, [config], { now, days: 30 });
  assert.equal(seven.dates.length, 7);
  assert.equal(thirty.dates.length, 30);
  assert.equal(seven.start, localTime(23, 0));
  assert.equal(seven.dates.at(-1), localTime(29, 0));
  assert.equal(seven.inRangeSamples.length, 1);
  assert.ok(thirty.dates.every((at) => new Date(at).getHours() === 0));
});

test('keeps unknown fields and entirely uncollected accounts explicit instead of using cached balances', () => {
  const now = localTime(29, 18);
  const unknown = platform('a', 'Unknown balance', 'token', { account: { available: 500000000 } });
  const absent = platform('b', 'No samples', 'token-b', { userId: '13' });
  const data = history(localTime(20), {
    a: { identity: identity(unknown), samples: [sample(localTime(29), null, null, null)] },
  });
  const model = HistoryView.buildViewModel(data, [unknown, absent], { now, days: 7, site: unknown.baseUrl });
  assert.equal(model.latestBalance.value, null);
  assert.ok(model.charts.balance[0].points.every((point) => point.value === null));
  assert.equal(model.charts.balance[0].points.at(-1).observed, true);
  assert.equal(model.charts.balance[0].points.at(-1).missing, 1);
  assert.ok(model.charts.balance[1].points.every((point) => point.uncollected === 1 && point.value === null));
});

test('renders missing markers and both adjacent edges gray and dashed, then restores a normal line', () => {
  const doc = mockDocument();
  const container = doc.createElement('div');
  const selected = [];
  const points = [
    { at: localTime(24, 0), value: 10, missing: 0 },
    { at: localTime(25, 0), value: 10, missing: 1, status: '当日未采集' },
    { at: localTime(26, 0), value: 0, missing: 0 },
    { at: localTime(27, 0), value: 5, missing: 0 },
  ];
  HistoryView.renderChart(container, [], '账号额度', HistoryView.formatCurrency, '暂无数据', {
    series: [
      { key: 'a', label: 'Account A', kind: 'account', color: '#10b981', points },
      { key: 'b', label: 'Account B', kind: 'account', color: '#38bdf8', points: points.map((point) => ({ at: point.at, value: null, missing: 1, uncollected: 1, status: '当日未采集' })) },
    ],
    onSelect: (series, point) => selected.push([series.key, point && point.at]),
  });
  const svg = container.children.find((node) => node.tagName === 'svg');
  const paths = svg.children.filter((node) => node.tagName === 'path' && node.getAttribute('data-series') === 'a');
  const dashed = paths.find((node) => hasClass(node, 'history-chart-line-missing'));
  const normal = paths.find((node) => !hasClass(node, 'history-chart-line-missing'));
  assert.equal((dashed.getAttribute('d').match(/L/g) || []).length, 2, 'the entering and exiting edges both belong to the dashed segment');
  assert.equal((normal.getAttribute('d').match(/L/g) || []).length, 1, 'two consecutive real days reconnect normally');
  const dots = svg.children.filter((node) => node.tagName === 'circle' && node.getAttribute('data-series') === 'a');
  assert.equal(hasClass(dots[1], 'history-chart-dot-missing'), true);
  assert.equal(hasClass(dots[2], 'history-chart-dot-missing'), false, 'real zero does not get a gray marker');
  assert.match(deepText(dots[1]), /当日未采集/);
  assert.match(deepText(dots[1]), /仅作位置参考/);
  const absentDots = svg.children.filter((node) => node.tagName === 'circle' && node.getAttribute('data-series') === 'b');
  assert.equal(absentDots.length, 4, 'accounts with no readings still have gray markers in the no-data lane');
  assert.ok(absentDots.every((node) => hasClass(node, 'history-chart-dot-missing')));
  assert.match(deepText(absentDots[0]), /—/);
  assert.ok(svg.children.some((node) => node.textContent === '无数据'));
  dots[1].listeners.click[0]();
  dots[2].listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(selected, [['a', points[1].at], ['a', points[2].at]]);
  const css = fs.readFileSync(path.join(root, 'history-view.css'), 'utf8');
  assert.match(css, /\.history-chart-line-missing\{[^}]*stroke:var\(--history-missing-color\);stroke-dasharray:5 5/);
  assert.match(css, /\.history-chart-dot-missing\{[^}]*fill:var\(--history-missing-color\);stroke:var\(--history-missing-color\)/);
});

test('an entirely unknown daily curve renders gray markers without a numeric zero axis', () => {
  const doc = mockDocument();
  const container = doc.createElement('div');
  HistoryView.renderChart(container, [], '账号额度', HistoryView.formatCurrency, '尚无真实样本', {
    series: [{ key: 'empty', label: 'No samples', kind: 'account', points: [24, 25].map((day) => ({
      at: localTime(day, 0), value: null, missing: 1, uncollected: 1, status: '当日未采集',
    })) }],
  });
  const dots = descendants(container, (node) => node.tagName === 'circle');
  assert.equal(dots.length, 2);
  assert.ok(dots.every((node) => hasClass(node, 'history-chart-dot-missing')));
  assert.equal(descendants(container, (node) => hasClass(node, 'history-chart-line-missing')).length, 1);
  assert.equal(descendants(container, (node) => hasClass(node, 'history-grid-line')).length, 0);
  assert.doesNotMatch(deepText(container), /\$0\.0000/);
});

test('selecting an account with no history keeps its gray calendar curve in the empty-state panel', async () => {
  const previousDocument = global.document;
  const previousChrome = global.chrome;
  const doc = mockDocument();
  const config = platform('empty', 'No samples', 'token');
  const now = Date.now();
  global.document = doc;
  global.chrome = { storage: { local: { get(_keys, callback) {
    callback({ 'nacheckin.platforms': [config], [HistoryView.STORAGE_KEY]: history(now - DAY, {}) });
  } } } };
  const flush = () => new Promise(setImmediate);
  try {
    HistoryView.open([config]);
    await flush();
    const select = doc.body.querySelector('select');
    select.value = identity(config);
    select.listeners.change[0]();
    await flush();
    const period = doc.body.querySelector('.history-controls').children[1].querySelector('select');
    period.value = '7';
    period.listeners.change[0]();
    await flush();
    const chart = doc.body.querySelector('.history-chart-container');
    assert.equal(descendants(chart, (node) => node.tagName === 'circle').length, 7);
    assert.ok(descendants(chart, (node) => node.tagName === 'circle').every((node) => hasClass(node, 'history-chart-dot-missing')));
    assert.equal(doc.body.querySelector('.history-summary').children.length, 0, 'missing data never invents a zero balance');
    assert.match(deepText(doc.body.querySelector('.history-coverage')), /尚无真实历史样本/);
  } finally {
    HistoryView.close();
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
    if (previousChrome === undefined) delete global.chrome; else global.chrome = previousChrome;
  }
});

test('website legends and points drill into accounts, return to overview, and follow local configuration changes', async () => {
  const previousDocument = global.document;
  const previousChrome = global.chrome;
  const doc = mockDocument();
  const changes = new Set();
  const a = platform('a', 'Account A', 'token-a');
  const b = platform('b', 'Account B', 'token-b', { userId: '13' });
  const c = platform('c', 'Other site', 'token-c', { baseUrl: 'https://other.example.test' });
  const now = Date.now();
  const store = {
    'nacheckin.platforms': [a, b, c],
    [HistoryView.STORAGE_KEY]: history(now - 3 * DAY, Object.fromEntries([a, b, c].map((config, index) => [config.id, {
      identity: identity(config), samples: [sample(now - DAY, index + 4, 1, 1), sample(now - 1000, index + 5, 2, 2)],
    }]))),
  };
  global.document = doc;
  global.chrome = { storage: {
    local: { get(keys, callback) { callback(Object.fromEntries(keys.map((key) => [key, store[key]]))); } },
    onChanged: { addListener: (fn) => changes.add(fn), removeListener: (fn) => changes.delete(fn) },
  } };
  const flush = () => new Promise(setImmediate);
  const legends = () => doc.body.querySelector('.history-chart-legend').children;
  const select = () => doc.body.querySelector('select');
  try {
    HistoryView.open([a, b, c]);
    await flush();
    assert.deepEqual(legends().map((node) => node.getAttribute('data-series')), [a.baseUrl, c.baseUrl]);
    const period = doc.body.querySelector('.history-controls').children[1].querySelector('select');
    period.value = '7';
    period.listeners.change[0]();
    await flush();
    legends()[0].listeners.click[0]();
    await flush();
    assert.equal(select().value, 'site:' + a.baseUrl);
    assert.deepEqual(legends().map((node) => node.getAttribute('data-series')), [identity(a), identity(b)]);
    assert.match(deepText(doc.body.querySelector('.history-summary')), /\$11\.0000/);
    assert.doesNotMatch(deepText(doc.body.querySelector('.history-table')), /Other site/);
    const back = doc.body.querySelector('.history-back');
    assert.equal(back.hidden, false);
    assert.equal(doc.activeElement, back, 'drilldown keeps keyboard focus on a stable control inside the panel');
    back.listeners.click[0]();
    await flush();
    assert.equal(select().value, 'all');
    assert.equal(back.hidden, true);
    assert.equal(doc.activeElement, select(), 'returning does not leave focus on the now-hidden back button');
    assert.equal(period.value, '7');
    const point = descendants(doc.body.querySelector('.history-chart-container'), (node) => node.tagName === 'circle' && node.getAttribute('data-series') === a.baseUrl)[0];
    point.listeners.click[0]();
    await flush();
    assert.equal(select().value, 'site:' + a.baseUrl, 'a website data point uses the same drilldown as its legend');
    store['nacheckin.platforms'] = [a, c];
    for (const listener of changes) listener({ 'nacheckin.platforms': {} }, 'local');
    await flush();
    assert.equal(select().value, 'site:' + a.baseUrl);
    assert.deepEqual(legends().map((node) => node.getAttribute('data-series')), [identity(a)]);
    store['nacheckin.platforms'] = [c];
    for (const listener of changes) listener({ 'nacheckin.platforms': {} }, 'local');
    await flush();
    assert.equal(select().value, 'all', 'removing the selected website returns to the remaining overview');
    assert.equal(period.value, '7');
    assert.deepEqual(legends().map((node) => node.getAttribute('data-series')), [c.baseUrl]);
  } finally {
    HistoryView.close();
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
    if (previousChrome === undefined) delete global.chrome; else global.chrome = previousChrome;
  }
});
