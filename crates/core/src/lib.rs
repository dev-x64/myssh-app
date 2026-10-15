//! Platform-independent core of MySSH.
//!
//! Everything here is UI-agnostic so the same logic can back the desktop
//! shell today and other platforms later.

pub mod cloud;
pub mod error;
pub mod history;
pub mod keys;
pub mod keystore;
pub mod known_hosts;
pub mod localfs;
pub mod model;
pub mod sftp;
pub mod ssh;
pub mod sync;
pub mod vault;

pub use error::{Error, Result};

/// Current time as Unix milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
