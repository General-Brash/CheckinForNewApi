const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
