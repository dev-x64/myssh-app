//! Files on this computer, for the local side of the file manager.

use std::path::{Path, PathBuf};

use crate::sftp::{validate_name, Entry, EntryKind};
use crate::{Error, Result};

fn modified_seconds(meta: &std::fs::Metadata) -> Option<u32> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u32::try_from(d.as_secs()).ok())
}

#[cfg(unix)]
fn permissions(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode())
}

#[cfg(not(unix))]
fn permissions(_: &std::fs::Metadata) -> Option<u32> {
    None
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn map_io(e: std::io::Error) -> Error {
    match e.kind() {
        std::io::ErrorKind::NotFound => Error::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => Error::PermissionDenied,
        _ => Error::Io(e),
    }
}

/// The user's home directory.
pub fn home() -> Result<String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| text(Path::new(&home)))
        .ok_or_else(|| Error::Invalid("the home directory is unknown".into()))
}

/// Absolute form of a path, verified to be a directory. `~` means home.
pub async fn resolve_dir(path: &str) -> Result<String> {
    let expanded: PathBuf = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            PathBuf::from(format!("{}{rest}", home()?))
        }
        _ => PathBuf::from(path),
    };
    let absolute = tokio::fs::canonicalize(&expanded).await.map_err(map_io)?;
    if !tokio::fs::metadata(&absolute).await.map_err(map_io)?.is_dir() {
        return Err(Error::Invalid(format!(
            "\"{}\" is not a directory",
            absolute.display()
        )));
    }
    Ok(text(&absolute))
}

/// What the file manager shows of one item, or nothing if it is gone or unreadable.
async fn entry_at(path: &Path) -> Option<Entry> {
    let meta = tokio::fs::symlink_metadata(path).await.ok()?;
    let mut target = None;
    let (kind, is_dir) = if meta.file_type().is_symlink() {
        let target_is_dir = tokio::fs::metadata(path)
            .await
            .map(|target| target.is_dir())
            .unwrap_or(false);
        target = tokio::fs::read_link(path).await.ok().map(|to| text(&to));
        (EntryKind::Symlink, target_is_dir)
    } else if meta.is_dir() {
        (EntryKind::Dir, true)
    } else if meta.is_file() {
        (EntryKind::File, false)
    } else {
        (EntryKind::Other, false)
    };
    Some(Entry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| text(path)),
        path: text(path),
        kind,
        is_dir,
        size: meta.len(),
        modified: modified_seconds(&meta),
        permissions: permissions(&meta),
        target,
    })
}

pub async fn list(dir: &str) -> Result<Vec<Entry>> {
    let mut reader = tokio::fs::read_dir(dir).await.map_err(map_io)?;
    let mut entries = Vec::new();
    while let Some(item) = reader.next_entry().await.map_err(map_io)? {
        // An entry can vanish or be unreadable between listing and
        // inspection; it is simply left out.
        if let Some(entry) = entry_at(&item.path()).await {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// The items at these paths, as a listing shows them: files dragged in from
/// the system. The ones that are gone are left out.
pub async fn entries(paths: &[String]) -> Vec<Entry> {
    let mut entries = Vec::new();
    for path in paths {
        if let Some(entry) = entry_at(Path::new(path)).await {
            entries.push(entry);
        }
    }
    entries
}

pub async fn create_dir(parent: &str, name: &str) -> Result<String> {
    validate_name(name)?;
    let path = Path::new(parent).join(name);
    if tokio::fs::symlink_metadata(&path).await.is_ok() {
        return Err(Error::AlreadyExists(name.to_string()));
    }
    tokio::fs::create_dir(&path).await.map_err(map_io)?;
    Ok(text(&path))
}

/// Renames within the same directory. Never replaces an existing entry.
pub async fn rename(path: &str, new_name: &str) -> Result<String> {
    validate_name(new_name)?;
    let source = Path::new(path);
    let target = source
        .parent()
        .ok_or_else(|| Error::Invalid("this item cannot be renamed".into()))?
        .join(new_name);
    if target == source {
        return Ok(text(&target));
    }
    if tokio::fs::symlink_metadata(&target).await.is_ok() {
        return Err(Error::AlreadyExists(new_name.to_string()));
    }
    tokio::fs::rename(source, &target).await.map_err(map_io)?;
    Ok(text(&target))
}

/// Sets the permission bits of a local file or directory, as `chmod` does.
pub async fn set_permissions(path: &str, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(mode & 0o7777);
        tokio::fs::set_permissions(path, permissions).await.map_err(map_io)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Err(Error::Invalid("permissions are not supported on this system".into()))
    }
}

/// What a local file looks like at this moment; two that differ mean the
/// file was written in between.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stamp {
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified_ms: u64,
}

/// The stamp of a local file, or `None` if it is no longer there.
pub async fn stamp(path: &Path) -> Result<Option<Stamp>> {
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(map_io(e)),
    };
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(Stamp { size: meta.len(), modified_ms }))
}

/// Moves items to the system trash, so a local deletion can be undone.
pub async fn trash(paths: Vec<String>) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        delete_all(paths.iter().map(Path::new)).map_err(|e| Error::Sftp(e.to_string()))
    })
    .await
    .map_err(|e| Error::Sftp(e.to_string()))?
}

/// The same, for a caller that is not async. Nothing to move is fine.
pub fn trash_now(paths: &[std::path::PathBuf]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    delete_all(paths.iter().map(PathBuf::as_path)).map_err(|e| Error::Io(std::io::Error::other(e)))
}

#[cfg(not(target_os = "android"))]
fn delete_all<'a>(paths: impl IntoIterator<Item = &'a Path>) -> std::result::Result<(), String> {
    ::trash::delete_all(paths).map_err(|e| e.to_string())
}

/// Android has no trash: what is deleted there is gone.
#[cfg(target_os = "android")]
fn delete_all<'a>(paths: impl IntoIterator<Item = &'a Path>) -> std::result::Result<(), String> {
    for path in paths {
        let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        let removed = if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        removed.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn browse_create_rename() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let root_str = root.to_str().unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("sub"), root.join("link")).unwrap();

        assert_eq!(resolve_dir(root_str).await.unwrap(), root_str);
        assert_eq!(
            resolve_dir(&format!("{root_str}/sub/..")).await.unwrap(),
            root_str
        );
        assert!(matches!(
            resolve_dir(&format!("{root_str}/a.txt")).await,
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            resolve_dir(&format!("{root_str}/missing")).await,
            Err(Error::NoSuchFile)
        ));
        assert_eq!(resolve_dir("~").await.unwrap(), resolve_dir(&home().unwrap()).await.unwrap());

        let mut listing = list(root_str).await.unwrap();
        listing.sort_by(|a, b| a.name.cmp(&b.name));
        let summary: Vec<_> = listing
            .iter()
            .map(|e| (e.name.as_str(), e.kind, e.is_dir, e.size))
            .collect();
        assert_eq!(summary[0], ("a.txt", EntryKind::File, false, 5));
        #[cfg(unix)]
        assert_eq!((summary[1].0, summary[1].1, summary[1].2), ("link", EntryKind::Symlink, true));
        assert!(listing.iter().all(|e| e.modified.is_some()));

        assert!(matches!(
            create_dir(root_str, "sub").await,
            Err(Error::AlreadyExists(_))
        ));
        let made = create_dir(root_str, "new").await.unwrap();
        assert!(Path::new(&made).is_dir());
        assert!(matches!(
            rename(&made, "a.txt").await,
            Err(Error::AlreadyExists(_))
        ));
        let renamed = rename(&made, "renamed").await.unwrap();
        assert!(Path::new(&renamed).is_dir() && !Path::new(&made).exists());
        assert!(matches!(create_dir(root_str, "x/y").await, Err(Error::Invalid(_))));
    }
}
