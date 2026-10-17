//! Sync between devices.
//!
//! Most tests run two or three vaults against an in-memory server that
//! follows the real server's rule (a change is applied only if it is based
//! on the item's current revision). The last test does the same through the
//! real server when one is reachable.

use std::collections::BTreeMap;
use std::sync::Mutex;

use myssh_core::cloud::{self, DeviceInfo, Page, Transport};
use myssh_core::keys::KeyKind;
use myssh_core::known_hosts::{HostKeyStatus, KnownHosts};
use myssh_core::keystore::FileKeyStore;
use myssh_core::model::*;
use myssh_core::sync::{Outgoing, PushResult, RemoteItem, Resolution, SETTINGS_ID};
use myssh_core::vault::Vault;
use myssh_core::{Error, Result};
use uuid::Uuid;

const SUFFIX: &str = "(conflict)";

#[derive(Default)]
struct FakeServer {
    state: Mutex<(u64, BTreeMap<Id, RemoteItem>)>,
    /// Pretend to be unreachable.
    offline: Mutex<bool>,
}

impl FakeServer {
    fn check_online(&self) -> Result<()> {
        if *self.offline.lock().unwrap() {
            return Err(Error::Offline("test: no network".into()));
        }
        Ok(())
    }

    fn items(&self) -> Vec<RemoteItem> {
        self.state.lock().unwrap().1.values().cloned().collect()
    }

    /// Stores something no client version understands.
    fn plant(&self, id: Id, blob: &[u8]) {
        let mut state = self.state.lock().unwrap();
        state.0 += 1;
        let rev = state.0;
        state.1.insert(
            id,
            RemoteItem {
                id,
                rev,
                deleted: false,
                blob: blob.to_vec(),
            },
        );
    }

    fn lose(&self, id: Id) {
        self.state.lock().unwrap().1.remove(&id);
    }
}

impl Transport for FakeServer {
    async fn pull(&self, since: u64) -> Result<Page> {
        self.check_online()?;
        let state = self.state.lock().unwrap();
        let mut items: Vec<RemoteItem> = state
            .1
            .values()
            .filter(|item| item.rev > since)
            .cloned()
            .collect();
        items.sort_by_key(|item| item.rev);
        Ok(Page {
            items,
            cursor: state.0,
            more: false,
        })
    }

    async fn push(&self, changes: &[Outgoing]) -> Result<Vec<PushResult>> {
        self.check_online()?;
        let mut state = self.state.lock().unwrap();
        let mut results = Vec::new();
        for change in changes {
            let current = state.1.get(&change.id).map_or(0, |item| item.rev);
            if current != change.base_rev {
                results.push(PushResult::Conflict {
                    id: change.id,
                    exists: state.1.contains_key(&change.id),
                });
                continue;
            }
            state.0 += 1;
            let rev = state.0;
            state.1.insert(
                change.id,
                RemoteItem {
                    id: change.id,
                    rev,
                    deleted: change.deleted,
                    blob: change.blob.clone(),
                },
            );
            results.push(PushResult::Accepted { id: change.id, rev });
        }
        Ok(results)
    }
}

struct Device {
    _dir: tempfile::TempDir,
    vault: Mutex<Vault>,
}

impl Device {
    /// A fresh device signed in to the shared test account.
    fn new(vault_key: &str) -> Device {
        let device = Device::signed_out();
        device
            .vault
            .lock()
            .unwrap()
            .set_cloud_account(Some(CloudAccount {
                server: "http://127.0.0.1:1".into(),
                email: "me@example.com".into(),
                user_id: "user".into(),
                device_id: Uuid::new_v4().to_string(),
                token: "token".into(),
                vault_key: vault_key.into(),
                cursor: 0,
                last_sync_at: None,
                revoked: false,
            }))
            .unwrap();
        device
    }

    fn signed_out() -> Device {
        let dir = tempfile::tempdir().unwrap();
        let keystore = FileKeyStore::new(dir.path().join("master.key"));
        let vault = Vault::open(dir.path().join("vault.bin"), &keystore).unwrap();
        Device {
            _dir: dir,
            vault: Mutex::new(vault),
        }
    }

    fn edit<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T>) -> T {
        f(&mut self.vault.lock().unwrap()).unwrap()
    }

    fn snapshot(&self) -> Snapshot {
        self.vault.lock().unwrap().snapshot()
    }

    fn host(&self, id: Id) -> Option<HostView> {
        self.snapshot().hosts.into_iter().find(|h| h.id == id)
    }

    /// Edits a host the way its form would: read it, change it, save it.
    fn change(&self, id: Id, f: impl FnOnce(&mut HostInput)) {
        let input = edited(&self.host(id).unwrap(), f);
        self.edit(|v| v.save_host(input));
    }

    fn labels(&self) -> Vec<String> {
        let mut labels: Vec<String> = self.snapshot().hosts.into_iter().map(|h| h.label).collect();
        labels.sort();
        labels
    }

    async fn sync(&self, server: &FakeServer) -> cloud::SyncReport {
        cloud::sync_with(&self.vault, server, SUFFIX).await.unwrap()
    }
}

fn shared_key() -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(&cloud::new_vault_key()[..])
}

fn host(label: &str) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: format!("{}.example.com", label.replace(' ', "-")),
        port: None,
        group_id: None,
        tags: vec!["prod".into()],
        auth: HostAuthInput::Inline {
            username: "root".into(),
            password: SecretInput::Set(format!("{label}-password")),
            key_id: None,
        },
        startup_snippet_id: None,
        forwards: None,
    }
}

/// The host as an edit form would resubmit it, with changes applied.
fn edited(view: &HostView, change: impl FnOnce(&mut HostInput)) -> HostInput {
    let mut input = HostInput {
        id: Some(view.id),
        label: view.label.clone(),
        address: view.address.clone(),
        port: Some(view.port),
        group_id: view.group_id,
        tags: view.tags.clone(),
        auth: match &view.auth {
            HostAuthView::Inline {
                username, key_id, ..
            } => HostAuthInput::Inline {
                username: username.clone(),
                password: SecretInput::Keep,
                key_id: *key_id,
            },
            HostAuthView::Identity { identity_id } => HostAuthInput::Identity {
                identity_id: *identity_id,
            },
        },
        startup_snippet_id: view.startup_snippet_id,
        forwards: None,
    };
    change(&mut input);
    input
}

fn key_of(view: &HostView) -> Option<Id> {
    match &view.auth {
        HostAuthView::Inline { key_id, .. } => *key_id,
        HostAuthView::Identity { .. } => None,
    }
}

/// A device with its own known hosts' file: the saved hosts' keys follow
/// the account, as in the app.
struct Keyed {
    device: Device,
    known: Mutex<KnownHosts>,
}

impl cloud::VaultAccess for Keyed {
    fn with_vault<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T>) -> Result<T> {
        f(&mut self.device.vault.lock().unwrap())
    }

    fn known_hosts(&self) -> Option<&Mutex<KnownHosts>> {
        Some(&self.known)
    }
}

impl Keyed {
    fn new(vault_key: &str) -> Keyed {
        let device = Device::new(vault_key);
        let known = KnownHosts::open(device._dir.path().join("known_hosts.json")).unwrap();
        Keyed { device, known: Mutex::new(known) }
    }

    async fn sync(&self, server: &FakeServer) -> cloud::SyncReport {
        cloud::sync_with(self, server, SUFFIX).await.unwrap()
    }

    fn status(&self, host: &str, key: &russh::keys::PublicKey) -> HostKeyStatus {
        self.known.lock().unwrap().check(host, 22, key).unwrap()
    }
}

fn server_key() -> russh::keys::PublicKey {
    let key = myssh_core::keys::generate(KeyKind::Ed25519, "server").unwrap();
    russh::keys::PublicKey::from_openssh(&key.public_key).unwrap()
}

#[tokio::test]
async fn everything_travels_encrypted_and_arrives_whole() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));

    let group = a.edit(|v| {
        v.save_group(GroupInput {
            id: None,
            name: "Production".into(),
            parent_id: None,
        })
    });
    let snippet = a.edit(|v| {
        v.save_snippet(SnippetInput {
            id: None,
            name: "logs".into(),
            description: String::new(),
            script: "tail -f /var/log/syslog".into(),
            package: "ops".into(),
        })
    });
    let shared = a.edit(|v| v.generate_key(KeyKind::Ed25519, "shared"));
    a.edit(|v| v.set_key_sync(shared.id, true));
    let local = a.edit(|v| v.generate_key(KeyKind::Ed25519, "this device only"));
    let identity = a.edit(|v| {
        v.save_identity(IdentityInput {
            id: None,
            label: "deploy".into(),
            username: "deploy".into(),
            password: SecretInput::Set("identity-password".into()),
            key_id: Some(shared.id),
        })
    });
    let web = a.edit(|v| {
        v.save_host(HostInput {
            group_id: Some(group.id),
            startup_snippet_id: Some(snippet.id),
            ..host("web")
        })
    });
    let db = a.edit(|v| {
        v.save_host(HostInput {
            auth: HostAuthInput::Identity {
                identity_id: identity.id,
            },
            ..host("db")
        })
    });
    let edge = a.edit(|v| {
        v.save_host(HostInput {
            auth: HostAuthInput::Inline {
                username: "root".into(),
                password: SecretInput::Keep,
                key_id: Some(local.id),
            },
            ..host("edge")
        })
    });
    a.edit(|v| v.save_settings(serde_json::json!({ "theme": "dark", "fontSize": 14 })));

    assert_eq!(a.snapshot().cloud.unwrap().pending, 8);
    let report = a.sync(&server).await;
    assert_eq!((report.pushed, report.pulled, report.pending), (8, 0, 0));
    assert!(report.conflicts.is_empty());
    assert_eq!(a.snapshot().cloud.unwrap().pending, 0);

    // The server holds only opaque blobs: no names, addresses or secrets.
    let stored = server.items();
    assert_eq!(stored.len(), 8);
    for item in &stored {
        let text = String::from_utf8_lossy(&item.blob);
        for secret in [
            "web",
            "example.com",
            "password",
            "PRIVATE KEY",
            "deploy",
            "tail -f",
            "dark",
        ] {
            assert!(!text.contains(secret), "{secret} is visible to the server");
        }
    }
    // The device-only key never left.
    assert!(!stored.iter().any(|item| item.id == local.id));

    let report = b.sync(&server).await;
    assert_eq!((report.pulled, report.pushed), (8, 0));
    let there = b.snapshot();
    assert_eq!(there.hosts.len(), 3);
    assert_eq!(there.groups[0].name, "Production");
    assert_eq!(there.snippets[0].script, "tail -f /var/log/syslog\n".trim_end());
    assert_eq!(there.settings["fontSize"], 14);
    assert_eq!(
        there.keys.iter().map(|k| (k.label.as_str(), k.sync)).collect::<Vec<_>>(),
        vec![("shared", true)]
    );
    assert_eq!(there.keys[0].fingerprint, shared.fingerprint);

    // References and secrets arrive intact.
    let (_, credentials) = b.edit(|v| v.resolve_credentials(web.id));
    assert_eq!(credentials.password.as_deref(), Some("web-password"));
    let (_, credentials) = b.edit(|v| v.resolve_credentials(db.id));
    assert_eq!(credentials.username, "deploy");
    assert_eq!(credentials.password.as_deref(), Some("identity-password"));
    assert_eq!(credentials.key.unwrap().fingerprint, shared.fingerprint);
    let web_there = b.host(web.id).unwrap();
    assert_eq!(web_there.group_id, Some(group.id));
    assert_eq!(web_there.startup_snippet_id, Some(snippet.id));
    // The host that uses A's device-only key simply has no key on B.
    assert_eq!(key_of(&b.host(edge.id).unwrap()), None);
    assert_eq!(key_of(&a.host(edge.id).unwrap()), Some(local.id));

    // Nothing left to do in either direction.
    for device in [&a, &b] {
        let report = device.sync(&server).await;
        assert_eq!((report.pulled, report.pushed, report.pending), (0, 0, 0));
    }
}

#[tokio::test]
async fn edits_made_on_both_devices_are_both_kept() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let web = a.edit(|v| v.save_host(host("web")));
    a.sync(&server).await;
    b.sync(&server).await;

    // A plain edit just travels.
    a.change(web.id, |h| h.port = Some(2200));
    a.sync(&server).await;
    let report = b.sync(&server).await;
    assert!(report.conflicts.is_empty());
    assert_eq!(b.host(web.id).unwrap().port, 2200);

    // Now both edit the same host before syncing.
    a.change(web.id, |h| h.address = "a.example.com".into());
    b.change(web.id, |h| h.address = "b.example.com".into());
    a.sync(&server).await;
    let report = b.sync(&server).await;
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].resolution, Resolution::KeptBoth);
    assert_eq!((report.conflicts[0].item, report.conflicts[0].name.as_str()), ("host", "web"));

    // B: the other device's version is in place, B's own is kept as a copy.
    assert_eq!(b.host(web.id).unwrap().address, "a.example.com");
    assert_eq!(b.labels(), vec!["web", "web (conflict)"]);
    let copy = b.snapshot().hosts.into_iter().find(|h| h.label == "web (conflict)").unwrap();
    assert_eq!(copy.address, "b.example.com");
    let (_, credentials) = b.edit(|v| v.resolve_credentials(copy.id));
    assert_eq!(credentials.password.as_deref(), Some("web-password"));

    // And A receives the copy too: neither edit was lost anywhere.
    a.sync(&server).await;
    assert_eq!(a.labels(), vec!["web", "web (conflict)"]);
    assert_eq!(a.host(copy.id).unwrap().address, "b.example.com");

    // The same edit made on both sides is not a conflict.
    a.edit(|v| v.save_settings(serde_json::json!({ "theme": "light" })));
    b.edit(|v| v.save_settings(serde_json::json!({ "theme": "light" })));
    a.sync(&server).await;
    assert!(b.sync(&server).await.conflicts.is_empty());
    // Different preferences cannot both stay: the later sync says so.
    a.edit(|v| v.save_settings(serde_json::json!({ "theme": "dark" })));
    b.edit(|v| v.save_settings(serde_json::json!({ "theme": "solarized" })));
    a.sync(&server).await;
    let report = b.sync(&server).await;
    assert_eq!(report.conflicts[0].resolution, Resolution::Replaced);
    assert_eq!(report.conflicts[0].item, "settings");
    assert_eq!(b.snapshot().settings["theme"], "dark");
}

#[tokio::test]
async fn changes_to_different_parts_of_a_host_are_put_together() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let web = a.edit(|v| v.save_host(host("web")));
    a.sync(&server).await;
    b.sync(&server).await;

    // Renamed on one device; on the other its password was changed. Each
    // touched what the other left alone, so both changes stand: one host.
    a.change(web.id, |h| h.label = "web, renamed".into());
    b.change(web.id, |h| {
        h.auth = HostAuthInput::Inline {
            username: "root".into(),
            password: SecretInput::Set("typed on b".into()),
            key_id: None,
        }
    });
    a.sync(&server).await;
    let report = b.sync(&server).await;
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert_eq!(b.labels(), vec!["web, renamed"]);
    let (_, credentials) = b.edit(|v| v.resolve_credentials(web.id));
    assert_eq!(credentials.password.as_deref(), Some("typed on b"));
    // The result went back up, and the first device has it whole as well.
    assert!(a.sync(&server).await.conflicts.is_empty());
    assert_eq!(a.labels(), vec!["web, renamed"]);
    let (_, credentials) = a.edit(|v| v.resolve_credentials(web.id));
    assert_eq!(credentials.password.as_deref(), Some("typed on b"));
    assert_eq!(b.sync(&server).await.pulled, 0);

    // The same when what one device did was only to connect, and note the
    // server's system by itself: that is no edit to quarrel over.
    let ubuntu = HostOs { id: "ubuntu".into(), family: Some("debian".into()), name: "Ubuntu 24.04".into() };
    a.change(web.id, |h| h.port = Some(2200));
    assert!(b.edit(|v| v.set_host_os(web.id, ubuntu.clone())));
    a.sync(&server).await;
    assert!(b.sync(&server).await.conflicts.is_empty());
    a.sync(&server).await;
    for device in [&a, &b] {
        let host = device.host(web.id).unwrap();
        assert_eq!((host.port, host.os.as_ref().map(|os| os.id.as_str())), (2200, Some("ubuntu")));
        assert_eq!(device.labels(), vec!["web, renamed"]);
    }
    // Two devices that each noticed the system, differently worded: still no quarrel.
    let newer = HostOs { name: "Ubuntu 24.04.1 LTS".into(), ..ubuntu.clone() };
    a.change(web.id, |h| h.tags = vec!["prod".into(), "eu".into()]);
    assert!(b.edit(|v| v.set_host_os(web.id, newer)));
    a.sync(&server).await;
    assert!(b.sync(&server).await.conflicts.is_empty());
    assert_eq!(b.host(web.id).unwrap().tags, vec!["prod", "eu"]);

    // The very same part changed on both, differently: that still cannot
    // be settled, and both versions are kept, whatever else was changed.
    a.change(web.id, |h| h.label = "named on a".into());
    b.change(web.id, |h| {
        h.label = "named on b".into();
        h.port = Some(2222);
    });
    a.sync(&server).await;
    let report = b.sync(&server).await;
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].resolution, Resolution::KeptBoth);
    assert_eq!(b.labels(), vec!["named on a", "named on b (conflict)"]);

    // Preferences are put together the same way, one by one.
    a.edit(|v| v.save_settings(serde_json::json!({ "theme": "light", "fontSize": 13 })));
    a.sync(&server).await;
    b.sync(&server).await;
    a.edit(|v| v.save_settings(serde_json::json!({ "theme": "dark", "fontSize": 13 })));
    b.edit(|v| v.save_settings(serde_json::json!({ "theme": "light", "fontSize": 15 })));
    a.sync(&server).await;
    assert!(b.sync(&server).await.conflicts.is_empty());
    a.sync(&server).await;
    for device in [&a, &b] {
        assert_eq!(device.snapshot().settings, serde_json::json!({ "theme": "dark", "fontSize": 15 }));
    }
}

#[tokio::test]
async fn a_pin_travels_and_survives_an_edit_elsewhere() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let web = a.edit(|v| v.save_host(host("web")));
    let db = a.edit(|v| v.save_host(host("db")));
    a.sync(&server).await;
    b.sync(&server).await;

    // Pinned on one device, renamed on the other: both stand.
    assert!(a.edit(|v| v.pin_host(db.id, true)).pinned);
    b.change(db.id, |h| h.label = "db, renamed".into());
    a.sync(&server).await;
    assert!(b.sync(&server).await.conflicts.is_empty());
    a.sync(&server).await;
    for device in [&a, &b] {
        let host = device.host(db.id).unwrap();
        assert!(host.pinned);
        assert_eq!(host.label, "db, renamed");
        // The edit form knows nothing of pins, and saving it keeps one.
        assert!(!device.host(web.id).unwrap().pinned);
    }
    b.change(db.id, |h| h.port = Some(2222));
    assert!(b.host(db.id).unwrap().pinned);

    // Unpinning travels too.
    b.edit(|v| v.pin_host(db.id, false));
    b.sync(&server).await;
    a.sync(&server).await;
    assert!(!a.host(db.id).unwrap().pinned);
}

#[tokio::test]
async fn a_device_that_signs_in_again_quarrels_only_over_what_differs() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let web = a.edit(|v| v.save_host(host("web")));
    let db = a.edit(|v| v.save_host(host("db")));
    a.sync(&server).await;
    b.sync(&server).await;

    // B signs out and in again: it no longer knows what it had in common
    // with the cloud. Meanwhile one host was renamed elsewhere, and B
    // itself only connected to the other and noted its system.
    let account = b.edit(|v| Ok(v.cloud_account().unwrap()));
    b.edit(|v| v.set_cloud_account(None));
    a.change(web.id, |h| h.label = "web, renamed".into());
    a.sync(&server).await;
    let debian = HostOs { id: "debian".into(), family: None, name: "Debian 12".into() };
    assert!(b.edit(|v| v.set_host_os(db.id, debian)));
    b.edit(|v| v.set_cloud_account(Some(CloudAccount { cursor: 0, last_sync_at: None, ..account })));

    let report = b.sync(&server).await;
    // The renamed one differs in a way nothing can settle: both are kept.
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].name, "web");
    // The other differs only by what the device noted itself: one host, with the note.
    assert_eq!(b.labels(), vec!["db", "web (conflict)", "web, renamed"]);
    assert_eq!(b.host(db.id).unwrap().os.map(|os| os.id), Some("debian".into()));
}

#[tokio::test]
async fn an_edit_beats_a_deletion_either_way() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let one = a.edit(|v| v.save_host(host("one")));
    let two = a.edit(|v| v.save_host(host("two")));
    let three = a.edit(|v| v.save_host(host("three")));
    a.sync(&server).await;
    b.sync(&server).await;

    // one: deleted on A, edited on B. two: edited on A, deleted on B.
    // three: deleted on both.
    a.edit(|v| v.delete_host(one.id));
    b.change(one.id, |h| h.port = Some(2222));
    a.change(two.id, |h| h.port = Some(2223));
    b.edit(|v| v.delete_host(two.id));
    a.edit(|v| v.delete_host(three.id));
    b.edit(|v| v.delete_host(three.id));

    a.sync(&server).await;
    let report = b.sync(&server).await;
    let mut seen: Vec<_> = report
        .conflicts
        .iter()
        .map(|c| (c.name.as_str(), c.resolution))
        .collect();
    seen.sort_by_key(|(name, _)| *name);
    assert_eq!(
        seen,
        vec![("one", Resolution::KeptEdited), ("two", Resolution::Restored)]
    );
    assert_eq!(b.labels(), vec!["one", "two"]);
    assert_eq!(b.host(one.id).unwrap().port, 2222);
    assert_eq!(b.host(two.id).unwrap().port, 2223);

    let report = a.sync(&server).await;
    assert!(report.conflicts.is_empty());
    assert_eq!(a.labels(), vec!["one", "two"]);
    assert_eq!(a.host(one.id).unwrap().port, 2222);

    // An ordinary deletion still propagates.
    a.edit(|v| v.delete_host(two.id));
    a.sync(&server).await;
    b.sync(&server).await;
    assert_eq!(b.labels(), vec!["one"]);
}

#[tokio::test]
async fn one_host_can_use_a_different_key_on_each_device() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let web = a.edit(|v| v.save_host(host("web")));
    a.sync(&server).await;
    b.sync(&server).await;

    let key_a = a.edit(|v| v.generate_key(KeyKind::Ed25519, "A's key"));
    let key_b = b.edit(|v| v.generate_key(KeyKind::Ed25519, "B's key"));
    a.edit(|v| v.assign_key(web.id, key_a.id));
    b.edit(|v| v.assign_key(web.id, key_b.id));

    // A device-only key choice is not a change for the cloud at all.
    for _ in 0..2 {
        for device in [&a, &b] {
            let report = device.sync(&server).await;
            assert_eq!((report.pushed, report.pulled), (0, 0));
        }
    }
    assert_eq!(key_of(&a.host(web.id).unwrap()), Some(key_a.id));
    assert_eq!(key_of(&b.host(web.id).unwrap()), Some(key_b.id));

    // Another change to the host travels without disturbing either choice.
    a.change(web.id, |h| h.port = Some(2200));
    a.sync(&server).await;
    b.sync(&server).await;
    assert_eq!(b.host(web.id).unwrap().port, 2200);
    assert_eq!(key_of(&a.host(web.id).unwrap()), Some(key_a.id));
    assert_eq!(key_of(&b.host(web.id).unwrap()), Some(key_b.id));

    // Allowing A's key to sync shares it, and the host then names it.
    a.edit(|v| v.set_key_sync(key_a.id, true));
    a.sync(&server).await;
    b.sync(&server).await;
    assert_eq!(b.snapshot().keys.len(), 2);
    assert_eq!(key_of(&b.host(web.id).unwrap()), Some(key_a.id));

    // Withdrawing it removes it from the cloud and from B; A keeps it.
    a.edit(|v| v.set_key_sync(key_a.id, false));
    a.sync(&server).await;
    b.sync(&server).await;
    assert_eq!(
        b.snapshot().keys.iter().map(|k| k.label.as_str()).collect::<Vec<_>>(),
        vec!["B's key"]
    );
    assert_eq!(key_of(&b.host(web.id).unwrap()), None);
    assert_eq!(key_of(&a.host(web.id).unwrap()), Some(key_a.id));
    assert!(a.snapshot().keys.iter().any(|k| k.id == key_a.id && !k.sync));
}

#[tokio::test]
async fn offline_changes_wait_and_then_merge() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let web = a.edit(|v| v.save_host(host("web")));
    a.sync(&server).await;
    b.sync(&server).await;

    *server.offline.lock().unwrap() = true;
    a.edit(|v| v.save_host(host("made offline")));
    a.change(web.id, |h| h.port = Some(2200));
    let failed = cloud::sync_with(&a.vault, &server, SUFFIX).await;
    assert!(matches!(failed, Err(Error::Offline(_))));
    // Local work is unaffected and remembered as pending.
    assert_eq!(a.labels(), vec!["made offline", "web"]);
    assert_eq!(a.snapshot().cloud.unwrap().pending, 2);

    *server.offline.lock().unwrap() = false;
    b.edit(|v| v.save_host(host("made on b")));
    b.sync(&server).await;
    let report = a.sync(&server).await;
    assert_eq!((report.pushed, report.pulled, report.pending), (2, 1, 0));
    b.sync(&server).await;
    assert_eq!(b.labels(), vec!["made offline", "made on b", "web"]);
    assert_eq!(b.host(web.id).unwrap().port, 2200);
}

#[tokio::test]
async fn a_new_device_merges_what_it_already_has() {
    let server = FakeServer::default();
    let key = shared_key();
    let a = Device::new(&key);
    a.edit(|v| v.save_host(host("from cloud")));
    a.sync(&server).await;

    // A device that was used before signing in keeps its own hosts.
    let c = Device::signed_out();
    c.edit(|v| v.save_host(host("local before sign-in")));
    assert!(c.snapshot().cloud.is_none());
    assert!(matches!(
        cloud::sync_with(&c.vault, &server, SUFFIX).await,
        Err(Error::NotSignedIn)
    ));
    let account = a.edit(|v| Ok(v.cloud_account().unwrap()));
    // A fresh sign-in starts from the beginning of the account's history.
    c.edit(|v| v.set_cloud_account(Some(CloudAccount { cursor: 0, ..account })));
    let report = c.sync(&server).await;
    assert_eq!((report.pulled, report.pushed), (1, 1));
    assert_eq!(c.labels(), vec!["from cloud", "local before sign-in"]);
    a.sync(&server).await;
    assert_eq!(a.labels(), vec!["from cloud", "local before sign-in"]);

    // Signing out keeps the data and stops counting changes.
    c.edit(|v| v.set_cloud_account(None));
    c.edit(|v| v.save_host(host("after sign-out")));
    assert_eq!(c.labels().len(), 3);
    assert!(c.snapshot().cloud.is_none());
}

#[tokio::test]
async fn what_cannot_be_read_is_left_alone() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let web = a.edit(|v| v.save_host(host("web")));
    a.sync(&server).await;

    // Garbage, and an item of a kind this version does not know.
    let garbage = Uuid::new_v4();
    server.plant(garbage, b"not a valid ciphertext at all, just bytes........");
    let future = Uuid::new_v4();
    let vault_key = {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&key).unwrap();
        zeroize::Zeroizing::new(<[u8; 32]>::try_from(&bytes[..]).unwrap())
    };
    let blob = cloud::seal_item(&vault_key, future, br#"{"kind":"tunnel","data":{"port":8080}}"#).unwrap();
    server.plant(future, &blob);

    for device in [&a, &b] {
        let report = device.sync(&server).await;
        assert!(report.conflicts.is_empty());
        assert_eq!(report.pushed, 0);
    }
    assert_eq!(b.labels(), vec!["web"]);
    // Neither device deleted or rewrote what it could not read.
    let stored = server.items();
    assert_eq!(stored.len(), 3);
    assert!(stored.iter().all(|item| !item.deleted));
    assert_eq!(stored.iter().find(|i| i.id == future).unwrap().blob, blob);

    // The server lost an item the device still has: it is offered again.
    server.lose(web.id);
    a.change(web.id, |h| h.port = Some(2200));
    let report = a.sync(&server).await;
    assert_eq!(report.pending, 0);
    assert!(server.items().iter().any(|item| item.id == web.id));
    b.sync(&server).await;
    assert_eq!(b.host(web.id).unwrap().port, 2200);
}

#[tokio::test]
async fn references_to_things_deleted_elsewhere_are_released() {
    let server = FakeServer::default();
    let key = shared_key();
    let (a, b) = (Device::new(&key), Device::new(&key));
    let group = a.edit(|v| {
        v.save_group(GroupInput {
            id: None,
            name: "g".into(),
            parent_id: None,
        })
    });
    let identity = a.edit(|v| {
        v.save_identity(IdentityInput {
            id: None,
            label: String::new(),
            username: "deploy".into(),
            password: SecretInput::Keep,
            key_id: None,
        })
    });
    a.sync(&server).await;
    b.sync(&server).await;

    // B starts using the group and the identity; A deletes both meanwhile.
    let web = b.edit(|v| {
        v.save_host(HostInput {
            group_id: Some(group.id),
            auth: HostAuthInput::Identity {
                identity_id: identity.id,
            },
            ..host("web")
        })
    });
    a.edit(|v| v.delete_group(group.id));
    a.edit(|v| v.delete_identity(identity.id));
    a.sync(&server).await;
    b.sync(&server).await;

    // The host survives, now ungrouped and asking for credentials.
    let host = b.host(web.id).unwrap();
    assert_eq!(host.group_id, None);
    assert!(matches!(
        host.auth,
        HostAuthView::Inline {
            ref username,
            has_password: false,
            key_id: None
        } if username.is_empty()
    ));
    assert!(b.snapshot().groups.is_empty() && b.snapshot().identities.is_empty());
    a.sync(&server).await;
    assert!(a.host(web.id).is_some());
    assert_eq!(SETTINGS_ID, Uuid::from_u128(1));
}

/// The same flow through a real server, when one is running
/// (`cd myssh-cloud && docker compose up -d`). Skipped otherwise.
#[tokio::test(flavor = "multi_thread")]
async fn real_server_accounts_devices_and_sync() {
    let server = std::env::var("MYSSH_TEST_SERVER").unwrap_or("http://127.0.0.1:8787".into());
    let reachable = tokio::net::TcpStream::connect(
        server.trim_start_matches("http://").trim_start_matches("https://"),
    )
    .await
    .is_ok();
    if !reachable {
        eprintln!("skipping: no cloud server at {server}");
        return;
    }
    // The availability check: a real server answers, a dead port is offline.
    let info = cloud::server_info(&server).await.unwrap();
    assert_eq!((info.name.as_str(), info.api), ("myssh-cloud", 1));
    assert!(matches!(
        cloud::server_info("http://127.0.0.1:1").await,
        Err(Error::Offline(_))
    ));
    let email = format!("test-{}@example.com", Uuid::new_v4().simple());
    let password = "correct horse battery staple";
    let device = |name: &str| DeviceInfo {
        name: name.into(),
        platform: "macos".into(),
    };
    let (a, b) = (Device::signed_out(), Device::signed_out());

    // Plain HTTP to another machine is refused before anything is sent.
    assert!(matches!(
        cloud::sign_in(&a.vault, "http://example.com", &email, password, device("x")).await,
        Err(Error::InsecureServer)
    ));
    assert!(matches!(
        cloud::sign_up(&a.vault, &server, &email, "short", device("x")).await,
        Err(Error::Invalid(_))
    ));
    // Unknown account: the server says so. Then the real thing.
    assert!(matches!(
        cloud::sign_in(&a.vault, &server, &email, password, device("MacBook")).await,
        Err(Error::NoAccount)
    ));
    a.edit(|v| v.save_host(host("web")));
    cloud::sign_up(&a.vault, &server, &email, password, device("MacBook")).await.unwrap();
    assert!(matches!(
        cloud::sign_up(&b.vault, &server, &email, password, device("Other")).await,
        Err(Error::AccountExists)
    ));
    let report = cloud::sync(&a.vault, SUFFIX).await.unwrap();
    assert_eq!((report.pushed, report.pending), (1, 0));

    // A second device: wrong password is refused, the right one restores.
    assert!(matches!(
        cloud::sign_in(&b.vault, &server, &email, "not the password!", device("Work Mac")).await,
        Err(Error::BadCredentials)
    ));
    assert!(b.snapshot().cloud.is_none());
    cloud::sign_in(&b.vault, &server, &email.to_uppercase(), password, device("Work Mac")).await.unwrap();
    let report = cloud::sync(&b.vault, SUFFIX).await.unwrap();
    assert_eq!(report.pulled, 1);
    assert_eq!(b.labels(), vec!["web"]);
    let web = b.snapshot().hosts[0].clone();
    let (_, credentials) = b.edit(|v| v.resolve_credentials(web.id));
    assert_eq!(credentials.password.as_deref(), Some("web-password"));

    // A conflict through the real server resolves the same way.
    a.change(web.id, |h| h.address = "a.example.com".into());
    b.change(web.id, |h| h.address = "b.example.com".into());
    cloud::sync(&a.vault, SUFFIX).await.unwrap();
    let report = cloud::sync(&b.vault, SUFFIX).await.unwrap();
    assert_eq!(report.conflicts[0].resolution, Resolution::KeptBoth);
    cloud::sync(&a.vault, SUFFIX).await.unwrap();
    assert_eq!(a.labels(), vec!["web", "web (conflict)"]);
    assert_eq!(b.labels(), vec!["web", "web (conflict)"]);

    // Devices: both listed; revoking B cuts B off and leaves its data.
    let devices = cloud::devices(&a.vault).await.unwrap();
    let names: Vec<_> = devices.iter().map(|d| (d.name.as_str(), d.current)).collect();
    assert_eq!(names, vec![("MacBook", true), ("Work Mac", false)]);
    let other = devices.iter().find(|d| !d.current).unwrap();
    cloud::revoke_device(&a.vault, &other.id).await.unwrap();
    b.edit(|v| v.save_host(host("made after revocation")));
    assert!(matches!(
        cloud::sync(&b.vault, SUFFIX).await,
        Err(Error::DeviceRevoked)
    ));
    let state = b.snapshot().cloud.unwrap();
    assert!(state.revoked);
    assert_eq!(b.labels().len(), 3);
    assert!(matches!(cloud::devices(&b.vault).await, Err(Error::DeviceRevoked)));
    // A is unaffected and never receives what B made after being cut off.
    cloud::sync(&a.vault, SUFFIX).await.unwrap();
    assert_eq!(a.labels(), vec!["web", "web (conflict)"]);
    assert_eq!(cloud::devices(&a.vault).await.unwrap().len(), 1);

    // B signs out (allowed while revoked) and can sign in again.
    cloud::sign_out(&b.vault).await.unwrap();
    assert!(b.snapshot().cloud.is_none());
    cloud::sign_in(&b.vault, &server, &email, password, device("Work Mac")).await.unwrap();
    cloud::sync(&b.vault, SUFFIX).await.unwrap();
    cloud::sync(&a.vault, SUFFIX).await.unwrap();
    assert_eq!(a.labels(), vec!["made after revocation", "web", "web (conflict)"]);

    // The plan, and the account's pages: a one-time link that signs a browser in.
    let plan = cloud::plan(&a.vault).await.unwrap().unwrap();
    assert_eq!((plan.plan.as_str(), plan.state.as_str()), ("free", "free"));
    let page = cloud::account_page(&a.vault, "ru").await.unwrap();
    assert!(page.starts_with(&format!("{server}/account/enter?t=")), "{page}");
    assert!(page.ends_with("&lang=ru"));
    let browser = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let entered = browser.get(&page).send().await.unwrap();
    assert_eq!(entered.status(), 303);
    assert!(entered
        .headers()
        .get_all("set-cookie")
        .iter()
        .any(|cookie| cookie.to_str().unwrap().starts_with("myssh_account=")));
    assert_eq!(browser.get(&page).send().await.unwrap().status(), 410);

    // A new e-mail, behind the master password; the keys stay what they were.
    let renamed = format!("renamed-{}@example.com", Uuid::new_v4().simple());
    assert!(matches!(
        cloud::change_email(&a.vault, "not the password!", &renamed).await,
        Err(Error::BadCredentials)
    ));
    assert_eq!(cloud::change_email(&a.vault, password, &renamed.to_uppercase()).await.unwrap(), renamed);
    assert_eq!(a.snapshot().cloud.unwrap().email, renamed);
    cloud::sync(&a.vault, SUFFIX).await.unwrap();
    let c = Device::signed_out();
    assert!(matches!(
        cloud::sign_in(&c.vault, &server, &email, password, device("Third")).await,
        Err(Error::NoAccount)
    ));
    cloud::sign_in(&c.vault, &server, &renamed, password, device("Third")).await.unwrap();
    cloud::sync(&c.vault, SUFFIX).await.unwrap();
    assert_eq!(c.labels(), a.labels());
    cloud::sign_out(&c.vault).await.unwrap();
    // The other device learns the new address when it next asks.
    assert_ne!(b.snapshot().cloud.unwrap().email, renamed);
    cloud::plan(&b.vault).await.unwrap();
    assert_eq!(b.snapshot().cloud.unwrap().email, renamed);
    let email = renamed;

    cloud::sign_out(&a.vault).await.unwrap();
    assert!(matches!(cloud::sync(&a.vault, SUFFIX).await, Err(Error::NotSignedIn)));
    assert_eq!(a.labels().len(), 3);

    // Deleting the account needs the master password, removes everything
    // on the server, and leaves the device's own data alone.
    assert!(matches!(
        cloud::delete_account(&b.vault, "not the password!").await,
        Err(Error::BadCredentials)
    ));
    cloud::delete_account(&b.vault, password).await.unwrap();
    assert!(b.snapshot().cloud.is_none());
    assert_eq!(b.labels().len(), 3);
    assert!(matches!(
        cloud::sign_in(&a.vault, &server, &email, password, device("MacBook")).await,
        Err(Error::NoAccount)
    ));
}

#[tokio::test]
async fn the_saved_hosts_server_keys_follow_the_account() {
    let server = FakeServer::default();
    let vault_key = shared_key();
    let (a, b) = (Keyed::new(&vault_key), Keyed::new(&vault_key));
    let (first, second, elsewhere) = (server_key(), server_key(), server_key());

    // Trusted on one device: for a saved host it travels, for any other it does not.
    a.device.edit(|v| v.save_host(host("web")));
    a.known.lock().unwrap().trust("web.example.com", 22, &first).unwrap();
    a.known.lock().unwrap().trust("10.0.0.5", 22, &elsewhere).unwrap();
    assert!(a.sync(&server).await.conflicts.is_empty());
    assert!(b.sync(&server).await.conflicts.is_empty());
    assert_eq!(b.status("web.example.com", &first), HostKeyStatus::Trusted);
    assert_eq!(b.status("10.0.0.5", &elsewhere), HostKeyStatus::Unknown);
    // On the other device, a different key is caught at once.
    assert!(matches!(b.status("web.example.com", &second), HostKeyStatus::Changed(_)));

    // The server's new key, accepted on the second device, is the one trusted on the first.
    b.known.lock().unwrap().trust("web.example.com", 22, &second).unwrap();
    b.sync(&server).await;
    a.sync(&server).await;
    assert_eq!(a.status("web.example.com", &second), HostKeyStatus::Trusted);
    assert!(matches!(a.status("web.example.com", &first), HostKeyStatus::Changed(_)));

    // Trusted again, alike, on a device that had not synced: no news, nothing to settle.
    let c = Keyed::new(&vault_key);
    c.known.lock().unwrap().trust("web.example.com", 22, &second).unwrap();
    assert!(c.sync(&server).await.conflicts.is_empty());
    assert_eq!(c.status("web.example.com", &second), HostKeyStatus::Trusted);

    // Forgotten on one device, forgotten on all.
    a.known.lock().unwrap().forget("web.example.com", 22).unwrap();
    a.sync(&server).await;
    b.sync(&server).await;
    c.sync(&server).await;
    assert_eq!(b.status("web.example.com", &second), HostKeyStatus::Unknown);
    assert_eq!(c.status("web.example.com", &second), HostKeyStatus::Unknown);
    // The key of the host that was never saved stays where it was trusted.
    assert_eq!(a.status("10.0.0.5", &elsewhere), HostKeyStatus::Trusted);
}
