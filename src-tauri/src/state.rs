use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use myssh_core::error::ErrorInfo;
use myssh_core::history::History;
use myssh_core::keystore::FileKeyStore;
use myssh_core::known_hosts::KnownHosts;
use myssh_core::sftp::{CancelFlag, Sftp};
use myssh_core::model::Id;
use myssh_core::ssh::{Forward, ForwardStatus, SessionHandle};
use myssh_core::vault::Vault;
use myssh_core::{Error, Result};

pub struct AppState {
    pub data_dir: PathBuf,
    vault: Mutex<Option<Vault>>,
    /// Why the vault could not be opened, if it could not.
    vault_error: Mutex<Option<ErrorInfo>>,
    pub known_hosts: Arc<Mutex<KnownHosts>>,
    sessions: Mutex<HashMap<u64, Arc<SessionHandle>>>,
    /// Terminals on this computer, numbered along with the sessions.
    locals: Mutex<HashMap<u64, Arc<crate::local::LocalShell>>>,
    next_session: AtomicU64,
    /// File transfer channels, one per terminal session, opened on demand.
    sftp: Mutex<HashMap<u64, Arc<Sftp>>>,
    /// Ports forwarded through each session's connection, by forward id.
    /// They close with the session.
    forwards: Mutex<HashMap<u64, HashMap<Id, Forward>>>,
    transfers: Mutex<HashMap<u64, CancelFlag>>,
    /// Command history; absent when the vault key is unavailable.
    history: Mutex<Option<History>>,
    /// Held for the length of a sync, so two never run at once.
    pub sync_lock: tokio::sync::Mutex<()>,
}

/// The vault's master key lives in a file beside the vault.
fn keystore(data_dir: &std::path::Path) -> FileKeyStore {
    FileKeyStore::new(data_dir.join("master.key"))
}

/// What is sealed with the vault key: the vault and the command history.
struct Stores {
    vault: Option<Vault>,
    /// Why the vault could not be opened, if it could not.
    error: Option<ErrorInfo>,
    history: Option<History>,
}

impl Stores {
    fn open(data_dir: &std::path::Path) -> Self {
        let prepared = std::fs::create_dir_all(data_dir).map_err(Error::from);
        let keystore = keystore(data_dir);
        let opened = prepared.and_then(|_| Vault::open(data_dir.join("vault.bin"), &keystore));
        let (vault, error) = match opened {
            Ok(vault) => (Some(vault), None),
            Err(e) => {
                log::error!("vault unavailable: {e}");
                (None, Some(e.info()))
            }
        };
        // History reuses the vault key, so it is opened only once the vault is.
        let history = vault.as_ref().and_then(|_| {
            History::open(data_dir.join("history.bin"), &keystore)
                .map_err(|e| log::error!("command history unavailable: {e}"))
                .ok()
        });
        Stores { vault, error, history }
    }
}

impl AppState {
    pub fn open(app_data_dir: PathBuf) -> Self {
        // Debug and release builds never share data. A debug build can also
        // be pointed at another folder, to run a second "device" side by side.
        let data_dir = if cfg!(debug_assertions) {
            std::env::var_os("MYSSH_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| app_data_dir.join("dev"))
        } else {
            app_data_dir
        };
        let stores = Stores::open(&data_dir);
        // Working copies of remote files opened in other apps belong to
        // the run that made them.
        let _ = std::fs::remove_dir_all(data_dir.join(crate::files::OPENED_DIR));
        let known_hosts_path = data_dir.join("known_hosts.json");
        let known_hosts = KnownHosts::open(&known_hosts_path).unwrap_or_else(|e| {
            // An unreadable list must not be silently replaced: keep it aside
            // and start empty, so every host is confirmed again.
            log::error!("known hosts unreadable: {e}");
            let _ = std::fs::rename(
                &known_hosts_path,
                known_hosts_path.with_extension("json.damaged"),
            );
            KnownHosts::open(&known_hosts_path).expect("empty known hosts")
        });
        AppState {
            history: Mutex::new(stores.history),
            sync_lock: tokio::sync::Mutex::new(()),
            data_dir,
            vault: Mutex::new(stores.vault),
            vault_error: Mutex::new(stores.error),
            known_hosts: Arc::new(Mutex::new(known_hosts)),
            sessions: Mutex::new(HashMap::new()),
            locals: Mutex::new(HashMap::new()),
            next_session: AtomicU64::new(1),
            sftp: Mutex::new(HashMap::new()),
            forwards: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
        }
    }

    pub fn vault_error(&self) -> Option<ErrorInfo> {
        self.vault_error.lock().unwrap().clone()
    }

    /// Tries once more to open a vault that could not be opened: the key
    /// file may have been put back.
    pub fn retry_vault(&self) {
        let mut vault = self.vault.lock().unwrap();
        if vault.is_none() {
            self.install(&mut vault, Stores::open(&self.data_dir));
        }
    }

    /// Starts an empty vault in place of one that cannot be opened. The
    /// unreadable vault, its key and the history sealed with that key go to
    /// the system trash; nothing is erased outright. Refused while a vault
    /// is open: a working vault is never replaced.
    pub fn replace_vault(&self) -> Result<()> {
        let mut vault = self.vault.lock().unwrap();
        if vault.is_some() {
            return Err(Error::Invalid("the vault is open".into()));
        }
        let old: Vec<PathBuf> = ["vault.bin", "master.key", "history.bin"]
            .iter()
            .map(|name| self.data_dir.join(name))
            .filter(|path| path.exists())
            .collect();
        myssh_core::localfs::trash_now(&old)?;
        let stores = Stores::open(&self.data_dir);
        let failed = stores.error.clone();
        self.install(&mut vault, stores);
        match failed {
            Some(e) => Err(Error::VaultUnavailable(e.message)),
            None => Ok(()),
        }
    }

    fn install(&self, vault: &mut Option<Vault>, stores: Stores) {
        *vault = stores.vault;
        *self.vault_error.lock().unwrap() = stores.error;
        *self.history.lock().unwrap() = stores.history;
    }

    pub fn with_vault<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T>) -> Result<T> {
        let mut guard = self.vault.lock().unwrap();
        match guard.as_mut() {
            Some(vault) => f(vault),
            None => Err(Error::VaultUnavailable(
                self.vault_error().map(|e| e.message).unwrap_or_default(),
            )),
        }
    }

    /// Runs `f` on the command history. Without history it does nothing and
    /// yields the default value: suggestions are a convenience, not a need.
    pub fn with_history<T: Default>(&self, f: impl FnOnce(&mut History) -> Result<T>) -> Result<T> {
        match self.history.lock().unwrap().as_mut() {
            Some(history) => f(history),
            None => Ok(T::default()),
        }
    }

    pub fn add_session(&self, handle: Arc<SessionHandle>) -> u64 {
        let id = self.next_session.fetch_add(1, Ordering::Relaxed);
        self.sessions.lock().unwrap().insert(id, handle);
        id
    }

    pub fn add_local(&self, shell: Arc<crate::local::LocalShell>) -> u64 {
        let id = self.next_session.fetch_add(1, Ordering::Relaxed);
        self.locals.lock().unwrap().insert(id, shell);
        id
    }

    pub fn local(&self, id: u64) -> Option<Arc<crate::local::LocalShell>> {
        self.locals.lock().unwrap().get(&id).cloned()
    }

    pub fn remove_local(&self, id: u64) -> Option<Arc<crate::local::LocalShell>> {
        self.locals.lock().unwrap().remove(&id)
    }

    pub fn drain_locals(&self) -> Vec<Arc<crate::local::LocalShell>> {
        self.locals.lock().unwrap().drain().map(|(_, s)| s).collect()
    }

    pub fn session(&self, id: u64) -> Result<Arc<SessionHandle>> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or(Error::SessionClosed)
    }

    pub fn remove_session(&self, id: u64) -> Option<Arc<SessionHandle>> {
        self.sftp.lock().unwrap().remove(&id);
        self.forwards.lock().unwrap().remove(&id);
        self.sessions.lock().unwrap().remove(&id)
    }

    pub fn drain_sessions(&self) -> Vec<Arc<SessionHandle>> {
        self.sftp.lock().unwrap().clear();
        self.forwards.lock().unwrap().clear();
        self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect()
    }

    /// The file transfer channel of a terminal session, opened on first use.
    pub async fn sftp(&self, session_id: u64) -> Result<Arc<Sftp>> {
        if let Some(existing) = self.sftp.lock().unwrap().get(&session_id).cloned() {
            return Ok(existing);
        }
        let opened = Arc::new(self.session(session_id)?.open_sftp().await?);
        // The session may have ended while the channel was opening.
        self.session(session_id)?;
        let mut channels = self.sftp.lock().unwrap();
        Ok(channels.entry(session_id).or_insert(opened).clone())
    }

    /// Keeps an open forward with its session. Refused, closing it, when
    /// the session ended while it was being opened.
    pub fn add_forward(&self, session_id: u64, forward_id: Id, forward: Forward) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        if !sessions.contains_key(&session_id) {
            return Err(Error::SessionClosed);
        }
        let mut forwards = self.forwards.lock().unwrap();
        forwards.entry(session_id).or_default().insert(forward_id, forward);
        Ok(())
    }

    /// Closes a forward, freeing its port. Whether it was open.
    pub fn stop_forward(&self, session_id: u64, forward_id: Id) -> bool {
        let mut forwards = self.forwards.lock().unwrap();
        forwards
            .get_mut(&session_id)
            .and_then(|open| open.remove(&forward_id))
            .is_some()
    }

    pub fn forward_status(&self, session_id: u64) -> HashMap<Id, ForwardStatus> {
        let forwards = self.forwards.lock().unwrap();
        forwards
            .get(&session_id)
            .map(|open| open.iter().map(|(id, f)| (*id, f.status())).collect())
            .unwrap_or_default()
    }

    /// Forgets a channel that stopped working so the next use reopens it.
    pub fn drop_sftp(&self, session_id: u64) {
        self.sftp.lock().unwrap().remove(&session_id);
    }

    pub fn begin_transfer(&self, id: u64) -> CancelFlag {
        let flag = CancelFlag::default();
        self.transfers.lock().unwrap().insert(id, flag.clone());
        flag
    }

    pub fn end_transfer(&self, id: u64) {
        self.transfers.lock().unwrap().remove(&id);
    }

    pub fn cancel_transfer(&self, id: u64) {
        if let Some(flag) = self.transfers.lock().unwrap().get(&id) {
            flag.cancel();
        }
    }
}

impl myssh_core::cloud::VaultAccess for AppState {
    fn with_vault<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T>) -> Result<T> {
        AppState::with_vault(self, f)
    }

    fn known_hosts(&self) -> Option<&Mutex<KnownHosts>> {
        Some(&self.known_hosts)
    }
}
