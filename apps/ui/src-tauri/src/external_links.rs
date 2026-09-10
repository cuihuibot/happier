//! Routes webview new-window requests to the registered system browser.
//!
//! An assistant Markdown link renders as an anchor with `target="_blank"`, and every other
//! external-open path in the UI ends in `window.open`. Both surface to the platform webview as a
//! new-window request. When no handler is installed the macOS WebKit UI delegate answers with no
//! webview, so the navigation is dropped silently: no browser document, no in-app window and no
//! error. Installing one handler that hands supported URLs to the platform opener and denies the
//! in-app window is what makes ordinary external links work.

use std::ffi::OsStr;

use tauri::utils::config::WindowConfig;
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Manager, Runtime, Url, WebviewWindowBuilder};

use crate::os_open::spawn_os_open;

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// Schemes that may leave the app through the platform opener.
///
/// This mirrors the frontend's `SAFE_EXTERNAL_URL_SCHEME_PATTERN` so there is a single external
/// scheme policy. Anything else - notably `javascript:`, `data:`, `file:` and the app's own
/// `tauri:` origin - stays inside the webview boundary and is denied.
const SUPPORTED_EXTERNAL_URL_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

fn parse_supported_external_url(raw: &str) -> Option<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let url = Url::parse(trimmed).ok()?;
    if SUPPORTED_EXTERNAL_URL_SCHEMES.contains(&url.scheme()) {
        Some(url)
    } else {
        None
    }
}

/// Whether a URL may be handed to the registered system handler.
pub fn is_supported_external_url(raw: &str) -> bool {
    parse_supported_external_url(raw).is_some()
}

/// A short, non-sensitive description of an external URL.
///
/// Assistant links carry session-scoped queries, fragments and opaque references, and `mailto:`
/// targets carry addresses, so only the scheme and the host are ever reported.
pub fn describe_external_url(raw: &str) -> String {
    match Url::parse(raw.trim()) {
        Ok(url) => match url.host_str() {
            Some(host) => format!("{}://{host}", url.scheme()),
            None => format!("{}: link", url.scheme()),
        },
        Err(_) => "unparseable link".to_string(),
    }
}

/// Opens a supported external URL with the registered system handler.
///
/// Unsupported schemes are rejected before anything is launched, and the error never repeats the
/// complete URL.
pub fn open_external_url(raw: &str) -> Result<(), String> {
    let Some(url) = parse_supported_external_url(raw) else {
        return Err(format!(
            "refused to open an unsupported external link ({})",
            describe_external_url(raw)
        ));
    };

    spawn_os_open(OsStr::new(url.as_str())).map_err(|error| {
        format!(
            "failed to open {} externally: {error}",
            describe_external_url(url.as_str())
        )
    })
}

/// Handles a webview new-window request by opening supported URLs externally.
///
/// The in-app window is always denied: allowing it would open a second embedded webview instead of
/// the user's browser, which is not what an external link means.
fn respond_to_new_window_request<R: Runtime>(url: &Url) -> NewWindowResponse<R> {
    match open_external_url(url.as_str()) {
        Ok(()) => log::info!(
            "opened an external link with the system handler ({})",
            describe_external_url(url.as_str())
        ),
        Err(error) => log::warn!("{error}"),
    }

    NewWindowResponse::Deny
}

fn main_window_config<R: Runtime, M: Manager<R>>(manager: &M) -> Option<WindowConfig> {
    manager
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
}

/// Creates the configured main window with external-link routing installed.
///
/// The window is built from the shipped `WindowConfig` rather than a hand-written copy, so title,
/// size, visibility, decorations, overlay titlebar, background colour, drag-drop and resizability
/// keep coming from configuration. Configuration opts out of automatic creation (`"create": false`)
/// because `on_new_window` can only be supplied while the webview is being built.
///
/// This must run before the chrome, tray and pet-overlay registration, which all resolve the main
/// window by label and silently do nothing when it is missing.
pub(crate) fn create_main_window<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let Some(config) = main_window_config(app) else {
        return Ok(());
    };

    WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(|url, _features: NewWindowFeatures| respond_to_new_window_request(&url))
        .build()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{describe_external_url, is_supported_external_url, open_external_url};

    #[test]
    fn supported_schemes_are_admitted() {
        for url in [
            "https://example.test/path?query=1#frag",
            "http://example.test/",
            "mailto:person@example.test",
        ] {
            assert!(is_supported_external_url(url), "{url} should be admitted");
        }
    }

    #[test]
    fn unsupported_schemes_are_denied_without_launching_anything() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "tauri://localhost/session/abc",
            "",
            "   ",
            "not-a-url",
        ] {
            assert!(!is_supported_external_url(url), "{url} should be denied");
            assert!(
                open_external_url(url).is_err(),
                "{url} should be rejected before launching the platform opener"
            );
        }
    }

    #[test]
    fn descriptions_and_errors_do_not_leak_url_details() {
        let description =
            describe_external_url("https://host.example.test/secret?token=supersecret#frag");
        assert_eq!(description, "https://host.example.test");

        let error = open_external_url("javascript:steal('token=supersecret')")
            .expect_err("javascript: should be denied");
        assert!(!error.contains("supersecret"), "{error}");
    }
}
