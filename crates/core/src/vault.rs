//! Encrypted local store for hosts, groups, identities and keys.
//!
//! File layout: `MAGIC (6) | nonce (24) | XChaCha20-Poly1305 ciphertext`,
//! with the magic bound in as associated data. The plaintext is the JSON
//! form of [`VaultData`].

use std::io::Write;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::keys::{self, KeyKind};
use crate::keystore::{KeyStore, MasterKey, KEY_LEN};
use crate::model::*;
use crate::{now_ms, Error, Result};

const MAGIC: &[u8; 6] = b"MTHV1\n";
const NONCE_LEN: usize = 24;
const DATA_VERSION: u32 = 1;

/// Writes a file so that a crash leaves either the old or the new content.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Encrypts a file body. `magic` identifies the file type and is bound in
/// as associated data, so one kind of file cannot be passed off as another.
pub(crate) fn seal(key: &MasterKey, magic: &[u8; 6], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: magic,
            },
        )
        .map_err(|_| Error::VaultFormat)?;
    let mut out = Vec::with_capacity(magic.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(magic);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub(crate) fn open_sealed(
    key: &MasterKey,
    magic: &[u8; 6],
    file: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    if file.len() < magic.len() + NONCE_LEN || &file[..magic.len()] != magic {
        return Err(Error::VaultFormat);
    }
    let (nonce, ciphertext) = file[magic.len()..].split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: magic,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| Error::VaultDecrypt)
}

fn encrypt(key: &MasterKey, plaintext: &[u8]) -> Result<Vec<u8>> {
    seal(key, MAGIC, plaintext)
}

fn decrypt(key: &MasterKey, file: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    open_sealed(key, MAGIC, file)
}

pub struct Vault {
    path: PathBuf,
    key: MasterKey,
    pub(crate) data: VaultData,
}

impl Vault {
    /// Opens the vault at `path`, creating an empty one (and its key) on
    /// first run.
    ///
    /// An existing vault whose key is gone is reported as
    /// [`Error::VaultKeyMissing`] and left untouched, never overwritten.
    pub fn open(path: impl Into<PathBuf>, keystore: &dyn KeyStore) -> Result<Self> {
        let path = path.into();
        let file = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let stored_key = keystore.load()?;

        match (file, stored_key) {
            (Some(file), Some(key)) => {
                let plaintext = decrypt(&key, &file)?;
                let data: VaultData = serde_json::from_slice(&plaintext)?;
                if data.version > DATA_VERSION {
                    return Err(Error::VaultFormat);
                }
                Ok(Vault { path, key, data })
            }
            (Some(_), None) => Err(Error::VaultKeyMissing),
            (None, existing) => {
                let key = match existing {
                    Some(key) => key,
                    None => {
                        let mut key = Zeroizing::new([0u8; KEY_LEN]);
                        key.copy_from_slice(&XChaCha20Poly1305::generate_key(&mut OsRng));
                        keystore.store(&key)?;
                        key
                    }
                };
                let vault = Vault {
                    path,
                    key,
                    data: VaultData {
                        version: DATA_VERSION,
                        ..VaultData::default()
                    },
                };
                vault.save()?;
                Ok(vault)
            }
        }
    }

    fn save(&self) -> Result<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(&self.data)?);
        write_atomic(&self.path, &encrypt(&self.key, &plaintext)?)
    }

    /// Applies a change and persists it; on a failed save the in-memory
    /// state is rolled back so memory and disk never disagree.
    pub(crate) fn commit<T>(
        &mut self,
        change: impl FnOnce(&mut VaultData) -> Result<T>,
    ) -> Result<T> {
        let before = self.data.clone();
        let result = change(&mut self.data).and_then(|value| self.save().map(|_| value));
        if result.is_err() {
            self.data = before;
        }
        result
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            hosts: self.data.hosts.iter().map(HostView::from).collect(),
            groups: self.data.groups.clone(),
            identities: self.data.identities.iter().map(IdentityView::from).collect(),
            keys: self.data.keys.iter().map(KeyView::from).collect(),
            snippets: self.data.snippets.clone(),
            settings: self.data.settings.clone(),
            cloud: self.data.cloud.as_ref().map(|account| CloudView {
                server: account.server.clone(),
                email: account.email.clone(),
                device_id: account.device_id.clone(),
                last_sync_at: account.last_sync_at,
                revoked: account.revoked,
                pending: self.pending_changes(),
            }),
        }
    }

    // ------------------------------------------------------------ hosts ---

    pub fn save_host(&mut self, input: HostInput) -> Result<HostView> {
        let address = input.address.trim().to_string();
        if address.is_empty() {
            return Err(Error::Invalid("the host address is required".into()));
        }
        if address.chars().any(char::is_whitespace) {
            return Err(Error::Invalid(
                "the host address must not contain spaces".into(),
            ));
        }
        let port = input.port.unwrap_or(DEFAULT_SSH_PORT);
        if port == 0 {
            return Err(Error::Invalid("the port must be between 1 and 65535".into()));
        }

        self.commit(|data| {
            if let Some(group_id) = input.group_id {
                if !data.groups.iter().any(|g| g.id == group_id) {
                    return Err(Error::NotFound("group"));
                }
            }
            if let Some(snippet_id) = input.startup_snippet_id {
                if !data.snippets.iter().any(|s| s.id == snippet_id) {
                    return Err(Error::NotFound("snippet"));
                }
            }
            let existing = match input.id {
                Some(id) => Some(
                    data.hosts
                        .iter()
                        .position(|h| h.id == id)
                        .ok_or(Error::NotFound("host"))?,
                ),
                None => None,
            };
            let current_password = existing.and_then(|i| match &data.hosts[i].auth {
                HostAuth::Inline { password, .. } => password.clone(),
                HostAuth::Identity { .. } => None,
            });
            let auth = match input.auth {
                HostAuthInput::Inline {
                    username,
                    password,
                    key_id,
                } => {
                    if let Some(key_id) = key_id {
                        if !data.keys.iter().any(|k| k.id == key_id) {
                            return Err(Error::NotFound("key"));
                        }
                    }
                    HostAuth::Inline {
                        username: username.trim().to_string(),
                        password: password.apply(current_password),
                        key_id,
                    }
                }
                HostAuthInput::Identity { identity_id } => {
                    if !data.identities.iter().any(|i| i.id == identity_id) {
                        return Err(Error::NotFound("identity"));
                    }
                    HostAuth::Identity { identity_id }
                }
            };
            let now = now_ms();
            // What is known about the system belongs to the machine at
            // this address; a new address starts unknown.
            let os = existing
                .filter(|i| data.hosts[*i].address == address)
                .and_then(|i| data.hosts[i].os.clone());
            let host = Host {
                id: input.id.unwrap_or_else(Uuid::new_v4),
                label: input.label.trim().to_string(),
                address,
                port,
                group_id: input.group_id,
                tags: normalize_tags(input.tags),
                auth,
                startup_snippet_id: input.startup_snippet_id,
                os,
                // Pinning is not part of the edit form; it stays as it was.
                pinned: existing.is_some_and(|i| data.hosts[i].pinned),
                created_at: existing.map_or(now, |i| data.hosts[i].created_at),
                updated_at: now,
            };
            let view = HostView::from(&host);
            match existing {
                Some(i) => data.hosts[i] = host,
                None => data.hosts.push(host),
            }
            Ok(view)
        })
    }

    pub fn delete_host(&mut self, id: Id) -> Result<()> {
        self.commit(|data| {
            let before = data.hosts.len();
            data.hosts.retain(|h| h.id != id);
            if data.hosts.len() == before {
                return Err(Error::NotFound("host"));
            }
            Ok(())
        })
    }

    /// Copies a host, including its stored credentials, under a new label.
    pub fn duplicate_host(&mut self, id: Id, label_suffix: &str) -> Result<HostView> {
        self.commit(|data| {
            let source = data
                .hosts
                .iter()
                .find(|h| h.id == id)
                .ok_or(Error::NotFound("host"))?;
            let now = now_ms();
            let base = if source.label.is_empty() {
                &source.address
            } else {
                &source.label
            };
            let copy = Host {
                id: Uuid::new_v4(),
                label: format!("{base} {label_suffix}").trim().to_string(),
                pinned: false,
                created_at: now,
                updated_at: now,
                ..source.clone()
            };
            let view = HostView::from(&copy);
            data.hosts.push(copy);
            Ok(view)
        })
    }

    /// Moves a host into a group, or out of all groups with `None`.
    pub fn move_host(&mut self, host_id: Id, group_id: Option<Id>) -> Result<HostView> {
        self.commit(|data| {
            if let Some(group_id) = group_id {
                if !data.groups.iter().any(|g| g.id == group_id) {
                    return Err(Error::NotFound("group"));
                }
            }
            let host = data
                .hosts
                .iter_mut()
                .find(|h| h.id == host_id)
                .ok_or(Error::NotFound("host"))?;
            if host.group_id != group_id {
                host.group_id = group_id;
                host.updated_at = now_ms();
            }
            Ok(HostView::from(&*host))
        })
    }

    /// Pins a host before the others in its list, or unpins it.
    pub fn pin_host(&mut self, host_id: Id, pinned: bool) -> Result<HostView> {
        self.commit(|data| {
            let host = data
                .hosts
                .iter_mut()
                .find(|h| h.id == host_id)
                .ok_or(Error::NotFound("host"))?;
            if host.pinned != pinned {
                host.pinned = pinned;
                host.updated_at = now_ms();
            }
            Ok(HostView::from(&*host))
        })
    }

    /// Records the operating system a host reported. Returns whether that
    /// was news.
    pub fn set_host_os(&mut self, host_id: Id, os: HostOs) -> Result<bool> {
        let known = self
            .data
            .hosts
            .iter()
            .find(|h| h.id == host_id)
            .ok_or(Error::NotFound("host"))?
            .os
            .as_ref();
        if known == Some(&os) {
            return Ok(false);
        }
        self.commit(|data| {
            if let Some(host) = data.hosts.iter_mut().find(|h| h.id == host_id) {
                host.os = Some(os);
            }
            Ok(true)
        })
    }

    /// Stores a password the user asked to remember during a connection.
    ///
    /// It goes wherever the host's credentials live: on the host itself, or
    /// on the identity the host uses.
    pub fn remember_password(&mut self, host_id: Id, new_password: String) -> Result<()> {
        self.commit(|data| {
            let host = data
                .hosts
                .iter_mut()
                .find(|h| h.id == host_id)
                .ok_or(Error::NotFound("host"))?;
            let now = now_ms();
            match &mut host.auth {
                HostAuth::Inline { password, .. } => {
                    *password = Some(new_password);
                    host.updated_at = now;
                }
                HostAuth::Identity { identity_id } => {
                    let identity_id = *identity_id;
                    let identity = data
                        .identities
                        .iter_mut()
                        .find(|i| i.id == identity_id)
                        .ok_or(Error::NotFound("identity"))?;
                    identity.password = Some(new_password);
                    identity.updated_at = now;
                }
            }
            Ok(())
        })
    }

    /// Stores a username entered during a connection to a host that had none.
    pub fn remember_username(&mut self, host_id: Id, new_username: String) -> Result<()> {
        self.commit(|data| {
            let host = data
                .hosts
                .iter_mut()
                .find(|h| h.id == host_id)
                .ok_or(Error::NotFound("host"))?;
            if let HostAuth::Inline { username, .. } = &mut host.auth {
                *username = new_username;
                host.updated_at = now_ms();
            }
            Ok(())
        })
    }

    /// Makes the host sign in with the given key from now on.
    ///
    /// Returns `false`, changing nothing, for a host whose credentials come
    /// from an identity: the identity is shared and is not edited behind
    /// the user's back.
    pub fn assign_key(&mut self, host_id: Id, new_key: Id) -> Result<bool> {
        self.commit(|data| {
            if !data.keys.iter().any(|k| k.id == new_key) {
                return Err(Error::NotFound("key"));
            }
            let host = data
                .hosts
                .iter_mut()
                .find(|h| h.id == host_id)
                .ok_or(Error::NotFound("host"))?;
            match &mut host.auth {
                HostAuth::Inline { key_id, .. } => {
                    *key_id = Some(new_key);
                    host.updated_at = now_ms();
                    Ok(true)
                }
                HostAuth::Identity { .. } => Ok(false),
            }
        })
    }

    pub fn key(&self, id: Id) -> Result<SshKey> {
        self.data
            .keys
            .iter()
            .find(|k| k.id == id)
            .cloned()
            .ok_or(Error::NotFound("key"))
    }

    /// Credentials to use for a connection to the host.
    pub fn resolve_credentials(&self, host_id: Id) -> Result<(Host, ResolvedCredentials)> {
        let host = self
            .data
            .hosts
            .iter()
            .find(|h| h.id == host_id)
            .ok_or(Error::NotFound("host"))?;
        let (username, password, key_id) = match &host.auth {
            HostAuth::Inline {
                username,
                password,
                key_id,
            } => (username.clone(), password.clone(), *key_id),
            HostAuth::Identity { identity_id } => {
                let identity = self
                    .data
                    .identities
                    .iter()
                    .find(|i| i.id == *identity_id)
                    .ok_or(Error::NotFound("identity"))?;
                (
                    identity.username.clone(),
                    identity.password.clone(),
                    identity.key_id,
                )
            }
        };
        let key = match key_id {
            Some(id) => Some(
                self.data
                    .keys
                    .iter()
                    .find(|k| k.id == id)
                    .cloned()
                    .ok_or(Error::NotFound("key"))?,
            ),
            None => None,
        };
        Ok((
            host.clone(),
            ResolvedCredentials {
                username,
                password,
                key,
            },
        ))
    }

    /// The script to run when a session to the host is first opened, if any.
    pub fn startup_script(&self, host: &Host) -> Option<String> {
        let id = host.startup_snippet_id?;
        self.data
            .snippets
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.script.clone())
    }

    // --------------------------------------------------------- snippets ---

    pub fn save_snippet(&mut self, input: SnippetInput) -> Result<Snippet> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(Error::Invalid("the snippet name is required".into()));
        }
        if input.script.trim().is_empty() {
            return Err(Error::Invalid("the snippet script is empty".into()));
        }
        // Line endings are normalized; they are converted for the terminal
        // when the snippet is sent.
        let script = input.script.replace("\r\n", "\n").replace('\r', "\n");
        self.commit(|data| {
            let now = now_ms();
            let description = input.description.trim().to_string();
            let package = input.package.trim().to_string();
            match input.id {
                Some(id) => {
                    let snippet = data
                        .snippets
                        .iter_mut()
                        .find(|s| s.id == id)
                        .ok_or(Error::NotFound("snippet"))?;
                    snippet.name = name;
                    snippet.description = description;
                    snippet.script = script;
                    snippet.package = package;
                    snippet.updated_at = now;
                    Ok(snippet.clone())
                }
                None => {
                    let snippet = Snippet {
                        id: Uuid::new_v4(),
                        name,
                        description,
                        script,
                        package,
                        targets: Vec::new(),
                        created_at: now,
                        updated_at: now,
                    };
                    data.snippets.push(snippet.clone());
                    Ok(snippet)
                }
            }
        })
    }

    /// Remembers the hosts a snippet is run on together, or forgets them
    /// (an empty list). Hosts that do not exist are left out.
    pub fn set_snippet_targets(&mut self, id: Id, targets: Vec<Id>) -> Result<Snippet> {
        self.commit(|data| {
            let hosts: Vec<Id> = data.hosts.iter().map(|h| h.id).collect();
            let mut kept: Vec<Id> = Vec::new();
            for target in targets {
                if hosts.contains(&target) && !kept.contains(&target) {
                    kept.push(target);
                }
            }
            let snippet = data
                .snippets
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or(Error::NotFound("snippet"))?;
            if snippet.targets != kept {
                snippet.targets = kept;
                snippet.updated_at = now_ms();
            }
            Ok(snippet.clone())
        })
    }

    /// Deletes a snippet. Hosts that ran it on connect simply stop doing so.
    pub fn delete_snippet(&mut self, id: Id) -> Result<()> {
        self.commit(|data| {
            let before = data.snippets.len();
            data.snippets.retain(|s| s.id != id);
            if data.snippets.len() == before {
                return Err(Error::NotFound("snippet"));
            }
            let now = now_ms();
            for host in data
                .hosts
                .iter_mut()
                .filter(|h| h.startup_snippet_id == Some(id))
            {
                host.startup_snippet_id = None;
                host.updated_at = now;
            }
            Ok(())
        })
    }

    // ----------------------------------------------------------- groups ---

    pub fn save_group(&mut self, input: GroupInput) -> Result<Group> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(Error::Invalid("the group name is required".into()));
        }
        self.commit(|data| {
            if let Some(parent) = input.parent_id {
                if !data.groups.iter().any(|g| g.id == parent) {
                    return Err(Error::NotFound("group"));
                }
                // A group may not become its own ancestor.
                if let Some(id) = input.id {
                    let mut cursor = Some(parent);
                    while let Some(current) = cursor {
                        if current == id {
                            return Err(Error::Invalid(
                                "a group cannot be placed inside itself".into(),
                            ));
                        }
                        cursor = data
                            .groups
                            .iter()
                            .find(|g| g.id == current)
                            .and_then(|g| g.parent_id);
                    }
                }
            }
            let now = now_ms();
            match input.id {
                Some(id) => {
                    let group = data
                        .groups
                        .iter_mut()
                        .find(|g| g.id == id)
                        .ok_or(Error::NotFound("group"))?;
                    group.name = name;
                    group.parent_id = input.parent_id;
                    group.updated_at = now;
                    Ok(group.clone())
                }
                None => {
                    let group = Group {
                        id: Uuid::new_v4(),
                        name,
                        parent_id: input.parent_id,
                        created_at: now,
                        updated_at: now,
                    };
                    data.groups.push(group.clone());
                    Ok(group)
                }
            }
        })
    }

    /// Deletes a group. Its hosts and subgroups move up to its parent.
    pub fn delete_group(&mut self, id: Id) -> Result<()> {
        self.commit(|data| {
            let parent = data
                .groups
                .iter()
                .find(|g| g.id == id)
                .ok_or(Error::NotFound("group"))?
                .parent_id;
            data.groups.retain(|g| g.id != id);
            let now = now_ms();
            for group in data.groups.iter_mut().filter(|g| g.parent_id == Some(id)) {
                group.parent_id = parent;
                group.updated_at = now;
            }
            for host in data.hosts.iter_mut().filter(|h| h.group_id == Some(id)) {
                host.group_id = parent;
                host.updated_at = now;
            }
            Ok(())
        })
    }

    // ------------------------------------------------------- identities ---

    pub fn save_identity(&mut self, input: IdentityInput) -> Result<IdentityView> {
        let username = input.username.trim().to_string();
        if username.is_empty() {
            return Err(Error::Invalid("the username is required".into()));
        }
        self.commit(|data| {
            if let Some(key_id) = input.key_id {
                if !data.keys.iter().any(|k| k.id == key_id) {
                    return Err(Error::NotFound("key"));
                }
            }
            let now = now_ms();
            let label = input.label.trim().to_string();
            match input.id {
                Some(id) => {
                    let identity = data
                        .identities
                        .iter_mut()
                        .find(|i| i.id == id)
                        .ok_or(Error::NotFound("identity"))?;
                    identity.label = label;
                    identity.username = username;
                    identity.password = input.password.apply(identity.password.take());
                    identity.key_id = input.key_id;
                    identity.updated_at = now;
                    Ok(IdentityView::from(&*identity))
                }
                None => {
                    let identity = Identity {
                        id: Uuid::new_v4(),
                        label,
                        username,
                        password: input.password.apply(None),
                        key_id: input.key_id,
                        created_at: now,
                        updated_at: now,
                    };
                    let view = IdentityView::from(&identity);
                    data.identities.push(identity);
                    Ok(view)
                }
            }
        })
    }

    /// Who else holds the credentials this host keeps for itself: the same
    /// user name, password and key. A user name alone is not counted; it is
    /// what is secret that is worth keeping in one place.
    pub fn shared_credentials(&self, host_id: Id) -> Result<SharedCredentials> {
        let host = self
            .data
            .hosts
            .iter()
            .find(|h| h.id == host_id)
            .ok_or(Error::NotFound("host"))?;
        let HostAuth::Inline { username, password, key_id } = &host.auth else {
            return Ok(SharedCredentials::default());
        };
        if password.is_none() && key_id.is_none() {
            return Ok(SharedCredentials::default());
        }
        let same = |other: &HostAuth| {
            matches!(other, HostAuth::Inline { username: u, password: p, key_id: k }
                if u == username && p == password && k == key_id)
        };
        Ok(SharedCredentials {
            hosts: self
                .data
                .hosts
                .iter()
                .filter(|h| h.id != host_id && same(&h.auth))
                .map(|h| h.id)
                .collect(),
            identity: self
                .data
                .identities
                .iter()
                .find(|i| &i.username == username && &i.password == password && &i.key_id == key_id)
                .map(|i| i.id),
        })
    }

    /// Gathers the credentials a host keeps for itself, and every other
    /// host keeps the same, into one identity, and points all those hosts
    /// at it: from then on the password is changed in one place. An
    /// identity that already holds them is used; otherwise one is made,
    /// under the label given.
    pub fn gather_credentials(&mut self, host_id: Id, label: &str) -> Result<IdentityView> {
        let shared = self.shared_credentials(host_id)?;
        self.commit(|data| {
            let host = data
                .hosts
                .iter()
                .find(|h| h.id == host_id)
                .ok_or(Error::NotFound("host"))?;
            let HostAuth::Inline { username, password, key_id } = host.auth.clone() else {
                return Err(Error::Invalid("the host already takes its credentials from an identity".into()));
            };
            if password.is_none() && key_id.is_none() {
                return Err(Error::Invalid("the host has no password or key to move".into()));
            }
            let now = now_ms();
            let view = match shared.identity.and_then(|id| data.identities.iter().find(|i| i.id == id)) {
                Some(identity) => IdentityView::from(identity),
                None => {
                    let identity = Identity {
                        id: Uuid::new_v4(),
                        label: label.trim().to_string(),
                        username,
                        password,
                        key_id,
                        created_at: now,
                        updated_at: now,
                    };
                    let view = IdentityView::from(&identity);
                    data.identities.push(identity);
                    view
                }
            };
            for host in data
                .hosts
                .iter_mut()
                .filter(|h| h.id == host_id || shared.hosts.contains(&h.id))
            {
                host.auth = HostAuth::Identity { identity_id: view.id };
                host.updated_at = now;
            }
            Ok(view)
        })
    }

    /// The password a host keeps for itself, to show to the user who asks
    /// for it. Nothing else reads passwords out of the vault for display.
    pub fn host_password(&self, host_id: Id) -> Result<Option<String>> {
        let host = self
            .data
            .hosts
            .iter()
            .find(|h| h.id == host_id)
            .ok_or(Error::NotFound("host"))?;
        Ok(match &host.auth {
            HostAuth::Inline { password, .. } => password.clone(),
            HostAuth::Identity { .. } => None,
        })
    }

    /// The password of an identity, to show to the user who asks for it.
    pub fn identity_password(&self, id: Id) -> Result<Option<String>> {
        self.data
            .identities
            .iter()
            .find(|i| i.id == id)
            .map(|i| i.password.clone())
            .ok_or(Error::NotFound("identity"))
    }

    /// Deletes an identity. Refused while any host still uses it, so no host
    /// silently loses its credentials.
    pub fn delete_identity(&mut self, id: Id) -> Result<()> {
        self.commit(|data| {
            if !data.identities.iter().any(|i| i.id == id) {
                return Err(Error::NotFound("identity"));
            }
            let users = data
                .hosts
                .iter()
                .filter(|h| matches!(&h.auth, HostAuth::Identity { identity_id } if *identity_id == id))
                .count();
            if users > 0 {
                return Err(Error::InUse(format!(
                    "the identity is used by {users} host(s)"
                )));
            }
            data.identities.retain(|i| i.id != id);
            Ok(())
        })
    }

    // ------------------------------------------------------------- keys ---

    pub fn generate_key(&mut self, kind: KeyKind, label: &str) -> Result<KeyView> {
        let key = keys::generate(kind, label)?;
        self.add_key(key)
    }

    /// Adds an already prepared key. Refused if the same key is present.
    pub fn add_key(&mut self, key: SshKey) -> Result<KeyView> {
        self.commit(|data| {
            if let Some(existing) = data.keys.iter().find(|k| k.fingerprint == key.fingerprint) {
                return Err(Error::KeyExists(existing.label.clone()));
            }
            let view = KeyView::from(&key);
            data.keys.push(key);
            Ok(view)
        })
    }

    /// Allows or forbids storing a key in the cloud. Forbidding it removes
    /// the key from the cloud and, as they sync, from the other devices;
    /// this device keeps it.
    pub fn set_key_sync(&mut self, id: Id, sync: bool) -> Result<KeyView> {
        self.commit(|data| {
            let key = data
                .keys
                .iter_mut()
                .find(|k| k.id == id)
                .ok_or(Error::NotFound("key"))?;
            key.sync = sync;
            key.updated_at = now_ms();
            Ok(KeyView::from(&*key))
        })
    }

    /// Replaces the synced preferences.
    pub fn save_settings(&mut self, settings: serde_json::Value) -> Result<()> {
        if self.data.settings == settings {
            return Ok(());
        }
        self.commit(|data| {
            data.settings = settings;
            Ok(())
        })
    }

    pub fn rename_key(&mut self, id: Id, label: &str) -> Result<KeyView> {
        self.commit(|data| {
            let key = data
                .keys
                .iter_mut()
                .find(|k| k.id == id)
                .ok_or(Error::NotFound("key"))?;
            key.label = label.trim().to_string();
            key.updated_at = now_ms();
            Ok(KeyView::from(&*key))
        })
    }

    /// Stores the passphrase of an encrypted key after it proved correct.
    pub fn remember_passphrase(&mut self, key_id: Id, passphrase: String) -> Result<()> {
        self.commit(|data| {
            let key = data
                .keys
                .iter_mut()
                .find(|k| k.id == key_id)
                .ok_or(Error::NotFound("key"))?;
            keys::decrypt(&key.private_key, Some(&passphrase))?;
            key.passphrase = Some(passphrase);
            key.updated_at = now_ms();
            Ok(())
        })
    }

    /// Deletes a key. Refused while hosts or identities still use it.
    pub fn delete_key(&mut self, id: Id) -> Result<()> {
        self.commit(|data| {
            if !data.keys.iter().any(|k| k.id == id) {
                return Err(Error::NotFound("key"));
            }
            let hosts = data
                .hosts
                .iter()
                .filter(|h| matches!(&h.auth, HostAuth::Inline { key_id, .. } if *key_id == Some(id)))
                .count();
            let identities = data
                .identities
                .iter()
                .filter(|i| i.key_id == Some(id))
                .count();
            if hosts + identities > 0 {
                return Err(Error::InUse(format!(
                    "the key is used by {hosts} host(s) and {identities} identity(ies)"
                )));
            }
            data.keys.retain(|k| k.id != id);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::FileKeyStore;

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Fixture {
                dir: tempfile::tempdir().unwrap(),
            }
        }
        fn vault_path(&self) -> PathBuf {
            self.dir.path().join("vault.bin")
        }
        fn keystore(&self) -> FileKeyStore {
            FileKeyStore::new(self.dir.path().join("master.key"))
        }
        fn open(&self) -> Result<Vault> {
            Vault::open(self.vault_path(), &self.keystore())
        }
    }

    fn inline_host(label: &str, password: SecretInput) -> HostInput {
        HostInput {
            id: None,
            label: label.into(),
            address: "10.0.0.1".into(),
            port: None,
            group_id: None,
            tags: vec![" prod ".into(), "Prod".into(), "db".into(), "".into()],
            auth: HostAuthInput::Inline {
                username: "root".into(),
                password,
                key_id: None,
            },
            startup_snippet_id: None,
        }
    }

    #[test]
    fn persists_and_hides_secrets() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let host = vault
            .save_host(inline_host("web", SecretInput::Set("s3cret-pass".into())))
            .unwrap();
        assert_eq!(host.port, 22);
        assert_eq!(host.tags, vec!["prod", "db"]);
        assert!(matches!(
            host.auth,
            HostAuthView::Inline {
                has_password: true,
                ..
            }
        ));

        // Nothing secret reaches the UI projection.
        let json = serde_json::to_string(&vault.snapshot()).unwrap();
        assert!(!json.contains("s3cret-pass"));

        // The file on disk is not readable text.
        let raw = std::fs::read(fx.vault_path()).unwrap();
        assert!(raw.starts_with(MAGIC));
        let raw_text = String::from_utf8_lossy(&raw);
        assert!(!raw_text.contains("s3cret-pass"));
        assert!(!raw_text.contains("10.0.0.1"));

        // Reopening with the same key restores everything.
        let vault = fx.open().unwrap();
        let (_, creds) = vault.resolve_credentials(host.id).unwrap();
        assert_eq!(creds.username, "root");
        assert_eq!(creds.password.as_deref(), Some("s3cret-pass"));
    }

    #[test]
    fn edit_keeps_or_clears_password() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let host = vault
            .save_host(inline_host("web", SecretInput::Set("pw".into())))
            .unwrap();

        let mut edit = inline_host("web2", SecretInput::Keep);
        edit.id = Some(host.id);
        let edited = vault.save_host(edit).unwrap();
        assert_eq!(edited.label, "web2");
        assert_eq!(edited.created_at, host.created_at);
        let (_, creds) = vault.resolve_credentials(host.id).unwrap();
        assert_eq!(creds.password.as_deref(), Some("pw"));

        let mut clear = inline_host("web2", SecretInput::Clear);
        clear.id = Some(host.id);
        vault.save_host(clear).unwrap();
        let (_, creds) = vault.resolve_credentials(host.id).unwrap();
        assert!(creds.password.is_none());
        assert_eq!(vault.snapshot().hosts.len(), 1);
    }

    #[test]
    fn rejects_invalid_hosts() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let mut bad = inline_host("x", SecretInput::Keep);
        bad.address = "  ".into();
        assert!(matches!(vault.save_host(bad), Err(Error::Invalid(_))));
        let mut bad = inline_host("x", SecretInput::Keep);
        bad.address = "a b".into();
        assert!(matches!(vault.save_host(bad), Err(Error::Invalid(_))));
        let mut bad = inline_host("x", SecretInput::Keep);
        bad.port = Some(0);
        assert!(matches!(vault.save_host(bad), Err(Error::Invalid(_))));
        let mut bad = inline_host("x", SecretInput::Keep);
        bad.group_id = Some(Uuid::new_v4());
        assert!(matches!(vault.save_host(bad), Err(Error::NotFound(_))));
        assert!(vault.snapshot().hosts.is_empty());
    }

    #[test]
    fn host_os_follows_the_address_and_hosts_move_between_groups() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let host = vault.save_host(inline_host("web", SecretInput::Keep)).unwrap();
        assert!(host.os.is_none());
        let ubuntu = HostOs {
            id: "ubuntu".into(),
            family: Some("debian".into()),
            name: "Ubuntu 24.04.1 LTS".into(),
        };
        assert!(vault.set_host_os(host.id, ubuntu.clone()).unwrap());
        assert!(!vault.set_host_os(host.id, ubuntu.clone()).unwrap());

        // An ordinary edit keeps it; pointing the host elsewhere forgets it.
        let mut edit = inline_host("web renamed", SecretInput::Keep);
        edit.id = Some(host.id);
        assert_eq!(vault.save_host(edit).unwrap().os, Some(ubuntu));
        let mut moved = inline_host("web renamed", SecretInput::Keep);
        moved.id = Some(host.id);
        moved.address = "10.0.0.2".into();
        assert!(vault.save_host(moved).unwrap().os.is_none());

        let group = vault
            .save_group(GroupInput {
                id: None,
                name: "prod".into(),
                parent_id: None,
            })
            .unwrap();
        assert_eq!(
            vault.move_host(host.id, Some(group.id)).unwrap().group_id,
            Some(group.id)
        );
        assert_eq!(vault.move_host(host.id, None).unwrap().group_id, None);
        assert!(matches!(
            vault.move_host(host.id, Some(Uuid::new_v4())),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            vault.move_host(Uuid::new_v4(), None),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn duplicate_copies_credentials() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let host = vault
            .save_host(inline_host("web", SecretInput::Set("pw".into())))
            .unwrap();
        let copy = vault.duplicate_host(host.id, "(copy)").unwrap();
        assert_ne!(copy.id, host.id);
        assert_eq!(copy.label, "web (copy)");
        let (_, creds) = vault.resolve_credentials(copy.id).unwrap();
        assert_eq!(creds.password.as_deref(), Some("pw"));
    }

    #[test]
    fn groups_nest_and_release_members_on_delete() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let group = |name: &str, parent| GroupInput {
            id: None,
            name: name.into(),
            parent_id: parent,
        };
        let top = vault.save_group(group("prod", None)).unwrap();
        let mid = vault.save_group(group("eu", Some(top.id))).unwrap();
        let leaf = vault.save_group(group("db", Some(mid.id))).unwrap();

        // No cycles.
        let cycle = GroupInput {
            id: Some(top.id),
            name: "prod".into(),
            parent_id: Some(leaf.id),
        };
        assert!(matches!(vault.save_group(cycle), Err(Error::Invalid(_))));

        let mut input = inline_host("h", SecretInput::Keep);
        input.group_id = Some(mid.id);
        let host = vault.save_host(input).unwrap();

        vault.delete_group(mid.id).unwrap();
        let snap = vault.snapshot();
        assert_eq!(snap.groups.len(), 2);
        let host = snap.hosts.iter().find(|h| h.id == host.id).unwrap();
        assert_eq!(host.group_id, Some(top.id));
        let leaf = snap.groups.iter().find(|g| g.id == leaf.id).unwrap();
        assert_eq!(leaf.parent_id, Some(top.id));
    }

    #[test]
    fn identities_and_keys_guard_their_users() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let key = vault.generate_key(KeyKind::Ed25519, "laptop").unwrap();
        let identity = vault
            .save_identity(IdentityInput {
                id: None,
                label: "deploy".into(),
                username: "deploy".into(),
                password: SecretInput::Set("pw".into()),
                key_id: Some(key.id),
            })
            .unwrap();
        let host = vault
            .save_host(HostInput {
                auth: HostAuthInput::Identity {
                    identity_id: identity.id,
                },
                ..inline_host("web", SecretInput::Keep)
            })
            .unwrap();

        let (_, creds) = vault.resolve_credentials(host.id).unwrap();
        assert_eq!(creds.username, "deploy");
        assert_eq!(creds.password.as_deref(), Some("pw"));
        assert_eq!(creds.key.unwrap().fingerprint, key.fingerprint);

        assert!(matches!(vault.delete_key(key.id), Err(Error::InUse(_))));
        assert!(matches!(
            vault.delete_identity(identity.id),
            Err(Error::InUse(_))
        ));

        // A password remembered during a connection lands on the identity.
        vault.remember_password(host.id, "new".into()).unwrap();
        let (_, creds) = vault.resolve_credentials(host.id).unwrap();
        assert_eq!(creds.password.as_deref(), Some("new"));

        vault.delete_host(host.id).unwrap();
        vault.delete_identity(identity.id).unwrap();
        vault.delete_key(key.id).unwrap();
        assert!(vault.snapshot().keys.is_empty());

        // The same key cannot be added twice.
        let key = keys::generate(KeyKind::Ed25519, "a").unwrap();
        let text = key.private_key.clone();
        vault.add_key(key).unwrap();
        let again = keys::import(&text, None, false, "b").unwrap();
        assert!(matches!(
            vault.add_key(again),
            Err(Error::KeyExists(label)) if label == "a"
        ));
    }

    #[test]
    fn snippets_and_startup_reference() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let snippet = |name: &str, script: &str| SnippetInput {
            id: None,
            name: name.into(),
            description: " d ".into(),
            script: script.into(),
            package: " ops ".into(),
        };
        assert!(matches!(
            vault.save_snippet(snippet(" ", "ls")),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            vault.save_snippet(snippet("x", " \n ")),
            Err(Error::Invalid(_))
        ));

        let saved = vault
            .save_snippet(snippet(" logs ", "cd /var/log\r\ntail -f syslog\r"))
            .unwrap();
        assert_eq!(saved.name, "logs");
        assert_eq!(saved.package, "ops");
        assert_eq!(saved.description, "d");
        assert_eq!(saved.script, "cd /var/log\ntail -f syslog\n");

        let mut input = inline_host("web", SecretInput::Keep);
        input.startup_snippet_id = Some(Uuid::new_v4());
        assert!(matches!(vault.save_host(input), Err(Error::NotFound(_))));

        let mut input = inline_host("web", SecretInput::Keep);
        input.startup_snippet_id = Some(saved.id);
        let host = vault.save_host(input).unwrap();
        let (stored, _) = vault.resolve_credentials(host.id).unwrap();
        assert_eq!(
            vault.startup_script(&stored).as_deref(),
            Some("cd /var/log\ntail -f syslog\n")
        );

        // Editing keeps the id; deleting releases the host.
        let edited = vault
            .save_snippet(SnippetInput {
                id: Some(saved.id),
                ..snippet("logs2", "uptime")
            })
            .unwrap();
        assert_eq!(edited.id, saved.id);
        assert_eq!(edited.created_at, saved.created_at);
        vault.delete_snippet(saved.id).unwrap();
        let (stored, _) = vault.resolve_credentials(host.id).unwrap();
        assert!(stored.startup_snippet_id.is_none());
        assert!(vault.startup_script(&stored).is_none());
        assert!(vault.snapshot().snippets.is_empty());
    }

    #[test]
    fn refuses_wrong_or_missing_key_without_touching_the_file() {
        let fx = Fixture::new();
        fx.open()
            .unwrap()
            .save_host(inline_host("web", SecretInput::Keep))
            .unwrap();
        let original = std::fs::read(fx.vault_path()).unwrap();

        // Key lost: the vault is reported, not replaced with an empty one.
        std::fs::remove_file(fx.dir.path().join("master.key")).unwrap();
        assert!(matches!(fx.open(), Err(Error::VaultKeyMissing)));
        assert_eq!(std::fs::read(fx.vault_path()).unwrap(), original);

        // Wrong key.
        fx.keystore().store(&Zeroizing::new([7u8; KEY_LEN])).unwrap();
        assert!(matches!(fx.open(), Err(Error::VaultDecrypt)));

        // Tampered file.
        let mut damaged = original.clone();
        *damaged.last_mut().unwrap() ^= 1;
        std::fs::write(fx.vault_path(), &damaged).unwrap();
        assert!(matches!(fx.open(), Err(Error::VaultDecrypt)));

        std::fs::write(fx.vault_path(), b"garbage").unwrap();
        assert!(matches!(fx.open(), Err(Error::VaultFormat)));
    }

    #[test]
    fn hosts_that_share_credentials_are_gathered_into_one_identity() {
        let fx = Fixture::new();
        let mut vault = fx.open().unwrap();
        let key = vault.generate_key(KeyKind::Ed25519, "k").unwrap();
        let host = |vault: &mut Vault, label: &str, username: &str, password: &str, key_id: Option<Id>| {
            vault
                .save_host(HostInput {
                    auth: HostAuthInput::Inline {
                        username: username.into(),
                        password: SecretInput::Set(password.into()),
                        key_id,
                    },
                    ..inline_host(label, SecretInput::Keep)
                })
                .unwrap()
                .id
        };
        let a = host(&mut vault, "a", "root", "hunter2", None);
        let b = host(&mut vault, "b", "root", "hunter2", None);
        let c = host(&mut vault, "c", "root", "hunter2", None);
        // The same name with another password, another name, the same with a key: not the same.
        let other_password = host(&mut vault, "d", "root", "other", None);
        let other_name = host(&mut vault, "e", "admin", "hunter2", None);
        let with_key = host(&mut vault, "f", "root", "hunter2", Some(key.id));
        // A name with nothing secret beside it is not worth gathering.
        let bare = host(&mut vault, "g", "root", "", None);
        let bare_too = host(&mut vault, "h", "root", "", None);

        let shared = vault.shared_credentials(a).unwrap();
        assert_eq!(shared.hosts, vec![b, c]);
        assert!(shared.identity.is_none());
        assert!(vault.shared_credentials(other_password).unwrap().hosts.is_empty());
        assert!(vault.shared_credentials(bare).unwrap().hosts.is_empty());
        assert!(vault.gather_credentials(bare, "x").is_err());
        assert_eq!(vault.host_password(a).unwrap().as_deref(), Some("hunter2"));
        assert_eq!(vault.host_password(bare).unwrap(), None);

        let identity = vault.gather_credentials(b, " Root everywhere ").unwrap();
        assert_eq!((identity.label.as_str(), identity.username.as_str()), ("Root everywhere", "root"));
        assert!(identity.has_password && identity.key_id.is_none());
        assert_eq!(vault.identity_password(identity.id).unwrap().as_deref(), Some("hunter2"));
        let snapshot = vault.snapshot();
        let uses = |id: Id| {
            let host = snapshot.hosts.iter().find(|h| h.id == id).unwrap();
            matches!(&host.auth, HostAuthView::Identity { identity_id } if *identity_id == identity.id)
        };
        assert!(uses(a) && uses(b) && uses(c));
        assert!(!uses(other_password) && !uses(other_name) && !uses(with_key) && !uses(bare_too));
        assert_eq!(snapshot.identities.len(), 1);
        // They still connect with what they had.
        let (_, credentials) = vault.resolve_credentials(a).unwrap();
        assert_eq!(credentials.username, "root");
        // Once gathered there is nothing of its own left on the host to show or to gather.
        assert_eq!(vault.host_password(a).unwrap(), None);
        assert!(vault.gather_credentials(a, "again").is_err());

        // A host added later with the same credentials is offered the identity that holds them.
        let late = host(&mut vault, "late", "root", "hunter2", None);
        let shared = vault.shared_credentials(late).unwrap();
        assert!(shared.hosts.is_empty());
        assert_eq!(shared.identity, Some(identity.id));
        assert_eq!(vault.gather_credentials(late, "ignored").unwrap().id, identity.id);
        assert_eq!(vault.snapshot().identities.len(), 1);

        // It all survives being written and read back.
        drop(vault);
        let vault = fx.open().unwrap();
        assert_eq!(vault.identity_password(identity.id).unwrap().as_deref(), Some("hunter2"));
    }
}
