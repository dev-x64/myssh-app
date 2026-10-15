//! Command history per host, for suggestions while typing.
//!
//! Kept on this device only, encrypted with the vault's master key:
//! commands can carry sensitive arguments.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::keystore::{KeyStore, MasterKey};
use crate::model::Id;
use crate::vault::{open_sealed, seal, write_atomic};
use crate::{now_ms, Error, Result};

const MAGIC: &[u8; 6] = b"MTHH1\n";
const MAX_COMMAND_LEN: usize = 2048;
const MAX_PER_HOST: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    host_id: Id,
    command: String,
    count: u32,
    last_used: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Suggestion {
    pub command: String,
    /// The command was run on the host being typed into.
    pub this_host: bool,
}

/// A command run often enough to be worth keeping as a snippet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Frequent {
    pub command: String,
    /// How many times it was run, over all hosts.
    pub count: u32,
    /// On how many hosts.
    pub hosts: usize,
    pub last_used: i64,
}

/// Shorter commands are quicker to type than to pick from a list.
const MIN_FREQUENT_LEN: usize = 8;

pub struct History {
    path: PathBuf,
    key: MasterKey,
    entries: Vec<Entry>,
}

impl History {
    /// Opens the history. It needs the vault's key to exist already and
    /// never creates one. An unreadable file is set aside, not deleted, and
    /// history starts empty.
    pub fn open(path: impl Into<PathBuf>, keystore: &dyn KeyStore) -> Result<Self> {
        let path = path.into();
        let key = keystore.load()?.ok_or(Error::VaultKeyMissing)?;
        let entries = match std::fs::read(&path) {
            Ok(file) => {
                let parsed = open_sealed(&key, MAGIC, &file)
                    .and_then(|plain| Ok(serde_json::from_slice::<Vec<Entry>>(&plain)?));
                match parsed {
                    Ok(entries) => entries,
                    Err(e) => {
                        log::error!("command history unreadable, starting empty: {e}");
                        let _ = std::fs::rename(&path, path.with_extension("damaged"));
                        Vec::new()
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(History { path, key, entries })
    }

    fn save(&self) -> Result<()> {
        let plain = zeroize::Zeroizing::new(serde_json::to_vec(&self.entries)?);
        write_atomic(&self.path, &seal(&self.key, MAGIC, &plain)?)
    }

    /// Remembers a command that was run on a host.
    ///
    /// Skipped, as shells conventionally do, when the command starts with a
    /// space: that is how a user keeps one out of history.
    pub fn record(&mut self, host_id: Id, command: &str) -> Result<()> {
        if command.starts_with(' ') {
            return Ok(());
        }
        let command = command.trim();
        if command.is_empty() || command.len() > MAX_COMMAND_LEN || command.contains('\n') {
            return Ok(());
        }
        let now = now_ms();
        match self
            .entries
            .iter_mut()
            .find(|e| e.host_id == host_id && e.command == command)
        {
            Some(entry) => {
                entry.count = entry.count.saturating_add(1);
                entry.last_used = now;
            }
            None => self.entries.push(Entry {
                host_id,
                command: command.to_string(),
                count: 1,
                last_used: now,
            }),
        }
        // Keep each host's history bounded, dropping what was used longest ago.
        let mine = self.entries.iter().filter(|e| e.host_id == host_id).count();
        if mine > MAX_PER_HOST {
            let mut stamps: Vec<i64> = self
                .entries
                .iter()
                .filter(|e| e.host_id == host_id)
                .map(|e| e.last_used)
                .collect();
            stamps.sort_unstable();
            let cutoff = stamps[mine - MAX_PER_HOST];
            let mut excess = mine - MAX_PER_HOST;
            self.entries.retain(|e| {
                if excess > 0 && e.host_id == host_id && e.last_used <= cutoff && e.command != command {
                    excess -= 1;
                    false
                } else {
                    true
                }
            });
        }
        self.save()
    }

    /// Commands that continue what has been typed. The host's own history
    /// comes first, most recent first; other hosts follow.
    pub fn suggest(&self, host_id: Id, typed: &str, limit: usize) -> Vec<Suggestion> {
        let typed = typed.trim_start();
        if typed.is_empty() {
            return Vec::new();
        }
        let mut matches: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|e| e.command.len() > typed.len() && e.command.starts_with(typed))
            .collect();
        matches.sort_by(|a, b| {
            (b.host_id == host_id)
                .cmp(&(a.host_id == host_id))
                .then(b.last_used.cmp(&a.last_used))
                .then(b.count.cmp(&a.count))
        });
        let mut seen = std::collections::HashSet::new();
        matches
            .into_iter()
            .filter(|e| seen.insert(e.command.as_str()))
            .take(limit)
            .map(|e| Suggestion {
                command: e.command.clone(),
                this_host: e.host_id == host_id,
            })
            .collect()
    }

    /// The commands run most often, over all hosts, most used first.
    pub fn frequent(&self, limit: usize) -> Vec<Frequent> {
        let mut merged: std::collections::HashMap<&str, Frequent> = std::collections::HashMap::new();
        for entry in &self.entries {
            if entry.command.chars().count() < MIN_FREQUENT_LEN {
                continue;
            }
            let found = merged.entry(entry.command.as_str()).or_insert_with(|| Frequent {
                command: entry.command.clone(),
                count: 0,
                hosts: 0,
                last_used: 0,
            });
            found.count = found.count.saturating_add(entry.count);
            found.hosts += 1;
            found.last_used = found.last_used.max(entry.last_used);
        }
        let mut found: Vec<Frequent> = merged.into_values().collect();
        found.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then(b.last_used.cmp(&a.last_used))
                .then(a.command.cmp(&b.command))
        });
        found.truncate(limit);
        found
    }

    /// Forgets the history of one host, or all of it.
    pub fn clear(&mut self, host_id: Option<Id>) -> Result<()> {
        match host_id {
            Some(id) => self.entries.retain(|e| e.host_id != id),
            None => self.entries.clear(),
        }
        self.save()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::FileKeyStore;
    use uuid::Uuid;

    fn keystore(dir: &std::path::Path) -> FileKeyStore {
        let store = FileKeyStore::new(dir.join("master.key"));
        store.store(&zeroize::Zeroizing::new([9u8; 32])).unwrap();
        store
    }

    fn commands(found: Vec<Suggestion>) -> Vec<(String, bool)> {
        found.into_iter().map(|s| (s.command, s.this_host)).collect()
    }

    #[test]
    fn ranks_this_host_first_and_persists_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let store = keystore(dir.path());
        let path = dir.path().join("history.bin");
        let (web, db) = (Uuid::new_v4(), Uuid::new_v4());

        let mut history = History::open(&path, &store).unwrap();
        history.record(db, "systemctl status postgresql").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        history.record(web, "systemctl restart nginx").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        history.record(web, "systemctl status nginx").unwrap();
        history.record(web, "  systemctl status nginx  ").unwrap_or(());
        history.record(web, " secret-thing --token abc").unwrap();
        history.record(web, "").unwrap();
        history.record(web, "multi\nline").unwrap();
        assert_eq!(history.len(), 3);

        assert_eq!(
            commands(history.suggest(web, "systemctl s", 10)),
            vec![
                ("systemctl status nginx".to_string(), true),
                ("systemctl status postgresql".to_string(), false),
            ]
        );
        // From the other host's point of view the order flips.
        assert_eq!(
            commands(history.suggest(db, "systemctl", 10))[0],
            ("systemctl status postgresql".to_string(), true)
        );
        assert_eq!(history.suggest(web, "systemctl", 1).len(), 1);
        // Nothing to add to a command typed in full, and nothing for nothing.
        assert!(history.suggest(web, "systemctl status nginx", 10).is_empty());
        assert!(history.suggest(web, "  ", 10).is_empty());
        assert!(history.suggest(web, "secret", 10).is_empty());

        // On disk: not readable, and back after a reopen.
        let raw = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
        assert!(!raw.contains("systemctl"));
        let mut history = History::open(&path, &store).unwrap();
        assert_eq!(history.suggest(web, "systemctl r", 10).len(), 1);

        history.clear(Some(web)).unwrap();
        assert_eq!(history.len(), 1);
        history.clear(None).unwrap();
        assert!(History::open(&path, &store).unwrap().is_empty());
    }

    #[test]
    fn frequent_commands_are_counted_over_all_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let keys = keystore(dir.path());
        let mut history = History::open(dir.path().join("history.bin"), &keys).unwrap();
        let (a, b) = (Id::new_v4(), Id::new_v4());
        for _ in 0..2 {
            history.record(a, "docker compose up -d").unwrap();
        }
        history.record(b, "docker compose up -d").unwrap();
        history.record(b, "systemctl restart nginx").unwrap();
        for _ in 0..9 {
            history.record(a, "ls -la").unwrap();
        }
        let found = history.frequent(10);
        assert_eq!(
            found.iter().map(|f| (f.command.as_str(), f.count, f.hosts)).collect::<Vec<_>>(),
            vec![("docker compose up -d", 3, 2), ("systemctl restart nginx", 1, 1)]
        );
        assert_eq!(history.frequent(1).len(), 1);
    }

    #[test]
    fn bounded_per_host_and_survives_a_damaged_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = keystore(dir.path());
        let path = dir.path().join("history.bin");
        let host = Uuid::new_v4();

        let mut history = History::open(&path, &store).unwrap();
        // Writing on every record is too slow for a thousand entries here.
        for i in 0..MAX_PER_HOST + 5 {
            history.entries.push(Entry {
                host_id: host,
                command: format!("cmd {i}"),
                count: 1,
                last_used: i as i64,
            });
        }
        history.record(host, "newest").unwrap();
        assert_eq!(history.len(), MAX_PER_HOST);
        assert!(history.suggest(host, "cmd 0", 5).is_empty());
        assert_eq!(history.suggest(host, "newes", 5).len(), 1);

        std::fs::write(&path, b"MTHH1\nnot really encrypted data, just junk....").unwrap();
        let history = History::open(&path, &store).unwrap();
        assert!(history.is_empty());
        assert!(path.with_extension("damaged").exists());

        // Without the vault key there is no history, and none is invented.
        std::fs::remove_file(dir.path().join("master.key")).unwrap();
        assert!(matches!(
            History::open(&path, &FileKeyStore::new(dir.path().join("master.key"))),
            Err(Error::VaultKeyMissing)
        ));
    }
}
