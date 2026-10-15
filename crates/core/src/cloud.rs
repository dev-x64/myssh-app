//! The cloud account: keys derived from the master password, the server
//! API, and the sync loop.
//!
//! Nothing readable leaves the device. From the master password two keys
//! are derived with Argon2id: an *auth key*, sent to the server as proof of
//! identity, and a *wrapping key*, which never leaves and unlocks the vault
//! key. The vault key encrypts every synced item; the server stores it only
//! wrapped. Knowing the auth key does not help to find the wrapping key.

use std::sync::OnceLock;
use std::time::Duration;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::known_hosts::KnownHosts;
use crate::model::{CloudAccount, Id};
use crate::sync::{ConflictNote, Outgoing, PushResult, RemoteItem};
use crate::vault::Vault;
use crate::{Error, Result};

const NONCE_LEN: usize = 24;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Changes sent per request; the server accepts up to 500.
const PUSH_BATCH: usize = 200;
/// Pull/push rounds per sync before giving up until next time.
const MAX_ROUNDS: usize = 5;

pub type VaultKey = Zeroizing<[u8; 32]>;

// ------------------------------------------------------------------ keys ---

/// Parameters of the password KDF. Stored with the account so that every
/// device derives the same keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub alg: String,
    /// Memory in KiB.
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        KdfParams {
            alg: "argon2id".into(),
            m: 64 * 1024,
            t: 3,
            p: 1,
        }
    }
}

pub struct DerivedKeys {
    /// Proves the password to the server.
    pub auth_key: Zeroizing<[u8; 32]>,
    /// Unlocks the vault key. Never sent anywhere.
    pub wrapping_key: Zeroizing<[u8; 32]>,
}

/// Derives the account keys from the master password.
///
/// Parameters come from the server at sign-in, so they are bounded here: a
/// server must not be able to talk a client into a weak derivation, nor
/// into exhausting the device.
pub fn derive_keys(password: &str, salt: &[u8], kdf: &KdfParams) -> Result<DerivedKeys> {
    let acceptable = kdf.alg == "argon2id"
        && (19 * 1024..=1024 * 1024).contains(&kdf.m)
        && (2..=20).contains(&kdf.t)
        && (1..=8).contains(&kdf.p)
        && salt.len() >= 16;
    if !acceptable {
        return Err(Error::Cloud(
            "the server asked for unacceptable key derivation settings".into(),
        ));
    }
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32))
        .map_err(|e| Error::Cloud(format!("key derivation: {e}")))?;
    let mut stretched = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut stretched[..])
        .map_err(|e| Error::Cloud(format!("key derivation: {e}")))?;

    let expand = |info: &[u8]| -> Result<Zeroizing<[u8; 32]>> {
        let mut out = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(salt), &stretched[..])
            .expand(info, &mut out[..])
            .map_err(|_| Error::Cloud("key derivation failed".into()))?;
        Ok(out)
    };
    Ok(DerivedKeys {
        auth_key: expand(b"myssh/auth/v1")?,
        wrapping_key: expand(b"myssh/wrap/v1")?,
    })
}

fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Cloud("encryption failed".into()))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn open(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if sealed.len() < NONCE_LEN {
        return Err(Error::Cloud("the encrypted data is damaged".into()));
    }
    let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
    XChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| Error::Cloud("the encrypted data cannot be read with this key".into()))
}

pub fn new_vault_key() -> VaultKey {
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&XChaCha20Poly1305::generate_key(&mut OsRng));
    key
}

/// Encrypts the vault key for storage on the server.
pub fn wrap_vault_key(wrapping_key: &[u8; 32], vault_key: &VaultKey) -> Result<Vec<u8>> {
    seal(wrapping_key, b"myssh/vault-key/v1", &vault_key[..])
}

/// Recovers the vault key. Failing here means the password is not the one
/// the vault key was wrapped with.
pub fn unwrap_vault_key(wrapping_key: &[u8; 32], wrapped: &[u8]) -> Result<VaultKey> {
    let plain = open(wrapping_key, b"myssh/vault-key/v1", wrapped).map_err(|_| Error::BadCredentials)?;
    let bytes: [u8; 32] = plain[..].try_into().map_err(|_| Error::BadCredentials)?;
    Ok(Zeroizing::new(bytes))
}

fn item_aad(id: Id) -> Vec<u8> {
    [b"myssh/item/v1/".as_slice(), id.as_bytes()].concat()
}

/// Encrypts one item. The item's id is bound in, so a ciphertext cannot be
/// served back under another item's id.
pub fn seal_item(key: &VaultKey, id: Id, plaintext: &[u8]) -> Result<Vec<u8>> {
    seal(key, &item_aad(id), plaintext)
}

pub fn open_item(key: &VaultKey, id: Id, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    open(key, &item_aad(id), sealed)
}

fn vault_key_of(account: &CloudAccount) -> Result<VaultKey> {
    let bytes = Zeroizing::new(
        BASE64
            .decode(&account.vault_key)
            .map_err(|_| Error::Cloud("the stored vault key is damaged".into()))?,
    );
    let key: [u8; 32] = bytes[..]
        .try_into()
        .map_err(|_| Error::Cloud("the stored vault key is damaged".into()))?;
    Ok(Zeroizing::new(key))
}

// ------------------------------------------------------------------- api ---

/// A host plain HTTP may reach besides this machine; see [`allow_plain_http`].
static PLAIN_HTTP_HOST: OnceLock<String> = OnceLock::new();

/// Lets plain HTTP reach one more host: for test builds only, which talk to
/// a development server on another machine of the local network (a Mac
/// serving a Windows copy in a virtual machine). Release builds never call
/// it. Only the first call counts.
pub fn allow_plain_http(host: &str) {
    let _ = PLAIN_HTTP_HOST.set(host.to_string());
}

/// Normalizes a server address and refuses plain HTTP, except to this very
/// machine: a token or auth key must not cross a network unencrypted.
pub fn normalize_server(input: &str) -> Result<String> {
    let input = input.trim();
    let (scheme, rest) = input.split_once("://").unwrap_or(("https", input));
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return Err(Error::Invalid("the server address is not valid".into()));
    }
    let with_scheme = format!("{scheme}://{rest}");
    let url = reqwest::Url::parse(&with_scheme)
        .map_err(|_| Error::Invalid("the server address is not valid".into()))?;
    let host = url.host_str().unwrap_or("");
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
        || PLAIN_HTTP_HOST.get().is_some_and(|allowed| allowed == host);
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err(Error::InsecureServer),
    }
    if host.is_empty() {
        return Err(Error::Invalid("the server address is not valid".into()));
    }
    Ok(with_scheme)
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub current: bool,
}

#[derive(Deserialize)]
struct ServerError {
    code: String,
    message: String,
}

#[derive(Deserialize)]
struct Prelogin {
    kdf: KdfParams,
    kdf_salt: String,
}

#[derive(Deserialize)]
struct Signed {
    user_id: String,
    device_id: String,
    token: String,
    #[serde(default)]
    wrapped_vault_key: Option<String>,
}

#[derive(Deserialize)]
struct WireItem {
    id: Id,
    rev: u64,
    deleted: bool,
    blob: String,
}

#[derive(Deserialize)]
struct PullResponse {
    items: Vec<WireItem>,
    cursor: u64,
    more: bool,
}

#[derive(Deserialize)]
struct WireResult {
    id: Id,
    status: String,
    #[serde(default)]
    rev: u64,
    #[serde(default)]
    item: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct PushResponse {
    results: Vec<WireResult>,
}

#[derive(Deserialize)]
struct DevicesResponse {
    devices: Vec<Device>,
}

/// What the account is on, as the server says.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    /// "free" or "pro".
    pub plan: String,
    /// free, active, ending (cancelled, runs to its end), past_due or gift.
    pub state: String,
    /// "month" or "year"; none for Free and for a gift.
    pub period: Option<String>,
    /// When the period paid for (or given) ends, Unix seconds.
    pub ends_at: Option<i64>,
    /// Whether the account may ask for AI suggestions now; the owner of the
    /// server turns them on and off, for everyone or for Free.
    #[serde(default)]
    pub ai: bool,
    /// What is left of the account's AI asks, while they are on for it.
    #[serde(default)]
    pub ai_allowance: Option<AiAllowance>,
}

/// An account's AI asks in its window of hours.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiAllowance {
    pub left: i64,
    pub limit: i64,
    pub window_hours: i64,
    /// When the next ask comes back, Unix seconds; none when none is used.
    pub back_at: Option<i64>,
}

#[derive(Deserialize)]
struct AccountResponse {
    email: String,
    /// A server from before plans says nothing of them.
    #[serde(default)]
    plan: Option<Plan>,
}

/// Asks the server for the account's details, and keeps its e-mail: it may
/// have been changed on another device.
async fn fetch_account(access: &impl VaultAccess, api: &Api) -> Result<AccountResponse> {
    let response: Result<AccountResponse> = api.send(api.http.get(api.url("/v1/account"))).await;
    let details = note_revocation(access, response)?;
    access.with_vault(|vault| match vault.cloud_account() {
        Some(mut current) if current.email != details.email => {
            current.email = details.email.clone();
            vault.update_cloud_account(current)
        }
        _ => Ok(()),
    })?;
    Ok(details)
}

#[derive(Deserialize)]
struct WebLinkResponse {
    path: String,
}

struct Api {
    base: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl Api {
    fn new(server: &str, token: Option<&str>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("MySSH/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| Error::Cloud(e.to_string()))?;
        Ok(Api {
            base: normalize_server(server)?,
            token: token.map(str::to_string),
            http,
        })
    }

    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T> {
        let text = self.send_raw(request).await?;
        serde_json::from_str(&text).map_err(|e| Error::Cloud(format!("unexpected answer: {e}")))
    }

    async fn send_raw(&self, request: reqwest::RequestBuilder) -> Result<String> {
        let request = match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        };
        let response = request.send().await.map_err(|e| {
            // Not reaching the server is the ordinary offline case.
            Error::Offline(e.without_url().to_string())
        })?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| Error::Offline(e.without_url().to_string()))?;
        if status.is_success() {
            return Ok(text);
        }
        let Ok(error) = serde_json::from_str::<ServerError>(&text) else {
            return Err(Error::Cloud(format!("the server answered {status}")));
        };
        Err(match error.code.as_str() {
            "bad_credentials" => Error::BadCredentials,
            "no_account" => Error::NoAccount,
            "account_exists" => Error::AccountExists,
            "registration_closed" => Error::RegistrationClosed,
            "too_many_attempts" => Error::TooManyAttempts,
            "device_revoked" | "unauthorized" => Error::DeviceRevoked,
            "pro_required" => Error::ProRequired,
            "invalid" => Error::Invalid(error.message),
            _ => Error::Cloud(error.message),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

}

/// One page of changes from the server.
pub struct Page {
    pub items: Vec<RemoteItem>,
    /// Everything up to this revision has now been delivered.
    pub cursor: u64,
    /// Ask again from `cursor` for the rest.
    pub more: bool,
}

/// The two calls sync needs from a server.
pub trait Transport {
    fn pull(&self, since: u64) -> impl std::future::Future<Output = Result<Page>> + Send;
    fn push(
        &self,
        changes: &[Outgoing],
    ) -> impl std::future::Future<Output = Result<Vec<PushResult>>> + Send;
}

impl Transport for Api {
    async fn pull(&self, since: u64) -> Result<Page> {
        let page: PullResponse = self
            .send(
                self.http
                    .get(self.url("/v1/sync"))
                    .query(&[("since", since)]),
            )
            .await?;
        let mut items = Vec::with_capacity(page.items.len());
        for item in page.items {
            items.push(RemoteItem {
                id: item.id,
                rev: item.rev,
                deleted: item.deleted,
                blob: decode(&item.blob, "item")?,
            });
        }
        Ok(Page {
            items,
            cursor: page.cursor,
            more: page.more,
        })
    }

    async fn push(&self, changes: &[Outgoing]) -> Result<Vec<PushResult>> {
        let body = serde_json::json!({
            "changes": changes.iter().map(|change| serde_json::json!({
                "id": change.id,
                "base_rev": change.base_rev,
                "deleted": change.deleted,
                "blob": BASE64.encode(&change.blob),
            })).collect::<Vec<_>>(),
        });
        let response: PushResponse = self
            .send(self.http.post(self.url("/v1/sync")).json(&body))
            .await?;
        Ok(response
            .results
            .into_iter()
            .map(|result| match result.status.as_str() {
                "ok" => PushResult::Accepted {
                    id: result.id,
                    rev: result.rev,
                },
                _ => PushResult::Conflict {
                    id: result.id,
                    exists: result.item.is_some_and(|item| !item.is_null()),
                },
            })
            .collect())
    }
}

/// What a cloud server says about itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub api: u32,
    /// `open` when new accounts can be created, otherwise `closed`.
    pub registration: String,
}

/// Asks the server whether it is there. Quick, and needs no account: this
/// is what "the cloud is available" on the sign-in screen is based on.
pub async fn server_info(server: &str) -> Result<ServerInfo> {
    let base = normalize_server(server)?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent(concat!("MySSH/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| Error::Cloud(e.to_string()))?;
    let response = http
        .get(format!("{base}/v1/info"))
        .send()
        .await
        .map_err(|e| Error::Offline(e.without_url().to_string()))?;
    if !response.status().is_success() {
        return Err(Error::Offline(format!(
            "the server answered {}",
            response.status()
        )));
    }
    let info: ServerInfo = response
        .json()
        .await
        .map_err(|_| Error::Offline("this is not a MySSH cloud server".into()))?;
    if info.name != "myssh-cloud" {
        return Err(Error::Offline("this is not a MySSH cloud server".into()));
    }
    Ok(info)
}

// --------------------------------------------------------------- account ---

/// How the cloud code reaches the vault. The vault is locked only for the
/// short steps that read or change it, never across a network call.
pub trait VaultAccess: Send + Sync {
    fn with_vault<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T>) -> Result<T>;

    /// The server keys this device trusts, when the saved hosts' keys are
    /// to follow the account. Without them, server keys stay out of sync.
    fn known_hosts(&self) -> Option<&std::sync::Mutex<KnownHosts>> {
        None
    }
}

impl VaultAccess for std::sync::Mutex<Vault> {
    fn with_vault<T>(&self, f: impl FnOnce(&mut Vault) -> Result<T>) -> Result<T> {
        f(&mut self.lock().unwrap())
    }
}

fn account_of(access: &impl VaultAccess) -> Result<CloudAccount> {
    access
        .with_vault(|vault| Ok(vault.cloud_account()))?
        .ok_or(Error::NotSignedIn)
}

fn decode(value: &str, what: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(value)
        .map_err(|_| Error::Cloud(format!("the server sent a damaged {what}")))
}

/// The account name is an e-mail address. Returns it trimmed and lowercased.
pub fn normalize_email(email: &str) -> Result<String> {
    let email = email.trim().to_lowercase();
    let valid = match email.split_once('@') {
        Some((name, domain)) => {
            !name.is_empty()
                && !domain.contains('@')
                && domain.split('.').count() >= 2
                && domain.split('.').all(|part| !part.is_empty())
                && !email.chars().any(char::is_whitespace)
                && email.len() <= 254
        }
        None => false,
    };
    if !valid {
        return Err(Error::Invalid("enter a valid e-mail address".into()));
    }
    Ok(email)
}

fn check_password(password: &str) -> Result<()> {
    if password.chars().count() < 10 {
        return Err(Error::Invalid(
            "the master password must be at least 10 characters long".into(),
        ));
    }
    Ok(())
}

/// Creates an account and signs this vault in to it. What is already in
/// the vault is uploaded by the next sync.
pub async fn sign_up(
    access: &impl VaultAccess,
    server: &str,
    email: &str,
    password: &str,
    device: DeviceInfo,
) -> Result<()> {
    let email = &normalize_email(email)?;
    check_password(password)?;
    let api = Api::new(server, None)?;
    let kdf = KdfParams::default();
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&XChaCha20Poly1305::generate_key(&mut OsRng)[..16]);

    let keys = derive(password, &salt, &kdf).await?;
    let vault_key = new_vault_key();
    let wrapped = wrap_vault_key(&keys.wrapping_key, &vault_key)?;
    let signed: Signed = api
        .send(api.http.post(api.url("/v1/auth/register")).json(&serde_json::json!({
            "email": email,
            "kdf": kdf,
            "kdf_salt": BASE64.encode(salt),
            "auth_key": BASE64.encode(&keys.auth_key[..]),
            "wrapped_vault_key": BASE64.encode(&wrapped),
            "device": device,
        })))
        .await?;
    store_account(access, &api.base, email, signed, &vault_key)
}

/// Signs this vault in to an existing account. Local and cloud content are
/// merged by the next sync; nothing on either side is dropped.
pub async fn sign_in(
    access: &impl VaultAccess,
    server: &str,
    email: &str,
    password: &str,
    device: DeviceInfo,
) -> Result<()> {
    let email = &normalize_email(email)?;
    let api = Api::new(server, None)?;
    let pre: Prelogin = api
        .send(
            api.http
                .post(api.url("/v1/auth/prelogin"))
                .json(&serde_json::json!({ "email": email })),
        )
        .await?;
    let salt = decode(&pre.kdf_salt, "salt")?;
    let keys = derive(password, &salt, &pre.kdf).await?;
    let signed: Signed = api
        .send(api.http.post(api.url("/v1/auth/login")).json(&serde_json::json!({
            "email": email,
            "auth_key": BASE64.encode(&keys.auth_key[..]),
            "device": device,
        })))
        .await?;
    let wrapped = decode(
        signed.wrapped_vault_key.as_deref().unwrap_or_default(),
        "vault key",
    )?;
    let vault_key = unwrap_vault_key(&keys.wrapping_key, &wrapped)?;
    store_account(access, &api.base, email, signed, &vault_key)
}

/// Argon2id is deliberately slow; keep it off the async threads.
async fn derive(password: &str, salt: &[u8], kdf: &KdfParams) -> Result<DerivedKeys> {
    let (password, salt, kdf) = (
        Zeroizing::new(password.to_string()),
        salt.to_vec(),
        kdf.clone(),
    );
    tokio::task::spawn_blocking(move || derive_keys(&password, &salt, &kdf))
        .await
        .map_err(|e| Error::Cloud(e.to_string()))?
}

fn store_account(
    access: &impl VaultAccess,
    server: &str,
    email: &str,
    signed: Signed,
    vault_key: &VaultKey,
) -> Result<()> {
    let account = CloudAccount {
        server: server.to_string(),
        email: email.to_string(),
        user_id: signed.user_id,
        device_id: signed.device_id,
        token: signed.token,
        vault_key: BASE64.encode(&vault_key[..]),
        cursor: 0,
        last_sync_at: None,
        revoked: false,
    };
    access.with_vault(|vault| vault.set_cloud_account(Some(account)))
}

/// Signs out: this device's access to the cloud ends and syncing stops.
/// Everything stays in the local vault.
pub async fn sign_out(access: &impl VaultAccess) -> Result<()> {
    let account = account_of(access)?;
    if !account.revoked {
        // Best effort: being offline must not keep the user signed in.
        if let Ok(api) = Api::new(&account.server, Some(&account.token)) {
            let _ = api
                .send_raw(api.http.post(api.url("/v1/auth/logout")))
                .await;
        }
    }
    access.with_vault(|vault| vault.set_cloud_account(None))
}

/// Changes the address the account signs in with, after checking the
/// master password. Nothing is encrypted with it, so nothing else changes;
/// other signed-in devices stay signed in. Returns the address as stored.
pub async fn change_email(access: &impl VaultAccess, password: &str, new_email: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Changed {
        email: String,
    }
    let new_email = normalize_email(new_email)?;
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    let current = fetch_account(access, &api).await?.email;
    let pre: Prelogin = api
        .send(
            api.http
                .post(api.url("/v1/auth/prelogin"))
                .json(&serde_json::json!({ "email": current })),
        )
        .await?;
    let keys = derive(password, &decode(&pre.kdf_salt, "salt")?, &pre.kdf).await?;
    let response: Result<Changed> = api
        .send(api.http.post(api.url("/v1/account/email")).json(&serde_json::json!({
            "auth_key": BASE64.encode(&keys.auth_key[..]),
            "email": new_email,
        })))
        .await;
    let changed = note_revocation(access, response)?;
    access.with_vault(|vault| match vault.cloud_account() {
        Some(mut current) => {
            current.email = changed.email.clone();
            vault.update_cloud_account(current)
        }
        None => Ok(()),
    })?;
    Ok(changed.email)
}

/// Deletes the account and everything the server stores for it, after
/// checking the master password. Local data stays in the vault.
pub async fn delete_account(access: &impl VaultAccess, password: &str) -> Result<()> {
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    // The address may have been changed on another device.
    let current = fetch_account(access, &api).await?.email;
    let pre: Prelogin = api
        .send(
            api.http
                .post(api.url("/v1/auth/prelogin"))
                .json(&serde_json::json!({ "email": current })),
        )
        .await?;
    let keys = derive(password, &decode(&pre.kdf_salt, "salt")?, &pre.kdf).await?;
    api.send_raw(
        api.http
            .post(api.url("/v1/account/delete"))
            .json(&serde_json::json!({ "auth_key": BASE64.encode(&keys.auth_key[..]) })),
    )
    .await?;
    access.with_vault(|vault| vault.set_cloud_account(None))
}

/// What the app needs to share a terminal: where to connect as the host
/// of a room just reserved on the server, and the link guests open.
#[derive(Debug, Clone, Serialize)]
pub struct ShareInvite {
    /// WebSocket address for the host, with its one-time ticket.
    pub socket: String,
    /// The page guests open. The key is added after `#` by the app and
    /// never reaches the server.
    pub link: String,
    /// How the host is named to guests: the account's name without its domain.
    pub host: String,
}

/// Reserves a room for sharing a terminal with people invited by link.
pub async fn share_open(access: &impl VaultAccess) -> Result<ShareInvite> {
    #[derive(Deserialize)]
    struct Opened {
        room: String,
        ticket: String,
    }
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    let response: Result<Opened> = api.send(api.http.post(api.url("/v1/share"))).await;
    let opened = note_revocation(access, response)?;
    let socket_base = match api.base.split_once("://") {
        Some(("https", rest)) => format!("wss://{rest}"),
        Some((_, rest)) => format!("ws://{rest}"),
        None => return Err(Error::Cloud("the server address is not valid".into())),
    };
    Ok(ShareInvite {
        socket: format!("{socket_base}/v1/share/{}/host?ticket={}", opened.room, opened.ticket),
        link: format!("{}/s/{}", api.base, opened.room),
        host: account.email.split('@').next().unwrap_or_default().to_string(),
    })
}

/// What is on a terminal's command line and around it, for AI suggestions
/// (a part of Pro). The app takes secrets out of it before it gets here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiAsk {
    pub line: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub locale: String,
}

/// A command the AI offers for the line. It is put on the line, never run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSuggestion {
    pub command: String,
    pub explanation: String,
    pub danger: bool,
}

/// The server's answer: commands, or, once the plan's allowance is used
/// up, none and when asking will work again.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiAnswer {
    pub suggestions: Vec<AiSuggestion>,
    /// Unix seconds; present when the allowance is used up.
    #[serde(default)]
    pub limited_until: Option<i64>,
    /// `free` or `pro`, as the server counted the ask.
    #[serde(default)]
    pub plan: Option<String>,
}

/// Asks the cloud server, which asks the model, for commands that do what
/// the line begins or says.
pub async fn ai_suggest(access: &impl VaultAccess, ask: &AiAsk) -> Result<AiAnswer> {
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    let response: Result<AiAnswer> = api.send(api.http.post(api.url("/v1/ai/suggest")).json(ask)).await;
    note_revocation(access, response)
}

/// Where a guest connects to join a shared terminal: the room's address
/// on the cloud server. No account is needed; the invitation is the pass.
pub fn share_guest_socket(server: &str, room: &str) -> Result<String> {
    let well_formed =
        room.len() == 22 && room.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !well_formed {
        return Err(Error::Invalid("the invitation is damaged".into()));
    }
    let base = normalize_server(server)?;
    let socket_base = match base.split_once("://") {
        Some(("https", rest)) => format!("wss://{rest}"),
        Some((_, rest)) => format!("ws://{rest}"),
        None => return Err(Error::Cloud("the server address is not valid".into())),
    };
    Ok(format!("{socket_base}/v1/share/{room}/guest"))
}

pub async fn devices(access: &impl VaultAccess) -> Result<Vec<Device>> {
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    let response: Result<DevicesResponse> = api.send(api.http.get(api.url("/v1/devices"))).await;
    Ok(note_revocation(access, response)?.devices)
}

/// What the account is on. `None` from a server that knows no plans.
pub async fn plan(access: &impl VaultAccess) -> Result<Option<Plan>> {
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    Ok(fetch_account(access, &api).await?.plan)
}

/// The address of the account's pages on the server (profile, subscription,
/// devices), to open in a browser. It signs the browser in as this device,
/// works once and only for two minutes; the master password stays here.
pub async fn account_page(access: &impl VaultAccess, language: &str) -> Result<String> {
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    let response: Result<WebLinkResponse> = api.send(api.http.post(api.url("/v1/account/web"))).await;
    let link = note_revocation(access, response)?;
    if !link.path.starts_with("/account/") || link.path.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error::Cloud("unexpected answer from the server".into()));
    }
    let language = if matches!(language, "en" | "ru") { language } else { "en" };
    Ok(api.url(&format!("{}&lang={language}", link.path)))
}

/// Ends another device's access to the cloud. It does not erase what that
/// device already holds, and it does not remove any SSH key from servers.
pub async fn revoke_device(access: &impl VaultAccess, device_id: &str) -> Result<()> {
    let account = account_of(access)?;
    let api = Api::new(&account.server, Some(&account.token))?;
    let response = api
        .send_raw(
            api.http
                .delete(api.url(&format!("/v1/devices/{device_id}"))),
        )
        .await
        .map(|_| ());
    note_revocation(access, response)
}

/// If the server says this device is no longer welcome, remember it so the
/// app stops trying and can tell the user.
fn note_revocation<T>(access: &impl VaultAccess, result: Result<T>) -> Result<T> {
    if matches!(result, Err(Error::DeviceRevoked)) {
        access.with_vault(|vault| vault.mark_cloud_revoked())?;
    }
    result
}

// ------------------------------------------------------------------ sync ---

#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncReport {
    /// Items received from other devices.
    pub pulled: usize,
    /// Local changes the server accepted.
    pub pushed: usize,
    /// Decisions taken where both sides had changed the same item.
    pub conflicts: Vec<ConflictNote>,
    /// Local changes still waiting (the server kept moving); the next sync
    /// continues.
    pub pending: usize,
}

/// Brings the vault and the cloud to the same state.
///
/// Pull first, merge, then push what is still different, repeating while
/// other devices keep changing things. Being offline is reported as
/// [`Error::Offline`] and changes nothing: local edits simply wait.
pub async fn sync(access: &impl VaultAccess, copy_suffix: &str) -> Result<SyncReport> {
    let account = account_of(access)?;
    if account.revoked {
        return Err(Error::DeviceRevoked);
    }
    let api = Api::new(&account.server, Some(&account.token))?;
    let result = sync_with(access, &api, copy_suffix).await;
    note_revocation(access, result)
}

/// The sync loop over any [`Transport`].
pub async fn sync_with(
    access: &impl VaultAccess,
    server: &impl Transport,
    copy_suffix: &str,
) -> Result<SyncReport> {
    let key = vault_key_of(&account_of(access)?)?;
    let mut report = SyncReport::default();

    // Keys trusted or forgotten here since the last time go up with the rest.
    if let Some(known) = access.known_hosts() {
        let file = known.lock().unwrap().entries().to_vec();
        access.with_vault(|vault| vault.take_host_keys(&file))?;
    }

    for _ in 0..MAX_ROUNDS {
        // Pull everything new.
        loop {
            let cursor = account_of(access)?.cursor;
            let page = server.pull(cursor).await?;
            let (merged, keys) = access.with_vault(|vault| {
                vault.merge_remote_keys(page.items, page.cursor, !page.more, &key, copy_suffix)
            })?;
            // What other devices trusted or forgot, this one does too, at once.
            if let Some(known) = access.known_hosts() {
                let mut known = known.lock().unwrap();
                for (host, port, entry) in keys {
                    let done = match entry {
                        Some(entry) => known.put(entry),
                        None => known.forget(&host, port).map(|_| ()),
                    };
                    if let Err(error) = done {
                        log::warn!("could not update the trusted key of {host}:{port}: {error}");
                    }
                }
            }
            report.pulled += merged.applied;
            report.conflicts.extend(merged.notes);
            if merged.complete {
                break;
            }
        }

        // Push what differs.
        let changes = access.with_vault(|vault| vault.outgoing(&key, PUSH_BATCH))?;
        if changes.is_empty() {
            report.pending = 0;
            access.with_vault(|vault| vault.mark_synced())?;
            return Ok(report);
        }
        let results = server.push(&changes).await?;
        report.pushed += results
            .iter()
            .filter(|r| matches!(r, PushResult::Accepted { .. }))
            .count();
        access.with_vault(|vault| vault.mark_pushed(&changes, &results))?;
        // Conflicts, and anything beyond one batch, are settled by going
        // round again: pull the newer state, merge, push the rest.
    }

    report.pending = access.with_vault(|vault| Ok(vault.pending_changes()))?;
    access.with_vault(|vault| vault.mark_synced())?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn fast() -> KdfParams {
        KdfParams {
            alg: "argon2id".into(),
            m: 19 * 1024,
            t: 2,
            p: 1,
        }
    }

    #[test]
    fn keys_depend_on_password_and_salt_and_differ_from_each_other() {
        let a = derive_keys("correct horse battery", &[1u8; 16], &fast()).unwrap();
        let again = derive_keys("correct horse battery", &[1u8; 16], &fast()).unwrap();
        let other_password = derive_keys("correct horse batterz", &[1u8; 16], &fast()).unwrap();
        let other_salt = derive_keys("correct horse battery", &[2u8; 16], &fast()).unwrap();
        assert_eq!(a.auth_key[..], again.auth_key[..]);
        assert_eq!(a.wrapping_key[..], again.wrapping_key[..]);
        assert_ne!(a.auth_key[..], a.wrapping_key[..]);
        assert_ne!(a.auth_key[..], other_password.auth_key[..]);
        assert_ne!(a.wrapping_key[..], other_salt.wrapping_key[..]);
    }

    #[test]
    fn weak_or_absurd_kdf_settings_are_refused() {
        let salt = [1u8; 16];
        for bad in [
            KdfParams { m: 1024, ..fast() },
            KdfParams { t: 1, ..fast() },
            KdfParams { p: 64, ..fast() },
            KdfParams { m: 8 * 1024 * 1024, ..fast() },
            KdfParams { alg: "pbkdf2".into(), ..fast() },
        ] {
            assert!(derive_keys("password", &salt, &bad).is_err(), "{bad:?}");
        }
        assert!(derive_keys("password", &[1u8; 4], &fast()).is_err());
    }

    #[test]
    fn vault_key_wraps_only_under_the_right_password() {
        let right = derive_keys("the master password", &[7u8; 16], &fast()).unwrap();
        let wrong = derive_keys("another password!!", &[7u8; 16], &fast()).unwrap();
        let vault_key = new_vault_key();
        let wrapped = wrap_vault_key(&right.wrapping_key, &vault_key).unwrap();
        assert!(!wrapped.windows(32).any(|w| w == &vault_key[..]));
        assert_eq!(
            unwrap_vault_key(&right.wrapping_key, &wrapped).unwrap()[..],
            vault_key[..]
        );
        assert!(matches!(
            unwrap_vault_key(&wrong.wrapping_key, &wrapped),
            Err(Error::BadCredentials)
        ));
        // The auth key, which the server sees, does not unwrap it either.
        assert!(unwrap_vault_key(&right.auth_key, &wrapped).is_err());
    }

    #[test]
    fn items_are_bound_to_their_id() {
        let key = new_vault_key();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let sealed = seal_item(&key, a, b"secret host").unwrap();
        assert!(!sealed.windows(6).any(|w| w == b"secret"));
        assert_eq!(&open_item(&key, a, &sealed).unwrap()[..], b"secret host");
        assert!(open_item(&key, b, &sealed).is_err());
        assert!(open_item(&new_vault_key(), a, &sealed).is_err());
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(open_item(&key, a, &tampered).is_err());
        assert!(open_item(&key, a, b"short").is_err());
    }

    #[tokio::test]
    async fn an_unreachable_server_is_reported_as_offline() {
        // Nothing listens on port 1.
        assert!(matches!(
            server_info("http://127.0.0.1:1").await,
            Err(Error::Offline(_))
        ));
        // Plain HTTP to another machine is refused before any request.
        assert!(matches!(
            server_info("http://example.com").await,
            Err(Error::InsecureServer)
        ));
    }

    #[test]
    fn the_login_is_an_email_address() {
        assert_eq!(normalize_email("  Me@Example.COM ").unwrap(), "me@example.com");
        assert_eq!(normalize_email("a.b+tag@mail.example.org").unwrap(), "a.b+tag@mail.example.org");
        for bad in ["", "admin", "me@", "@example.com", "me@example", "me@@example.com", "me @example.com", "me@example..com", "me@.com"] {
            assert!(normalize_email(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn plain_http_is_allowed_only_to_this_machine() {
        assert_eq!(
            normalize_server(" https://cloud.example.com/ ").unwrap(),
            "https://cloud.example.com"
        );
        assert_eq!(
            normalize_server("cloud.example.com").unwrap(),
            "https://cloud.example.com"
        );
        assert_eq!(
            normalize_server("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_server("http://localhost:8787").is_ok());
        assert!(matches!(
            normalize_server("http://cloud.example.com"),
            Err(Error::InsecureServer)
        ));
        assert!(matches!(
            normalize_server("http://192.168.1.10:8787"),
            Err(Error::InsecureServer)
        ));
        assert!(matches!(
            normalize_server("ftp://example.com"),
            Err(Error::InsecureServer)
        ));
        // A test build may name one more host; every other stays refused.
        allow_plain_http("10.211.55.2");
        assert_eq!(
            normalize_server("http://10.211.55.2:8787").unwrap(),
            "http://10.211.55.2:8787"
        );
        assert!(matches!(
            normalize_server("http://10.211.55.3:8787"),
            Err(Error::InsecureServer)
        ));
        assert!(normalize_server("https://").is_err());
    }
}
