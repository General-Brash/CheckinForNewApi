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

    reads[1].callback({ [reads[1].key]: makeHistory(2) });
    await new Promise((resolve) => setImmediate(resolve));
    reads[0].callback({ [reads[0].key]: makeHistory(1) });
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
  assert.match(source, /storage\.get\(STORAGE_KEY/);
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
