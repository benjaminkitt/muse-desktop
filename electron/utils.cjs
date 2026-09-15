const fs = require("node:fs");
const path = require("node:path");

const META_REDIRECT_HOSTS = new Set([
  "www.facebook.com",
  "www.instagram.com",
  "auth.meta.com",
]);

function isTrustedNavigation(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.hostname === "muse.ai" || url.hostname.endsWith(".muse.ai"))
    return true;
  return (
    META_REDIRECT_HOSTS.has(url.hostname) && url.pathname.startsWith("/aymh/")
  );
}

function isAllowedExternalUrl(rawUrl) {
  try {
    return ["https:", "http:"].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function isMuseOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin === "https://muse.ai";
  } catch {
    return false;
  }
}

// Reserve the destination atomically, including against other processes.
function uniqueDownloadPath(downloadsDir, filename) {
  const safeName = path.basename(filename) || "muse-download";
  const parsed = path.parse(safeName);
  let candidate = path.join(downloadsDir, safeName);
  let suffix = 1;

  for (;;) {
    try {
      const fd = fs.openSync(candidate, "wx", 0o600);
      fs.closeSync(fd);
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      candidate = path.join(
        downloadsDir,
        `${parsed.name} (${suffix})${parsed.ext}`,
      );
      suffix += 1;
    }
  }
}

module.exports = {
  isTrustedNavigation,
  isAllowedExternalUrl,
  isMuseOrigin,
  uniqueDownloadPath,
};
