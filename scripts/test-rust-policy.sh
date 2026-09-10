#!/usr/bin/env bash
# test-rust-policy.sh — compile ONLY the policy module + its unit tests without
# pulling the full Tauri dependency tree (no network, no webview deps).
# It stubs the `url` crate's tiny surface used by policy.rs.
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/out"
cp src-tauri/src/policy.rs "$work/policy_under_test.rs"
# Minimal `url` stub: policy.rs only uses Url::parse, .scheme(), .host_str().
mkdir -p "$work/stub"
cat >"$work/stub/url.rs" <<'RS'
// Minimal stub of the `url` crate surface used by policy.rs (offline testing only).
#[derive(Debug, Clone)]
pub struct Url { scheme: String, host: String }
#[derive(Debug)]
pub struct ParseError;
impl std::fmt::Display for ParseError { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "parse error") } }
impl Url {
  pub fn parse(input: &str) -> Result<Url, ParseError> {
    let (scheme, rest) = input.split_once("://").ok_or(ParseError)?;
    let scheme = scheme.to_lowercase();
    if scheme.is_empty() || rest.is_empty() { return Err(ParseError); }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").to_lowercase();
    if host.is_empty() || host.contains(' ') || host.contains(':') && !host.starts_with('[') { /* keep simple */ }
    Ok(Url { scheme, host })
  }
  pub fn scheme(&self) -> &str { &self.scheme }
  pub fn host_str(&self) -> Option<&str> { Some(&self.host) }
}
RS
cat >"$work/runner.rs" <<'RS'
#[path = "stub/url.rs"]
mod url;
#[path = "policy_under_test.rs"]
mod policy;
fn main() {}
RS
# Rewrite `url::Url::` paths in the copied policy to the crate-rooted stub.
sed -i 's/url::Url::/crate::url::Url::/g' "$work/policy_under_test.rs"
cp "$work/runner.rs" "$work/main_check.rs"
echo "--- stub-compile policy.rs + unit tests (offline) ---"
rustc --edition 2021 --test "$work/runner.rs" -o "$work/out/policy_tests" 2>&1
"$work/out/policy_tests"
