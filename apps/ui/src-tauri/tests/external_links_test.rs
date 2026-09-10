use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn read_json_file(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    let source = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&source)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

/// An assistant Markdown link renders as an anchor with `target="_blank"`, and every other
/// external-open path in the UI ends in `window.open`. Both reach the webview as a new-window
/// request, so the native side has to route them to the registered browser. Without a handler the
/// platform webview drops the request silently: no browser document, no in-app window, no error.
#[test]
fn supported_external_schemes_are_routed_out_of_the_webview() {
    for url in [
        "https://example.test/path?query=1#frag",
        "http://example.test/",
        "mailto:person@example.test",
        "HTTPS://EXAMPLE.TEST/",
    ] {
        assert!(
            app_lib::external_links::is_supported_external_url(url),
            "{url} should be routed to the registered browser"
        );
    }
}

#[test]
fn unsupported_schemes_are_denied_and_never_reach_the_platform_opener() {
    for url in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<script>alert(1)</script>",
        "tauri://localhost/session/abc",
        "vbscript:msgbox(1)",
        "   ",
        "",
        "not-a-url",
    ] {
        assert!(
            !app_lib::external_links::is_supported_external_url(url),
            "{url} must not be handed to the platform opener"
        );

        let error = app_lib::external_links::open_external_url(url)
            .expect_err("an unsupported scheme must be rejected before launching anything");
        assert!(
            !error.is_empty(),
            "a denied external URL must surface a visible error"
        );
    }
}

/// Errors and logs have to stay diagnosable without leaking the complete URL, because assistant
/// links carry session-scoped queries, fragments and opaque references.
#[test]
fn external_url_descriptions_omit_path_query_and_fragment() {
    let description = app_lib::external_links::describe_external_url(
        "https://cuihuis-mac-mini.example.test/secret/path?token=abc123#fragment",
    );

    assert!(
        description.contains("https"),
        "description should keep the scheme: {description}"
    );
    assert!(
        description.contains("cuihuis-mac-mini.example.test"),
        "description should keep the host: {description}"
    );
    for leaked in ["secret", "path", "token", "abc123", "fragment"] {
        assert!(
            !description.contains(leaked),
            "description must not leak {leaked}: {description}"
        );
    }

    let mailto = app_lib::external_links::describe_external_url("mailto:person@example.test");
    assert!(
        !mailto.contains("person"),
        "a mailto description must not leak the address: {mailto}"
    );
}

#[test]
fn denied_external_url_errors_do_not_repeat_the_complete_url() {
    let error = app_lib::external_links::open_external_url(
        "javascript:steal('https://example.test/a?token=supersecret')",
    )
    .expect_err("javascript: must be denied");

    assert!(
        !error.contains("supersecret"),
        "the rejection must not echo the complete URL: {error}"
    );
}

/// The main window is created from configuration on the Rust side so the new-window handler can be
/// installed. That only works if the shipped configuration actually opts out of automatic creation
/// and still carries the label the chrome, tray and pet-overlay lifecycle code resolves.
#[test]
fn main_window_configuration_is_available_to_rust_creation() {
    for config_name in [
        "tauri.conf.json",
        "tauri.preview.conf.json",
        "tauri.publicdev.conf.json",
    ] {
        let config = read_json_file(manifest_dir().join(config_name));
        let raw_window = config["app"]["windows"]
            .as_array()
            .and_then(|windows| windows.first())
            .unwrap_or_else(|| panic!("{config_name} should declare a main window"))
            .clone();

        let window: tauri::utils::config::WindowConfig = serde_json::from_value(raw_window)
            .unwrap_or_else(|error| panic!("{config_name} should parse as WindowConfig: {error}"));

        assert!(
            !window.create,
            "{config_name} must leave main-window creation to Rust"
        );
        assert_eq!(window.label, "main");
    }
}
