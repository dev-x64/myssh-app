use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    InUse(String),
    #[error("port {0} on this computer is in use")]
    PortInUse(u16),
    #[error("this key is already in the keychain as \"{0}\"")]
    KeyExists(String),

    #[error("the vault could not be decrypted: wrong key or damaged file")]
    VaultDecrypt,
    #[error("the vault file has an unsupported format")]
    VaultFormat,
    #[error("the vault exists but its key file is missing")]
    VaultKeyMissing,
    #[error("secure key storage error: {0}")]
    KeyStore(String),
    #[error("the vault is not available: {0}")]
    VaultUnavailable(String),

    #[error("could not connect: {0}")]
    Connect(String),
    #[error("connection timed out")]
    Timeout,
    #[error("the server host key was not accepted")]
    HostKeyRejected,
    #[error("authentication failed")]
    AuthFailed,
    #[error("cancelled")]
    Cancelled,
    #[error("the session is closed")]
    SessionClosed,
    #[error("the private key is protected by a passphrase")]
    KeyEncrypted,
    #[error("key error: {0}")]
    Key(String),

    #[error("file transfer error: {0}")]
    Sftp(String),
    #[error("no such file or directory")]
    NoSuchFile,
    #[error("permission denied")]
    PermissionDenied,
    #[error("\"{0}\" already exists")]
    AlreadyExists(String),
    #[error("the file changed on the server after it was opened")]
    Conflict,
    #[error("the file is too large to edit ({0} bytes)")]
    TooLarge(u64),
    #[error("the file is not text")]
    NotText,

    #[error("the server did not accept the new key")]
    KeyNotAccepted,
    #[error("the command failed on the server: {0}")]
    Remote(String),

    #[error("the cloud server could not be reached: {0}")]
    Offline(String),
    #[error("this vault is not signed in to a cloud account")]
    NotSignedIn,
    #[error("the account name or master password is wrong")]
    BadCredentials,
    #[error("there is no account with this e-mail")]
    NoAccount,
    #[error("an account with this name already exists")]
    AccountExists,
    #[error("new accounts are not accepted on this server")]
    RegistrationClosed,
    #[error("too many failed attempts; try again later")]
    TooManyAttempts,
    #[error("cloud access was revoked for this device")]
    DeviceRevoked,
    #[error("sync and shared sessions come with MySSH Pro")]
    ProRequired,
    #[error("the server address must use https")]
    InsecureServer,
    #[error("cloud error: {0}")]
    Cloud(String),
    #[error("the app could not be updated: {0}")]
    Update(String),

    #[error("ssh error: {0}")]
    Ssh(#[from] russh::Error),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("data error: {0}")]
    Serde(#[from] serde_json::Error),
}

impl Error {
    /// Stable machine-readable code; the UI localizes by it.
    pub fn code(&self) -> &'static str {
        match self {
            Error::NotFound(_) => "not_found",
            Error::Invalid(_) => "invalid",
            Error::InUse(_) => "in_use",
            Error::PortInUse(_) => "port_in_use",
            Error::KeyExists(_) => "key_exists",
            Error::VaultDecrypt => "vault_decrypt",
            Error::VaultFormat => "vault_format",
            Error::VaultKeyMissing => "vault_key_missing",
            Error::KeyStore(_) => "key_store",
            Error::VaultUnavailable(_) => "vault_unavailable",
            Error::Connect(_) => "connect",
            Error::Timeout => "timeout",
            Error::HostKeyRejected => "host_key_rejected",
            Error::AuthFailed => "auth_failed",
            Error::Cancelled => "cancelled",
            Error::SessionClosed => "session_closed",
            Error::KeyEncrypted => "key_encrypted",
            Error::Key(_) => "key",
            Error::Sftp(_) => "sftp",
            Error::NoSuchFile => "no_such_file",
            Error::PermissionDenied => "permission_denied",
            Error::AlreadyExists(_) => "already_exists",
            Error::Conflict => "conflict",
            Error::TooLarge(_) => "too_large",
            Error::NotText => "not_text",
            Error::KeyNotAccepted => "key_not_accepted",
            Error::Remote(_) => "remote",
            Error::Offline(_) => "offline",
            Error::NotSignedIn => "not_signed_in",
            Error::BadCredentials => "bad_credentials",
            Error::NoAccount => "no_account",
            Error::AccountExists => "account_exists",
            Error::RegistrationClosed => "registration_closed",
            Error::TooManyAttempts => "too_many_attempts",
            Error::DeviceRevoked => "device_revoked",
            Error::ProRequired => "pro_required",
            Error::InsecureServer => "insecure_server",
            Error::Cloud(_) => "cloud",
            Error::Update(_) => "update",
            Error::Ssh(_) => "ssh",
            Error::Io(_) => "io",
            Error::Serde(_) => "data",
        }
    }

    /// The underlying cause, where there is one beyond what the code says.
    /// Not localized: it comes from the system or the SSH library.
    pub fn detail(&self) -> Option<String> {
        match self {
            Error::Connect(detail)
            | Error::Key(detail)
            | Error::KeyStore(detail)
            | Error::Sftp(detail)
            | Error::KeyExists(detail)
            | Error::Remote(detail)
            | Error::Offline(detail)
            | Error::Cloud(detail)
            | Error::Update(detail)
            | Error::AlreadyExists(detail) => Some(detail.clone()),
            Error::VaultUnavailable(detail) if !detail.is_empty() => Some(detail.clone()),
            Error::Ssh(e) => Some(e.to_string()),
            Error::Io(e) => Some(e.to_string()),
            Error::Serde(e) => Some(e.to_string()),
            _ => None,
        }
    }

    pub fn info(&self) -> ErrorInfo {
        ErrorInfo {
            code: self.code(),
            message: self.to_string(),
            detail: self.detail(),
        }
    }
}

impl From<russh::keys::Error> for Error {
    fn from(e: russh::keys::Error) -> Self {
        match e {
            russh::keys::Error::KeyIsEncrypted => Error::KeyEncrypted,
            other => Error::Key(other.to_string()),
        }
    }
}

impl From<russh_sftp::client::error::Error> for Error {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as Sftp;
        use russh_sftp::protocol::StatusCode;
        match e {
            Sftp::Status(status) => match status.status_code {
                StatusCode::NoSuchFile => Error::NoSuchFile,
                StatusCode::PermissionDenied => Error::PermissionDenied,
                StatusCode::ConnectionLost | StatusCode::NoConnection => Error::SessionClosed,
                _ => Error::Sftp(status.error_message),
            },
            Sftp::Timeout => Error::Timeout,
            other => Error::Sftp(other.to_string()),
        }
    }
}

impl From<russh::keys::ssh_key::Error> for Error {
    fn from(e: russh::keys::ssh_key::Error) -> Self {
        Error::Key(e.to_string())
    }
}

/// Serializable form of an error, sent to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorInfo {
    pub code: &'static str,
    pub message: String,
    pub detail: Option<String>,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        self.info().serialize(s)
    }
}
