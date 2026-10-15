//! Trusted server host keys (trust on first use, warn on change).
//!
//! Kept separately from the vault: which keys a device has seen is local
//! knowledge and is not secret.

use std::path::PathBuf;

use russh::keys::PublicKey;
use serde::{Deserialize, Serialize};

use crate::keys::{fingerprint, public_line};
use crate::{now_ms, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// The presented key is already trusted for this host.
    Trusted,
    /// Nothing is known about this host yet.
    Unknown,
    /// The host is known, but under different keys.
    Changed(Vec<KnownHost>),
}

pub struct KnownHosts {
    path: PathBuf,
    entries: Vec<KnownHost>,
}

fn same_host(entry: &KnownHost, host: &str, port: u16) -> bool {
    entry.port == port && entry.host.eq_ignore_ascii_case(host)
}

impl KnownHosts {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let entries = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(KnownHosts { path, entries })
    }

    pub fn entries(&self) -> &[KnownHost] {
        &self.entries
    }

    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> Result<HostKeyStatus> {
        let line = public_line(key)?;
        let known: Vec<KnownHost> = self
            .entries
            .iter()
            .filter(|e| same_host(e, host, port))
            .cloned()
            .collect();
        Ok(if known.is_empty() {
            HostKeyStatus::Unknown
        } else if known.iter().any(|e| e.public_key == line) {
            HostKeyStatus::Trusted
        } else {
            HostKeyStatus::Changed(known)
        })
    }

    /// Trusts `key` for the host, replacing whatever was trusted before.
    pub fn trust(&mut self, host: &str, port: u16, key: &PublicKey) -> Result<()> {
        let entry = KnownHost {
            host: host.to_string(),
            port,
            algorithm: key.algorithm().as_str().to_string(),
            public_key: public_line(key)?,
            fingerprint: fingerprint(key),
            added_at: now_ms(),
        };
        self.entries.retain(|e| !same_host(e, host, port));
        self.entries.push(entry);
        self.save()
    }

    /// Forgets the host. Returns whether anything was removed.
    pub fn forget(&mut self, host: &str, port: u16) -> Result<bool> {
        let before = self.entries.len();
        self.entries.retain(|e| !same_host(e, host, port));
        let removed = self.entries.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    fn save(&self) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&self.entries)?;
        crate::vault::write_atomic(&self.path, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{generate, KeyKind};

    fn public(kind: KeyKind) -> PublicKey {
        let key = generate(kind, "t").unwrap();
        PublicKey::from_openssh(&key.public_key).unwrap()
    }

    #[test]
    fn trust_on_first_use_then_detect_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let (first, second) = (public(KeyKind::Ed25519), public(KeyKind::Ed25519));

        let mut kh = KnownHosts::open(&path).unwrap();
        assert_eq!(
            kh.check("example.com", 22, &first).unwrap(),
            HostKeyStatus::Unknown
        );
        kh.trust("example.com", 22, &first).unwrap();

        // Survives a reload, and the host name is case-insensitive.
        let mut kh = KnownHosts::open(&path).unwrap();
        assert_eq!(
            kh.check("Example.COM", 22, &first).unwrap(),
            HostKeyStatus::Trusted
        );
        // Another port is another host.
        assert_eq!(
            kh.check("example.com", 2222, &first).unwrap(),
            HostKeyStatus::Unknown
        );

        match kh.check("example.com", 22, &second).unwrap() {
            HostKeyStatus::Changed(known) => {
                assert_eq!(known.len(), 1);
                assert_eq!(known[0].fingerprint, fingerprint(&first));
            }
            other => panic!("expected Changed, got {other:?}"),
        }

        // Accepting the new key replaces the old one.
        kh.trust("example.com", 22, &second).unwrap();
        assert_eq!(
            kh.check("example.com", 22, &second).unwrap(),
            HostKeyStatus::Trusted
        );
        assert!(matches!(
            kh.check("example.com", 22, &first).unwrap(),
            HostKeyStatus::Changed(_)
        ));

        assert!(kh.forget("example.com", 22).unwrap());
        assert!(!kh.forget("example.com", 22).unwrap());
        assert_eq!(
            kh.check("example.com", 22, &second).unwrap(),
            HostKeyStatus::Unknown
        );
    }
}
