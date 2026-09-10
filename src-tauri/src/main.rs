//! muse-desktop: minimal Tauri v2 wrapper around https://muse.ai (macOS + Linux).
//!
//! Architecture (reviewer notes):
//! * The main window is created in Rust (not `tauri.conf.json`) so the
//!   `initialization_script` and the `on_navigation` / `on_new_window`
//!   guards attach to the exact same window. `policy::classify_navigation`
//!   is the single classifier for top-level navigations; the JS
//!   `link-policy.js` is a deliberate MIRROR (not the same module —
//!   corrected README), pinned to the same matrix by tests on both sides.
//! * Transport truth: plugins are reached via
//!   `window.__TAURI_INTERNALS__.invoke` (`plugin:notification|…`,
//!   `plugin:opener|…`), NOT via `window.__TAURI__.notification/.opener`
//!   (those properties do not exist). See `frontend/tauri-adapter.js`.
//! * External http(s) is opened from RUST (`on_navigation` + `on_new_window`
//!   via `OpenerExt::open_url` on a cloned `AppHandle`), because the remote
//!   capability grants opener ONLY to the local window context — the remote
//!   page itself has no opener invoke grant (least privilege). The JS click
//!   interceptor ALSO invokes `plugin:opener|open_url` for new-context
//!   anchor gestures; whichever layer fires first wins and the other is a
//!   no-op (navigation cancelled / popup returns null). Same-tab external
//!   clicks rely on the Rust guard alone.
//! * The opener plugin is built with `open_js_links_on_click(false)` so its
//!   bundled click→open listener does not double-fire alongside ours.
//! * Close hides to tray: `CloseRequested` → `prevent_close()` + `hide()`.
//!   Quit happens only via the tray "Quit" menu item (or Cmd/Ctrl+Q); the
//!   tray is built ONLY in Rust — `tauri.conf.json` has no `trayIcon` key
//!   (duplicate-id fix).
//! * Left-click tray restores the window (macOS/Windows). On Linux, click
//!   events are unsupported by Tauri, so the right-click menu is the path.

mod policy;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    Manager, WebviewUrl, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

/// Tray menu item ids (also asserted in the smoke checklist).
const MENU_SHOW_ID: &str = "show";
const MENU_QUIT_ID: &str = "quit";

/// Initial window geometry (logical pixels).
const WINDOW_WIDTH: f64 = 1200.0;
const WINDOW_HEIGHT: f64 = 800.0;
const WINDOW_MIN_WIDTH: f64 = 360.0;
const WINDOW_MIN_HEIGHT: f64 = 240.0;

/// Static tray menu labels (kept in code, not config, for reviewability).
const MENU_SHOW_LABEL: &str = "Show";
const MENU_QUIT_LABEL: &str = "Quit";

/// Build the tray menu: exactly "Show" and "Quit".
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, MENU_SHOW_ID, MENU_SHOW_LABEL, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT_ID, MENU_QUIT_LABEL, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        {
            // Best-effort dock unhide parity; ignore failures on other targets.
            let _ = window.unminimize();
        }
    }
}

/// Open an external http(s) URL in the OS browser. Failures are logged, never
/// propagated (navigation guards must not panic the webview thread).
fn open_external(handle: &tauri::AppHandle, url: &str) {
    if let Err(err) = handle.opener().open_url(url, None::<&str>) {
        log::warn!("opener failed for {url}: {err}");
    }
}

fn build_init_script() -> String {
    // Concatenation order matters: adapter + helpers first, bootstrap last.
    // `frontend/dist/*.js` are generated at build time by
    // `scripts/inline-frontend.sh` (see tauri.conf.json beforeBundleCommand).
    format!(
        "{}\n{}\n{}\n{}",
        include_str!("../../frontend/dist/tauri-adapter.js"),
        include_str!("../../frontend/dist/notification-bridge.js"),
        include_str!("../../frontend/dist/link-policy.js"),
        include_str!("../../frontend/dist/main.js"),
    )
}

fn main() {
    run();
}

pub fn run() {
    let init_script = build_init_script();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(move |app| {
            let menu = build_tray_menu(app.handle())?;
            let handle = app.handle().clone();

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Muse")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    MENU_SHOW_ID => show_main_window(app),
                    MENU_QUIT_ID => app.exit(0),
                    other => {
                        log::warn!("unhandled tray menu item: {other}");
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click release restores the window. Linux does not
                    // emit click events: right-click menu remains the path.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            let nav_handle = handle.clone();
            let popup_handle = handle.clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(policy::APP_URL.parse().expect("valid app url")),
            )
            .title("Muse")
            .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
            .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
            .initialization_script(&init_script)
            .on_navigation(move |url| {
                // Backstop for top-level / server-driven navigations. External
                // http(s) is opened in the OS browser via AppHandle and
                // cancelled in-webview; auth/app hosts proceed.
                if policy::is_external(url.as_str()) {
                    eprintln!("[navigation] opening external origin: {}", url.origin().ascii_serialization());
                    open_external(&nav_handle, url.as_str());
                }
                policy::is_webview_allowed(url.as_str())
            })
            .on_new_window(move |url, _features| {
                // window.open / popup path: trusted stays in-webview (deny a
                // NEW webview; the page can navigate its own tab), external
                // opens in the OS browser, dangerous schemes are denied.
                // Documented API: WebviewWindowBuilder::on_new_window ->
                // NewWindowResponse::{Allow, Deny} (no Create: popups must
                // never spawn policy-bypassing webviews).
                match policy::classify_navigation(url.as_str()) {
                    policy::NavigationTarget::Webview => NewWindowResponse::Deny,
                    policy::NavigationTarget::External => {
                        eprintln!("[popup] opening external origin: {}", url.origin().ascii_serialization());
                        open_external(&popup_handle, url.as_str());
                        NewWindowResponse::Deny
                    }
                    policy::NavigationTarget::Blocked => {
                        log::warn!("blocked popup navigation: {url}");
                        NewWindowResponse::Deny
                    }
                }
            })
            .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close hides to tray instead of quitting.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build muse-desktop")
        .run(|app, event| {
            // macOS: reopen main window on dock-icon click when hidden.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
