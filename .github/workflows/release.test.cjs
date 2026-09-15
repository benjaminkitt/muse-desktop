const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const workflow = fs.readFileSync(path.join(__dirname, "release.yml"), "utf8");
const allocation = workflow
  .match(/ {8}run: \|\n( {10}set -euo pipefail[\s\S]*?)\n\n {2}build:/)[1]
  .replace(/^ {10}/gm, "");

test("every release action is pinned to a full SHA with a version annotation", () => {
  const actions = workflow.split("\n").filter((line) => line.includes("uses:"));
  assert.equal(actions.length, 6);
  for (const line of actions)
    assert.match(line, /@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
});

function resume(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-release-test-"));
  try {
    // Mock only external boundaries; execute the workflow's actual allocation shell.
    const mocks = {
      git: `#!/usr/bin/env bash
set -eu
case "$1" in
  rev-parse) test "$MISSING" = 0; echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  merge-base) test "$UNRELATED" = 0 ;;
  show) printf '{"version":"%s"}' "$VERSION" ;;
  *) echo "Unexpected git mutation: $*" >&2; exit 90 ;;
esac
`,
      gh: `#!/usr/bin/env bash
set -eu
test "$API_FAIL" = 0
printf '%s' "$PUBLISHED"
`,
      npm: '#!/usr/bin/env bash\necho "Unexpected npm mutation" >&2\nexit 91\n',
    };
    for (const [name, content] of Object.entries(mocks)) {
      fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
    }
    const output = path.join(dir, "output");
    const result = spawnSync("bash", ["-c", allocation], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        RESUME_TAG: "v0.2.1",
        BUMP: "major",
        DEFAULT_BRANCH: "main",
        GH_REPO: "owner/repo",
        VERSION: "0.2.1",
        MISSING: "0",
        UNRELATED: "0",
        API_FAIL: "0",
        PUBLISHED: "",
        ...overrides,
      },
    });
    return {
      ...result,
      output: fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("resume keeps the exact tag and SHA without npm version, commit, tag, or push", () => {
  const result = resume();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.output,
    "tag=v0.2.1\nsha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
  );
});

for (const [name, env] of Object.entries({
  "invalid tag": { RESUME_TAG: "v0.2.1;echo unsafe" },
  "missing tag": { MISSING: "1" },
  "tag outside default branch history": { UNRELATED: "1" },
  "version mismatch": { VERSION: "0.2.2" },
  "already published release": { PUBLISHED: "v0.2.1" },
  "GitHub API failure": { API_FAIL: "1" },
})) {
  test(`resume rejects ${name} without allocating a version`, () => {
    const result = resume(env);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, "");
    assert.doesNotMatch(result.stderr, /Unexpected/);
  });
}
