//! Interactive SSH terminal sessions.
//!
//! A session runs as one task. It reports through a stream of
//! [`SessionOutput`] and is steered through a [`SessionHandle`]. Anything
//! that needs a human decision (an unknown host key, a missing password) is
//! raised as a [`Prompt`] and the task waits for the matching reply.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect, MethodKind, MethodSet, SshId};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::timeout;

use crate::error::ErrorInfo;
use crate::keys;
use crate::known_hosts::{HostKeyStatus, KnownHosts};
use crate::model::Id;
use crate::{Error, Result};

mod archive;
mod install;
pub use install::{install_comment, install_script, spawn_install, InstallParams};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SHELL_TIMEOUT: Duration = Duration::from_secs(20);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const MAX_SECRET_ATTEMPTS: u32 = 3;
/// Output not yet consumed by the terminal above which reading pauses, so a
/// flood of output cannot pile up in memory and Ctrl+C stays responsive.
const HIGH_WATER: usize = 1024 * 1024;
const TERM: &str = "xterm-256color";

pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    /// Empty means "ask".
    pub username: String,
    pub password: Option<String>,
    pub key: Option<KeyParams>,
    /// Script typed into the shell once it is up. Callers leave this empty
    /// when reconnecting, so a reconnection never runs anything by itself.
    pub startup: Option<String>,
    pub cols: u32,
    pub rows: u32,
}

pub struct KeyParams {
    pub id: Id,
    pub label: String,
    pub private_key: String,
    pub passphrase: Option<String>,
}

/// Everything a session produces.
#[derive(Debug)]
pub enum SessionOutput {
    Event(SessionEvent),
    /// Terminal output. Acknowledge consumed bytes with [`SessionHandle::ack`].
    Data(Vec<u8>),
    /// A secret the user asked to keep, raised only after it proved correct.
    Remember(Remember),
}

#[derive(Debug)]
pub enum Remember {
    Username(String),
    Password(String),
    Passphrase { key_id: Id, passphrase: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    Stage {
        stage: Stage,
    },
    Prompt {
        id: u64,
        prompt: Prompt,
    },
    Banner {
        text: String,
    },
    /// One step of the connection, for the connection log.
    Log {
        entry: LogEntry,
    },
    Connected,
    /// The public key is in the account's `authorized_keys`.
    KeyInstalled {
        /// It was there already; nothing was written.
        already_present: bool,
    },
    /// A fresh connection signed in with the new key alone.
    KeyVerified,
    Closed {
        reason: CloseReason,
        exit_status: Option<u32>,
        error: Option<ErrorInfo>,
    },
}

/// What happened at one step of connecting. The UI turns these into the
/// lines of its connection log, so a failure can be traced to its cause:
/// which address answered, which key the server showed, which ways of
/// signing in it offered, and what became of each attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum LogEntry {
    Connecting { host: String, port: u16 },
    /// The network connection is up; `address` is what the name resolved to.
    Reached { address: String },
    HostKey {
        algorithm: String,
        fingerprint: String,
        /// `trusted`, `new` or `changed`.
        status: &'static str,
    },
    HostKeyAccepted,
    /// The ways of signing in the server is willing to accept.
    AuthOffered { methods: Vec<String> },
    /// The server let the user in without any credentials.
    AuthNotRequired,
    /// A configured credential cannot be used: the server does not offer
    /// that way of signing in.
    AuthUnavailable { method: &'static str },
    AuthTrying {
        method: &'static str,
        /// For a key, its name.
        detail: Option<String>,
        /// The credential came from the vault rather than from a prompt.
        saved: bool,
    },
    AuthAccepted { method: &'static str },
    AuthRejected {
        method: &'static str,
        /// Accepted, but the server wants one more step (two-factor).
        partial: bool,
        remaining: Vec<String>,
    },
    /// Waiting for the user: `host_key`, `username`, `password`,
    /// `passphrase` or `answers`.
    Waiting { what: &'static str },
    ShellOpening,
    ShellReady,
}

fn method_names(methods: &MethodSet) -> Vec<String> {
    methods.iter().map(String::from).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Connecting,
    Handshake,
    Authenticating,
    OpeningShell,
    InstallingKey,
    VerifyingKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// The remote shell ended (for example the user typed `exit`), or a
    /// one-off task finished.
    Exited,
    /// Closed from this side.
    User,
    /// The connection was never established.
    Failed,
    /// An established connection dropped.
    Lost,
}

#[derive(Debug, Clone, Serialize)]
pub struct KnownKeyInfo {
    pub algorithm: String,
    pub fingerprint: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InteractivePrompt {
    pub prompt: String,
    pub echo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Prompt {
    /// The server key is new (`known` empty) or differs from the trusted one.
    HostKey {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
        known: Vec<KnownKeyInfo>,
    },
    Username,
    Password {
        username: String,
        attempt: u32,
    },
    KeyPassphrase {
        key_label: String,
        attempt: u32,
    },
    KeyboardInteractive {
        name: String,
        instructions: String,
        prompts: Vec<InteractivePrompt>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PromptReply {
    Cancel,
    /// Trust the presented host key.
    Accept,
    Text {
        value: String,
        #[serde(default)]
        remember: bool,
    },
    Answers {
        values: Vec<String>,
    },
}

enum Command {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct Shared {
    prompts: Mutex<HashMap<u64, oneshot::Sender<PromptReply>>>,
    next_prompt: AtomicU64,
    unacked: AtomicUsize,
    acked: Notify,
    /// The live connection, while the shell is up. Side channels (commands,
    /// file transfer) are opened on it.
    connection: Mutex<Option<Arc<client::Handle<Handler>>>>,
}

/// Output of a command run on a side channel.
#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.exit_status == Some(0)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

const EXEC_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

/// How busy the server is, read for advanced mode; it changes nothing.
/// Linux says it all in `/proc` (the processor is watched for a second);
/// elsewhere only the disk, the uptime and the load are found.
const STATS_PROBE: &str = r#"
if [ -r /proc/stat ]; then
  # The processor's share busy over one second, from its counters before and after.
  read_cpu() {
    set -- $(sed -n 's/^cpu  *//p' /proc/stat)
    idle=$(( $4 + ${5:-0} )); total=0
    for n in "$@"; do total=$(( total + n )); done
  }
  read_cpu; idle0=$idle; total0=$total
  sleep 1
  read_cpu
  [ $(( total - total0 )) -gt 0 ] && echo "cpu=$(( 1000 * (total - total0 - idle + idle0) / (total - total0) ))"
  echo "cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
  awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {if (t) print "mem=" t*1024 " " a*1024}' /proc/meminfo 2>/dev/null
  echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
  echo "load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
else
  boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ *sec = \([0-9]*\).*/\1/p')
  [ -n "$boot" ] && echo "uptime=$(( $(date +%s) - boot ))"
  echo "load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
fi
df -Pk / 2>/dev/null | awk 'NR == 2 {print "disk=" $2*1024 " " $4*1024}'
"#;

/// A reading of [`STATS_PROBE`]: whatever the server said, each part on its own.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct ServerStats {
    /// How busy the processor was over a second, all cores together, 0–100.
    pub cpu_percent: Option<f64>,
    pub cores: Option<u32>,
    pub mem_total: Option<u64>,
    pub mem_available: Option<u64>,
    /// The root filesystem, in bytes.
    pub disk_total: Option<u64>,
    pub disk_free: Option<u64>,
    pub uptime_secs: Option<u64>,
    pub load1: Option<f64>,
}

pub fn parse_stats(text: &str) -> ServerStats {
    let mut stats = ServerStats::default();
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else { continue };
        let numbers: Vec<&str> = value.split_whitespace().collect();
        let int = |i: usize| numbers.get(i).and_then(|n| n.parse::<u64>().ok());
        match key {
            // In tenths of a percent, as shell arithmetic has no fractions.
            "cpu" => stats.cpu_percent = int(0).map(|tenths| (tenths.min(1000) as f64) / 10.0),
            "cores" => stats.cores = int(0).and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0),
            "mem" => (stats.mem_total, stats.mem_available) = (int(0), int(1)),
            "disk" => (stats.disk_total, stats.disk_free) = (int(0), int(1)),
            "uptime" => {
                stats.uptime_secs = numbers.first().and_then(|n| n.parse::<f64>().ok()).map(|n| n as u64)
            }
            "load" => stats.load1 = numbers.first().and_then(|n| n.parse::<f64>().ok()),
            _ => {}
        }
    }
    stats
}

/// Reads what the system says about itself; changes nothing.
const OS_PROBE: &str = "cat /etc/os-release 2>/dev/null; echo; \
echo \"MYSSH_KERNEL=$(uname -s 2>/dev/null)\"; \
echo \"MYSSH_MACOS=$(sw_vers -productVersion 2>/dev/null)\"";

/// Makes sense of [`OS_PROBE`] output: `os-release` where there is one,
/// otherwise the kernel name.
pub fn parse_os(text: &str) -> Option<crate::model::HostOs> {
    let field = |key: &str| {
        text.lines()
            .filter_map(|line| line.trim().strip_prefix(key)?.strip_prefix('='))
            .map(|value| value.trim().trim_matches(|c| c == '"' || c == '\'').trim().to_string())
            .find(|value| !value.is_empty())
    };
    let tidy = |id: String| -> Option<String> {
        let id = id.to_lowercase();
        let plain = !id.is_empty()
            && id.len() <= 40
            && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        plain.then_some(id)
    };
    let name = |value: String| value.chars().filter(|c| !c.is_control()).take(80).collect::<String>();

    if let Some(id) = field("ID").and_then(tidy) {
        let family = field("ID_LIKE")
            .and_then(|like| like.split_whitespace().next().map(str::to_string))
            .and_then(tidy)
            .filter(|family| *family != id);
        let pretty = field("PRETTY_NAME").or_else(|| field("NAME")).unwrap_or_else(|| id.clone());
        return Some(crate::model::HostOs {
            id,
            family,
            name: name(pretty),
        });
    }
    let kernel = field("MYSSH_KERNEL")?;
    let (id, label) = match kernel.as_str() {
        "Darwin" => {
            let version = field("MYSSH_MACOS").map(|v| format!("macOS {v}"));
            ("macos", version.unwrap_or_else(|| "macOS".into()))
        }
        "Linux" => ("linux", "Linux".to_string()),
        "FreeBSD" => ("freebsd", "FreeBSD".to_string()),
        "OpenBSD" => ("openbsd", "OpenBSD".to_string()),
        "NetBSD" => ("netbsd", "NetBSD".to_string()),
        "SunOS" => ("sunos", "SunOS".to_string()),
        _ => return None,
    };
    Some(crate::model::HostOs {
        id: id.to_string(),
        family: None,
        name: name(label),
    })
}

/// Finds the working directory of the session's terminal from a side
/// channel, without typing anything into the terminal itself.
///
/// The side channel's shell and the terminal's shell descend from the same
/// per-connection server process. The script looks, among that process's
/// children, for the one that owns a terminal, prefers that terminal's
/// foreground job (a nested shell, say) and reads its working directory.
/// On Linux everything comes from `/proc`, so it works on minimal systems
/// too; elsewhere `ps` and `lsof` are used.
const CWD_PROBE: &str = r#"
found() { case "$1" in /*) printf '%s\n' "$1"; exit 0 ;; esac; }

if [ -r /proc/self/stat ]; then
  ancestor=$PPID
  for level in 1 2 3; do
    shell=; job=
    for stat in /proc/[0-9]*/stat; do
      read -r line < "$stat" 2>/dev/null || continue
      pid=${stat#/proc/}; pid=${pid%/stat}
      # After the command name: state ppid pgrp session tty tpgid ...
      set -- ${line##*) }
      if [ "$2" = "$ancestor" ] && [ "$pid" != "$$" ] && [ "$5" != "0" ]; then
        shell=$pid; job=$6
      fi
    done
    if [ -n "$shell" ]; then
      for pid in "$job" "$shell"; do
        [ "${pid:-0}" -gt 0 ] 2>/dev/null || continue
        found "$(readlink "/proc/$pid/cwd" 2>/dev/null)"
      done
      exit 1
    fi
    # The login shell may sit between us and the server process.
    read -r line < "/proc/$ancestor/stat" 2>/dev/null || break
    set -- ${line##*) }
    ancestor=$2
    [ "${ancestor:-0}" -gt 1 ] 2>/dev/null || break
  done
  exit 1
fi

parent=$PPID
grandparent=$(ps -o ppid= -p "$parent" 2>/dev/null | tr -d ' ')
for pid in $(ps -axo pid=,ppid=,pgid=,tpgid=,tty= 2>/dev/null | awk -v p="$parent" -v g="$grandparent" -v me="$$" '
  { pid[NR]=$1; ppid[NR]=$2; tpgid[NR]=$4; tty[NR]=$5 }
  function scan(anc,   i) {
    for (i = 1; i <= NR; i++)
      if (ppid[i] == anc && pid[i] != me && pid[i] != p && tty[i] != "?" && tty[i] != "??" && tty[i] != "-") { sh = pid[i]; fg = tpgid[i] }
  }
  END {
    scan(p)
    if (sh == "" && g != "" && g > 1) scan(g)
    if (sh == "") exit 1
    if (fg != "" && fg != sh && fg > 0) print fg
    print sh
  }'); do
  found "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
done
exit 1
"#;

/// Control side of a running session. Dropping it closes the session.
pub struct SessionHandle {
    commands: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
}

impl SessionHandle {
    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .map_err(|_| Error::SessionClosed)
    }

    pub fn write(&self, data: Vec<u8>) -> Result<()> {
        self.send(Command::Write(data))
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.send(Command::Resize(cols, rows))
    }

    pub fn close(&self) {
        let _ = self.send(Command::Close);
    }

    /// Answers a pending [`Prompt`].
    pub fn reply(&self, prompt_id: u64, reply: PromptReply) -> Result<()> {
        let waiter = self
            .shared
            .prompts
            .lock()
            .unwrap()
            .remove(&prompt_id)
            .ok_or(Error::NotFound("prompt"))?;
        waiter.send(reply).map_err(|_| Error::SessionClosed)
    }

    fn connection(&self) -> Result<Arc<client::Handle<Handler>>> {
        self.shared
            .connection
            .lock()
            .unwrap()
            .clone()
            .ok_or(Error::SessionClosed)
    }

    /// Runs a command on a separate channel of this session's connection.
    /// The terminal is not involved and sees nothing of it.
    pub async fn exec(&self, command: &str, limit: Duration) -> Result<ExecOutput> {
        let connection = self.connection()?;
        timeout(limit, exec_on(&connection, command, None))
            .await
            .map_err(|_| Error::Timeout)?
    }

    /// Runs a POSIX shell script on a separate channel, whatever the
    /// account's login shell is.
    async fn script(&self, script: &str, limit: Duration) -> Result<ExecOutput> {
        let connection = self.connection()?;
        timeout(limit, run_script(&connection, script))
            .await
            .map_err(|_| Error::Timeout)?
    }

    /// The terminal's current working directory on the server, if it can be
    /// determined. `None` is an ordinary outcome, not an error.
    pub async fn working_directory(&self) -> Result<Option<String>> {
        let output = self.script(CWD_PROBE, Duration::from_secs(8)).await?;
        let dir = output.stdout_text();
        let dir = dir.lines().next().unwrap_or("").trim();
        Ok((output.success() && dir.starts_with('/')).then(|| dir.to_string()))
    }

    /// How busy the server is, for advanced mode, on a side channel.
    pub async fn server_stats(&self) -> Result<ServerStats> {
        let output = self.script(STATS_PROBE, Duration::from_secs(8)).await?;
        Ok(parse_stats(&output.stdout_text()))
    }

    /// The name of the account's login shell (`bash`, `zsh`…), on a side
    /// channel. `None` when the server does not say.
    pub async fn login_shell(&self) -> Result<Option<String>> {
        let output = self.script("printf '%s\\n' \"${SHELL:-}\"", Duration::from_secs(8)).await?;
        let path = output.stdout_text();
        let name = path.lines().next().unwrap_or("").trim().rsplit('/').next().unwrap_or("").to_string();
        let plain = !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
        Ok(plain.then_some(name))
    }

    /// Asks the server which operating system it runs, on a side channel.
    /// `None` when it does not say in a form we understand.
    pub async fn detect_os(&self) -> Result<Option<crate::model::HostOs>> {
        let output = self.script(OS_PROBE, Duration::from_secs(8)).await?;
        Ok(parse_os(&output.stdout_text()))
    }

    /// Opens a file transfer channel on this session's connection. No new
    /// login happens: it rides on the connection the terminal already has.
    pub async fn open_sftp(&self) -> Result<crate::sftp::Sftp> {
        let connection = self.connection()?;
        timeout(SHELL_TIMEOUT, async {
            let channel = connection.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            crate::sftp::Sftp::start(channel.into_stream()).await
        })
        .await
        .map_err(|_| Error::Timeout)?
    }

    /// Reports that the terminal has consumed `bytes` of output.
    pub fn ack(&self, bytes: usize) {
        let _ = self
            .shared
            .unacked
            .try_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.saturating_sub(bytes))
            });
        self.shared.acked.notify_one();
    }
}

#[derive(Clone)]
struct Io {
    out: mpsc::UnboundedSender<SessionOutput>,
    shared: Arc<Shared>,
    /// Someone is there to answer prompts. A quiet look at a server (its
    /// load, for advanced mode) has nobody: whatever would need asking ends
    /// the attempt instead, so nothing is ever trusted or tried unasked.
    interactive: bool,
}

impl Io {
    fn event(&self, event: SessionEvent) {
        let _ = self.out.send(SessionOutput::Event(event));
    }

    fn stage(&self, stage: Stage) {
        self.event(SessionEvent::Stage { stage });
    }

    fn log(&self, entry: LogEntry) {
        self.event(SessionEvent::Log { entry });
    }

    fn remember(&self, secret: Remember) {
        let _ = self.out.send(SessionOutput::Remember(secret));
    }

    fn data(&self, data: Vec<u8>) {
        self.shared.unacked.fetch_add(data.len(), Ordering::AcqRel);
        let _ = self.out.send(SessionOutput::Data(data));
    }

    /// Raises a prompt and waits for its reply. A cancelled or abandoned
    /// prompt is [`Error::Cancelled`].
    async fn ask(&self, prompt: Prompt) -> Result<PromptReply> {
        if !self.interactive {
            return Err(Error::Cancelled);
        }
        self.log(LogEntry::Waiting {
            what: match &prompt {
                Prompt::HostKey { .. } => "host_key",
                Prompt::Username => "username",
                Prompt::Password { .. } => "password",
                Prompt::KeyPassphrase { .. } => "passphrase",
                Prompt::KeyboardInteractive { .. } => "answers",
            },
        });
        let id = self.shared.next_prompt.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.shared.prompts.lock().unwrap().insert(id, tx);
        self.event(SessionEvent::Prompt { id, prompt });
        match rx.await {
            Ok(PromptReply::Cancel) | Err(_) => Err(Error::Cancelled),
            Ok(reply) => Ok(reply),
        }
    }
}

/// A quiet look at a server for advanced mode: connects with what the host
/// has saved, reads how busy it is, and leaves. Nothing is asked of anyone:
/// a server whose key is not trusted yet, or that wants a password or a
/// passphrase not saved, ends it with an error, and so does a slow one.
pub async fn probe_stats(params: ConnectParams, known_hosts: Arc<Mutex<KnownHosts>>) -> Result<ServerStats> {
    let (out, _dropped) = mpsc::unbounded_channel();
    let io = Io {
        out,
        shared: Arc::new(Shared {
            prompts: Mutex::new(HashMap::new()),
            next_prompt: AtomicU64::new(1),
            unacked: AtomicUsize::new(0),
            acked: Notify::new(),
            connection: Mutex::new(None),
        }),
        interactive: false,
    };
    let look = async {
        let (handle, _) = establish(&params, known_hosts, &io).await?;
        let output = run_script(&handle, STATS_PROBE).await;
        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        Ok::<_, Error>(parse_stats(&output?.stdout_text()))
    };
    timeout(Duration::from_secs(20), look).await.map_err(|_| Error::Timeout)?
}

/// Starts a session. Must be called from within a Tokio runtime.
pub fn spawn(
    params: ConnectParams,
    known_hosts: Arc<Mutex<KnownHosts>>,
    out: mpsc::UnboundedSender<SessionOutput>,
) -> SessionHandle {
    let (commands, command_rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared {
        prompts: Mutex::new(HashMap::new()),
        next_prompt: AtomicU64::new(1),
        unacked: AtomicUsize::new(0),
        acked: Notify::new(),
        connection: Mutex::new(None),
    });
    let io = Io {
        out,
        shared: shared.clone(),
        interactive: true,
    };
    tokio::spawn(run(params, known_hosts, io, command_rx));
    SessionHandle { commands, shared }
}

enum Ended {
    Exited(Option<u32>),
    ByUser,
    Lost,
}

async fn run(
    params: ConnectParams,
    known_hosts: Arc<Mutex<KnownHosts>>,
    io: Io,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    let mut connected = false;
    let outcome = drive(&params, known_hosts, &io, &mut commands, &mut connected).await;
    let (reason, exit_status, error) = match outcome {
        Ok(Ended::Exited(status)) => (CloseReason::Exited, status, None),
        Ok(Ended::ByUser) | Err(Error::Cancelled) => (CloseReason::User, None, None),
        Ok(Ended::Lost) => (CloseReason::Lost, None, None),
        Err(e) if connected => (CloseReason::Lost, None, Some(e.info())),
        Err(e) => (CloseReason::Failed, None, Some(e.info())),
    };
    // Nobody is left to answer prompts.
    io.shared.prompts.lock().unwrap().clear();
    io.event(SessionEvent::Closed {
        reason,
        exit_status,
        error,
    });
}

async fn drive(
    params: &ConnectParams,
    known_hosts: Arc<Mutex<KnownHosts>>,
    io: &Io,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    connected: &mut bool,
) -> Result<Ended> {
    let mut size = (params.cols, params.rows);

    // While connecting, stay responsive to a close request and keep track of
    // the latest window size; input typed this early is dropped.
    let handle = {
        let establish = establish(params, known_hosts, io);
        tokio::pin!(establish);
        loop {
            tokio::select! {
                result = &mut establish => break result?.0,
                command = commands.recv() => match command {
                    None | Some(Command::Close) => return Err(Error::Cancelled),
                    Some(Command::Resize(cols, rows)) => size = (cols, rows),
                    Some(Command::Write(_)) => {}
                },
            }
        }
    };

    let handle = Arc::new(handle);
    io.stage(Stage::OpeningShell);
    io.log(LogEntry::ShellOpening);
    let mut channel = timeout(SHELL_TIMEOUT, open_shell(&handle, size))
        .await
        .map_err(|_| Error::Timeout)??;
    io.log(LogEntry::ShellReady);

    *connected = true;
    *io.shared.connection.lock().unwrap() = Some(handle.clone());
    io.event(SessionEvent::Connected);
    let ended = pump(&mut channel, io, commands, params.startup.as_deref().map(typed)).await;
    *io.shared.connection.lock().unwrap() = None;
    let _ = handle
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;
    ended
}

/// A script as it would be typed: every line ends with Enter.
fn typed(script: &str) -> Vec<u8> {
    let mut text = script.replace("\r\n", "\n").replace('\n', "\r");
    if !text.ends_with('\r') {
        text.push('\r');
    }
    text.into_bytes()
}

/// Runs a POSIX shell script on a side channel.
///
/// The script is fed to `sh` on its standard input rather than passed as a
/// command line, so it does not matter which shell the account logs in
/// with (fish and csh do not speak this syntax) and nothing needs quoting.
async fn run_script(connection: &client::Handle<Handler>, script: &str) -> Result<ExecOutput> {
    exec_on(connection, "sh", Some(script.as_bytes())).await
}

async fn exec_on(
    connection: &client::Handle<Handler>,
    command: &str,
    stdin: Option<&[u8]>,
) -> Result<ExecOutput> {
    let mut channel = connection.channel_open_session().await?;
    channel.exec(true, command).await?;
    if let Some(input) = stdin {
        channel.data(input).await?;
        channel.eof().await?;
    }
    let mut output = ExecOutput::default();
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => output.stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext: 1 } => output.stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => output.exit_status = Some(exit_status),
            ChannelMsg::Failure => return Err(Error::Connect("the server refused to run the command".into())),
            ChannelMsg::Close => break,
            _ => {}
        }
        if output.stdout.len() + output.stderr.len() > EXEC_OUTPUT_LIMIT {
            let _ = channel.close().await;
            return Err(Error::Invalid("the command produced too much output".into()));
        }
    }
    Ok(output)
}

/// Connects and completes the SSH handshake, including the host key check.
async fn open_transport(
    host: &str,
    port: u16,
    known_hosts: Arc<Mutex<KnownHosts>>,
    io: &Io,
) -> Result<client::Handle<Handler>> {
    io.log(LogEntry::Connecting {
        host: host.to_string(),
        port,
    });
    let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|e| Error::Connect(e.to_string()))?;
    let _ = stream.set_nodelay(true);
    if let Ok(peer) = stream.peer_addr() {
        io.log(LogEntry::Reached {
            address: peer.to_string(),
        });
    }

    io.stage(Stage::Handshake);
    let config = Arc::new(client::Config {
        client_id: SshId::Standard(Cow::Borrowed(concat!(
            "SSH-2.0-MySSH_",
            env!("CARGO_PKG_VERSION")
        ))),
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: 3,
        ..Default::default()
    });
    let handler = Handler {
        host: host.to_string(),
        port,
        known_hosts,
        io: io.clone(),
    };
    client::connect_stream(config, stream, handler).await
}

/// Connects and signs in. Returns the connection and the user name that
/// was accepted (it may have been asked for).
async fn establish(
    params: &ConnectParams,
    known_hosts: Arc<Mutex<KnownHosts>>,
    io: &Io,
) -> Result<(client::Handle<Handler>, String)> {
    io.stage(Stage::Connecting);
    let mut handle = open_transport(&params.host, params.port, known_hosts, io).await?;
    io.stage(Stage::Authenticating);
    let username = authenticate(&mut handle, params, io).await?;
    Ok((handle, username))
}

struct Handler {
    host: String,
    port: u16,
    known_hosts: Arc<Mutex<KnownHosts>>,
    io: Io,
}

impl client::Handler for Handler {
    type Error = Error;

    async fn check_server_key(&mut self, presented: &PublicKeyOrCertificate) -> Result<bool> {
        // A host certificate is pinned by the key it certifies; certificate
        // authorities are not consulted.
        let key = match presented {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let status = self
            .known_hosts
            .lock()
            .unwrap()
            .check(&self.host, self.port, &key)?;
        let log = |status| {
            self.io.log(LogEntry::HostKey {
                algorithm: key.algorithm().as_str().to_string(),
                fingerprint: keys::fingerprint(&key),
                status,
            })
        };
        let known = match status {
            HostKeyStatus::Trusted => {
                log("trusted");
                return Ok(true);
            }
            HostKeyStatus::Unknown => {
                log("new");
                Vec::new()
            }
            HostKeyStatus::Changed(known) => {
                log("changed");
                known
            }
        };
        let prompt = Prompt::HostKey {
            host: self.host.clone(),
            port: self.port,
            algorithm: key.algorithm().as_str().to_string(),
            fingerprint: keys::fingerprint(&key),
            known: known
                .into_iter()
                .map(|k| KnownKeyInfo {
                    algorithm: k.algorithm,
                    fingerprint: k.fingerprint,
                    added_at: k.added_at,
                })
                .collect(),
        };
        match self.io.ask(prompt).await {
            Ok(PromptReply::Accept) => {
                self.known_hosts
                    .lock()
                    .unwrap()
                    .trust(&self.host, self.port, &key)?;
                self.io.log(LogEntry::HostKeyAccepted);
                Ok(true)
            }
            _ => Err(Error::HostKeyRejected),
        }
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<()> {
        self.io.event(SessionEvent::Banner {
            text: banner.to_string(),
        });
        Ok(())
    }
}

fn remaining(result: AuthResult) -> Option<MethodSet> {
    match result {
        AuthResult::Success => None,
        AuthResult::Failure {
            remaining_methods, ..
        } => Some(remaining_methods),
    }
}

async fn authenticate(
    handle: &mut client::Handle<Handler>,
    params: &ConnectParams,
    io: &Io,
) -> Result<String> {
    let mut username = params.username.trim().to_string();
    if username.is_empty() {
        username = match io.ask(Prompt::Username).await? {
            PromptReply::Text { value, remember } if !value.trim().is_empty() => {
                let value = value.trim().to_string();
                if remember {
                    io.remember(Remember::Username(value.clone()));
                }
                value
            }
            _ => return Err(Error::Cancelled),
        };
    }

    // Learn which methods the server accepts (and let through the rare
    // server that wants no authentication at all).
    let Some(mut methods) = remaining(handle.authenticate_none(&username).await?) else {
        io.log(LogEntry::AuthNotRequired);
        return Ok(username);
    };
    io.log(LogEntry::AuthOffered {
        methods: method_names(&methods),
    });

    // Reports the server's verdict on an attempt; `None` means "signed in".
    let verdict = |method: &'static str, result: AuthResult| -> Option<MethodSet> {
        match result {
            AuthResult::Success => {
                io.log(LogEntry::AuthAccepted { method });
                None
            }
            AuthResult::Failure {
                remaining_methods,
                partial_success,
            } => {
                io.log(LogEntry::AuthRejected {
                    method,
                    partial: partial_success,
                    remaining: method_names(&remaining_methods),
                });
                Some(remaining_methods)
            }
        }
    };

    if let Some(key) = &params.key {
        if methods.contains(&MethodKind::PublicKey) {
            let private = load_key(key, io).await?;
            io.log(LogEntry::AuthTrying {
                method: "publickey",
                detail: Some(format!("{} ({})", key.label, private.algorithm().as_str())),
                saved: true,
            });
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            let signer = PrivateKeyWithHashAlg::new(Arc::new(private), hash);
            let result = handle.authenticate_publickey(&username, signer).await?;
            match verdict("publickey", result) {
                None => return Ok(username),
                Some(left) => methods = left,
            }
        } else {
            io.log(LogEntry::AuthUnavailable { method: "publickey" });
        }
    }

    if let Some(password) = &params.password {
        let attempt = if methods.contains(&MethodKind::Password) {
            io.log(LogEntry::AuthTrying {
                method: "password",
                detail: None,
                saved: true,
            });
            let result = handle.authenticate_password(&username, password).await?;
            Some(("password", result))
        } else if methods.contains(&MethodKind::KeyboardInteractive) {
            io.log(LogEntry::AuthTrying {
                method: "keyboard-interactive",
                detail: None,
                saved: true,
            });
            let result = keyboard_interactive(handle, &username, io, Some(password)).await?;
            Some(("keyboard-interactive", result))
        } else {
            io.log(LogEntry::AuthUnavailable { method: "password" });
            None
        };
        if let Some((method, result)) = attempt {
            match verdict(method, result) {
                None => return Ok(username),
                Some(left) => methods = left,
            }
        }
    }

    for attempt in 1..=MAX_SECRET_ATTEMPTS {
        let (method, result) = if methods.contains(&MethodKind::Password) {
            let prompt = Prompt::Password {
                username: username.clone(),
                attempt,
            };
            let PromptReply::Text { value, remember } = io.ask(prompt).await? else {
                return Err(Error::Cancelled);
            };
            io.log(LogEntry::AuthTrying {
                method: "password",
                detail: None,
                saved: false,
            });
            let result = handle.authenticate_password(&username, &value).await?;
            if result.success() && remember {
                io.remember(Remember::Password(value));
            }
            ("password", result)
        } else if methods.contains(&MethodKind::KeyboardInteractive) {
            io.log(LogEntry::AuthTrying {
                method: "keyboard-interactive",
                detail: None,
                saved: false,
            });
            let result = keyboard_interactive(handle, &username, io, None).await?;
            ("keyboard-interactive", result)
        } else {
            break;
        };
        match verdict(method, result) {
            None => return Ok(username),
            Some(left) => methods = left,
        }
    }
    Err(Error::AuthFailed)
}

/// Runs one keyboard-interactive exchange. A saved password answers a lone
/// hidden question once; everything else goes to the user.
async fn keyboard_interactive(
    handle: &mut client::Handle<Handler>,
    username: &str,
    io: &Io,
    mut saved_password: Option<&str>,
) -> Result<AuthResult> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None::<String>)
        .await?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(AuthResult::Success),
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                partial_success,
            } => {
                return Ok(AuthResult::Failure {
                    remaining_methods,
                    partial_success,
                })
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let lone_hidden = prompts.len() == 1 && !prompts[0].echo;
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if let (true, Some(password)) = (lone_hidden, saved_password.take()) {
                    vec![password.to_string()]
                } else {
                    let expected = prompts.len();
                    let prompt = Prompt::KeyboardInteractive {
                        name,
                        instructions,
                        prompts: prompts
                            .into_iter()
                            .map(|p| InteractivePrompt {
                                prompt: p.prompt,
                                echo: p.echo,
                            })
                            .collect(),
                    };
                    match io.ask(prompt).await? {
                        PromptReply::Answers { values } if values.len() == expected => values,
                        _ => return Err(Error::Cancelled),
                    }
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}

/// Key decryption runs a deliberately slow KDF, so it stays off the async
/// threads.
async fn decrypt_key(text: &str, passphrase: Option<&str>) -> Result<PrivateKey> {
    let text = text.to_string();
    let passphrase = passphrase.map(str::to_string);
    tokio::task::spawn_blocking(move || keys::decrypt(&text, passphrase.as_deref()))
        .await
        .map_err(|e| Error::Key(e.to_string()))?
}

async fn load_key(key: &KeyParams, io: &Io) -> Result<PrivateKey> {
    match decrypt_key(&key.private_key, key.passphrase.as_deref()).await {
        Ok(private) => return Ok(private),
        Err(Error::KeyEncrypted) => {}
        // A saved passphrase that no longer works: ask for the right one.
        Err(Error::Key(_)) if key.passphrase.is_some() => {}
        Err(e) => return Err(e),
    }
    for attempt in 1..=MAX_SECRET_ATTEMPTS {
        let prompt = Prompt::KeyPassphrase {
            key_label: key.label.clone(),
            attempt,
        };
        let PromptReply::Text { value, remember } = io.ask(prompt).await? else {
            return Err(Error::Cancelled);
        };
        match decrypt_key(&key.private_key, Some(&value)).await {
            Ok(private) => {
                if remember {
                    io.remember(Remember::Passphrase {
                        key_id: key.id,
                        passphrase: value,
                    });
                }
                return Ok(private);
            }
            Err(Error::Key(_)) | Err(Error::KeyEncrypted) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(Error::Key("the passphrase is wrong".into()))
}

async fn open_shell(
    handle: &client::Handle<Handler>,
    (cols, rows): (u32, u32),
) -> Result<Channel<client::Msg>> {
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, TERM, cols.max(1), rows.max(1), 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    Ok(channel)
}

/// How long the shell's first output has to pause before the startup snippet
/// is typed, and how long to wait for any output at all.
const STARTUP_SETTLE: Duration = Duration::from_millis(300);
const STARTUP_WAIT: Duration = Duration::from_secs(3);

/// Moves the terminal's input and output until the session ends. `startup`
/// is typed once the shell is listening: when its first output (the
/// greeting, the prompt) has paused, or after a few seconds of none. Typed
/// at once, it can be lost: Tailscale SSH drops what arrives before the
/// shell has started.
async fn pump(
    channel: &mut Channel<client::Msg>,
    io: &Io,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    mut startup: Option<Vec<u8>>,
) -> Result<Ended> {
    let mut exit_status = None;
    let opened = tokio::time::Instant::now();
    let mut heard: Option<tokio::time::Instant> = None;
    loop {
        let paused = io.shared.unacked.load(Ordering::Acquire) > HIGH_WATER;
        let type_at = heard.map_or(opened + STARTUP_WAIT, |at| (at + STARTUP_SETTLE).min(opened + STARTUP_WAIT));
        tokio::select! {
            _ = tokio::time::sleep_until(type_at), if startup.is_some() => {
                if let Some(script) = startup.take() {
                    channel.data(&script[..]).await?;
                }
            }
            command = commands.recv() => match command {
                None | Some(Command::Close) => return Ok(Ended::ByUser),
                Some(Command::Write(data)) => channel.data(&data[..]).await?,
                Some(Command::Resize(cols, rows)) => {
                    channel.window_change(cols.max(1), rows.max(1), 0, 0).await?
                }
            },
            _ = io.shared.acked.notified(), if paused => {}
            message = channel.wait(), if !paused => match message {
                Some(ChannelMsg::Data { data }) => {
                    heard = Some(tokio::time::Instant::now());
                    io.data(data.to_vec());
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    heard = Some(tokio::time::Instant::now());
                    io.data(data.to_vec());
                }
                Some(ChannelMsg::ExitStatus { exit_status: status }) => exit_status = Some(status),
                Some(ChannelMsg::Close) => return Ok(Ended::Exited(exit_status)),
                Some(_) => {}
                None => {
                    return Ok(match exit_status {
                        Some(_) => Ended::Exited(exit_status),
                        None => Ended::Lost,
                    })
                }
            },
        }
    }
}

#[cfg(test)]
mod os_tests {
    use super::parse_os;

    fn os(text: &str) -> Option<(String, Option<String>, String)> {
        parse_os(text).map(|os| (os.id, os.family, os.name))
    }

    #[test]
    fn reads_os_release_and_falls_back_to_the_kernel() {
        let ubuntu = "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nID_LIKE=debian\n\nMYSSH_KERNEL=Linux\nMYSSH_MACOS=\n";
        assert_eq!(
            os(ubuntu),
            Some(("ubuntu".into(), Some("debian".into()), "Ubuntu 24.04.1 LTS".into()))
        );
        let debian = "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nID=debian\nMYSSH_KERNEL=Linux\n";
        assert_eq!(
            os(debian),
            Some(("debian".into(), None, "Debian GNU/Linux 12 (bookworm)".into()))
        );
        let rocky = "NAME=\"Rocky Linux\"\nID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\nPRETTY_NAME=\"Rocky Linux 9.4 (Blue Onyx)\"\n";
        assert_eq!(
            os(rocky),
            Some(("rocky".into(), Some("rhel".into()), "Rocky Linux 9.4 (Blue Onyx)".into()))
        );
        let alpine = "NAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME=\"Alpine Linux v3.20\"\n";
        assert_eq!(os(alpine).unwrap().0, "alpine");
        // No PRETTY_NAME: the plain name will do.
        assert_eq!(os("ID=arch\nNAME='Arch Linux'\n").unwrap().2, "Arch Linux");

        assert_eq!(
            os("\nMYSSH_KERNEL=Darwin\nMYSSH_MACOS=15.1\n"),
            Some(("macos".into(), None, "macOS 15.1".into()))
        );
        assert_eq!(os("\nMYSSH_KERNEL=FreeBSD\nMYSSH_MACOS=\n").unwrap().0, "freebsd");
        assert_eq!(os("\nMYSSH_KERNEL=Linux\n").unwrap().2, "Linux");

        // Nothing usable, or something that is not an identifier.
        assert_eq!(os(""), None);
        assert_eq!(os("\nMYSSH_KERNEL=\nMYSSH_MACOS=\n"), None);
        assert_eq!(os("MYSSH_KERNEL=Plan9\n"), None);
        assert_eq!(os("ID=\"$(rm -rf /)\"\nMYSSH_KERNEL=Linux\n").unwrap().0, "linux");
    }

    #[test]
    fn server_stats_are_read_part_by_part() {
        use super::{parse_stats, ServerStats};
        let linux = "cpu=125\ncores=4\nmem=8000000000 5000000000\nuptime=3600.52\nload=0.08\ndisk=80000000000 31000000000\n";
        assert_eq!(
            parse_stats(linux),
            ServerStats {
                cpu_percent: Some(12.5),
                cores: Some(4),
                mem_total: Some(8_000_000_000),
                mem_available: Some(5_000_000_000),
                disk_total: Some(80_000_000_000),
                disk_free: Some(31_000_000_000),
                uptime_secs: Some(3600),
                load1: Some(0.08),
            }
        );
        // A BSD says less; what it does not say stays unknown.
        let bsd = parse_stats("uptime=86400\nload=\ndisk=100 50\n");
        assert_eq!((bsd.uptime_secs, bsd.load1, bsd.cpu_percent, bsd.disk_free), (Some(86400), None, None, Some(50)));
        assert_eq!(parse_stats("garbage\n=\ncpu=x y\n"), ServerStats::default());
        assert_eq!(parse_stats("cpu=4000\n").cpu_percent, Some(100.0));
    }
}
