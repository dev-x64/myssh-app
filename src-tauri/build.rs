//! Bakes build-time configuration into the binary.
//!
//! The cloud server address comes from `app.config.json` at the repository
//! root (or from `MYSSH_CLOUD_SERVER`, which wins). It is fixed at compile
//! time on purpose: the app talks to one backend, and users cannot point it
//! elsewhere. An empty address builds an app without the cloud.
//!
//! The key updates are checked against is baked in the same way: an app
//! takes updates from its cloud server, signed by one key, both fixed when
//! it was built.
//!
//! `MYSSH_TEST_BUILD=1` makes a test build (scripts/release.sh, "Тестовая
//! сборка"): its server may then be plain HTTP on any address, a
//! development server elsewhere on the local network, which the app is
//! told to allow. Releases are never built so.

use std::path::Path;

fn cloud_server() -> String {
    println!("cargo:rerun-if-env-changed=MYSSH_CLOUD_SERVER");
    if let Ok(value) = std::env::var("MYSSH_CLOUD_SERVER") {
        return value;
    }
    let path = Path::new("../app.config.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let config: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
    config["cloud"]["server"]
        .as_str()
        .unwrap_or_else(|| panic!("{}: cloud.server must be a string", path.display()))
        .to_string()
}

/// A value of the `updates` section of `app.config.json`, or of the
/// environment variable that overrides it. Absent reads as empty.
fn update_setting(key: &str, variable: &str) -> String {
    println!("cargo:rerun-if-env-changed={variable}");
    if let Ok(value) = std::env::var(variable) {
        return value.trim().to_string();
    }
    let path = Path::new("../app.config.json");
    let config: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    config["updates"][key].as_str().unwrap_or_default().trim().to_string()
}

fn main() {
    // `updates.pubkey`: the public half of the key that signs releases.
    // Releases are handed out by the cloud server, so an app without a
    // server, or without the key, does not update itself.
    let pubkey = update_setting("pubkey", "MYSSH_UPDATE_PUBKEY");
    println!("cargo:rustc-env=MYSSH_UPDATE_PUBKEY={pubkey}");

    println!("cargo:rerun-if-env-changed=MYSSH_TEST_BUILD");
    let test_build = std::env::var("MYSSH_TEST_BUILD").as_deref() == Ok("1");
    println!("cargo:rustc-env=MYSSH_TEST_BUILD={}", if test_build { "1" } else { "" });

    let server = cloud_server().trim().trim_end_matches('/').to_string();
    let local = ["http://127.0.0.1", "http://localhost"]
        .iter()
        .any(|prefix| server == *prefix || server.starts_with(&format!("{prefix}:")));
    let plain_for_test = test_build && server.starts_with("http://");
    if !(server.is_empty() || server.starts_with("https://") || local || plain_for_test) {
        panic!("cloud.server must be an https:// address (or http://127.0.0.1 for development), got {server:?}");
    }
    if local && !test_build && std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:warning=this release build uses a local cloud server ({server}); set cloud.server in app.config.json before distributing");
    }
    println!("cargo:rustc-env=MYSSH_CLOUD_SERVER={server}");
    if (pubkey.is_empty() || server.is_empty()) && std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:warning=updates.pubkey or cloud.server is missing in app.config.json: this build will not update itself (see scripts/updater-key.sh)");
    }

    // Shared terminals reach the server from the window itself, over a
    // WebSocket, and the window may connect only where its content security
    // policy says. That policy lives in tauri.conf.json and has to name
    // the same server.
    if let Some(host) = server.strip_prefix("https://") {
        println!("cargo:rerun-if-changed=tauri.conf.json");
        let conf = std::fs::read_to_string("tauri.conf.json").unwrap_or_default();
        let socket = format!("wss://{host}");
        if !conf.contains(&socket) {
            panic!("tauri.conf.json: add {socket} to connect-src of app.security.csp (it must match cloud.server in app.config.json)");
        }
    }

    tauri_build::build()
}
