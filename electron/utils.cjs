const fs = require('node:fs');
const path = require('node:path');

const META_REDIRECT_HOSTS = new Set([
  'www.facebook.com',
  'www.instagram.com',
  'auth.meta.com',
]);

function isTrustedNavigation(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'muse.ai' || url.hostname.endsWith('.muse.ai')) return true;
  return META_REDIRECT_HOSTS.has(url.hostname) && url.pathname.startsWith('/aymh/');
}

function uniqueDownloadPath(downloadsDir, filename) {
  const safeName = path.basename(filename) || 'muse-download';
  const parsed = path.parse(safeName);
  let candidate = path.join(downloadsDir, safeName);
  let suffix = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(downloadsDir, `${parsed.name} (${suffix})${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

module.exports = { isTrustedNavigation, uniqueDownloadPath };
