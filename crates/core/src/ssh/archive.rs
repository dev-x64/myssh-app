//! Moving a whole directory as one tar stream on a side channel of the
//! connection, instead of file by file over SFTP: thousands of small files
//! then cost a few round trips in all, not a few each. Nothing is
//! compressed. The user turns this on in the settings; a server without
//! `tar` or without a POSIX shell answers `None`, and the caller goes the
//! SFTP way.
//!
//! Neither direction leaves a part of the copy under the real name. What
//! arrives is unpacked into a hidden directory beside the target and moved
//! into place only once all of it is there; a cancelled or failed transfer
//! removes that directory. As over SFTP, links and special files are
//! skipped and counted, and an existing directory is merged into only when
//! `overwrite` is set.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicU64;

use tokio::sync::mpsc;

use super::*;
use crate::sftp::{file_name, join, validate_name, CancelFlag, TransferSummary};

/// The small steps around a transfer (checks, moving into place, cleanup).
const STEP_LIMIT: Duration = Duration::from_secs(60);
const CHUNK: usize = 64 * 1024;
/// Printed by a step's script once it has run to its end.
const DONE: &str = "myssh-archive-ok";
const EXISTS: u32 = 3;
const MISSING: u32 = 4;
const CANNOT_PREPARE: u32 = 5;

/// A text as one word for a POSIX shell.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// A command that runs `script` in `sh`, whatever the login shell is.
fn sh(script: &str) -> String {
    format!("sh -c {}", quote(script))
}

fn hidden_name() -> String {
    format!(".myssh-{}.part", uuid::Uuid::new_v4().simple())
}

async fn step(connection: &client::Handle<Handler>, script: &str) -> Result<ExecOutput> {
    timeout(STEP_LIMIT, exec_on(connection, &sh(script), None))
        .await
        .map_err(|_| Error::Timeout)?
}

/// Whether a step's script ran to its end.
fn finished(output: &ExecOutput) -> bool {
    output.success() && output.stdout_text().lines().any(|line| line.trim() == DONE)
}

fn failure(output: &ExecOutput) -> Error {
    let said = output.stderr_text();
    let said = said.trim();
    Error::Remote(if said.is_empty() {
        format!("exit status {}", output.exit_status.unwrap_or(1))
    } else {
        said.chars().take(2000).collect()
    })
}

async fn remove_remote(connection: &client::Handle<Handler>, path: &str) {
    let _ = step(connection, &format!("rm -rf {}", quote(path))).await;
}

/// What a stream channel said besides its data.
#[derive(Default)]
struct Heard {
    exit_status: Option<u32>,
    stderr: Vec<u8>,
}

impl Heard {
    /// What the server said, without the line naming the process.
    fn output(&self) -> ExecOutput {
        let text = String::from_utf8_lossy(&self.stderr);
        let said: Vec<&str> = text.lines().filter(|line| !line.starts_with(PID)).collect();
        ExecOutput { stdout: Vec::new(), stderr: said.join("\n").into_bytes(), exit_status: self.exit_status }
    }

    fn pid(&self) -> Option<u32> {
        String::from_utf8_lossy(&self.stderr)
            .lines()
            .find_map(|line| line.strip_prefix(PID)?.trim().parse().ok())
    }

    fn check(self) -> Result<()> {
        if self.exit_status == Some(0) {
            return Ok(());
        }
        Err(failure(&self.output()))
    }
}

// ----------------------------------------------------------------- upload ---

struct LocalFile {
    path: PathBuf,
    /// Inside the directory being sent, with `/` between the parts.
    name: String,
    size: u64,
    mode: u32,
    modified: u64,
}

struct LocalDir {
    name: String,
    mode: u32,
    modified: u64,
}

/// What is to be sent, found before anything is.
#[derive(Default)]
struct Plan {
    dirs: Vec<LocalDir>,
    files: Vec<LocalFile>,
    skipped: u64,
    bytes: u64,
}

fn mode_and_time(meta: &std::fs::Metadata, default_mode: u32) -> (u32, u64) {
    #[cfg(unix)]
    let mode = std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o7777;
    #[cfg(not(unix))]
    let mode = default_mode;
    #[cfg(unix)]
    let _ = default_mode;
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |at| at.as_secs());
    (mode, modified)
}

/// Walks a local directory. Links inside it are not followed, which also
/// rules out cycles.
fn plan_local(root: &Path) -> std::io::Result<Plan> {
    let mut plan = Plan::default();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        for item in std::fs::read_dir(&dir)? {
            let item = item?;
            let name = format!("{prefix}{}", item.file_name().to_string_lossy());
            let kind = item.file_type()?;
            if kind.is_dir() {
                let (mode, modified) = mode_and_time(&item.metadata()?, 0o755);
                plan.dirs.push(LocalDir { name: name.clone(), mode, modified });
                pending.push((item.path(), format!("{name}/")));
            } else if kind.is_file() {
                let meta = item.metadata()?;
                let (mode, modified) = mode_and_time(&meta, 0o644);
                plan.bytes += meta.len();
                plan.files.push(LocalFile { path: item.path(), name, size: meta.len(), mode, modified });
            } else {
                plan.skipped += 1;
            }
        }
    }
    // Parents before what is in them.
    plan.dirs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(plan)
}

/// Hands the archive over in chunks to the task that sends it.
struct ChunkWriter {
    out: mpsc::Sender<Vec<u8>>,
    buffer: Vec<u8>,
}

impl ChunkWriter {
    fn pass(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = std::mem::replace(&mut self.buffer, Vec::with_capacity(CHUNK));
        self.out
            .blocking_send(chunk)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the transfer stopped"))
    }
}

impl Write for ChunkWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(data);
        if self.buffer.len() >= CHUNK {
            self.pass()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.pass()
    }
}

/// A file's content as the archive declared it: counted as it is read, and
/// padded with zeros should the file have shrunk meanwhile, so the archive
/// stays whole.
struct Content<'a, R> {
    inner: std::io::Take<R>,
    left: u64,
    done: &'a AtomicU64,
}

impl<R: Read> Read for Content<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 {
            return Ok(0);
        }
        let mut read = self.inner.read(buffer)?;
        if read == 0 {
            read = buffer.len().min(self.left as usize);
            buffer[..read].fill(0);
        }
        self.left -= read as u64;
        self.done.fetch_add(read as u64, Ordering::Relaxed);
        Ok(read)
    }
}

fn header(kind: tar::EntryType, size: u64, mode: u32, modified: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(kind);
    header.set_size(size);
    header.set_mode(mode);
    header.set_mtime(modified);
    // Whoever unpacks it owns what it makes, as with files sent over SFTP.
    header.set_uid(0);
    header.set_gid(0);
    header
}

fn write_archive(plan: &Plan, out: ChunkWriter, done: &AtomicU64) -> std::io::Result<()> {
    let mut builder = tar::Builder::new(out);
    for dir in &plan.dirs {
        let mut entry = header(tar::EntryType::Directory, 0, dir.mode, dir.modified);
        builder.append_data(&mut entry, format!("{}/", dir.name), std::io::empty())?;
    }
    for file in &plan.files {
        let source = std::fs::File::open(&file.path)?;
        let mut entry = header(tar::EntryType::Regular, file.size, file.mode, file.modified);
        let content = Content { inner: source.take(file.size), left: file.size, done };
        builder.append_data(&mut entry, &file.name, content)?;
    }
    builder.into_inner()?.flush()
}

impl SessionHandle {
    /// Uploads a local directory into a remote one as a tar stream. `None`:
    /// the server cannot take it this way, nothing was done there.
    pub async fn upload_archive(
        &self,
        local: &Path,
        remote_dir: &str,
        overwrite: bool,
        cancel: &CancelFlag,
        mut progress: impl FnMut(u64, u64) + Send,
    ) -> Result<Option<TransferSummary>> {
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::Invalid("the local path has no file name".into()))?;
        validate_name(&name)?;
        let target = join(remote_dir, &name);
        let hidden = join(remote_dir, &hidden_name());
        let connection = self.connection()?;

        let root = local.to_path_buf();
        let plan = tokio::task::spawn_blocking(move || plan_local(&root))
            .await
            .map_err(|e| Error::Io(std::io::Error::other(e)))??;

        let (t, h) = (quote(&target), quote(&hidden));
        let prepared = step(
            &connection,
            &format!(
                "command -v tar >/dev/null 2>&1 || exit 0\n\
                 if [ -e {t} ] || [ -L {t} ]; then [ {o} = 1 ] && [ -d {t} ] || exit {EXISTS}; fi\n\
                 mkdir {h} || exit {CANNOT_PREPARE}\n\
                 echo {DONE}",
                o = u8::from(overwrite),
            ),
        )
        .await?;
        if !finished(&prepared) {
            return match prepared.exit_status {
                Some(EXISTS) => Err(Error::AlreadyExists(name)),
                Some(CANNOT_PREPARE) => Err(failure(&prepared)),
                // No tar there, or no sh: SFTP it is.
                _ => Ok(None),
            };
        }

        let sent = send_archive(&connection, &hidden, plan, cancel, &mut progress).await;
        let summary = match sent {
            Ok(summary) => summary,
            Err((e, pid)) => {
                remove_after(&connection, &hidden, pid).await;
                return Err(e);
            }
        };
        // All of it is there: into place, or merged into what is there.
        let placed = step(
            &connection,
            &format!(
                "if [ -d {t} ]; then cp -Rp {h}/. {t}/ || exit 1; else mv {h} {t} || exit 1; fi\n\
                 rm -rf {h}\n\
                 echo {DONE}"
            ),
        )
        .await;
        match placed {
            Ok(output) if finished(&output) => Ok(Some(summary)),
            Ok(output) => {
                remove_remote(&connection, &hidden).await;
                Err(failure(&output))
            }
            Err(e) => {
                remove_remote(&connection, &hidden).await;
                Err(e)
            }
        }
    }

    /// Downloads a remote directory into a local one as a tar stream.
    /// `None`: the server cannot send it this way, nothing was done here.
    pub async fn download_archive(
        &self,
        remote: &str,
        local_dir: &Path,
        overwrite: bool,
        cancel: &CancelFlag,
        mut progress: impl FnMut(u64, u64) + Send,
    ) -> Result<Option<TransferSummary>> {
        let name = file_name(remote)?;
        let target = local_dir.join(&name);
        let existing = tokio::fs::symlink_metadata(&target).await.ok();
        match &existing {
            Some(_) if !overwrite => return Err(Error::AlreadyExists(name)),
            Some(meta) if !meta.is_dir() => return Err(Error::AlreadyExists(name)),
            _ => {}
        }
        let connection = self.connection()?;
        let source = quote(remote);
        // The size is only an estimate (`du` counts blocks), for progress.
        let prepared = step(
            &connection,
            &format!(
                "command -v tar >/dev/null 2>&1 || exit 0\n\
                 [ -d {source} ] || exit {MISSING}\n\
                 echo {DONE}\n\
                 du -sk {source} 2>/dev/null"
            ),
        )
        .await?;
        if !finished(&prepared) {
            return match prepared.exit_status {
                Some(MISSING) => Err(Error::NoSuchFile),
                _ => Ok(None),
            };
        }
        let estimate = prepared
            .stdout_text()
            .lines()
            .skip_while(|line| line.trim() != DONE)
            .nth(1)
            .and_then(|line| line.split_whitespace().next()?.parse::<u64>().ok())
            .map_or(0, |kib| kib * 1024);

        let hidden = local_dir.join(hidden_name());
        tokio::fs::create_dir(&hidden).await?;
        let received = receive_archive(&connection, remote, &hidden, estimate, cancel, &mut progress).await;
        let placed = match received {
            Ok(summary) => {
                let (from, to) = (hidden.clone(), target.clone());
                tokio::task::spawn_blocking(move || {
                    if existing.is_some() {
                        merge(&from, &to)
                    } else {
                        std::fs::rename(&from, &to)
                    }
                })
                .await
                .map_err(|e| Error::Io(std::io::Error::other(e)))?
                .map(|()| summary)
                .map_err(Error::from)
            }
            Err(e) => Err(e),
        };
        if tokio::fs::metadata(&hidden).await.is_ok() {
            let _ = tokio::fs::remove_dir_all(&hidden).await;
        }
        placed.map(Some)
    }
}

/// The first line a stream's command writes to stderr: the process id of
/// its tar, for the cleanup after a stopped upload.
const PID: &str = "myssh-pid:";

/// Sends the planned files into `hidden` on the server.
///
/// A stream stopped by this side is not waited on: once the app closes a
/// channel, the SSH library no longer passes on what the server says about
/// it. Whatever the server's tar made of the part it got is removed by
/// [`remove_after`].
async fn send_archive(
    connection: &client::Handle<Handler>,
    hidden: &str,
    plan: Plan,
    cancel: &CancelFlag,
    progress: &mut (impl FnMut(u64, u64) + Send),
) -> std::result::Result<TransferSummary, (Error, Option<u32>)> {
    let started = async {
        let channel = connection.channel_open_session().await?;
        channel
            .exec(true, sh(&format!("cd {} && echo {PID}$$ >&2 && exec tar -xf -", quote(hidden))))
            .await?;
        Ok::<_, Error>(channel.split())
    };
    let (mut reading, writing) = started.await.map_err(|e| (e, None))?;

    let summary = TransferSummary { files: plan.files.len() as u64, bytes: plan.bytes, skipped: plan.skipped };
    let total = plan.bytes;
    let done = Arc::new(AtomicU64::new(0));
    let (chunks, mut incoming) = mpsc::channel::<Vec<u8>>(4);
    let counted = done.clone();
    let builder = tokio::task::spawn_blocking(move || {
        write_archive(&plan, ChunkWriter { out: chunks, buffer: Vec::with_capacity(CHUNK) }, &counted)
    });

    let heard = std::sync::Mutex::new(Heard::default());
    let sending = async {
        progress(0, total);
        while let Some(chunk) = incoming.recv().await {
            cancel.check()?;
            writing.data(&chunk[..]).await.map_err(|_| Error::SessionClosed)?;
            let now = done.load(Ordering::Relaxed);
            progress(now, total.max(now));
        }
        // The archive must be whole before the server is told it ended:
        // a reader that stops early would otherwise look like the end.
        builder.await.map_err(|e| Error::Io(std::io::Error::other(e)))??;
        writing.eof().await?;
        Ok::<_, Error>(())
    };
    let listening = async {
        while let Some(message) = reading.wait().await {
            let mut heard = heard.lock().unwrap();
            match message {
                ChannelMsg::ExtendedData { data, ext: 1 } if heard.stderr.len() < 64 * 1024 => {
                    heard.stderr.extend_from_slice(&data)
                }
                ChannelMsg::ExitStatus { exit_status } => heard.exit_status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    tokio::pin!(sending, listening);
    let mut ended = false;
    let sent = loop {
        tokio::select! {
            result = &mut sending => break result,
            () = &mut listening, if !ended => {
                // The server's side ended before all was sent: tar failed.
                ended = true;
                let heard = heard.lock().unwrap();
                if heard.exit_status != Some(0) {
                    break Err(failure(&heard.output()));
                }
            }
        }
    };
    let pid = || heard.lock().unwrap().pid();
    if let Err(e) = sent {
        drop(sending);
        let _ = writing.close().await;
        return Err((e, pid()));
    }
    if !ended {
        listening.await;
    }
    let heard = heard.lock().unwrap();
    if heard.exit_status != Some(0) {
        return Err((failure(&heard.output()), heard.pid()));
    }
    Ok(summary)
}

/// Removes what a stopped upload left on the server. Its tar is first given
/// time to notice the end of its input (and stopped if it does not), so
/// that it writes nothing after the removal.
async fn remove_after(connection: &client::Handle<Handler>, hidden: &str, pid: Option<u32>) {
    let wait = match pid {
        // Only a process that is still a tar is waited on or stopped.
        Some(pid) => format!(
            "tar_alive() {{ case \"$(ps -p {pid} -o comm= 2>/dev/null)\" in *tar*) return 0;; esac; return 1; }}\n\
             i=0; while tar_alive && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done\n\
             tar_alive && kill {pid} 2>/dev/null && sleep 1\n"
        ),
        None => "sleep 2\n".to_string(),
    };
    let _ = step(connection, &format!("{wait}rm -rf {h}\nsleep 1\nrm -rf {h}", h = quote(hidden))).await;
}

/// Reads the archive's chunks as one stream, for the unpacking thread.
struct ChunkReader {
    incoming: mpsc::Receiver<Vec<u8>>,
    current: Vec<u8>,
    at: usize,
}

impl Read for ChunkReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        while self.at >= self.current.len() {
            match self.incoming.blocking_recv() {
                Some(chunk) => {
                    self.current = chunk;
                    self.at = 0;
                }
                None => return Ok(0),
            }
        }
        let count = buffer.len().min(self.current.len() - self.at);
        buffer[..count].copy_from_slice(&self.current[self.at..self.at + count]);
        self.at += count;
        Ok(count)
    }
}

/// A path from the archive as one inside the directory it is unpacked
/// into; `None` for anything that would lead out of it.
fn inside(path: &Path) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::Normal(name) => clean.push(name),
            _ => return None,
        }
    }
    Some(clean)
}

fn unpack(input: impl Read, into: &Path, done: &AtomicU64) -> Result<TransferSummary> {
    let mut summary = TransferSummary::default();
    let mut archive = tar::Archive::new(input);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let relative = inside(&path)
            .ok_or_else(|| Error::Invalid(format!("the archive names a path outside it: {}", path.display())))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let to = into.join(&relative);
        match entry.header().entry_type() {
            tar::EntryType::Directory => std::fs::create_dir_all(&to)?,
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                if let Some(parent) = to.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut file = std::fs::File::create(&to)?;
                let mut buffer = vec![0u8; CHUNK];
                loop {
                    let read = entry.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    file.write_all(&buffer[..read])?;
                    done.fetch_add(read as u64, Ordering::Relaxed);
                    summary.bytes += read as u64;
                }
                #[cfg(unix)]
                if let Ok(mode) = entry.header().mode() {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = file.set_permissions(std::fs::Permissions::from_mode(mode & 0o777));
                }
                summary.files += 1;
            }
            _ => summary.skipped += 1,
        }
    }
    Ok(summary)
}

/// Receives the remote directory's content into `hidden`.
async fn receive_archive(
    connection: &client::Handle<Handler>,
    remote: &str,
    hidden: &Path,
    estimate: u64,
    cancel: &CancelFlag,
    progress: &mut (impl FnMut(u64, u64) + Send),
) -> Result<TransferSummary> {
    let channel = connection.channel_open_session().await?;
    channel.exec(true, sh(&format!(
        // A Mac's tar would add "._" files for extended attributes.
        "cd {} && COPYFILE_DISABLE=1 exec tar -cf - .",
        quote(remote)
    ))).await?;
    let (mut reading, writing) = channel.split();

    let done = Arc::new(AtomicU64::new(0));
    let (chunks, incoming) = mpsc::channel::<Vec<u8>>(4);
    let (into, counted) = (hidden.to_path_buf(), done.clone());
    let unpacking = tokio::task::spawn_blocking(move || {
        unpack(ChunkReader { incoming, current: Vec::new(), at: 0 }, &into, &counted)
    });

    let mut heard = Heard::default();
    let mut stopped = None;
    let mut closed = false;
    progress(0, estimate);
    while let Some(message) = reading.wait().await {
        if let Err(e) = cancel.check() {
            stopped = Some(e);
            break;
        }
        match message {
            ChannelMsg::Data { data } => {
                if chunks.send(data.to_vec()).await.is_err() {
                    // The unpacking stopped; its error says why.
                    break;
                }
                let now = done.load(Ordering::Relaxed);
                progress(now, estimate.max(now));
            }
            ChannelMsg::ExtendedData { data, ext: 1 } if heard.stderr.len() < 64 * 1024 => {
                heard.stderr.extend_from_slice(&data)
            }
            ChannelMsg::ExitStatus { exit_status } => heard.exit_status = Some(exit_status),
            ChannelMsg::Close => {
                closed = true;
                break;
            }
            _ => {}
        }
    }
    drop(chunks);
    if let Some(e) = stopped {
        // Closing ends the server's tar (its output goes nowhere); what came
        // so far is thrown away with the hidden directory.
        let _ = writing.close().await;
        let _ = unpacking.await;
        return Err(e);
    }
    let unpacked = unpacking.await.map_err(|e| Error::Io(std::io::Error::other(e)))?;
    if !closed {
        // The unpacking stopped first; its error says why.
        let _ = writing.close().await;
        unpacked?;
        return Err(Error::SessionClosed);
    }
    // The server's word comes first: an archive cut short because tar met
    // an unreadable file is not one to keep.
    heard.check()?;
    let summary = unpacked?;
    let now = done.load(Ordering::Relaxed);
    progress(now, now);
    Ok(summary)
}

/// Moves what was received into an existing directory: files replace
/// files, directories are merged.
fn merge(from: &Path, into: &Path) -> std::io::Result<()> {
    for item in std::fs::read_dir(from)? {
        let item = item?;
        let to = into.join(item.file_name());
        if item.file_type()?.is_dir() {
            if to.is_dir() {
                merge(&item.path(), &to)?;
            } else {
                if std::fs::symlink_metadata(&to).is_ok() {
                    std::fs::remove_file(&to)?;
                }
                std::fs::rename(item.path(), &to)?;
            }
        } else {
            if to.is_dir() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("\"{}\" is a folder here", to.display()),
                ));
            }
            // Windows does not rename over an existing file.
            #[cfg(windows)]
            if to.exists() {
                std::fs::remove_file(&to)?;
            }
            std::fs::rename(item.path(), &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_keeps_any_name_one_word() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(sh("echo 'x'"), r"sh -c 'echo '\''x'\'''");
    }

    #[test]
    fn nothing_in_an_archive_leads_out_of_it() {
        assert_eq!(inside(Path::new("./a/b")), Some(PathBuf::from("a/b")));
        assert_eq!(inside(Path::new(".")), Some(PathBuf::new()));
        assert_eq!(inside(Path::new("../x")), None);
        assert_eq!(inside(Path::new("a/../../x")), None);
        assert_eq!(inside(Path::new("/etc/passwd")), None);
    }
}
