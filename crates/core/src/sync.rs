//! Merging this device's vault with what the cloud holds.
//!
//! Sync works item by item. Each host, group, identity, snippet and synced
//! key is one encrypted item; the server knows only its id and revision.
//! Nothing here talks to the network: [`crate::cloud`] moves the bytes,
//! this module decides what they mean for the vault.
//!
//! The rule throughout is that an edit is never discarded silently. When
//! two devices changed the same item, their changes are put together field
//! by field: a name changed here and a password changed there both stand.
//! Only when both changed the very same field, differently, are both
//! versions kept. When one side deleted what the other edited, the edit wins.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::cloud::{open_item, seal_item, VaultKey};
use crate::model::*;
use crate::vault::Vault;
use crate::{now_ms, Result};

/// The single item that carries the synced preferences.
pub const SETTINGS_ID: Uuid = Uuid::from_u128(1);

/// The plaintext of a synced item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ItemBody {
    Host(Host),
    Group(Group),
    Identity(Identity),
    Key(SshKey),
    Snippet(Snippet),
    Settings(serde_json::Value),
}

impl ItemBody {
    fn kind(&self) -> &'static str {
        match self {
            ItemBody::Host(_) => "host",
            ItemBody::Group(_) => "group",
            ItemBody::Identity(_) => "identity",
            ItemBody::Key(_) => "key",
            ItemBody::Snippet(_) => "snippet",
            ItemBody::Settings(_) => "settings",
        }
    }

    fn name(&self) -> String {
        match self {
            ItemBody::Host(h) if h.label.is_empty() => h.address.clone(),
            ItemBody::Host(h) => h.label.clone(),
            ItemBody::Group(g) => g.name.clone(),
            ItemBody::Identity(i) if i.label.is_empty() => i.username.clone(),
            ItemBody::Identity(i) => i.label.clone(),
            ItemBody::Key(k) => k.label.clone(),
            ItemBody::Snippet(s) => s.name.clone(),
            ItemBody::Settings(_) => String::new(),
        }
    }

    /// The item as it is kept for comparing later versions with. A key is
    /// not kept: its secret need not lie in the vault twice.
    fn as_base(&self) -> Option<Value> {
        match self {
            ItemBody::Key(_) => None,
            _ => serde_json::to_value(self).ok(),
        }
    }

    /// A fingerprint of the content. The modification time is left out:
    /// two devices that end up with the same content agree, whenever each
    /// of them got there, and a change that only touches the time (such as
    /// picking a device-only key for a host) is no change for the cloud.
    fn hash(&self) -> String {
        let mut content = self.clone();
        match &mut content {
            ItemBody::Host(h) => h.updated_at = 0,
            ItemBody::Group(g) => g.updated_at = 0,
            ItemBody::Identity(i) => i.updated_at = 0,
            ItemBody::Key(k) => k.updated_at = 0,
            ItemBody::Snippet(s) => s.updated_at = 0,
            ItemBody::Settings(_) => {}
        }
        let bytes = serde_json::to_vec(&content).unwrap_or_default();
        Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

/// An item as the server returned it.
#[derive(Debug, Clone)]
pub struct RemoteItem {
    pub id: Id,
    pub rev: u64,
    pub deleted: bool,
    pub blob: Vec<u8>,
}

/// A local change ready to be sent.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub id: Id,
    /// The server revision this change is based on; 0 for a new item.
    pub base_rev: u64,
    pub deleted: bool,
    pub blob: Vec<u8>,
    /// Hash of the content that was sent, recorded once the server accepts.
    hash: String,
    /// The content itself, kept as what the two sides then agree on.
    base: Option<serde_json::Value>,
}

/// The server's answer to one [`Outgoing`] change.
#[derive(Debug, Clone)]
pub enum PushResult {
    Accepted { id: Id, rev: u64 },
    /// The item moved on the server in the meantime; the next pull brings
    /// its current state. `exists` is false when the server has no such item.
    Conflict { id: Id, exists: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    /// Edited on both sides: the other device's version is in place and
    /// this device's version was kept as a separate copy.
    KeptBoth,
    /// Deleted elsewhere but edited here: this device's version stays.
    KeptEdited,
    /// Deleted here but edited elsewhere: brought back.
    Restored,
    /// Edited on both sides and there is no way to keep two: the other
    /// device's version replaced this one (preferences, key names).
    Replaced,
}

/// Something sync decided on the user's behalf, to be shown to them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConflictNote {
    pub resolution: Resolution,
    /// `host`, `group`, `identity`, `key`, `snippet` or `settings`.
    pub item: &'static str,
    pub name: String,
}

/// The outcome of merging one batch of remote changes.
#[derive(Debug, Clone, Default)]
pub struct Merged {
    pub notes: Vec<ConflictNote>,
    /// Remote changes that were news to this device.
    pub applied: usize,
    /// This was the last page.
    pub complete: bool,
}

/// How a host or identity refers to a key in the cloud: a key known here
/// as device-only is not mentioned. Which device-only key a host uses stays
/// a local matter, and that is what lets one host use different keys on
/// different devices.
fn shared_key(data: &VaultData, key_id: Option<Id>) -> Option<Id> {
    key_id.filter(|id| !data.keys.iter().any(|k| k.id == *id && !k.sync))
}

/// The key to use after taking a remote record: the shared key if it names
/// one, otherwise whatever device-only key was assigned here.
fn merged_key(data: &VaultData, remote: Option<Id>, current: Option<Id>) -> Option<Id> {
    remote.or_else(|| current.filter(|id| data.keys.iter().any(|k| k.id == *id && !k.sync)))
}

/// Puts together two versions of a value that both grew from `base`. A
/// part only one side changed is taken from that side. `None`: both
/// changed the same part, differently, and there is no telling which is
/// meant. Without a `base`, as after signing in again, nothing is known
/// to have been changed by either side, so whatever differs is a clash,
/// save for what devices write by themselves.
fn join_values(base: Option<&Value>, mine: &Value, theirs: &Value, field: &str) -> Option<Value> {
    if mine == theirs {
        return Some(mine.clone());
    }
    match field {
        // When it was last touched: the later of the two.
        "updated_at" => return Some(if mine.as_i64() > theirs.as_i64() { mine.clone() } else { theirs.clone() }),
        // What a device noticed about the server while connected: either
        // will do, and it is never worth a second copy of the host.
        "os" => return Some(if theirs.is_null() { mine.clone() } else { theirs.clone() }),
        _ => {}
    }
    if base == Some(mine) {
        return Some(theirs.clone());
    }
    if base == Some(theirs) {
        return Some(mine.clone());
    }
    let (Value::Object(mine), Value::Object(theirs)) = (mine, theirs) else {
        return None;
    };
    // Two shapes of one thing, such as credentials of a host's own and an
    // identity's, do not mix.
    if mine.get("kind") != theirs.get("kind") {
        return None;
    }
    let base = base.and_then(Value::as_object);
    let mut joined = serde_json::Map::new();
    for name in mine.keys().chain(theirs.keys().filter(|name| !mine.contains_key(*name))) {
        let was = base.and_then(|base| base.get(name));
        match (mine.get(name), theirs.get(name)) {
            (Some(a), Some(b)) => {
                joined.insert(name.clone(), join_values(was, a, b, name)?);
            }
            // On one side only: added there, or removed on the other.
            (Some(only), None) | (None, Some(only)) => match was {
                None => {
                    joined.insert(name.clone(), only.clone());
                }
                Some(was) if was == only => {}
                Some(_) => return None,
            },
            (None, None) => {}
        }
    }
    Some(Value::Object(joined))
}

/// Puts together this device's version of an item and the cloud's.
fn join(base: Option<&Value>, mine: &ItemBody, theirs: &ItemBody) -> Option<ItemBody> {
    // A key is one piece: its parts make no sense from two sources.
    if matches!(mine, ItemBody::Key(_)) || mine.kind() != theirs.kind() {
        return None;
    }
    let (mine, theirs) = (serde_json::to_value(mine).ok()?, serde_json::to_value(theirs).ok()?);
    serde_json::from_value(join_values(base, &mine, &theirs, "")?).ok()
}

/// Everything in the vault that belongs in the cloud, in its cloud form.
fn export(data: &VaultData) -> BTreeMap<Id, ItemBody> {
    let mut items = BTreeMap::new();
    for host in &data.hosts {
        let mut host = host.clone();
        if let HostAuth::Inline { key_id, .. } = &mut host.auth {
            *key_id = shared_key(data, *key_id);
        }
        items.insert(host.id, ItemBody::Host(host));
    }
    for group in &data.groups {
        items.insert(group.id, ItemBody::Group(group.clone()));
    }
    for identity in &data.identities {
        let mut identity = identity.clone();
        identity.key_id = shared_key(data, identity.key_id);
        items.insert(identity.id, ItemBody::Identity(identity));
    }
    for key in data.keys.iter().filter(|k| k.sync) {
        items.insert(key.id, ItemBody::Key(key.clone()));
    }
    for snippet in &data.snippets {
        items.insert(snippet.id, ItemBody::Snippet(snippet.clone()));
    }
    if !data.settings.is_null() {
        items.insert(SETTINGS_ID, ItemBody::Settings(data.settings.clone()));
    }
    items
}

/// Puts a remote item into the vault, replacing the local one if present.
fn apply(data: &mut VaultData, body: ItemBody) {
    fn upsert<T>(list: &mut Vec<T>, item: T, id_of: impl Fn(&T) -> Id) {
        let id = id_of(&item);
        match list.iter_mut().find(|existing| id_of(existing) == id) {
            Some(existing) => *existing = item,
            None => list.push(item),
        }
    }
    match body {
        ItemBody::Host(mut host) => {
            let current = data
                .hosts
                .iter()
                .find(|h| h.id == host.id)
                .and_then(|h| match &h.auth {
                    HostAuth::Inline { key_id, .. } => *key_id,
                    HostAuth::Identity { .. } => None,
                });
            if let HostAuth::Inline { key_id, .. } = &mut host.auth {
                *key_id = merged_key(data, *key_id, current);
            }
            upsert(&mut data.hosts, host, |h| h.id);
        }
        ItemBody::Group(group) => upsert(&mut data.groups, group, |g| g.id),
        ItemBody::Identity(mut identity) => {
            let current = data
                .identities
                .iter()
                .find(|i| i.id == identity.id)
                .and_then(|i| i.key_id);
            identity.key_id = merged_key(data, identity.key_id, current);
            upsert(&mut data.identities, identity, |i| i.id);
        }
        ItemBody::Key(mut key) => {
            key.sync = true;
            upsert(&mut data.keys, key, |k| k.id);
        }
        ItemBody::Snippet(snippet) => upsert(&mut data.snippets, snippet, |s| s.id),
        ItemBody::Settings(settings) => data.settings = settings,
    }
}

fn remove(data: &mut VaultData, id: Id) {
    data.hosts.retain(|h| h.id != id);
    data.groups.retain(|g| g.id != id);
    data.identities.retain(|i| i.id != id);
    data.keys.retain(|k| k.id != id);
    data.snippets.retain(|s| s.id != id);
}

/// Stores this device's version of an item under a new id, marked as a
/// conflicted copy. Returns `false` for items that cannot exist twice.
fn keep_copy(data: &mut VaultData, body: ItemBody, suffix: &str) -> bool {
    let now = now_ms();
    let renamed = |name: &str| format!("{name} {suffix}").trim().to_string();
    match body {
        ItemBody::Host(mut host) => {
            let base = if host.label.is_empty() {
                host.address.clone()
            } else {
                host.label.clone()
            };
            host.id = Uuid::new_v4();
            host.label = renamed(&base);
            host.updated_at = now;
            data.hosts.push(host);
        }
        ItemBody::Group(mut group) => {
            group.id = Uuid::new_v4();
            group.name = renamed(&group.name);
            group.updated_at = now;
            data.groups.push(group);
        }
        ItemBody::Identity(mut identity) => {
            let base = if identity.label.is_empty() {
                identity.username.clone()
            } else {
                identity.label.clone()
            };
            identity.id = Uuid::new_v4();
            identity.label = renamed(&base);
            identity.updated_at = now;
            data.identities.push(identity);
        }
        ItemBody::Snippet(mut snippet) => {
            snippet.id = Uuid::new_v4();
            snippet.name = renamed(&snippet.name);
            snippet.updated_at = now;
            data.snippets.push(snippet);
        }
        ItemBody::Key(_) | ItemBody::Settings(_) => return false,
    }
    true
}

/// After a merge, makes sure nothing points at an item that is gone.
fn repair(data: &mut VaultData) {
    let groups: Vec<Id> = data.groups.iter().map(|g| g.id).collect();
    let keys: Vec<Id> = data.keys.iter().map(|k| k.id).collect();
    let identities: Vec<Id> = data.identities.iter().map(|i| i.id).collect();
    let snippets: Vec<Id> = data.snippets.iter().map(|s| s.id).collect();
    let present = |list: &[Id], id: Option<Id>| id.filter(|id| list.contains(id));

    for group in &mut data.groups {
        group.parent_id = present(&groups, group.parent_id).filter(|parent| *parent != group.id);
    }
    for identity in &mut data.identities {
        identity.key_id = present(&keys, identity.key_id);
    }
    for host in &mut data.hosts {
        host.group_id = present(&groups, host.group_id);
        host.startup_snippet_id = present(&snippets, host.startup_snippet_id);
        match &mut host.auth {
            HostAuth::Inline { key_id, .. } => *key_id = present(&keys, *key_id),
            HostAuth::Identity { identity_id } if !identities.contains(identity_id) => {
                // The identity is gone; the host falls back to asking.
                host.auth = HostAuth::Inline {
                    username: String::new(),
                    password: None,
                    key_id: None,
                };
            }
            HostAuth::Identity { .. } => {}
        }
    }
    // A snippet's remembered hosts that are gone are forgotten.
    let hosts: Vec<Id> = data.hosts.iter().map(|h| h.id).collect();
    for snippet in &mut data.snippets {
        snippet.targets.retain(|target| hosts.contains(target));
    }
}

fn pending(data: &VaultData) -> usize {
    let local = export(data);
    let changed = local
        .iter()
        .filter(|(id, body)| data.synced.get(id).map(|s| s.hash.as_str()) != Some(&body.hash()))
        .count();
    let deleted = data
        .synced
        .keys()
        .filter(|id| !local.contains_key(id))
        .count();
    changed + deleted
}

impl Vault {
    pub fn cloud_account(&self) -> Option<CloudAccount> {
        self.data.cloud.clone()
    }

    /// Signs the vault in to an account, or out of it. Either way what was
    /// known about the previous account's cloud state is forgotten; local
    /// data is untouched.
    pub fn set_cloud_account(&mut self, account: Option<CloudAccount>) -> Result<()> {
        self.commit(|data| {
            data.cloud = account;
            data.synced.clear();
            Ok(())
        })
    }

    /// Replaces the stored account details, keeping what is known about
    /// the cloud's content.
    pub fn update_cloud_account(&mut self, account: CloudAccount) -> Result<()> {
        self.commit(|data| {
            data.cloud = Some(account);
            Ok(())
        })
    }

    /// Records that the server no longer accepts this device.
    pub fn mark_cloud_revoked(&mut self) -> Result<()> {
        self.commit(|data| {
            if let Some(account) = &mut data.cloud {
                account.revoked = true;
            }
            Ok(())
        })
    }

    /// Number of local changes the cloud does not have yet. Zero when not
    /// signed in.
    pub fn pending_changes(&self) -> usize {
        match &self.data.cloud {
            Some(account) if !account.revoked => pending(&self.data),
            _ => 0,
        }
    }

    /// Merges changes pulled from the server, up to `cursor`. `complete`
    /// says this was the last page, so the vault has seen everything.
    ///
    /// `copy_suffix` names the copies kept when both sides edited the same
    /// item, e.g. `(conflict)`.
    pub fn merge_remote(
        &mut self,
        items: Vec<RemoteItem>,
        cursor: u64,
        complete: bool,
        key: &VaultKey,
        copy_suffix: &str,
    ) -> Result<Merged> {
        self.commit(|data| {
            let mut notes = Vec::new();
            let mut applied = 0usize;
            let note = |notes: &mut Vec<ConflictNote>, resolution, body: &ItemBody| {
                notes.push(ConflictNote {
                    resolution,
                    item: body.kind(),
                    name: body.name(),
                })
            };

            for remote in items {
                let known = data.synced.get(&remote.id).cloned();
                if known.as_ref().is_some_and(|s| remote.rev <= s.rev) {
                    continue;
                }
                applied += 1;
                let local = export(data).remove(&remote.id);
                let local_changed = match (&local, &known) {
                    (Some(body), Some(synced)) => body.hash() != synced.hash,
                    (Some(_), None) => true,
                    (None, Some(_)) => true,
                    (None, None) => false,
                };

                if remote.deleted {
                    match local {
                        // Edited here, deleted there: the edit stays and
                        // will be sent back as a re-creation.
                        Some(body) if local_changed && known.is_some() => {
                            note(&mut notes, Resolution::KeptEdited, &body);
                            data.synced.insert(
                                remote.id,
                                Synced {
                                    rev: remote.rev,
                                    hash: String::new(),
                                    base: None,
                                },
                            );
                        }
                        // Never synced under this id here: unrelated to the
                        // tombstone, keep it as a new item.
                        Some(_) if local_changed => {
                            data.synced.insert(
                                remote.id,
                                Synced {
                                    rev: remote.rev,
                                    hash: String::new(),
                                    base: None,
                                },
                            );
                        }
                        Some(_) => {
                            remove(data, remote.id);
                            data.synced.remove(&remote.id);
                        }
                        None => {
                            data.synced.remove(&remote.id);
                        }
                    }
                    continue;
                }

                // An item this version cannot read (damaged, or of a kind a
                // newer version introduced) is left alone on both sides.
                let Ok(plain) = open_item(key, remote.id, &remote.blob) else {
                    log::warn!("skipping unreadable cloud item {}", remote.id);
                    continue;
                };
                let Ok(body) = serde_json::from_slice::<ItemBody>(&plain) else {
                    log::warn!("skipping cloud item {} of an unknown kind", remote.id);
                    continue;
                };

                // What the cloud holds, when it is not what ends up here:
                // this device's own changes were merged in on top of it.
                let mut agreed: Option<ItemBody> = None;
                match local {
                    Some(mine) if local_changed => {
                        // Compare in this device's own terms.
                        let mut probe = data.clone();
                        apply(&mut probe, body.clone());
                        let theirs = export(&probe).remove(&remote.id);
                        if theirs.as_ref().map(ItemBody::hash) == Some(mine.hash()) {
                            apply(data, body);
                        } else if let Some((joined, theirs)) = theirs.and_then(|theirs| {
                            let base = known.as_ref().and_then(|s| s.base.as_ref());
                            join(base, &mine, &theirs).map(|joined| (joined, theirs))
                        }) {
                            // Changed on both sides, in different places:
                            // both changes stand, and the result goes back up.
                            apply(data, joined);
                            agreed = Some(theirs);
                        } else {
                            if keep_copy(data, mine.clone(), copy_suffix) {
                                note(&mut notes, Resolution::KeptBoth, &mine);
                            } else {
                                note(&mut notes, Resolution::Replaced, &mine);
                            }
                            apply(data, body);
                        }
                    }
                    Some(_) => apply(data, body),
                    None => {
                        if local_changed {
                            // Deleted here, edited there: it comes back.
                            note(&mut notes, Resolution::Restored, &body);
                        }
                        apply(data, body);
                    }
                }
                // The hash is taken from this device's own rendering of the
                // item, so re-serialization differences never look like edits.
                if let Some(applied) = agreed.or_else(|| export(data).remove(&remote.id)) {
                    data.synced.insert(
                        remote.id,
                        Synced {
                            rev: remote.rev,
                            hash: applied.hash(),
                            base: applied.as_base(),
                        },
                    );
                }
            }

            // References are checked only once everything has arrived: an
            // item may be delivered before the item it points to.
            if complete {
                repair(data);
            }
            if let Some(account) = &mut data.cloud {
                account.cursor = account.cursor.max(cursor);
            }
            Ok(Merged {
                notes,
                applied,
                complete,
            })
        })
    }

    /// Local changes to send: new and edited items, and deletions.
    pub fn outgoing(&self, key: &VaultKey, limit: usize) -> Result<Vec<Outgoing>> {
        let local = export(&self.data);
        let mut changes = Vec::new();
        for (id, body) in &local {
            let hash = body.hash();
            let known = self.data.synced.get(id);
            if known.map(|s| s.hash.as_str()) == Some(hash.as_str()) {
                continue;
            }
            changes.push(Outgoing {
                id: *id,
                base_rev: known.map_or(0, |s| s.rev),
                deleted: false,
                blob: seal_item(key, *id, &serde_json::to_vec(body)?)?,
                hash,
                base: body.as_base(),
            });
        }
        for (id, known) in &self.data.synced {
            if !local.contains_key(id) {
                changes.push(Outgoing {
                    id: *id,
                    base_rev: known.rev,
                    deleted: true,
                    blob: Vec::new(),
                    hash: String::new(),
                    base: None,
                });
            }
        }
        changes.truncate(limit);
        Ok(changes)
    }

    /// Records the server's verdict on what was sent.
    pub fn mark_pushed(&mut self, sent: &[Outgoing], results: &[PushResult]) -> Result<()> {
        self.commit(|data| {
            for result in results {
                match result {
                    PushResult::Accepted { id, rev } => {
                        let Some(change) = sent.iter().find(|c| c.id == *id) else {
                            continue;
                        };
                        if change.deleted {
                            data.synced.remove(id);
                        } else {
                            data.synced.insert(
                                *id,
                                Synced {
                                    rev: *rev,
                                    hash: change.hash.clone(),
                                    base: change.base.clone(),
                                },
                            );
                        }
                    }
                    // The server has nothing under this id although we
                    // thought it did: offer the item as new next time.
                    PushResult::Conflict { id, exists: false } => {
                        data.synced.remove(id);
                    }
                    PushResult::Conflict { .. } => {}
                }
            }
            // If the server numbered our changes right after the last
            // revision we had seen, nothing from other devices came in
            // between, and there is nothing to fetch up to that point.
            if let Some(account) = &mut data.cloud {
                let mut revs: Vec<u64> = results
                    .iter()
                    .filter_map(|result| match result {
                        PushResult::Accepted { rev, .. } => Some(*rev),
                        PushResult::Conflict { .. } => None,
                    })
                    .collect();
                revs.sort_unstable();
                for rev in revs {
                    if rev != account.cursor + 1 {
                        break;
                    }
                    account.cursor = rev;
                }
            }
            Ok(())
        })
    }

    pub fn mark_synced(&mut self) -> Result<()> {
        self.commit(|data| {
            if let Some(account) = &mut data.cloud {
                account.last_sync_at = Some(now_ms());
            }
            // What was synced before versions were kept to compare with:
            // an item that is in step with the cloud is its own base.
            let local = export(data);
            for (id, known) in data.synced.iter_mut().filter(|(_, known)| known.base.is_none()) {
                if let Some(body) = local.get(id).filter(|body| body.hash() == known.hash) {
                    known.base = body.as_base();
                }
            }
            Ok(())
        })
    }
}
