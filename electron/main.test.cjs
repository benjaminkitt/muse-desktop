const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isTrustedNavigation, uniqueDownloadPath } = require('./utils.cjs');

test('permits Muse and its narrowly scoped Meta sign-in redirects', () => {
  assert.equal(isTrustedNavigation('https://muse.ai/chat'), true);
  assert.equal(isTrustedNavigation('https://auth.muse.ai/aymh/'), true);
  assert.equal(isTrustedNavigation('https://www.facebook.com/aymh/redirect-cycle'), true);
  assert.equal(isTrustedNavigation('https://www.instagram.com/aymh/redirect-cycle'), true);
  assert.equal(isTrustedNavigation('https://auth.meta.com/aymh/redirect-cycle'), true);
  assert.equal(isTrustedNavigation('https://www.facebook.com/settings'), false);
  assert.equal(isTrustedNavigation('https://muse.ai.evil.example'), false);
  assert.equal(isTrustedNavigation('http://muse.ai'), false);
});

test('makes a safe non-overwriting download name', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-download-'));
  try {
    fs.writeFileSync(path.join(directory, 'report.pdf'), 'existing');
    assert.equal(uniqueDownloadPath(directory, '../../report.pdf'), path.join(directory, 'report (1).pdf'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
