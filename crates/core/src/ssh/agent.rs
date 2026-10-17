//! SSH agent forwarding, as `ssh -A` does it: the server may ask this
//! computer to sign with the user's keys, to go on from there (a `git pull`
//! from a private repository, an `ssh` to the next server). The keys never
//! leave this computer; each signature is made here, and the UI is told of
//! it.
//!
//! The agent answers only what forwarding needs: the list of keys and
//! signing with one of them. Adding, removing and locking keys, which a
//! local agent allows, are refused: the keys are the keychain's.

use std::sync::Arc;

use russh::keys::ssh_key::{self, private::KeypairData, HashAlg, PrivateKey};
use signature::Signer;
use ssh_key::encoding::Encode;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::{Io, SessionEvent};

/// The longest message an agent takes; real ones are far shorter.
const MAX_FRAME: usize = 256 * 1024;

const FAILURE: u8 = 5;
const REQUEST_IDENTITIES: u8 = 11;
const IDENTITIES_ANSWER: u8 = 12;
const SIGN_REQUEST: u8 = 13;
const SIGN_RESPONSE: u8 = 14;
/// Sign-request flags: an RSA key signs with SHA-256 or SHA-512.
const RSA_SHA2_256: u32 = 2;
const RSA_SHA2_512: u32 = 4;

/// A key the server may ask to sign with, ready to use.
pub(super) struct AgentKey {
    pub label: String,
    pub key: PrivateKey,
    /// The public key as the agent protocol names it.
    pub blob: Vec<u8>,
}

impl AgentKey {
    pub fn new(label: String, key: PrivateKey) -> Option<AgentKey> {
        let blob = key.public_key().to_bytes().ok()?;
        Some(AgentKey { label, key, blob })
    }
}

/// Answers the server's agent requests on one forwarded channel until it
/// closes.
pub(super) async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, keys: Arc<Vec<AgentKey>>, io: Io) {
    loop {
        let mut len = [0u8; 4];
        if stream.read_exact(&mut len).await.is_err() {
            return;
        }
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > MAX_FRAME {
            return;
        }
        let mut frame = vec![0u8; len];
        if stream.read_exact(&mut frame).await.is_err() {
            return;
        }
        let reply = answer(&frame, &keys, &io).unwrap_or_else(|| vec![FAILURE]);
        let mut out = (reply.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&reply);
        if stream.write_all(&out).await.is_err() || stream.flush().await.is_err() {
            return;
        }
    }
}

/// The reply to one request, without its length; `None` is a failure.
fn answer(frame: &[u8], keys: &[AgentKey], io: &Io) -> Option<Vec<u8>> {
    let (&kind, mut rest) = frame.split_first()?;
    match kind {
        REQUEST_IDENTITIES => {
            let mut out = vec![IDENTITIES_ANSWER];
            out.extend_from_slice(&(keys.len() as u32).to_be_bytes());
            for key in keys {
                put_string(&mut out, &key.blob);
                put_string(&mut out, key.label.as_bytes());
            }
            Some(out)
        }
        SIGN_REQUEST => {
            let blob = take_string(&mut rest)?;
            let data = take_string(&mut rest)?;
            let flags = take_u32(&mut rest).unwrap_or(0);
            let key = keys.iter().find(|k| k.blob == blob)?;
            let signature = sign(&key.key, data, flags)?;
            io.event(SessionEvent::AgentUsed {
                key: key.label.clone(),
            });
            let mut out = vec![SIGN_RESPONSE];
            put_string(&mut out, &signature);
            Some(out)
        }
        _ => None,
    }
}

/// A signature in the SSH wire form: the algorithm's name and the blob.
fn sign(key: &PrivateKey, data: &[u8], flags: u32) -> Option<Vec<u8>> {
    let signature = match key.key_data() {
        KeypairData::Rsa(rsa) => {
            // Without a flag it is SHA-1, which servers no longer accept;
            // SHA-512 is what OpenSSH's own agent picks then.
            let hash = if flags & RSA_SHA2_256 != 0 && flags & RSA_SHA2_512 == 0 {
                HashAlg::Sha256
            } else {
                HashAlg::Sha512
            };
            Signer::<ssh_key::Signature>::try_sign(&(rsa, Some(hash)), data).ok()?
        }
        other => Signer::<ssh_key::Signature>::try_sign(other, data).ok()?,
    };
    signature.encode_vec().ok()
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn take_u32(rest: &mut &[u8]) -> Option<u32> {
    let (head, tail) = rest.split_at_checked(4)?;
    *rest = tail;
    Some(u32::from_be_bytes(head.try_into().ok()?))
}

fn take_string<'a>(rest: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = take_u32(rest)? as usize;
    let (head, tail) = rest.split_at_checked(len)?;
    *rest = tail;
    Some(head)
}
