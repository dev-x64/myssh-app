//! Remote file commands. Each one addresses the terminal session whose
//! connection carries the file transfer channel.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use myssh_core::localfs::{self, Stamp};
use myssh_core::sftp::{CancelFlag, Entry, FileVersion, Sftp, TextFile, TransferSummary};
use myssh_core::{Error, Result};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::state::AppState;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

/// Runs an operation on the session's file channel. A channel that turns
/// out to be dead is forgotten, so the next call opens a fresh one.
async fn with_sftp<T, F>(state: &AppState, id: u64, operation: impl FnOnce(Arc<Sftp>) -> F) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    let sftp = state.sftp(id).await?;
    let result = operation(sftp).await;
    if matches!(result, Err(Error::SessionClosed | Error::Sftp(_) | Error::Timeout)) {
        state.drop_sftp(id);
    }
    result
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, id: u64) -> Result<String> {
    with_sftp(&state, id, |sftp| async move { sftp.home().await }).await
}

/// Absolute form of a directory path, checked to exist.
#[tauri::command]
pub async fn sftp_resolve(state: State<'_, AppState>, id: u64, path: String) -> Result<String> {
    with_sftp(&state, id, |sftp| async move { sftp.resolve_dir(&path).await }).await
}

#[tauri::command]
pub async fn sftp_list(state: State<'_, AppState>, id: u64, path: String) -> Result<Vec<Entry>> {
    with_sftp(&state, id, |sftp| async move { sftp.list(&path).await }).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    id: u64,
    dir: String,
    name: String,
) -> Result<String> {
    with_sftp(&state, id, |sftp| async move { sftp.create_dir(&dir, &name).await }).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    name: String,
) -> Result<String> {
    with_sftp(&state, id, |sftp| async move { sftp.rename(&path, &name).await }).await
}

#[tauri::command]
pub async fn sftp_remove(state: State<'_, AppState>, id: u64, path: String) -> Result<()> {
    with_sftp(&state, id, |sftp| async move { sftp.remove(&path).await }).await
}

/// Sets the permission bits of a remote file or directory.
#[tauri::command]
pub async fn sftp_chmod(state: State<'_, AppState>, id: u64, path: String, mode: u32) -> Result<()> {
    with_sftp(&state, id, |sftp| async move { sftp.set_permissions(&path, mode).await }).await
}

/// What a remote file looks like now.
#[tauri::command]
pub async fn sftp_version(state: State<'_, AppState>, id: u64, path: String) -> Result<FileVersion> {
    with_sftp(&state, id, |sftp| async move { sftp.version(&path).await }).await
}

#[tauri::command]
pub async fn sftp_read_text(state: State<'_, AppState>, id: u64, path: String) -> Result<TextFile> {
    with_sftp(&state, id, |sftp| async move { sftp.read_text(&path).await }).await
}

/// Saves editor content. `expected` is the version the editor loaded; when
/// the file no longer matches it, nothing is written and the error code is
/// `conflict`. Pass `null` to overwrite deliberately.
#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    content: String,
    crlf: bool,
    expected: Option<FileVersion>,
) -> Result<FileVersion> {
    with_sftp(&state, id, |sftp| async move {
        sftp.write_text(&path, &content, crlf, expected).await
    })
    .await
}

#[derive(Clone, Serialize)]
pub struct Progress {
    done: u64,
    total: u64,
}

/// Forwards progress no more often than the UI can use it.
fn reporter(channel: Channel<Progress>) -> impl FnMut(u64, u64) {
    let mut last: Option<Instant> = None;
    move |done, total| {
        let due = last.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL);
        if due || done >= total {
            last = Some(Instant::now());
            let _ = channel.send(Progress { done, total });
        }
    }
}

/// Downloads a remote file or directory tree into a local directory.
/// Existing items are replaced or merged only when `overwrite` is set;
/// otherwise the error code is `already_exists`.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    id: u64,
    remote: String,
    local_dir: PathBuf,
    overwrite: bool,
    transfer: u64,
    progress: Channel<Progress>,
    archive: Option<bool>,
) -> Result<TransferSummary> {
    let cancel = state.begin_transfer(transfer);
    let result = async {
        // A folder as one archive, if asked for and the server can; else SFTP.
        let folder = || {
            let path = remote.clone();
            with_sftp(&state, id, |sftp| async move { sftp.is_dir(&path).await })
        };
        if archive.unwrap_or(false) && folder().await? {
            let session = state.session(id)?;
            let sent = session
                .download_archive(&remote, &local_dir, overwrite, &cancel, reporter(progress.clone()))
                .await?;
            if let Some(summary) = sent {
                return Ok(summary);
            }
        }
        with_sftp(&state, id, |sftp| async move {
            sftp.download(&remote, &local_dir, overwrite, &cancel, reporter(progress))
                .await
        })
        .await
    }
    .await;
    state.end_transfer(transfer);
    result
}

/// Uploads a local file or directory tree into a remote directory, with
/// the same overwrite rule as [`sftp_download`].
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    id: u64,
    local: PathBuf,
    remote_dir: String,
    overwrite: bool,
    transfer: u64,
    progress: Channel<Progress>,
    archive: Option<bool>,
) -> Result<TransferSummary> {
    let cancel = state.begin_transfer(transfer);
    let result = async {
        // A folder as one archive, if asked for and the server can; else SFTP.
        if archive.unwrap_or(false) && tokio::fs::metadata(&local).await.is_ok_and(|meta| meta.is_dir()) {
            let session = state.session(id)?;
            let sent = session
                .upload_archive(&local, &remote_dir, overwrite, &cancel, reporter(progress.clone()))
                .await?;
            if let Some(summary) = sent {
                return Ok(summary);
            }
        }
        with_sftp(&state, id, |sftp| async move {
            sftp.upload(&local, &remote_dir, overwrite, &cancel, reporter(progress))
                .await
        })
        .await
    }
    .await;
    state.end_transfer(transfer);
    result
}

#[tauri::command]
pub fn transfer_cancel(state: State<'_, AppState>, transfer: u64) {
    state.cancel_transfer(transfer);
}

/// Writes text to a local file the user picked in a save dialog. Used to
/// keep an editor draft when it cannot be saved to the server.
#[tauri::command]
pub async fn local_write_text(path: PathBuf, content: String) -> Result<()> {
    tokio::fs::write(&path, content).await?;
    Ok(())
}

// ------------------------------------------------------- this computer ---

#[tauri::command]
pub fn local_home() -> Result<String> {
    localfs::home()
}

#[tauri::command]
pub async fn local_resolve(path: String) -> Result<String> {
    localfs::resolve_dir(&path).await
}

#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<Entry>> {
    localfs::list(&path).await
}

/// Files dragged into the window from the system, as the file manager lists them.
#[tauri::command]
pub async fn local_entries(paths: Vec<String>) -> Vec<Entry> {
    localfs::entries(&paths).await
}

#[tauri::command]
pub async fn local_mkdir(dir: String, name: String) -> Result<String> {
    localfs::create_dir(&dir, &name).await
}

#[tauri::command]
pub async fn local_rename(path: String, name: String) -> Result<String> {
    localfs::rename(&path, &name).await
}

/// Moves local items to the system trash.
#[tauri::command]
pub async fn local_trash(paths: Vec<String>) -> Result<()> {
    localfs::trash(paths).await
}

#[tauri::command]
pub async fn local_chmod(path: String, mode: u32) -> Result<()> {
    localfs::set_permissions(&path, mode).await
}

/// The stamp of a local file, or `null` once it is gone.
#[tauri::command]
pub async fn local_stamp(path: PathBuf) -> Result<Option<Stamp>> {
    localfs::stamp(&path).await
}

// ------------------------------------------------------ other programs ---

/// Folder, inside the data folder, for working copies of remote files
/// opened in other apps. Emptied at every start.
pub const OPENED_DIR: &str = "opened";

/// Hands a file or an address to the system, to be opened by whatever it
/// uses for such things. The target is passed as one argument, never
/// through a shell, so nothing in it is taken for a command.
#[cfg(target_os = "macos")]
fn open_by_system(target: &std::ffi::OsStr) -> Result<()> {
    let output = std::process::Command::new("/usr/bin/open").arg(target).output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::Invalid(String::from_utf8_lossy(&output.stderr).trim().to_string()))
    }
}

#[cfg(target_os = "windows")]
fn open_by_system(target: &std::ffi::OsStr) -> Result<()> {
    // The system's own way of opening a file or an address by its type.
    std::process::Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(target)
        .spawn()?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_by_system(target: &std::ffi::OsStr) -> Result<()> {
    std::process::Command::new("xdg-open").arg(target).spawn()?;
    Ok(())
}

/// Opens a file with the app the system uses for it, or with the app given:
/// the path of an application bundle on a Mac, of a program elsewhere.
fn open_in(path: &std::path::Path, app: Option<&str>) -> Result<()> {
    // Tests of a development build go through everything but the launch.
    if cfg!(debug_assertions) && std::env::var_os("MYSSH_NO_OPEN").is_some() {
        return Ok(());
    }
    let Some(app) = app else {
        return open_by_system(path.as_os_str());
    };
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/open").arg("-a").arg(app).arg(path).output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(Error::Invalid(String::from_utf8_lossy(&output.stderr).trim().to_string()))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::process::Command::new(app).arg(path).spawn()?;
        Ok(())
    }
}

#[tauri::command]
pub async fn local_open(path: PathBuf, app: Option<String>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || open_in(&path, app.as_deref()))
        .await
        .map_err(|e| Error::Io(std::io::Error::other(e)))?
}

/// Opens a web address from the terminal in the default browser. Only
/// `http` and `https` addresses are passed on: what is printed in a
/// terminal comes from a server and must not get to launch anything else.
#[tauri::command]
pub async fn open_link(app: tauri::AppHandle, url: String) -> Result<()> {
    let web = (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 4096
        && !url.chars().any(|c| c.is_control() || c.is_whitespace());
    if !web {
        return Err(Error::Invalid("not a web address".into()));
    }
    if cfg!(debug_assertions) && std::env::var_os("MYSSH_NO_OPEN").is_some() {
        return Ok(());
    }
    #[cfg(mobile)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).map_err(|e| Error::Io(std::io::Error::other(e.to_string())))
    }
    #[cfg(desktop)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || open_by_system(std::ffi::OsStr::new(&url)))
            .await
            .map_err(|e| Error::Io(std::io::Error::other(e)))?
    }
}

/// Shows the page of System Settings where the app is allowed onto the
/// local network, which a direct connection in a shared session needs.
#[tauri::command]
pub async fn open_network_privacy() -> Result<()> {
    if cfg!(debug_assertions) && std::env::var_os("MYSSH_NO_OPEN").is_some() {
        return Ok(());
    }
    // The permission is macOS's; elsewhere there is no such page to show.
    if !cfg!(target_os = "macos") {
        return Err(Error::Invalid("there is no such setting on this system".into()));
    }
    tauri::async_runtime::spawn_blocking(|| {
        open_by_system(std::ffi::OsStr::new(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
        ))
    })
    .await
    .map_err(|e| Error::Io(std::io::Error::other(e)))?
}

/// A remote file opened in another app, through a working copy.
#[derive(Serialize)]
pub struct External {
    /// The working copy.
    local: String,
    /// Its folder, to be removed when the copy is no longer needed.
    dir: String,
    /// What the remote file looked like when it was fetched.
    version: FileVersion,
    stamp: Stamp,
}

/// Fetches a remote file into a working folder of its own and opens it in
/// another app. Sending later changes back is up to the caller, which
/// watches the working copy.
#[tauri::command]
pub async fn sftp_open_external(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    app: Option<String>,
) -> Result<External> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let name = path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| Error::Invalid("the path has no file name".into()))?
        .to_string();
    let dir = state.data_dir.join(OPENED_DIR).join(format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    tokio::fs::create_dir_all(&dir).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let fetched = {
        let (remote, into) = (path.clone(), dir.clone());
        with_sftp(&state, id, |sftp| async move {
            // The version first: a change during the download is then
            // noticed when the file is sent back.
            let version = sftp.version(&remote).await?;
            sftp.download(&remote, &into, true, &CancelFlag::default(), |_, _| {}).await?;
            Ok(version)
        })
        .await
    };
    let local = dir.join(&name);
    let opened = match fetched {
        Ok(version) => match localfs::stamp(&local).await {
            Ok(Some(stamp)) => {
                let (file, with) = (local.clone(), app.clone());
                tauri::async_runtime::spawn_blocking(move || open_in(&file, with.as_deref()))
                    .await
                    .map_err(|e| Error::Io(std::io::Error::other(e)))
                    .and_then(|result| result)
                    .map(|()| (version, stamp))
            }
            Ok(None) => Err(Error::NoSuchFile),
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    };
    match opened {
        Ok((version, stamp)) => Ok(External {
            local: local.to_string_lossy().into_owned(),
            dir: dir.to_string_lossy().into_owned(),
            version,
            stamp,
        }),
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            Err(e)
        }
    }
}

/// Removes the working folder of a file that is no longer watched. Only
/// folders made by [`sftp_open_external`] are accepted.
#[tauri::command]
pub async fn external_discard(state: State<'_, AppState>, dir: PathBuf) -> Result<()> {
    let root = state.data_dir.join(OPENED_DIR);
    if dir.parent() != Some(root.as_path()) || dir.file_name().is_none() {
        return Err(Error::Invalid("not a working folder".into()));
    }
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
