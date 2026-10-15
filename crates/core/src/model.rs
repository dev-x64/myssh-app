//! Vault entities and their UI-facing projections.
//!
//! Stored types (`Host`, `Identity`, `SshKey`) hold secrets and never leave
//! the core. The UI works with `*View` types, which carry no secret material,
//! and submits `*Input` types.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type Id = Uuid;

pub const DEFAULT_SSH_PORT: u16 = 22;

// ---------------------------------------------------------------- stored ---

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultData {
    pub version: u32,
    pub hosts: Vec<Host>,
    pub groups: Vec<Group>,
    pub identities: Vec<Identity>,
    pub keys: Vec<SshKey>,
    pub snippets: Vec<Snippet>,
    /// Preferences that follow the user between devices. Opaque here; the
    /// UI owns their shape.
    pub settings: serde_json::Value,
    /// The cloud account this vault syncs with, if any.
    pub cloud: Option<CloudAccount>,
    /// The keys this device trusts for the saved hosts, as they last stood
    /// in step with the known hosts' file: what follows the account to the
    /// other devices. The file itself stays the device's own (see
    /// `known_hosts`); these are a copy of part of it.
    pub host_keys: Vec<crate::known_hosts::KnownHost>,
    /// What the cloud is known to hold: per item, its revision there and a
    /// hash of the content at that revision. Anything that differs locally
    /// is a change waiting to be sent.
    pub synced: std::collections::BTreeMap<Id, Synced>,
}

/// Sign-in state of this device. Stays inside the local vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudAccount {
    pub server: String,
    pub email: String,
    pub user_id: String,
    pub device_id: String,
    /// This device's access token for the server.
    pub token: String,
    /// The key that encrypts every synced item, base64. The server only
    /// ever holds it wrapped under a key derived from the master password.
    pub vault_key: String,
    /// Everything up to this server revision has been merged.
    #[serde(default)]
    pub cursor: u64,
    #[serde(default)]
    pub last_sync_at: Option<i64>,
    /// The server refused this device's token: access was revoked.
    #[serde(default)]
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Synced {
    pub rev: u64,
    pub hash: String,
    /// The item as it was when this device and the cloud last agreed on
    /// it. It is what lets changes made on two devices be told apart and
    /// put together, field by field. Absent for what was synced before
    /// this was kept, and for keys, whose secret need not lie here twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: Id,
    pub label: String,
    pub address: String,
    pub port: u16,
    #[serde(default)]
    pub group_id: Option<Id>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub auth: HostAuth,
    /// Snippet run once when a session to this host is first opened.
    #[serde(default)]
    pub startup_snippet_id: Option<Id>,
    /// The server's operating system, as last seen on connecting.
    #[serde(default)]
    pub os: Option<HostOs>,
    /// Shown before the others in its list. Left out when false, so that
    /// hosts nobody pinned are stored (and synced) exactly as before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a server said about its operating system.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostOs {
    /// Machine name of the system: `ubuntu`, `debian`, `alpine`, `macos`…
    pub id: String,
    /// What it is derived from, when it says so (`debian` for Ubuntu).
    #[serde(default)]
    pub family: Option<String>,
    /// Human name with version: `Ubuntu 24.04.1 LTS`.
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostAuth {
    /// Credentials stored on the host itself.
    Inline {
        username: String,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        key_id: Option<Id>,
    },
    /// Credentials come from a reusable identity.
    Identity { identity_id: Id },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<Id>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub id: Id,
    pub label: String,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key_id: Option<Id>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyOrigin {
    Generated,
    Imported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshKey {
    pub id: Id,
    pub label: String,
    /// SSH algorithm name, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// Private key in OpenSSH/PEM text form, exactly as generated or imported.
    pub private_key: String,
    /// Public key in `authorized_keys` line form, without a comment.
    pub public_key: String,
    /// `SHA256:…` fingerprint of the public key.
    pub fingerprint: String,
    /// The private key text is itself passphrase-protected.
    pub encrypted: bool,
    /// Saved passphrase for an encrypted key, if the user chose to keep it.
    #[serde(default)]
    pub passphrase: Option<String>,
    pub origin: KeyOrigin,
    /// The user allowed this key to be stored in the cloud and to appear
    /// on their other devices. Off by default: a key stays on the device
    /// it was created on.
    #[serde(default)]
    pub sync: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A saved command or multi-line script.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub script: String,
    /// Free-form group name; empty means ungrouped.
    #[serde(default)]
    pub package: String,
    /// The hosts it was last run on together, when the user asked for them
    /// to be remembered. Left out when empty, so that snippets nobody ran
    /// this way are stored (and synced) exactly as before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<Id>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ----------------------------------------------------------------- views ---

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub hosts: Vec<HostView>,
    pub groups: Vec<Group>,
    pub identities: Vec<IdentityView>,
    pub keys: Vec<KeyView>,
    pub snippets: Vec<Snippet>,
    pub settings: serde_json::Value,
    pub cloud: Option<CloudView>,
}

/// Cloud state as the UI sees it: no token, no key.
#[derive(Debug, Clone, Serialize)]
pub struct CloudView {
    pub server: String,
    pub email: String,
    pub device_id: String,
    pub last_sync_at: Option<i64>,
    pub revoked: bool,
    /// Local changes not yet sent.
    pub pending: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostView {
    pub id: Id,
    pub label: String,
    pub address: String,
    pub port: u16,
    pub group_id: Option<Id>,
    pub tags: Vec<String>,
    pub auth: HostAuthView,
    pub startup_snippet_id: Option<Id>,
    pub os: Option<HostOs>,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostAuthView {
    Inline {
        username: String,
        has_password: bool,
        key_id: Option<Id>,
    },
    Identity {
        identity_id: Id,
    },
}

/// Who else holds the credentials a host keeps for itself.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SharedCredentials {
    /// Other hosts that keep the very same ones, each for itself.
    pub hosts: Vec<Id>,
    /// An identity that already holds them.
    pub identity: Option<Id>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IdentityView {
    pub id: Id,
    pub label: String,
    pub username: String,
    pub has_password: bool,
    pub key_id: Option<Id>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyView {
    pub id: Id,
    pub label: String,
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
    pub encrypted: bool,
    pub has_passphrase: bool,
    pub origin: KeyOrigin,
    pub sync: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<&Host> for HostView {
    fn from(h: &Host) -> Self {
        HostView {
            id: h.id,
            label: h.label.clone(),
            address: h.address.clone(),
            port: h.port,
            group_id: h.group_id,
            tags: h.tags.clone(),
            auth: match &h.auth {
                HostAuth::Inline {
                    username,
                    password,
                    key_id,
                } => HostAuthView::Inline {
                    username: username.clone(),
                    has_password: password.is_some(),
                    key_id: *key_id,
                },
                HostAuth::Identity { identity_id } => HostAuthView::Identity {
                    identity_id: *identity_id,
                },
            },
            startup_snippet_id: h.startup_snippet_id,
            os: h.os.clone(),
            pinned: h.pinned,
            created_at: h.created_at,
            updated_at: h.updated_at,
        }
    }
}

impl From<&Identity> for IdentityView {
    fn from(i: &Identity) -> Self {
        IdentityView {
            id: i.id,
            label: i.label.clone(),
            username: i.username.clone(),
            has_password: i.password.is_some(),
            key_id: i.key_id,
            created_at: i.created_at,
            updated_at: i.updated_at,
        }
    }
}

impl From<&SshKey> for KeyView {
    fn from(k: &SshKey) -> Self {
        KeyView {
            id: k.id,
            label: k.label.clone(),
            algorithm: k.algorithm.clone(),
            public_key: k.public_key.clone(),
            fingerprint: k.fingerprint.clone(),
            encrypted: k.encrypted,
            has_passphrase: k.passphrase.is_some(),
            origin: k.origin,
            sync: k.sync,
            created_at: k.created_at,
            updated_at: k.updated_at,
        }
    }
}

// ---------------------------------------------------------------- inputs ---

/// How an edit form treats a stored secret it cannot read back.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "snake_case")]
pub enum SecretInput {
    /// Leave the stored value untouched.
    #[default]
    Keep,
    /// Remove the stored value.
    Clear,
    /// Replace the stored value.
    Set(String),
}

impl SecretInput {
    pub fn apply(self, current: Option<String>) -> Option<String> {
        match self {
            SecretInput::Keep => current,
            SecretInput::Clear => None,
            SecretInput::Set(v) if v.is_empty() => None,
            SecretInput::Set(v) => Some(v),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct HostInput {
    /// `None` creates a new host.
    #[serde(default)]
    pub id: Option<Id>,
    #[serde(default)]
    pub label: String,
    pub address: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub group_id: Option<Id>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub auth: HostAuthInput,
    #[serde(default)]
    pub startup_snippet_id: Option<Id>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostAuthInput {
    Inline {
        #[serde(default)]
        username: String,
        #[serde(default)]
        password: SecretInput,
        #[serde(default)]
        key_id: Option<Id>,
    },
    Identity {
        identity_id: Id,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupInput {
    #[serde(default)]
    pub id: Option<Id>,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<Id>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IdentityInput {
    #[serde(default)]
    pub id: Option<Id>,
    #[serde(default)]
    pub label: String,
    pub username: String,
    #[serde(default)]
    pub password: SecretInput,
    #[serde(default)]
    pub key_id: Option<Id>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SnippetInput {
    #[serde(default)]
    pub id: Option<Id>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub script: String,
    #[serde(default)]
    pub package: String,
}

/// Credentials resolved for a connection attempt. Stays inside the core.
#[derive(Debug, Clone)]
pub struct ResolvedCredentials {
    pub username: String,
    pub password: Option<String>,
    pub key: Option<SshKey>,
}

/// Normalizes a user-entered tag list: trimmed, non-empty, de-duplicated
/// case-insensitively, original order kept.
pub fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tags.into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && seen.insert(t.to_lowercase()))
        .collect()
}
