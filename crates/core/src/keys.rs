//! SSH key generation, import and inspection.

use russh::keys::ssh_key::{self, EcdsaCurve, HashAlg, LineEnding};
use russh::keys::{decode_secret_key, Algorithm, PrivateKey, PublicKey};
use serde::Deserialize;
use uuid::Uuid;

use crate::model::{KeyOrigin, SshKey};
use crate::{now_ms, Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    Ed25519,
    EcdsaP256,
    EcdsaP384,
    Rsa4096,
}

/// `SHA256:…` fingerprint, the form OpenSSH prints.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// `authorized_keys` line without a comment.
pub fn public_line(key: &PublicKey) -> Result<String> {
    let mut key = key.clone();
    key.set_comment("");
    Ok(key.to_openssh()?.trim().to_string())
}

fn describe(private: &PrivateKey) -> Result<(String, String, String)> {
    let public = private.public_key();
    Ok((
        private.algorithm().as_str().to_string(),
        public_line(public)?,
        fingerprint(public),
    ))
}

/// Generates a new unencrypted key. Protection at rest comes from the vault.
pub fn generate(kind: KeyKind, label: &str) -> Result<SshKey> {
    let mut rng = russh::keys::key::safe_rng();
    let private = match kind {
        KeyKind::Ed25519 => PrivateKey::random(&mut rng, Algorithm::Ed25519)?,
        KeyKind::EcdsaP256 => PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )?,
        KeyKind::EcdsaP384 => PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP384,
            },
        )?,
        KeyKind::Rsa4096 => {
            let pair = ssh_key::private::RsaKeypair::random(&mut rng, 4096)?;
            PrivateKey::new(ssh_key::private::KeypairData::Rsa(pair), "")?
        }
    };
    let (algorithm, public_key, fingerprint) = describe(&private)?;
    let now = now_ms();
    Ok(SshKey {
        id: Uuid::new_v4(),
        label: label.trim().to_string(),
        algorithm,
        private_key: private.to_openssh(LineEnding::LF)?.to_string(),
        public_key,
        fingerprint,
        encrypted: false,
        passphrase: None,
        origin: KeyOrigin::Generated,
        sync: false,
        created_at: now,
        updated_at: now,
    })
}

/// Whether private key text is passphrase-protected, judged without a
/// passphrase.
fn is_encrypted(text: &str) -> Result<bool> {
    match decode_secret_key(text, None) {
        Ok(_) => Ok(false),
        Err(russh::keys::Error::KeyIsEncrypted) => Ok(true),
        Err(e) => {
            // Encrypted OpenSSH-format keys are reported by the parser itself.
            if let Ok(k) = PrivateKey::from_openssh(text) {
                return Ok(k.is_encrypted());
            }
            Err(e.into())
        }
    }
}

/// Imports private key text (OpenSSH, PKCS#8, PKCS#1 or PuTTY).
///
/// An encrypted key needs its passphrase to be read at all; without one the
/// result is [`Error::KeyEncrypted`]. `save_passphrase` controls whether the
/// passphrase is kept in the vault or asked for on each connection.
pub fn import(
    text: &str,
    passphrase: Option<&str>,
    save_passphrase: bool,
    label: &str,
) -> Result<SshKey> {
    let text = text.trim();
    if text.is_empty() {
        return Err(Error::Invalid("the private key is empty".into()));
    }
    let encrypted = is_encrypted(text)?;
    let passphrase = passphrase.filter(|p| !p.is_empty());
    if encrypted && passphrase.is_none() {
        return Err(Error::KeyEncrypted);
    }
    let private = decrypt(text, if encrypted { passphrase } else { None })?;
    let (algorithm, public_key, fingerprint) = describe(&private)?;
    let now = now_ms();
    Ok(SshKey {
        id: Uuid::new_v4(),
        label: label.trim().to_string(),
        algorithm,
        private_key: format!("{text}\n"),
        public_key,
        fingerprint,
        encrypted,
        passphrase: if encrypted && save_passphrase {
            passphrase.map(str::to_string)
        } else {
            None
        },
        origin: KeyOrigin::Imported,
        sync: false,
        created_at: now,
        updated_at: now,
    })
}

/// Decodes private key text into a usable key.
///
/// Returns [`Error::KeyEncrypted`] when a passphrase is required but missing,
/// and [`Error::Key`] when the passphrase is wrong or the text is damaged.
pub fn decrypt(text: &str, passphrase: Option<&str>) -> Result<PrivateKey> {
    let key = decode_secret_key(text, passphrase)?;
    if key.is_encrypted() {
        return Err(Error::KeyEncrypted);
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_usable_keys() {
        for kind in [KeyKind::Ed25519, KeyKind::EcdsaP256, KeyKind::EcdsaP384] {
            let key = generate(kind, " test ").unwrap();
            assert_eq!(key.label, "test");
            assert!(key.fingerprint.starts_with("SHA256:"));
            assert!(!key.encrypted);
            assert_eq!(key.public_key.split_whitespace().count(), 2);
            let private = decrypt(&key.private_key, None).unwrap();
            assert_eq!(fingerprint(private.public_key()), key.fingerprint);
        }
    }

    #[test]
    fn import_round_trips_generated_key() {
        let generated = generate(KeyKind::Ed25519, "a").unwrap();
        let imported = import(&generated.private_key, None, false, "b").unwrap();
        assert_eq!(imported.fingerprint, generated.fingerprint);
        assert_eq!(imported.public_key, generated.public_key);
        assert_eq!(imported.origin, KeyOrigin::Imported);
        assert!(!imported.encrypted);
    }

    #[test]
    fn import_handles_passphrase_protected_keys() {
        let mut rng = russh::keys::key::safe_rng();
        let plain = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let locked = plain.encrypt(&mut rng, "hunter2").unwrap();
        let text = locked.to_openssh(LineEnding::LF).unwrap().to_string();

        assert!(matches!(
            import(&text, None, false, "k"),
            Err(Error::KeyEncrypted)
        ));
        assert!(matches!(
            import(&text, Some("wrong"), false, "k"),
            Err(Error::Key(_))
        ));

        let kept = import(&text, Some("hunter2"), true, "k").unwrap();
        assert!(kept.encrypted);
        assert_eq!(kept.passphrase.as_deref(), Some("hunter2"));
        assert_eq!(kept.fingerprint, fingerprint(plain.public_key()));

        let asked = import(&text, Some("hunter2"), false, "k").unwrap();
        assert!(asked.encrypted);
        assert!(asked.passphrase.is_none());
        assert!(matches!(
            decrypt(&asked.private_key, None),
            Err(Error::KeyEncrypted)
        ));
        assert!(decrypt(&asked.private_key, Some("hunter2")).is_ok());
    }

    #[test]
    fn import_rejects_garbage() {
        assert!(import("not a key", None, false, "k").is_err());
        assert!(import("   ", None, false, "k").is_err());
    }
}
