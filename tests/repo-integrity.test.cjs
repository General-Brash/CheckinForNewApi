const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function assertLocalFile(relativePath, source) {
  assert.equal(typeof relativePath, 'string', `${source} must be a local path`);
  assert.ok(relativePath.length > 0, `${source} must not be empty`);
  assert.ok(
    fs.existsSync(path.resolve(root, relativePath)),
    `${source} references missing file: ${relativePath}`,
  );
}

test('Manifest V3 entry points and icons exist', () => {
  assert.equal(manifest.manifest_version, 3);
  assertLocalFile(manifest.background?.service_worker, 'background.service_worker');
  assertLocalFile(manifest.side_panel?.default_path, 'side_panel.default_path');
  assertLocalFile(manifest.options_ui?.page, 'options_ui.page');

  for (const [size, file] of Object.entries(manifest.icons ?? {})) {
    assertLocalFile(file, `icons[${size}]`);
  }
  for (const [size, file] of Object.entries(manifest.action?.default_icon ?? {})) {
    assertLocalFile(file, `action.default_icon[${size}]`);
  }
});

test('Popup and sidebar local HTML assets exist', () => {
  for (const page of ['popup.html', 'sidebar.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
      const asset = match[1].trim();
      if (!asset || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(asset)) continue;
      assertLocalFile(asset.split(/[?#]/, 1)[0], `${page} asset`);
    }
  }
});

test('Git excludes private configuration and browser data without excluding public source', {
  skip: !fs.existsSync(path.join(root, '.git')),
}, () => {
  const privateFiles = [
    '.env', '.env.production', 'local.key', 'local.p12', 'local.pfx',
    'settings.local.json', 'settings.private.yaml', 'settings.secret.toml',
    '.config/settings.json', '.local/accounts.json', 'config/accounts.json',
    'configs/accounts.yaml', 'private/accounts.json', 'secrets/token.txt',
    'exports/accounts.json', 'backups/accounts.json',
    'config.json', 'config.production.json', 'config.yaml', 'config.yml', 'config.toml', 'config.ini',
    'credentials.json', 'credentials.yaml', 'credentials.yml',
    'secrets.json', 'secrets.yaml', 'secrets.yml',
    'newapi-checkin-config.json', 'newapi-checkin-config (1).json',
    'newapi-checkin-config-2026-11-05.json', 'backups/newapi-checkin-config.json',
    'nacheckin.platforms.json', 'nacheckin.accountHistory.json',
    '.playwright-cli/page-private.yml', '.playwright/session.json', 'playwright/.auth/user.json',
    'output/playwright/account.png', 'screenshots/account.png', 'artifacts/page.yml',
    'browser-profile/Preferences', 'user-data/Default/Cookies',
    'storage-state.json', 'storage-state.local.json', 'storageState.json', 'auth.json',
    'cookies.json', 'cookies.txt', 'network.har', 'debug.log',
  ];
  const publicFiles = [
    '.env.example', 'auth-config.js', 'manifest.json', '.github/workflows/ci.yml',
    'account-history.js', 'history-view.js', 'popup.js', 'popup.html', 'sidebar.html',
    'icons/icon128.png', 'tests/repo-integrity.test.cjs',
  ];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
    cwd: root,
    input: [...privateFiles, ...publicFiles].join('\0') + '\0',
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  assert.deepEqual(ignored, privateFiles, 'private files must be ignored and required source must stay publishable');

  const trackedPrivateFiles = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  assert.deepEqual(trackedPrivateFiles, [], 'ignored private files must also be removed from the Git index');
});
