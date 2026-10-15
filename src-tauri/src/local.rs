//! A terminal on this computer: the user's own shell in a pseudo-terminal,
//! shown in a tab like a server's. It reports through the same events and
//! output channel as an SSH session and takes the same writes, resizes and
//! acknowledgements, so the window treats the two alike.

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

use myssh_core::error::{Error, Result};
use myssh_core::ssh::{CloseReason, SessionEvent};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

/// Output not yet drawn by the window, past which the shell is made to wait:
/// a command that pours out text must not drown the window.
const MAX_UNACKED: usize = 4 * 1024 * 1024;

pub struct LocalShell {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Bytes sent to the window and not yet acknowledged as drawn.
    unacked: Mutex<usize>,
    drawn: Condvar,
}

impl LocalShell {
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(data).and_then(|_| writer.flush()).map_err(|_| Error::SessionClosed)
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(size(cols, rows))
            .map_err(|e| Error::Invalid(e.to_string()))
    }

    pub fn ack(&self, bytes: usize) {
        let mut unacked = self.unacked.lock().unwrap();
        *unacked = unacked.saturating_sub(bytes);
        self.drawn.notify_all();
    }

    pub fn close(&self) {
        let _ = self.child.lock().unwrap().kill();
        // Nothing waits for the window any more.
        *self.unacked.lock().unwrap() = 0;
        self.drawn.notify_all();
    }
}

fn size(cols: u32, rows: u32) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 1000) as u16,
        rows: rows.clamp(2, 1000) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The user's shell: their login shell on a Mac or Linux, PowerShell on
/// Windows. It starts in the home folder, and is told it runs in a colour
/// terminal that speaks UTF-8 (an app opened from the Finder is given no
/// language of its own).
fn shell() -> CommandBuilder {
    #[cfg(windows)]
    let mut command = {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command
    };
    #[cfg(not(windows))]
    let mut command = CommandBuilder::new_default_prog();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        command.cwd(home);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "MySSH");
    if std::env::var_os("LANG").is_none() && !cfg!(windows) {
        command.env("LANG", "en_US.UTF-8");
    }
    command
}

/// Opens a terminal on this computer. Its output and events arrive on the
/// channels given, as a server's would.
#[tauri::command]
pub fn local_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u32,
    rows: u32,
    events: Channel<SessionEvent>,
    output: Channel<InvokeResponseBody>,
) -> Result<u64> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| Error::Connect(format!("no terminal could be opened: {e}")))?;
    let child = pair
        .slave
        .spawn_command(shell())
        .map_err(|e| Error::Connect(format!("the shell did not start: {e}")))?;
    // The shell holds its end; ours would keep the terminal open after it exits.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| Error::Connect(e.to_string()))?;
    let writer = pair.master.take_writer().map_err(|e| Error::Connect(e.to_string()))?;
    let shell = Arc::new(LocalShell {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        unacked: Mutex::new(0),
        drawn: Condvar::new(),
    });
    let id = state.add_local(shell.clone());
    let _ = events.send(SessionEvent::Connected);

    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            {
                let mut unacked = shell.unacked.lock().unwrap();
                while *unacked > MAX_UNACKED {
                    unacked = shell.drawn.wait(unacked).unwrap();
                }
            }
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    *shell.unacked.lock().unwrap() += n;
                    if output.send(InvokeResponseBody::Raw(buffer[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let exit_status = shell.child.lock().unwrap().wait().ok().map(|status| status.exit_code());
        let _ = events.send(SessionEvent::Closed { reason: CloseReason::Exited, exit_status, error: None });
        app.state::<AppState>().remove_local(id);
    });
    Ok(id)
}
