// Packaging contract for Linux desktop integration (GNOME, KDE, and other
// freedesktop shells). The icon and the desktop entry must agree on one
// identity basename, and both packaging paths (electron-builder Linux targets
// and the Nix flake) must install icons in standard hicolor theme locations.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const flake = fs.readFileSync(path.join(repoRoot, "flake.nix"), "utf8");
const mainProcess = fs.readFileSync(
  path.join(repoRoot, "electron", "main.cjs"),
  "utf8",
);

// The single identity every packaging surface must agree on.
const desktopBaseName = packageJson.desktopName.replace(/\.desktop$/, "");
const iconSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];

function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.ok(
    buf.length > 24 &&
      buf
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `${file} is not a PNG`,
  );
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("declares one Linux desktop identity in package.json", () => {
  assert.equal(desktopBaseName, "muse-desktop");
  assert.equal(packageJson.build.linux.syncDesktopName, true);
  // A single icon.png installs only one hicolor size; Linux targets need the
  // multi-size icon set directory.
  assert.equal(packageJson.build.linux.icon, "build/icons");
});

test("ships a multi-size icon set with sizes that match their file names", () => {
  const { width, height } = pngSize(path.join(repoRoot, "build", "icon.png"));
  assert.deepEqual([width, height], [1024, 1024]);
  for (const size of iconSizes) {
    const file = path.join(repoRoot, "build", "icons", `${size}x${size}.png`);
    const dimensions = pngSize(file);
    assert.deepEqual(
      [dimensions.width, dimensions.height],
      [size, size],
      `${path.relative(repoRoot, file)} must be ${size}x${size}`,
    );
  }
});

test("keeps the packaged desktop name and hicolor icons in the Nix flake", () => {
  assert.match(flake, new RegExp(`name = "${desktopBaseName}";`));
  assert.match(flake, new RegExp(`icon = "${desktopBaseName}";`));
  assert.match(
    flake,
    new RegExp(`startupWMClass = "${desktopBaseName}";`),
    "the desktop entry needs StartupWMClass matching the runtime desktop name",
  );
  assert.match(
    flake,
    /share\/icons\/hicolor\/\$size\/apps\/muse-desktop\.png/,
    "each build/icons size must install into its hicolor size directory",
  );
  assert.match(
    flake,
    /share\/icons\/hicolor\/scalable\/apps\/muse-desktop\.svg/,
    "the scalable SVG must install into hicolor scalable",
  );
  assert.match(
    flake,
    /hasPrefix "build\/icons"/,
    "the Nix source filter must keep the icon set directory",
  );
  assert.match(flake, /"build\/icon\.svg"/);
});

test("sets the runtime desktop name that desktop shells match against", () => {
  assert.match(
    mainProcess,
    new RegExp(`app\\.setDesktopName\\("${desktopBaseName}\\.desktop"\\)`),
    "electron/main.cjs must set the desktop name to the packaged .desktop file",
  );
});
