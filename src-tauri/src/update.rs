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
//! An update is a newer version. The one exception is the way back: when
//! the server says the version in use has been withdrawn, the older one it
//! names is offered instead. That too is a genuine release, signed as the
//! version it claims to be, and it too waits for the user to take it; what
//! the server gains is the choice among releases the owner once signed.
//!
//! Asking, a copy names its version and system, and its installation: a
//! random number it made for itself on first launch, which has nothing to
//! do with the computer and goes with the app's data. The server counts
//! copies in use by it, a day at a time, and forgets it when the day ends.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use myssh_core::{Error, Result};
use semver::Version;
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
fn endpoint(install: Option<&str>) -> Option<Url> {
    if PUBKEY.is_empty() {
        return None;
    }
    if cfg!(debug_assertions) {
        return std::env::var("MYSSH_UPDATE_URL").ok()?.parse().ok();
    }
    if crate::cloud::SERVER.is_empty() {
        return None;
    }
    // The updater fills in its version and system; the server counts copies
    // in use by them and by the installation's number, a day at a time, and
    // keeps nothing else.
    let id = install.map(|id| format!("&id={id}")).unwrap_or_default();
    format!(
        "{}/updates/latest.json?v={{{{current_version}}}}&os={{{{target}}}}&arch={{{{arch}}}}{id}",
        crate::cloud::SERVER
    )
    .parse()
    .ok()
}

/// Whether this build updates itself. One that was built without the key,
/// such as the package for the Microsoft Store, does not: there the store
/// brings the updates, and the app must not go looking for them.
pub fn enabled() -> bool {
    endpoint(None).is_some()
}

fn failed(e: tauri_plugin_updater::Error) -> Error {
    Error::Update(e.to_string())
}

fn updater(app: &AppHandle) -> Result<Option<Updater>> {
    let install = install_id(&app.state::<AppState>().data_dir);
    let Some(endpoint) = endpoint(install.as_deref()) else {
        return Ok(None);
    };
    let updater = app
        .updater_builder()
        .pubkey(PUBKEY)
        .endpoints(vec![endpoint])
        .map_err(failed)?
        .timeout(Duration::from_secs(20))
        // Whatever differs from this version is looked at; `offer` decides.
        .version_comparator(|current, release| release.version != current)
        .build()
        .map_err(failed)?;
    Ok(Some(updater))
}

/// What the server has for this copy of the app.
struct Offer {
    update: Update,
    /// It is older than this version, which the server says is withdrawn.
    rollback: bool,
}

/// Asks the server. A newer version is an update; an older one is taken
/// only as a rollback the server asks for by name; anything else is nothing.
async fn offer(app: &AppHandle) -> Result<Option<Offer>> {
    let Some(updater) = updater(app)? else {
        return Ok(None);
    };
    let Some(update) = updater.check().await.map_err(failed)? else {
        return Ok(None);
    };
    let parse = |version: &str| Version::parse(version.trim_start_matches('v'));
    let (Ok(offered), Ok(current)) = (parse(&update.version), parse(&update.current_version)) else {
        return Ok(None);
    };
    let rollback = offered < current && update.raw_json["rollback"].as_bool() == Some(true);
    Ok((offered > current || rollback).then_some(Offer { update, rollback }))
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    /// When it was published, as the server wrote it.
    date: Option<String>,
    /// This is the way back from a withdrawn version, not a newer one.
    rollback: bool,
}

/// Looks for a newer version. `None`: this is the latest, or this build
/// does not update itself.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>> {
    Ok(offer(&app).await?.map(|Offer { update, rollback }| UpdateInfo {
        date: update.raw_json["pub_date"].as_str().map(str::to_string),
        notes: update.body.filter(|notes| !notes.trim().is_empty()),
        current: update.current_version,
        version: update.version,
        rollback,
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
        .ok_or_else(|| Error::Update("there is no other version to install".into()))?
        .update;
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

/// Starts the app again, as the version just installed. Open sessions end.
#[tauri::command]
pub fn update_restart(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    for session in state.drain_sessions() {
        session.close();
    }
    // The installer ends this app, and starts the new version when it is done.
    #[cfg(target_os = "windows")]
    if let Some((update, bytes)) = WAITING.lock().unwrap().take() {
        update.restart_after_install(true).install(bytes).map_err(failed)?;
    }
    app.restart();
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
