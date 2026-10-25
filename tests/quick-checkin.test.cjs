// Regression tests for collapsed account-row shortcuts; never executes a real check-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const previewStart = source.indexOf('function renderAccountPreview(p) {');
const groupStart = source.indexOf('function renderAccountGroup(group, index) {', previewStart);
const groupEnd = source.indexOf('\nfunction toggleAccountGroup(key) {', groupStart);
assert.notEqual(previewStart, -1, 'account preview renderer should exist');
assert.notEqual(groupStart, -1, 'account group renderer should exist');
assert.notEqual(groupEnd, -1, 'account group renderer boundary should exist');
const rendererSource = source.slice(previewStart, groupStart) + source.slice(groupStart, groupEnd);

function testContext(overrides = {}) {
  const context = {
    URL,
    expandedAccountGroups: new Set(),
    startingCheckins: new Map(),
    activeCheckins: new Map(),
    cancelledCheckins: new Map(),
    currentVisitProgress: () => '',
    isVisitOnly: (p) => p.visitOnly === true,
    status: () => ['就绪', 'badge-success'],
    accountGroupSummary: () => ({ total: 0, known: 1, unknown: 0, duplicates: 0 }),
    accountIdentity: (p) => `用户 ID ${p.userId || 'unknown'}`,
    accountUpdatedLabel: () => '余额更新时间未知',
    quotaUnitFor: () => 1,
    formatQuota: (value) => value === 0 ? '$0.0000' : `$${Number(value).toFixed(4)}`,
    renderPlatformCard: () => '<article class="platform-card"></article>',
    esc(value = '') { return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`); },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(`${rendererSource}\nthis.renderAccountPreview = renderAccountPreview; this.renderAccountGroup = renderAccountGroup;`, context);
  return context;
}

function collapsedHtml(account, overrides) {
  const context = testContext(overrides);
  return context.renderAccountGroup({ key: 'https://site.example.test', accounts: [account, { ...account, id: `${account.id}-second`, name: 'Second' }] }, 0);
}

test('collapsed rows place a separate quick check-in button beside each balance', () => {
  const html = collapsedHtml({ id: 'account-1', name: 'Primary', userId: '12', account: { available: 0 } });
  assert.equal((html.match(/data-action="checkin"/g) || []).length, 2);
  assert.match(html, /class="[^"]*account-preview-checkin" data-action="checkin" data-id="account-1"/);
  assert.match(html, /<span class="account-preview-amount">\$0\.0000<\/span>/);
  const toggleEnd = html.indexOf('</button>');
  const previewButton = html.indexOf('account-preview-checkin');
  assert.ok(toggleEnd >= 0 && previewButton > toggleEnd, 'quick action is outside the group toggle button');
});

test('visit-only accounts say Visit and use the same task action; busy accounts disable the shortcut', () => {
  const visitHtml = collapsedHtml({ id: 'visit-account', name: 'Visit only', visitOnly: true, account: { available: 1 } });
  assert.match(visitHtml, /aria-label="访问：Visit only"/);
  assert.match(visitHtml, /data-action="checkin" data-id="visit-account"[^>]*>访问<\/button>/);
  const busyHtml = collapsedHtml({ id: 'busy-account', name: 'Busy', account: { available: 2 } }, {
    startingCheckins: new Map([['busy-account', {}]]),
  });
  assert.match(busyHtml, /data-id="busy-account"[^>]* disabled>签到中…<\/button>/);
});

test('account labels and IDs are escaped, and the click remains routed through checkin(id)', () => {
  const html = collapsedHtml({ id: 'x"><img src=x>', name: '<img src=x onerror=1>', account: { available: 2 } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-id="x&#34;&#62;&#60;img src=x&#62;"/);
  assert.match(html, /快捷签到：&#60;img src=x onerror=1&#62;/);
  assert.match(source, /else if \(action === "checkin"\) checkin\(id\);/);
  assert.doesNotMatch(source, /function quickCheckin|data-action="quick-checkin"/);
});
