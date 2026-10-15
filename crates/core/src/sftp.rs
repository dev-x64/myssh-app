//! Remote files over SFTP: browsing, transfer, and text editing with change
//! detection.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{Error, Result};

/// Largest file the built-in editor opens.
pub const EDIT_LIMIT: u64 = 2 * 1024 * 1024;
const CHUNK: usize = 128 * 1024;
/// How many files of a transfer are on their way at once. A small file
/// costs a few round trips to the server (open, read or write, close), and
/// with several in flight most of that waiting overlaps.
const FILES_AT_ONCE: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// For a symlink: whether it leads to a directory.
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u32>,
    pub permissions: Option<u32>,
    /// For a symlink: where it points, as written in the link.
    pub target: Option<String>,
}

/// What a file looked like when it was read; compared before overwriting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileVersion {
    pub size: u64,
    pub modified: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextFile {
    /// File content with line endings normalized to `\n`.
    pub content: String,
    /// The file uses `\r\n`; restored on save.
    pub crlf: bool,
    pub version: FileVersion,
}

/// What a finished transfer did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct TransferSummary {
    pub files: u64,
    pub bytes: u64,
    /// Links and special files inside a directory that were not copied.
    pub skipped: u64,
}

/// Lets a running transfer be stopped from outside.
#[derive(Clone, Default)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.0.load(Ordering::Relaxed) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Stops the files of one transfer: when the user cancels it, or when
/// another of its files has failed.
struct Halt<'a> {
    cancel: &'a CancelFlag,
    failed: AtomicBool,
}

impl<'a> Halt<'a> {
    fn new(cancel: &'a CancelFlag) -> Self {
        Halt { cancel, failed: AtomicBool::new(false) }
    }

    fn check(&self) -> Result<()> {
        self.cancel.check()?;
        if self.failed.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
}

/// The bytes moved so far by all the files of a transfer, as one figure.
struct Tally<F> {
    total: u64,
    done: Mutex<(u64, F)>,
}

impl<F: FnMut(u64, u64)> Tally<F> {
    fn new(total: u64, mut report: F) -> Self {
        report(0, total);
        Tally { total, done: Mutex::new((0, report)) }
    }

    fn add(&self, bytes: u64) {
        let mut done = self.done.lock().unwrap();
        done.0 += bytes;
        let now = done.0;
        (done.1)(now, self.total.max(now));
    }

    fn bytes(&self) -> u64 {
        self.done.lock().unwrap().0
    }
}

/// Runs the files of a transfer, [`FILES_AT_ONCE`] at a time. The first
/// failure stops the rest: files already under way notice and clean up
/// after themselves, and no new ones start. Returns how many were done.
async fn each_file<T, Fut>(
    files: Vec<T>,
    halt: &Halt<'_>,
    transfer: impl Fn(T) -> Fut,
) -> Result<u64>
where
    Fut: std::future::Future<Output = Result<()>>,
{
    let mut running = futures::stream::iter(files)
        .map(|file| {
            let started = halt.check();
            let work = started.is_ok().then(|| transfer(file));
            async move {
                started?;
                work.expect("started").await
            }
        })
        .buffer_unordered(FILES_AT_ONCE);
    let mut finished = 0;
    let mut failure: Option<Error> = None;
    while let Some(result) = running.next().await {
        match result {
            Ok(()) => finished += 1,
            Err(e) => {
                halt.failed.store(true, Ordering::Relaxed);
                // The files stopped because of it say only "cancelled"; the
                // cause is what is worth reporting.
                if failure.as_ref().is_none_or(|f| matches!(f, Error::Cancelled)) {
                    failure = Some(e);
                }
            }
        }
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(finished),
    }
}

/// Joins a directory and a name into a remote path.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Parent directory of an absolute remote path; `/` is its own parent.
pub fn parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
    }
}

/// Last component of a remote path.
pub(crate) fn file_name(path: &str) -> Result<String> {
    let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    validate_name(name)?;
    Ok(name.to_string())
}

pub(crate) fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(Error::Invalid(format!("\"{name}\" is not a valid file name")));
    }
    Ok(())
}

pub struct Sftp {
    session: SftpSession,
}

impl Sftp {
    pub(crate) async fn start<S>(stream: S) -> Result<Self>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let session = SftpSession::new(stream).await?;
        session.set_timeout(30);
        Ok(Sftp { session })
    }

    /// The directory a new session starts in (normally the home directory).
    pub async fn home(&self) -> Result<String> {
        Ok(self.session.canonicalize(".").await?)
    }

    /// Absolute form of a path, verified to be a directory.
    pub async fn resolve_dir(&self, path: &str) -> Result<String> {
        let absolute = self.session.canonicalize(path).await?;
        if !self.session.metadata(absolute.as_str()).await?.is_dir() {
            return Err(Error::Invalid(format!("\"{absolute}\" is not a directory")));
        }
        Ok(absolute)
    }

    pub async fn list(&self, dir: &str) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        for item in self.session.read_dir(dir).await? {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = item.metadata();
            let path = join(dir, &name);
            let mut target = None;
            let (kind, is_dir) = if meta.is_symlink() {
                // Follow the link only to learn whether it can be entered.
                let target_is_dir = match self.session.metadata(path.as_str()).await {
                    Ok(target) => target.is_dir(),
                    Err(_) => false,
                };
                target = self.session.read_link(path.as_str()).await.ok();
                (EntryKind::Symlink, target_is_dir)
            } else if meta.is_dir() {
                (EntryKind::Dir, true)
            } else if meta.is_regular() {
                (EntryKind::File, false)
            } else {
                (EntryKind::Other, false)
            };
            entries.push(Entry {
                name,
                path,
                kind,
                is_dir,
                size: meta.size.unwrap_or(0),
                modified: meta.mtime,
                permissions: meta.permissions,
                target,
            });
        }
        Ok(entries)
    }

    /// Whether a path on the server is a directory (links followed).
    pub async fn is_dir(&self, path: &str) -> Result<bool> {
        Ok(self.session.metadata(path).await?.is_dir())
    }

    async fn exists(&self, path: &str) -> Result<bool> {
        match self.session.symlink_metadata(path).await {
            Ok(_) => Ok(true),
            Err(e) => match Error::from(e) {
                Error::NoSuchFile => Ok(false),
                other => Err(other),
            },
        }
    }

    pub async fn create_dir(&self, parent_dir: &str, name: &str) -> Result<String> {
        validate_name(name)?;
        let path = join(parent_dir, name);
        if self.exists(&path).await? {
            return Err(Error::AlreadyExists(name.to_string()));
        }
        self.session.create_dir(path.as_str()).await?;
        Ok(path)
    }

    /// Renames within the same directory. Never replaces an existing entry.
    pub async fn rename(&self, path: &str, new_name: &str) -> Result<String> {
        validate_name(new_name)?;
        let target = join(&parent(path), new_name);
        if target == path {
            return Ok(target);
        }
        if self.exists(&target).await? {
            return Err(Error::AlreadyExists(new_name.to_string()));
        }
        self.session.rename(path, target.as_str()).await?;
        Ok(target)
    }

    /// Deletes a file, a symlink (not what it points to), or a directory
    /// with everything in it.
    pub async fn remove(&self, path: &str) -> Result<()> {
        if path.trim_end_matches('/').is_empty() {
            return Err(Error::Invalid("refusing to delete the root directory".into()));
        }
        let meta = self.session.symlink_metadata(path).await?;
        if !meta.is_dir() {
            self.session.remove_file(path).await?;
            return Ok(());
        }
        // Depth-first without recursion: directories are removed after
        // their contents.
        let mut pending = vec![path.to_string()];
        let mut emptied = Vec::new();
        while let Some(dir) = pending.pop() {
            for item in self.session.read_dir(dir.as_str()).await? {
                let name = item.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = join(&dir, &name);
                if item.metadata().is_dir() {
                    pending.push(child);
                } else {
                    self.session.remove_file(child).await?;
                }
            }
            emptied.push(dir);
        }
        for dir in emptied.into_iter().rev() {
            self.session.remove_dir(dir).await?;
        }
        Ok(())
    }

    /// Sets the permission bits of a file or directory, as `chmod` does.
    /// Nothing else about it is touched: not its owner, not its times.
    pub async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
        let mut attributes = FileAttributes::empty();
        attributes.permissions = Some(mode & 0o7777);
        self.session.set_metadata(path, attributes).await?;
        Ok(())
    }

    /// What a file looks like now, to notice later that it has changed.
    pub async fn version(&self, path: &str) -> Result<FileVersion> {
        let meta = self.session.metadata(path).await?;
        if meta.is_dir() {
            return Err(Error::Invalid(format!("\"{path}\" is a directory")));
        }
        Ok(FileVersion {
            size: meta.size.unwrap_or(0),
            modified: meta.mtime,
        })
    }

    /// Reads a file for the editor. Refuses files that are too large or are
    /// not UTF-8 text.
    pub async fn read_text(&self, path: &str) -> Result<TextFile> {
        let version = self.version(path).await?;
        if version.size > EDIT_LIMIT {
            return Err(Error::TooLarge(version.size));
        }
        let mut file = self.session.open(path).await?;
        let mut bytes = Vec::with_capacity(version.size as usize);
        // The size can change between the check and the read.
        (&mut file)
            .take(EDIT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .await?;
        let _ = file.shutdown().await;
        if bytes.len() as u64 > EDIT_LIMIT {
            return Err(Error::TooLarge(bytes.len() as u64));
        }
        if bytes.contains(&0) {
            return Err(Error::NotText);
        }
        let text = String::from_utf8(bytes).map_err(|_| Error::NotText)?;
        let crlf = text.contains("\r\n");
        Ok(TextFile {
            content: if crlf { text.replace("\r\n", "\n") } else { text },
            crlf,
            version,
        })
    }

    /// Saves editor content over a file.
    ///
    /// With `expected` set, the file must still look as it did when it was
    /// read; otherwise nothing is written and the result is
    /// [`Error::Conflict`]. `None` overwrites unconditionally and is also
    /// used for new files.
    pub async fn write_text(
        &self,
        path: &str,
        content: &str,
        crlf: bool,
        expected: Option<FileVersion>,
    ) -> Result<FileVersion> {
        if let Some(expected) = expected {
            match self.version(path).await {
                Ok(current) if current == expected => {}
                Ok(_) | Err(Error::NoSuchFile) => return Err(Error::Conflict),
                Err(e) => return Err(e),
            }
        }
        let bytes = if crlf {
            content.replace("\r\n", "\n").replace('\n', "\r\n").into_bytes()
        } else {
            content.as_bytes().to_vec()
        };
        // Written in place, so ownership, permissions and links survive.
        let mut file = self.session.create(path).await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        file.shutdown().await?;
        self.version(path).await
    }

    /// Copies a remote file or directory tree into a local directory.
    ///
    /// Nothing existing is replaced unless `overwrite` is set; then files
    /// are replaced and directories are merged. Links and special files
    /// inside a tree are skipped and counted.
    pub async fn download(
        &self,
        remote: &str,
        local_dir: &Path,
        overwrite: bool,
        cancel: &CancelFlag,
        progress: impl FnMut(u64, u64) + Send,
    ) -> Result<TransferSummary> {
        let name = file_name(remote)?;
        let target = local_dir.join(&name);
        if !overwrite && tokio::fs::symlink_metadata(&target).await.is_ok() {
            return Err(Error::AlreadyExists(name));
        }

        // Plan first, so progress has a total and nothing is half-decided.
        let mut summary = TransferSummary::default();
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        let top = self.session.metadata(remote).await?;
        if top.is_dir() {
            let mut pending = vec![(remote.to_string(), target.clone())];
            while let Some((from, to)) = pending.pop() {
                cancel.check()?;
                dirs.push(to.clone());
                for item in self.session.read_dir(from.as_str()).await? {
                    let child = item.file_name();
                    if child == "." || child == ".." {
                        continue;
                    }
                    let meta = item.metadata();
                    if meta.is_dir() {
                        pending.push((join(&from, &child), to.join(&child)));
                    } else if meta.is_regular() {
                        files.push((join(&from, &child), to.join(&child), meta.size.unwrap_or(0)));
                    } else {
                        summary.skipped += 1;
                    }
                }
            }
        } else {
            files.push((remote.to_string(), target, top.size.unwrap_or(0)));
        }

        let tally = Tally::new(files.iter().map(|(_, _, size)| size).sum(), progress);
        for dir in dirs {
            tokio::fs::create_dir_all(&dir).await?;
        }
        let halt = Halt::new(cancel);
        let (tally, halt) = (&tally, &halt);
        summary.files = each_file(files, halt, |(from, to, _)| async move {
            self.download_file(&from, &to, halt, &|bytes| tally.add(bytes)).await
        })
        .await?;
        summary.bytes = tally.bytes();
        Ok(summary)
    }

    async fn download_file(
        &self,
        remote: &str,
        local: &Path,
        halt: &Halt<'_>,
        advanced: &(impl Fn(u64) + Sync),
    ) -> Result<()> {
        let mut source = self.session.open(remote).await?;
        // Written under a temporary name first; a failed or cancelled
        // transfer leaves nothing behind under the final name.
        let mut partial = local.as_os_str().to_owned();
        partial.push(".part");
        let partial = std::path::PathBuf::from(partial);
        let result = async {
            let mut target = tokio::fs::File::create(&partial).await?;
            let mut buffer = vec![0u8; CHUNK];
            loop {
                halt.check()?;
                let read = source.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                target.write_all(&buffer[..read]).await?;
                advanced(read as u64);
            }
            // Not forced onto the disk file by file: for thousands of small
            // files that alone takes longer than the copying.
            target.flush().await?;
            Ok::<_, Error>(())
        }
        .await;
        let _ = source.shutdown().await;
        match result {
            Ok(()) => {
                tokio::fs::rename(&partial, local).await?;
                Ok(())
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&partial).await;
                Err(e)
            }
        }
    }

    /// Copies a local file or directory tree into a remote directory.
    ///
    /// Nothing existing is replaced unless `overwrite` is set; then files
    /// are replaced and directories are merged. Links and special files
    /// inside a tree are skipped and counted.
    pub async fn upload(
        &self,
        local: &Path,
        remote_dir: &str,
        overwrite: bool,
        cancel: &CancelFlag,
        progress: impl FnMut(u64, u64) + Send,
    ) -> Result<TransferSummary> {
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::Invalid("the local path has no file name".into()))?;
        validate_name(&name)?;
        let target = join(remote_dir, &name);
        if !overwrite && self.exists(&target).await? {
            return Err(Error::AlreadyExists(name));
        }

        let mut summary = TransferSummary::default();
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        // The item the user picked is followed if it is a link; links
        // further down are not, which also rules out cycles.
        let top = tokio::fs::metadata(local).await?;
        if top.is_dir() {
            let mut pending = vec![(local.to_path_buf(), target.clone())];
            while let Some((from, to)) = pending.pop() {
                cancel.check()?;
                dirs.push(to.clone());
                let mut reader = tokio::fs::read_dir(&from).await?;
                while let Some(item) = reader.next_entry().await? {
                    let child = item.file_name().to_string_lossy().into_owned();
                    let kind = item.file_type().await?;
                    if kind.is_dir() {
                        pending.push((item.path(), join(&to, &child)));
                    } else if kind.is_file() {
                        files.push((item.path(), join(&to, &child), item.metadata().await?.len()));
                    } else {
                        summary.skipped += 1;
                    }
                }
            }
        } else {
            files.push((local.to_path_buf(), target, top.len()));
        }

        let tally = Tally::new(files.iter().map(|(_, _, size)| size).sum(), progress);
        // Parents come before their children. Creating straight away costs
        // one round trip for a new directory; only when that fails is it
        // asked what is there (merging into an existing one is fine).
        for dir in dirs {
            if let Err(failed) = self.session.create_dir(dir.as_str()).await {
                match self.session.metadata(dir.as_str()).await {
                    Ok(meta) if meta.is_dir() => {}
                    Ok(_) => return Err(Error::AlreadyExists(file_name(&dir)?)),
                    Err(_) => return Err(failed.into()),
                }
            }
        }
        let halt = Halt::new(cancel);
        let (tally, halt) = (&tally, &halt);
        summary.files = each_file(files, halt, |(from, to, _)| async move {
            self.upload_file(&from, &to, halt, &|bytes| tally.add(bytes)).await
        })
        .await?;
        summary.bytes = tally.bytes();
        Ok(summary)
    }

    async fn upload_file(
        &self,
        local: &Path,
        remote: &str,
        halt: &Halt<'_>,
        advanced: &(impl Fn(u64) + Sync),
    ) -> Result<()> {
        let mut source = tokio::fs::File::open(local).await?;
        let mut target = self
            .session
            .open_with_flags(
                remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await?;
        let result = async {
            let mut buffer = vec![0u8; CHUNK];
            loop {
                halt.check()?;
                let read = source.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                target.write_all(&buffer[..read]).await?;
                advanced(read as u64);
            }
            target.flush().await?;
            Ok::<_, Error>(())
        }
        .await;
        let closed = target.shutdown().await;
        match result {
            Ok(()) => Ok(closed?),
            Err(e) => {
                // Do not leave a truncated file posing as the real one.
                let _ = self.session.remove_file(remote).await;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_path_helpers() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/etc", "hosts"), "/etc/hosts");
        assert_eq!(join("/etc/", "hosts"), "/etc/hosts");
        assert_eq!(parent("/etc/hosts"), "/etc");
        assert_eq!(parent("/etc/"), "/");
        assert_eq!(parent("/etc"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(parent("/a/b c/d"), "/a/b c");
        for bad in ["", ".", "..", "a/b", "a\0b"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_name(".bashrc").is_ok());
        assert!(validate_name("with space.txt").is_ok());
    }
}
