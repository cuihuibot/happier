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

fn read_tauri_config(name: &str) -> Value {
    read_json_file(manifest_dir().join(name))
}

fn read_default_capability() -> Value {
    read_json_file(manifest_dir().join("capabilities").join("default.json"))
}

#[test]
fn default_capability_allows_main_window_chrome_commands_without_losing_pet_overlay_scope() {
    let default_capability = read_default_capability();
    assert_eq!(default_capability["windows"], serde_json::json!(["main"]));

    let permissions = default_capability["permissions"]
        .as_array()
        .expect("default capability permissions should be an array");

    for required_permission in [
        "allow-sync-desktop-pet-overlay-state",
        "core:window:allow-set-background-color",
        "allow-desktop-get-window-chrome-policy",
        "allow-desktop-get-window-state",
        "allow-desktop-minimize-window",
        "allow-desktop-toggle-window-maximize",
        "allow-desktop-close-window",
        "allow-desktop-show-main-window",
        "allow-desktop-start-window-dragging",
    ] {
        assert!(
            permissions.contains(&Value::String(required_permission.to_string())),
            "default capability should include {required_permission}",
        );
    }
}

#[test]
fn stable_preview_and_publicdev_configs_use_integrated_main_window_chrome() {
    for config_name in [
        "tauri.conf.json",
        "tauri.preview.conf.json",
        "tauri.publicdev.conf.json",
    ] {
        let config = read_tauri_config(config_name);
        let window = config["app"]["windows"]
            .as_array()
            .and_then(|windows| windows.first())
            .unwrap_or_else(|| panic!("{config_name} should declare a main window"));

        assert_eq!(
            window["decorations"], true,
            "{config_name} should keep native window decorations available"
        );
        assert_eq!(
            window["hiddenTitle"], true,
            "{config_name} should hide the native title text"
        );
        assert_eq!(
            window["titleBarStyle"], "Overlay",
            "{config_name} should use overlay titlebar chrome"
        );
        assert_eq!(
            window["backgroundColor"], "#F5F5F5",
            "{config_name} should set a main-window background fallback that matches the light grouped app surface"
        );
    }
}

#[test]
fn every_config_hands_main_window_creation_to_rust_without_losing_window_configuration() {
    for config_name in [
        "tauri.conf.json",
        "tauri.preview.conf.json",
        "tauri.publicdev.conf.json",
    ] {
        let config = read_tauri_config(config_name);
        let raw_window = config["app"]["windows"]
            .as_array()
            .and_then(|windows| windows.first())
            .unwrap_or_else(|| panic!("{config_name} should declare a main window"))
            .clone();

        assert_eq!(
            raw_window["create"], false,
            "{config_name} must opt out of automatic window creation so the Rust setup owns \
             main-window creation and can install the external-link new-window handler"
        );

        // Deserializing through the real Tauri type proves the runtime sees the same
        // configuration that `WebviewWindowBuilder::from_config` will consume, so the
        // window is reused rather than duplicated or silently reduced.
        let window: tauri::utils::config::WindowConfig = serde_json::from_value(raw_window)
            .unwrap_or_else(|error| {
                panic!("{config_name} main window should parse as a Tauri WindowConfig: {error}")
            });

        assert!(
            !window.create,
            "{config_name} WindowConfig::create should be false"
        );
        assert_eq!(
            window.label, "main",
            "{config_name} must keep the main window label the chrome, tray and pet-overlay \
             lifecycle code resolves"
        );
        assert!(
            !window.visible,
            "{config_name} should keep the main window initially hidden"
        );
        assert!(
            window.decorations,
            "{config_name} should keep native window decorations"
        );
        assert!(
            window.hidden_title,
            "{config_name} should keep the native title text hidden"
        );
        assert!(
            !window.drag_drop_enabled,
            "{config_name} should keep webview drag-and-drop disabled"
        );
        assert!(
            window.resizable,
            "{config_name} should keep the main window resizable"
        );
    }
}

#[test]
fn stable_and_publicdev_configs_preserve_pet_overlay_capability() {
    for config_name in ["tauri.conf.json", "tauri.publicdev.conf.json"] {
        let config = read_tauri_config(config_name);
        let capabilities = config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap_or_else(|| panic!("{config_name} should declare app.security.capabilities"));

        assert!(
            capabilities.contains(&Value::String("default".to_string())),
            "{config_name} should keep the default capability",
        );
        assert!(
            capabilities.contains(&Value::String("pet_overlay".to_string())),
            "{config_name} should keep the pet_overlay capability",
        );
    }
}
