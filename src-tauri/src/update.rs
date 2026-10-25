//! Updates of the app itself.
//!
//! The cloud server hands out releases, and the app asks it whether a newer
//! version exists. The server does not have to be trusted for this: an
//! update is a signed archive, installed only if its signature matches the
//! public key built into this binary, and only for the version it was
//! signed as. Nothing is installed until the user asks for it or has put
//! it off a few times (the window keeps count), and the app restarts only
//! when told to, since a restart ends open sessions.
//!
//! On a Mac an update is put in place of the app on disk, and the running
//! app goes on as it was. On Windows it is an installer, and running it
//! ends the app; so one taken for the next launch is downloaded and kept,
//! and the installer is run as the app closes.
//!
//! An update is only ever a newer version. A release that turns out to be
//! bad is mended by a newer one, never by sending copies back to an older
//! one, which may not read what the newer one wrote.
//!
//! Asking, a copy names its version and system, and its installation: a
//! random number it made for itself on first launch, which has nothing to
//! do with the computer and goes with the app's data. It says too whether
//! it is signed in to an account, but not to which. The server counts
//! copies in use by these, a day at a time, and forgets them when the day
//! ends.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use myssh_core::{Error, Result};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::state::AppState;

/// On Windows: an update downloaded and checked, waiting for the app to
/// close or restart, when its installer runs.
#[cfg(target_os = "windows")]
static WAITING: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);

/// The public half of the key releases are signed with; set at build time
/// from `app.config.json`. Without it the app does not look for updates.
const PUBKEY: &str = env!("MYSSH_UPDATE_PUBKEY");

/// This installation's number, made at random the first time it is asked
/// for and kept in the app's data: so that the server can tell copies
/// apart that share a network address, and one copy from itself on another
/// address. `None` when it cannot be kept, and then it is not sent.
fn install_id(data_dir: &Path) -> Option<String> {
    let path = data_dir.join("install_id");
    if let Ok(text) = std::fs::read_to_string(&path) {
        let text = text.trim();
        if text.len() == 32 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(text.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::write(&path, &id).ok()?;
    Some(id)
}

/// The address to ask: the cloud server this app was built for. A
/// development build has nothing to replace, so it asks only when pointed
/// somewhere by hand.
fn endpoint(install: Option<&str>, signed_in: bool) -> Option<Url> {
    // On a phone the app store brings the updates.
    if PUBKEY.is_empty() || cfg!(mobile) {
        return None;
    }
    if cfg!(debug_assertions) {
        return std::env::var("MYSSH_UPDATE_URL").ok()?.parse().ok();
    }
    if crate::cloud::SERVER.is_empty() {
        return None;
    }
    // The updater fills in its version and system; the server counts copies
    // in use by them, by the installation's number and by whether they are
    // signed in, a day at a time, and keeps nothing else.
    let id = install.map(|id| format!("&id={id}")).unwrap_or_default();
    let account = u8::from(signed_in);
    format!(
        "{}/updates/latest.json?v={{{{current_version}}}}&os={{{{target}}}}&arch={{{{arch}}}}{id}&acct={account}",
        crate::cloud::SERVER
    )
    .parse()
    .ok()
}

/// Whether this build updates itself. One that was built without the key,
/// such as the package for the Microsoft Store, does not: there the store
/// brings the updates, and the app must not go looking for them.
pub fn enabled() -> bool {
    endpoint(None, false).is_some()
}

fn failed(e: tauri_plugin_updater::Error) -> Error {
    Error::Update(e.to_string())
}

fn updater(app: &AppHandle) -> Result<Option<Updater>> {
    let state = app.state::<AppState>();
    let install = install_id(&state.data_dir);
    let signed_in = state
        .with_vault(|v| Ok(v.snapshot().cloud.is_some_and(|account| !account.revoked)))
        .unwrap_or(false);
    let Some(endpoint) = endpoint(install.as_deref(), signed_in) else {
        return Ok(None);
    };
    let updater = app
        .updater_builder()
        .pubkey(PUBKEY)
        .endpoints(vec![endpoint])
        .map_err(failed)?
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(failed)?;
    Ok(Some(updater))
}

/// Asks the server for a version newer than this one.
async fn offer(app: &AppHandle) -> Result<Option<Update>> {
    let Some(updater) = updater(app)? else {
        return Ok(None);
    };
    updater.check().await.map_err(failed)
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    /// When it was published, as the server wrote it.
    date: Option<String>,
}

/// Looks for a newer version. `None`: this is the latest, or this build
/// does not update itself.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>> {
    Ok(offer(&app).await?.map(|update| UpdateInfo {
        date: update.raw_json["pub_date"].as_str().map(str::to_string),
        notes: update.body.filter(|notes| !notes.trim().is_empty()),
        current: update.current_version,
        version: update.version,
    }))
}

#[derive(Clone, Serialize)]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Downloads the version on offer, checks its signature and puts it in
/// place of this one; on Windows, keeps it for when the app closes. The
/// running app is not affected until it restarts.
#[tauri::command]
pub async fn update_install(app: AppHandle, progress: Channel<Progress>) -> Result<()> {
    let update = offer(&app)
        .await?
        .ok_or_else(|| Error::Update("there is no newer version to install".into()))?;
    let downloaded = Mutex::new((0u64, Instant::now()));
    let done = progress.clone();
    let bytes = update
        .download(
            |chunk, total| {
                let mut state = downloaded.lock().unwrap();
                state.0 += chunk as u64;
                // A report for every chunk would only flood the window.
                if state.1.elapsed() >= Duration::from_millis(80) {
                    state.1 = Instant::now();
                    let _ = progress.send(Progress { downloaded: state.0, total });
                }
            },
            || {},
        )
        .await
        .map_err(failed)?;
    #[cfg(target_os = "windows")]
    {
        *WAITING.lock().unwrap() = Some((update, bytes));
    }
    #[cfg(not(target_os = "windows"))]
    update.install(bytes).map_err(failed)?;
    let total = downloaded.lock().unwrap().0;
    let _ = done.send(Progress { downloaded: total, total: Some(total) });
    Ok(())
}

/// Where the tabs open before a restart wait for the app to come back.
fn reopen_path(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("reopen.json")
}

/// Starts the app again, as the version just installed. Open sessions end;
/// `tabs`, what the window says was open, is kept on disk for the window
/// that comes back to open again (the window's own storage may not reach
/// the disk before the app is gone).
#[tauri::command]
pub fn update_restart(app: AppHandle, state: State<'_, AppState>, tabs: Option<String>) -> Result<()> {
    if let Some(tabs) = tabs {
        let _ = std::fs::write(reopen_path(&state), tabs);
    }
    for session in state.drain_sessions() {
        session.close();
    }
    // The installer ends this app, and starts the new version when it is done.
    #[cfg(target_os = "windows")]
    if let Some((update, bytes)) = WAITING.lock().unwrap().take() {
        if let Err(e) = update.restart_after_install(true).install(bytes) {
            let _ = std::fs::remove_file(reopen_path(&state));
            return Err(failed(e));
        }
    }
    #[cfg(target_os = "macos")]
    if relaunch_when_gone() {
        app.exit(0);
        return Ok(());
    }
    app.restart();
}

/// The tabs kept by the last restart, given once: a launch that fails with
/// them open must not open them again.
#[tauri::command]
pub fn update_reopen_take(state: State<'_, AppState>) -> Option<String> {
    let path = reopen_path(&state);
    let tabs = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    tabs
}

/// On a Mac: has the app opened again once this copy has quit, the way the
/// Finder opens it. Tauri's own restart opens a second copy while this one
/// is still running, and the Dock then shows the app twice: the copy kept
/// in the Dock, and the new one beside it. `false` when not run from an
/// app bundle (a development build), or when the helper did not start.
#[cfg(target_os = "macos")]
fn relaunch_when_gone() -> bool {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let Ok(binary) = std::env::current_exe() else {
        return false;
    };
    let Some(bundle) = binary.ancestors().nth(3).filter(|b| b.extension().is_some_and(|e| e == "app")) else {
        return false;
    };
    // Waits for this process to end (at most 30 s), then opens the bundle,
    // which is passed as $0 so that no path needs quoting.
    let script = format!(
        "i=0; while /bin/kill -0 {} 2>/dev/null && [ $i -lt 300 ]; do /bin/sleep 0.1; i=$((i+1)); done; exec /usr/bin/open \"$0\"",
        std::process::id()
    );
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group: nothing sent to the app's reaches it.
        .process_group(0)
        .spawn()
        .is_ok()
}

/// The app is closing. On Windows, an update waiting for that is installed
/// now, and the app is not started again: it was closed on purpose.
pub fn on_exit() {
    #[cfg(target_os = "windows")]
    if let Some((update, bytes)) = WAITING.lock().unwrap().take() {
        let _ = update.restart_after_install(false).install(bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_installation_keeps_its_number_and_mends_a_broken_one() {
        let dir = std::env::temp_dir().join(format!("myssh-install-id-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = install_id(&dir).unwrap();
        assert_eq!(first.len(), 32);
        assert_eq!(install_id(&dir).unwrap(), first);
        std::fs::write(dir.join("install_id"), "not a number").unwrap();
        let mended = install_id(&dir).unwrap();
        assert_ne!(mended, first);
        assert_eq!(install_id(&dir).unwrap(), mended);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
