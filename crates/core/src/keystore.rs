//! Storage for the vault master key.
//!
//! The vault file is encrypted with a random 256-bit key. The app keeps that
//! key in a file beside the vault, readable only by the owner. What protects
//! the pair at rest is therefore the user account and disk encryption; the
//! encryption of the vault itself guards against casual reading and against
//! a vault file that travels without its key.

use std::path::PathBuf;

use zeroize::Zeroizing;

use crate::{Error, Result};

pub const KEY_LEN: usize = 32;
pub type MasterKey = Zeroizing<[u8; KEY_LEN]>;

pub trait KeyStore: Send + Sync {
    /// Returns the stored key, or `None` if there is none yet.
    fn load(&self) -> Result<Option<MasterKey>>;
    fn store(&self, key: &MasterKey) -> Result<()>;
}

fn key_from_slice(bytes: &[u8]) -> Result<MasterKey> {
    let arr: [u8; KEY_LEN] = bytes
        .try_into()
        .map_err(|_| Error::KeyStore("stored key has an unexpected length".into()))?;
    Ok(Zeroizing::new(arr))
}

/// Keeps the key in a file readable only by the owner.
pub struct FileKeyStore {
    path: PathBuf,
}

impl FileKeyStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        FileKeyStore { path: path.into() }
    }
}

impl KeyStore for FileKeyStore {
    fn load(&self) -> Result<Option<MasterKey>> {
        match std::fs::read(&self.path) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                key_from_slice(&bytes).map(Some)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn store(&self, key: &MasterKey) -> Result<()> {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&self.path)?;
        f.write_all(&key[..])?;
        f.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_keeps_the_key_private() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileKeyStore::new(dir.path().join("master.key"));
        assert!(store.load().unwrap().is_none());

        store.store(&Zeroizing::new([7u8; KEY_LEN])).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("master.key")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(store.load().unwrap().unwrap()[..], [7u8; KEY_LEN]);

        // A file of the wrong size is an error, not a key.
        std::fs::write(dir.path().join("bad.key"), b"short").unwrap();
        assert!(FileKeyStore::new(dir.path().join("bad.key")).load().is_err());
    }
}
