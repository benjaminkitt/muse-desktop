//! Shared policy: which origins may load inside the webview.
//!
//! The single source of truth for "exact trusted origin". Both the capability
//! files (compile-time IPC grants) and the runtime `on_navigation` guard read
//! from the same constants, so they cannot drift apart. Unit tests pin the
//! classification matrix — see the `tests` module at the bottom.

/// Origins that may render inside the main webview.
pub const TRUSTED_APP_HOSTS: &[&str] = &["muse.ai", "www.muse.ai"];

/// Hosts the Muse login flow may legitimately bounce through (OAuth-style
/// redirects/popups, e.g. Meta account login). Allowed to navigate in the
/// webview so login can complete; they receive NO Tauri IPC surface (see
/// `capabilities/remote.json`, which grants IPC only to the exact app
/// origin), and the JS bridge does not install there (see `frontend/main.js`).
///
/// REVIEW BEFORE EXTENDING: every entry widens the unvalidated-auth surface.
/// Prefer removing entries over adding them; re-validate after any Muse
/// login-flow change.
pub const AUTH_FLOW_HOSTS: &[&str] = &["auth.muse.ai", "auth.meta.com", "www.facebook.com", "m.facebook.com", "www.instagram.com"];

/// Login entry point.
pub const APP_URL: &str = "https://muse.ai";

/// Classification of a navigation target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationTarget {
    /// Render inside the webview (trusted app or auth-flow host, https only).
    Webview,
    /// Hand to the OS browser via the opener plugin.
    External,
    /// Refuse outright (non-http(s) scheme).
    Blocked,
}

/// Classify a navigation target URL.
///
/// * Non-`http(s)` schemes (javascript:, data:, file:, custom protocols)
///   are always [`NavigationTarget::Blocked`].
/// * `https` (and plain `http`, upgraded/blocked downstream) URLs on
///   [`TRUSTED_APP_HOSTS`] or [`AUTH_FLOW_HOSTS`] stay in the webview.
/// * Everything else http(s) is [`NavigationTarget::External`].
/// * Unparseable input is [`NavigationTarget::Blocked`] (fail closed).
pub fn classify_navigation(url: &str) -> NavigationTarget {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return NavigationTarget::Blocked,
    };
    match parsed.scheme() {
        "https" | "http" => {}
        _ => return NavigationTarget::Blocked,
    }
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    if TRUSTED_APP_HOSTS.contains(&host.as_str()) || AUTH_FLOW_HOSTS.contains(&host.as_str()) {
        NavigationTarget::Webview
    } else {
        NavigationTarget::External
    }
}

/// `true` when the URL may load inside the webview.
pub fn is_webview_allowed(url: &str) -> bool {
    classify_navigation(url) == NavigationTarget::Webview
}

/// `true` when the URL should be handed to the OS browser instead.
pub fn is_external(url: &str) -> bool {
    classify_navigation(url) == NavigationTarget::External
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_origin_stays_in_webview() {
        assert_eq!(classify_navigation("https://muse.ai/"), NavigationTarget::Webview);
        assert_eq!(
            classify_navigation("https://muse.ai/chat?x=1#frag"),
            NavigationTarget::Webview
        );
        assert_eq!(
            classify_navigation("https://www.muse.ai/settings"),
            NavigationTarget::Webview
        );
    }

    #[test]
    fn auth_flow_hosts_stay_in_webview() {
        for host in AUTH_FLOW_HOSTS {
            assert_eq!(
                classify_navigation(&format!("https://{host}/login")),
                NavigationTarget::Webview,
                "auth host {host} must stay in webview"
            );
        }
    }

    #[test]
    fn lookalike_hosts_are_external() {
        // Subdomain tricks must NOT be treated as trusted.
        assert_eq!(
            classify_navigation("https://muse.ai.evil.com/"),
            NavigationTarget::External
        );
        assert_eq!(
            classify_navigation("https://evilmuse.ai/"),
            NavigationTarget::External
        );
        assert_eq!(
            classify_navigation("https://muse-ai.example.com/"),
            NavigationTarget::External
        );
    }

    #[test]
    fn unrelated_https_is_external() {
        assert_eq!(
            classify_navigation("https://example.com/article"),
            NavigationTarget::External
        );
        assert_eq!(
            classify_navigation("https://docs.meta.com/x"),
            NavigationTarget::External
        );
    }

    #[test]
    fn dangerous_schemes_are_blocked() {
        for url in [
            "javascript:alert(1)",
            "data:text/html,<h1>hi</h1>",
            "file:///etc/passwd",
            "muse://do-something",
            "ftp://example.com/x",
        ] {
            assert_eq!(classify_navigation(url), NavigationTarget::Blocked, "{url}");
        }
    }

    #[test]
    fn unparseable_input_fails_closed() {
        assert_eq!(classify_navigation("::::"), NavigationTarget::Blocked);
        assert_eq!(classify_navigation(""), NavigationTarget::Blocked);
    }

    #[test]
    fn host_matching_is_case_insensitive() {
        assert_eq!(
            classify_navigation("https://MUSE.AI/chat"),
            NavigationTarget::Webview
        );
    }

    #[test]
    fn predicate_helpers_agree_with_classifier() {
        assert!(is_webview_allowed("https://muse.ai/"));
        assert!(!is_webview_allowed("https://example.com/"));
        assert!(is_external("https://example.com/"));
        assert!(!is_external("https://muse.ai/"));
        assert!(!is_external("javascript:alert(1)"));
    }
}
