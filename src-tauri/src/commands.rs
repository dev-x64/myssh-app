use std::sync::Arc;

use myssh_core::error::ErrorInfo;
use myssh_core::keys::{self, KeyKind};
use myssh_core::known_hosts::KnownHost;
use myssh_core::model::*;
use myssh_core::ssh::{
    self, ConnectParams, InstallParams, KeyParams, PromptReply, Remember, SessionEvent,
    SessionOutput,
};
use myssh_core::{Error, Result};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::state::AppState;

/// Emitted whenever vault content changes outside of a direct UI request.
const VAULT_CHANGED: &str = "vault-changed";
/// Output chunks are merged up to this size before crossing into the webview.
const MAX_OUTPUT_BATCH: usize = 256 * 1024;

#[derive(Serialize)]
pub struct AppStatus {
    version: String,
    data_dir: String,
    debug: bool,
    vault_error: Option<ErrorInfo>,
    /// This build has a cloud server to talk to.
    cloud_available: bool,
    /// This build updates itself, rather than being updated by a store.
    updates: bool,
}

#[tauri::command]
pub fn app_status(app: AppHandle, state: State<'_, AppState>) -> AppStatus {
    AppStatus {
        // The version the bundle carries; it is what updates are compared with.
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.display().to_string(),
        debug: cfg!(debug_assertions),
        vault_error: state.vault_error(),
        cloud_available: !crate::cloud::SERVER.is_empty(),
        updates: crate::update::enabled(),
    }
}

/// Tries again to open a vault that could not be opened at start.
#[tauri::command]
pub fn vault_retry(app: AppHandle, state: State<'_, AppState>) -> AppStatus {
    state.retry_vault();
    app_status(app, state)
}

/// Starts an empty vault in place of one that cannot be opened; the old
/// files go to the trash.
#[tauri::command]
pub fn vault_replace(state: State<'_, AppState>) -> Result<()> {
    state.replace_vault()
}

/// Whether the disk is encrypted: the vault key lies beside the vault, so
/// that is what protects them on a computer that is lost or stolen. Only
/// macOS is asked; elsewhere the answer is "unknown".
#[tauri::command]
pub async fn disk_encryption() -> &'static str {
    if !cfg!(target_os = "macos") {
        return "unknown";
    }
    let asked = tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("/usr/bin/fdesetup").arg("status").output()
    })
    .await;
    match asked.map_err(std::io::Error::other).and_then(|out| out) {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.contains("FileVault is On") {
                "on"
            } else if text.contains("FileVault is Off") {
                "off"
            } else {
                "unknown"
            }
        }
        Err(_) => "unknown",
    }
}

/// What `bash -n` says of a snippet's script.
#[derive(serde::Serialize)]
pub struct ScriptCheck {
    /// bash was there to ask; on Windows it usually is not.
    checked: bool,
    /// The first syntax error, in bash's words, without its "line N:".
    error: Option<String>,
    line: Option<u32>,
}

/// Checks a snippet's syntax with `bash -n`, which reads the script and
/// runs none of it. The script goes in on standard input: nothing is
/// written anywhere.
#[tauri::command]
pub async fn script_check(script: String) -> ScriptCheck {
    let unchecked = ScriptCheck { checked: false, error: None, line: None };
    if cfg!(windows) || script.len() > 200_000 {
        return unchecked;
    }
    let ran = tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("bash")
            .arg("-n")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        child.stdin.take().expect("piped").write_all(script.as_bytes())?;
        child.wait_with_output()
    })
    .await;
    let Ok(Ok(output)) = ran else { return unchecked };
    if output.status.success() {
        return ScriptCheck { checked: true, error: None, line: None };
    }
    // "bash: line 3: syntax error near unexpected token `fi'"
    let said = String::from_utf8_lossy(&output.stderr);
    let first = said.lines().find(|l| !l.trim().is_empty()).unwrap_or("syntax error").trim();
    let rest = first.strip_prefix("bash: ").unwrap_or(first);
    let (line, text) = match rest.strip_prefix("line ").and_then(|r| r.split_once(": ")) {
        Some((number, text)) => (number.trim().parse().ok(), text.to_string()),
        None => (None, rest.to_string()),
    };
    ScriptCheck { checked: true, error: Some(text), line }
}

/// Rebuilds the application menu in the UI language.
#[tauri::command]
pub fn menu_set_locale(app: AppHandle, locale: String) -> std::result::Result<(), String> {
    crate::menu::install(&app, &locale).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_snapshot(state: State<'_, AppState>) -> Result<Snapshot> {
    state.with_vault(|v| Ok(v.snapshot()))
}

// -------------------------------------------------------------- hosts ---

#[tauri::command]
pub fn host_save(state: State<'_, AppState>, input: HostInput) -> Result<HostView> {
    state.with_vault(|v| v.save_host(input))
}

#[tauri::command]
pub fn host_delete(state: State<'_, AppState>, id: Id) -> Result<()> {
    state.with_vault(|v| v.delete_host(id))?;
    // The host's command history goes with it.
    if let Err(e) = state.with_history(|h| h.clear(Some(id))) {
        log::error!("could not clear the history of a deleted host: {e}");
    }
    Ok(())
}

/// Moves a host into a group, or out of all groups with `null`.
#[tauri::command]
pub fn host_move(state: State<'_, AppState>, id: Id, group_id: Option<Id>) -> Result<HostView> {
    state.with_vault(|v| v.move_host(id, group_id))
}

/// Pins a host before the others in its list, or unpins it.
#[tauri::command]
pub fn host_pin(state: State<'_, AppState>, id: Id, pinned: bool) -> Result<HostView> {
    state.with_vault(|v| v.pin_host(id, pinned))
}

#[tauri::command]
pub fn host_duplicate(state: State<'_, AppState>, id: Id, suffix: String) -> Result<HostView> {
    state.with_vault(|v| v.duplicate_host(id, &suffix))
}

#[tauri::command]
pub fn group_save(state: State<'_, AppState>, input: GroupInput) -> Result<Group> {
    state.with_vault(|v| v.save_group(input))
}

#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, id: Id) -> Result<()> {
    state.with_vault(|v| v.delete_group(id))
}

#[tauri::command]
pub fn snippet_targets(state: State<'_, AppState>, id: Id, targets: Vec<Id>) -> Result<Snippet> {
    state.with_vault(|v| v.set_snippet_targets(id, targets))
}

#[tauri::command]
pub fn snippet_save(state: State<'_, AppState>, input: SnippetInput) -> Result<Snippet> {
    state.with_vault(|v| v.save_snippet(input))
}

#[tauri::command]
pub fn snippet_delete(state: State<'_, AppState>, id: Id) -> Result<()> {
    state.with_vault(|v| v.delete_snippet(id))
}

// ----------------------------------------------------------- keychain ---

#[tauri::command]
pub fn identity_save(state: State<'_, AppState>, input: IdentityInput) -> Result<IdentityView> {
    state.with_vault(|v| v.save_identity(input))
}

#[tauri::command]
pub fn identity_delete(state: State<'_, AppState>, id: Id) -> Result<()> {
    state.with_vault(|v| v.delete_identity(id))
}

/// Who else holds the credentials a host keeps for itself.
#[tauri::command]
pub fn host_shared_credentials(state: State<'_, AppState>, id: Id) -> Result<SharedCredentials> {
    state.with_vault(|v| v.shared_credentials(id))
}

/// Gathers the credentials a host shares with others into one identity.
#[tauri::command]
pub fn host_gather_credentials(state: State<'_, AppState>, id: Id, label: String) -> Result<IdentityView> {
    state.with_vault(|v| v.gather_credentials(id, &label))
}

/// A saved password, for the user who asked to see it. The window is
/// given one only through these two, and only when the eye is pressed.
#[tauri::command]
pub fn host_password(state: State<'_, AppState>, id: Id) -> Result<Option<String>> {
    state.with_vault(|v| v.host_password(id))
}

#[tauri::command]
pub fn identity_password(state: State<'_, AppState>, id: Id) -> Result<Option<String>> {
    state.with_vault(|v| v.identity_password(id))
}

#[tauri::command]
pub async fn key_generate(
    state: State<'_, AppState>,
    kind: KeyKind,
    label: String,
) -> Result<KeyView> {
    // RSA generation takes a while; keep it off the UI and async threads.
    let key = tauri::async_runtime::spawn_blocking(move || keys::generate(kind, &label))
        .await
        .map_err(|e| Error::Key(e.to_string()))??;
    state.with_vault(|v| v.add_key(key))
}

#[tauri::command]
pub async fn key_import(
    state: State<'_, AppState>,
    text: String,
    passphrase: Option<String>,
    save_passphrase: bool,
    label: String,
) -> Result<KeyView> {
    let key = tauri::async_runtime::spawn_blocking(move || {
        keys::import(&text, passphrase.as_deref(), save_passphrase, &label)
    })
    .await
    .map_err(|e| Error::Key(e.to_string()))??;
    state.with_vault(|v| v.add_key(key))
}

#[tauri::command]
pub fn key_rename(state: State<'_, AppState>, id: Id, label: String) -> Result<KeyView> {
    state.with_vault(|v| v.rename_key(id, &label))
}

#[tauri::command]
pub fn key_delete(state: State<'_, AppState>, id: Id) -> Result<()> {
    state.with_vault(|v| v.delete_key(id))
}

// ------------------------------------------------------------ history ---

/// Remembers a command run on a host, for later suggestions.
#[tauri::command]
pub fn history_record(state: State<'_, AppState>, host_id: Id, command: String) -> Result<()> {
    state.with_history(|h| h.record(host_id, &command))
}

#[tauri::command]
pub fn history_suggest(
    state: State<'_, AppState>,
    host_id: Id,
    typed: String,
    limit: usize,
) -> Result<Vec<myssh_core::history::Suggestion>> {
    state.with_history(|h| Ok(h.suggest(host_id, &typed, limit)))
}

/// The commands run most often: candidates for snippets.
#[tauri::command]
pub fn history_frequent(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<myssh_core::history::Frequent>> {
    state.with_history(|h| Ok(h.frequent(limit)))
}

/// Forgets the command history of one host, or of all hosts.
#[tauri::command]
pub fn history_clear(state: State<'_, AppState>, host_id: Option<Id>) -> Result<()> {
    state.with_history(|h| h.clear(host_id))
}

// -------------------------------------------------------- known hosts ---

#[tauri::command]
pub fn known_hosts_list(state: State<'_, AppState>) -> Vec<KnownHost> {
    state.known_hosts.lock().unwrap().entries().to_vec()
}

#[tauri::command]
pub fn known_host_forget(state: State<'_, AppState>, host: String, port: u16) -> Result<bool> {
    state.known_hosts.lock().unwrap().forget(&host, port)
}

// ----------------------------------------------------------- sessions ---

fn remember(app: &AppHandle, host_id: Id, secret: Remember) {
    let state = app.state::<AppState>();
    let saved = state.with_vault(|v| match secret {
        Remember::Username(username) => v.remember_username(host_id, username),
        Remember::Password(password) => v.remember_password(host_id, password),
        Remember::Passphrase { key_id, passphrase } => v.remember_passphrase(key_id, passphrase),
    });
    match saved {
        Ok(()) => {
            let _ = app.emit(VAULT_CHANGED, ());
        }
        Err(e) => log::error!("could not save a remembered secret: {e}"),
    }
}

/// Opens a terminal session to a saved host.
///
/// `events` carries [`SessionEvent`]s as JSON; `output` carries raw terminal
/// bytes. The returned id addresses the session in the other commands.
///
/// `run_startup` is set only when the user opens the host; reconnections
/// leave it off so that they never run anything on their own.
#[tauri::command]
pub async fn session_open(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: Id,
    cols: u32,
    rows: u32,
    run_startup: bool,
    events: Channel<SessionEvent>,
    output: Channel<InvokeResponseBody>,
) -> Result<u64> {
    let (host, credentials, startup) = state.with_vault(|v| {
        let (host, credentials) = v.resolve_credentials(host_id)?;
        let startup = run_startup.then(|| v.startup_script(&host)).flatten();
        Ok((host, credentials, startup))
    })?;
    let params = ConnectParams {
        host: host.address,
        port: host.port,
        username: credentials.username,
        password: credentials.password,
        key: credentials.key.map(|k| KeyParams {
            id: k.id,
            label: k.label,
            private_key: k.private_key,
            passphrase: k.passphrase,
        }),
        startup,
        cols,
        rows,
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = Arc::new(ssh::spawn(params, state.known_hosts.clone(), tx));
    let id = state.add_session(handle);

    tauri::async_runtime::spawn(async move {
        let mut carried: Option<SessionOutput> = None;
        loop {
            let next = match carried.take() {
                Some(item) => item,
                None => match rx.recv().await {
                    Some(item) => item,
                    None => break,
                },
            };
            match next {
                SessionOutput::Data(mut bytes) => {
                    // Merge whatever output is already waiting into one message.
                    while bytes.len() < MAX_OUTPUT_BATCH {
                        match rx.try_recv() {
                            Ok(SessionOutput::Data(more)) => bytes.extend_from_slice(&more),
                            Ok(other) => {
                                carried = Some(other);
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    let _ = output.send(InvokeResponseBody::Raw(bytes));
                }
                SessionOutput::Event(event) => {
                    let closed = matches!(event, SessionEvent::Closed { .. });
                    if matches!(event, SessionEvent::Connected) {
                        note_host_os(app.clone(), id, host_id);
                    }
                    let _ = events.send(event);
                    if closed {
                        break;
                    }
                }
                SessionOutput::Remember(secret) => remember(&app, host_id, secret),
            }
        }
        app.state::<AppState>().remove_session(id);
    });

    Ok(id)
}

/// Once connected, asks the server which system it runs and remembers the
/// answer on the host. It is a read-only question on a side channel; the
/// terminal is not involved.
fn note_host_os(app: AppHandle, session_id: u64, host_id: Id) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Ok(session) = state.session(session_id) else {
            return;
        };
        let Ok(Some(os)) = session.detect_os().await else {
            return;
        };
        if let Ok(true) = state.with_vault(|v| v.set_host_os(host_id, os)) {
            let _ = app.emit(VAULT_CHANGED, ());
        }
    });
}

/// Installs a keychain key on a host through the host's current
/// credentials, then proves it by signing in with that key alone.
///
/// Reports through the same events as a terminal session and can be
/// answered and cancelled the same way. It does not change the host: once
/// `key_verified` arrives the UI may call [`host_assign_key`].
/// The script installing a key runs on each server, to be shown before it does.
#[tauri::command]
pub fn key_install_script(state: State<'_, AppState>, key_id: Id) -> Result<String> {
    let key = state.with_vault(|v| v.key(key_id))?;
    ssh::install_script(&key.public_key, &ssh::install_comment(&key.label))
}

#[tauri::command]
pub async fn key_install(
    app: AppHandle,
    state: State<'_, AppState>,
    key_id: Id,
    host_id: Id,
    events: Channel<SessionEvent>,
) -> Result<u64> {
    let (host, credentials, key) = state.with_vault(|v| {
        let (host, credentials) = v.resolve_credentials(host_id)?;
        Ok((host, credentials, v.key(key_id)?))
    })?;
    let params = InstallParams {
        connect: ConnectParams {
            host: host.address,
            port: host.port,
            username: credentials.username,
            password: credentials.password,
            key: credentials.key.map(|k| KeyParams {
                id: k.id,
                label: k.label,
                private_key: k.private_key,
                passphrase: k.passphrase,
            }),
            startup: None,
            cols: 80,
            rows: 24,
        },
        public_key: key.public_key.clone(),
        comment: ssh::install_comment(&key.label),
        key: KeyParams {
            id: key.id,
            label: key.label,
            private_key: key.private_key,
            passphrase: key.passphrase,
        },
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = Arc::new(ssh::spawn_install(params, state.known_hosts.clone(), tx));
    let id = state.add_session(handle);
    tauri::async_runtime::spawn(async move {
        while let Some(output) = rx.recv().await {
            match output {
                SessionOutput::Event(event) => {
                    let closed = matches!(event, SessionEvent::Closed { .. });
                    let _ = events.send(event);
                    if closed {
                        break;
                    }
                }
                SessionOutput::Remember(secret) => remember(&app, host_id, secret),
                SessionOutput::Data(_) => {}
            }
        }
        app.state::<AppState>().remove_session(id);
    });
    Ok(id)
}

/// Makes a host use a key. Returns `false`, changing nothing, when the
/// host's credentials come from a shared identity.
#[tauri::command]
pub fn host_assign_key(state: State<'_, AppState>, host_id: Id, key_id: Id) -> Result<bool> {
    state.with_vault(|v| v.assign_key(host_id, key_id))
}

#[tauri::command]
pub fn session_write(state: State<'_, AppState>, id: u64, data: String) -> Result<()> {
    if let Some(local) = state.local(id) {
        return local.write(data.as_bytes());
    }
    state.session(id)?.write(data.into_bytes())
}

#[tauri::command]
pub fn session_resize(state: State<'_, AppState>, id: u64, cols: u32, rows: u32) -> Result<()> {
    if let Some(local) = state.local(id) {
        return local.resize(cols, rows);
    }
    state.session(id)?.resize(cols, rows)
}

#[tauri::command]
pub fn session_reply(
    state: State<'_, AppState>,
    id: u64,
    prompt_id: u64,
    reply: PromptReply,
) -> Result<()> {
    state.session(id)?.reply(prompt_id, reply)
}

/// The terminal's working directory on the server, when it can be found.
#[tauri::command]
pub async fn session_cwd(state: State<'_, AppState>, id: u64) -> Result<Option<String>> {
    let session = state.session(id)?;
    session.working_directory().await
}

/// How busy a host is, for its tile in advanced mode: a quiet look with
/// what the host has saved, asking nobody anything (see `ssh::probe_stats`).
#[tauri::command]
pub async fn host_stats(state: State<'_, AppState>, host_id: Id) -> Result<myssh_core::ssh::ServerStats> {
    let (host, credentials) = state.with_vault(|v| v.resolve_credentials(host_id))?;
    let params = ConnectParams {
        host: host.address,
        port: host.port,
        username: credentials.username,
        password: credentials.password,
        key: credentials.key.map(|k| KeyParams {
            id: k.id,
            label: k.label,
            private_key: k.private_key,
            passphrase: k.passphrase,
        }),
        startup: None,
        cols: 80,
        rows: 24,
    };
    ssh::probe_stats(params, state.known_hosts.clone()).await
}

/// How busy the server is, for advanced mode.
#[tauri::command]
pub async fn session_stats(state: State<'_, AppState>, id: u64) -> Result<myssh_core::ssh::ServerStats> {
    let session = state.session(id)?;
    session.server_stats().await
}

/// The name of the account's login shell on the server, when it says.
#[tauri::command]
pub async fn session_shell(state: State<'_, AppState>, id: u64) -> Result<Option<String>> {
    let session = state.session(id)?;
    session.login_shell().await
}

#[tauri::command]
pub fn session_ack(state: State<'_, AppState>, id: u64, bytes: usize) {
    if let Some(local) = state.local(id) {
        local.ack(bytes);
    } else if let Ok(session) = state.session(id) {
        session.ack(bytes);
    }
}

#[tauri::command]
pub fn session_close(state: State<'_, AppState>, id: u64) {
    if let Some(local) = state.local(id) {
        // Removed once the shell has ended and said so.
        local.close();
    } else if let Some(session) = state.remove_session(id) {
        session.close();
    }
}

/// Closes every session. The UI calls this on start-up so a reloaded window
/// does not leave connections running that it can no longer reach.
#[tauri::command]
pub fn session_close_all(state: State<'_, AppState>) {
    for session in state.drain_sessions() {
        session.close();
    }
    for local in state.drain_locals() {
        local.close();
    }
}
