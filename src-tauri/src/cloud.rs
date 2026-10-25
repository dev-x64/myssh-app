//! Cloud account commands.

use myssh_core::cloud::{self, Device, DeviceInfo, Plan, SyncReport};
use myssh_core::model::{Id, KeyView};
use myssh_core::Result;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

const VAULT_CHANGED: &str = "vault-changed";

/// The one cloud server this build talks to, fixed at compile time from
/// `app.config.json`. Empty when the build has no cloud.
pub const SERVER: &str = env!("MYSSH_CLOUD_SERVER");

fn server() -> Result<&'static str> {
    if SERVER.is_empty() {
        return Err(myssh_core::Error::Invalid(
            "this build has no cloud server configured".into(),
        ));
    }
    Ok(SERVER)
}

/// A test build talks to its development server over plain HTTP even when
/// that is another machine of the local network; see build.rs. Releases
/// leave the rule as it is: HTTPS, or this very machine.
pub fn allow_test_server() {
    if env!("MYSSH_TEST_BUILD") != "1" {
        return;
    }
    if let Some(rest) = SERVER.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or_default();
        if !host.is_empty() {
            cloud::allow_plain_http(host);
        }
    }
}

/// A vault signed in under a different address follows the configured one:
/// the backend may have moved, and there is only ever one.
pub fn follow_configured_server(state: &AppState) {
    if SERVER.is_empty() {
        return;
    }
    let result = state.with_vault(|vault| match vault.cloud_account() {
        Some(mut account) if account.server != SERVER => {
            account.server = SERVER.to_string();
            vault.update_cloud_account(account)
        }
        _ => Ok(()),
    });
    if let Err(e) = result {
        log::error!("could not update the cloud server address: {e}");
    }
}

/// The name the system has for this computer, if it will say.
#[cfg(target_os = "macos")]
fn computer_name() -> Option<String> {
    let output = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "macos"))]
fn computer_name() -> Option<String> {
    // Windows keeps it in COMPUTERNAME; elsewhere HOSTNAME may have it, and
    // Linux keeps it in /etc/hostname (an app opened from a menu is given no HOSTNAME).
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().to_string())
}

/// How this computer is shown in the account's device list.
fn this_device() -> DeviceInfo {
    let unnamed = match std::env::consts::OS {
        "macos" => "Mac",
        "windows" => "Windows PC",
        "linux" => "Linux",
        _ => "Computer",
    };
    let name = computer_name()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| unnamed.to_string());
    DeviceInfo {
        name: name.chars().take(80).collect(),
        platform: std::env::consts::OS.to_string(),
    }
}

#[derive(serde::Serialize)]
pub struct CloudCheck {
    /// The server's host name, for display.
    host: String,
    online: bool,
    /// New accounts can be created.
    registration_open: bool,
    error: Option<myssh_core::error::ErrorInfo>,
}

/// Whether the cloud server can be reached right now. Never fails: being
/// unreachable is an answer.
#[tauri::command]
pub async fn cloud_check() -> CloudCheck {
    let host = SERVER
        .split_once("://")
        .map_or(SERVER, |(_, rest)| rest)
        .to_string();
    match cloud::server_info(SERVER).await {
        Ok(info) => CloudCheck {
            host,
            online: true,
            registration_open: info.registration == "open",
            error: None,
        },
        Err(e) => CloudCheck {
            host,
            online: false,
            registration_open: false,
            error: Some(e.info()),
        },
    }
}

/// Creates an account on the server and signs this vault in to it.
#[tauri::command]
pub async fn cloud_sign_up(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> Result<()> {
    cloud::sign_up(&*state, server()?, &email, &password, this_device()).await?;
    let _ = app.emit(VAULT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn cloud_sign_in(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> Result<()> {
    cloud::sign_in(&*state, server()?, &email, &password, this_device()).await?;
    let _ = app.emit(VAULT_CHANGED, ());
    Ok(())
}

/// Ends cloud access for this device. Local data stays.
#[tauri::command]
pub async fn cloud_sign_out(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let _running = state.sync_lock.lock().await;
    cloud::sign_out(&*state).await?;
    let _ = app.emit(VAULT_CHANGED, ());
    Ok(())
}

/// Changes the e-mail the account signs in with, once the master password
/// has been checked. Returns the address as stored.
#[tauri::command]
pub async fn cloud_change_email(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
    email: String,
) -> Result<String> {
    let _running = state.sync_lock.lock().await;
    let stored = cloud::change_email(&*state, &password, &email).await?;
    let _ = app.emit(VAULT_CHANGED, ());
    Ok(stored)
}

/// Deletes the account and everything the server keeps for it, once the
/// master password has been checked. Local data stays.
#[tauri::command]
pub async fn cloud_delete_account(app: AppHandle, state: State<'_, AppState>, password: String) -> Result<()> {
    let _running = state.sync_lock.lock().await;
    cloud::delete_account(&*state, &password).await?;
    let _ = app.emit(VAULT_CHANGED, ());
    Ok(())
}

/// Syncs with the cloud. `copy_suffix` marks copies kept on conflicts.
#[tauri::command]
pub async fn cloud_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    copy_suffix: String,
) -> Result<SyncReport> {
    let _running = state.sync_lock.lock().await;
    let result = cloud::sync(&*state, &copy_suffix).await;
    // Also on failure: the vault may have learned that access was revoked.
    let _ = app.emit(VAULT_CHANGED, ());
    result
}

/// Commands the AI offers for a terminal's command line.
#[tauri::command]
pub async fn ai_suggest(state: State<'_, AppState>, ask: cloud::AiAsk) -> Result<cloud::AiAnswer> {
    cloud::ai_suggest(&*state, &ask).await
}

/// Reserves a room on the cloud server for sharing a terminal.
#[tauri::command]
pub async fn share_open(app: AppHandle, state: State<'_, AppState>) -> Result<cloud::ShareInvite> {
    let result = cloud::share_open(&*state).await;
    if result.is_err() {
        let _ = app.emit(VAULT_CHANGED, ());
    }
    result
}

#[derive(serde::Serialize)]
pub struct ShareJoin {
    socket: String,
}

/// Where to connect to join the shared terminal of an invitation.
#[tauri::command]
pub fn share_join(room: String) -> Result<ShareJoin> {
    if SERVER.is_empty() {
        return Err(myssh_core::Error::Invalid("this build has no cloud server".into()));
    }
    Ok(ShareJoin { socket: cloud::share_guest_socket(SERVER, &room)? })
}

#[tauri::command]
pub async fn cloud_devices(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<Device>> {
    let result = cloud::devices(&*state).await;
    if result.is_err() {
        let _ = app.emit(VAULT_CHANGED, ());
    }
    result
}

/// What the account is on: Free or Pro, and until when.
#[tauri::command]
pub async fn cloud_plan(state: State<'_, AppState>) -> Result<Option<Plan>> {
    cloud::plan(&*state).await
}

/// Opens the account's pages in the browser, signed in as this device.
#[tauri::command]
pub async fn cloud_open_account(app: AppHandle, state: State<'_, AppState>, language: String) -> Result<()> {
    let url = cloud::account_page(&*state, &language).await?;
    crate::files::open_link(app, url).await
}

/// Ends another device's cloud access. Nothing on that device is erased
/// and no SSH key is removed from any server.
#[tauri::command]
pub async fn cloud_revoke_device(state: State<'_, AppState>, device_id: String) -> Result<()> {
    cloud::revoke_device(&*state, &device_id).await
}

/// Allows or forbids keeping a key in the cloud.
#[tauri::command]
pub fn key_set_sync(state: State<'_, AppState>, id: Id, sync: bool) -> Result<KeyView> {
    state.with_vault(|v| v.set_key_sync(id, sync))
}

/// Stores the preferences that follow the user between devices.
#[tauri::command]
pub fn settings_save(state: State<'_, AppState>, settings: serde_json::Value) -> Result<()> {
    state.with_vault(|v| v.save_settings(settings))
}
