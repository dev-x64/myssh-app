//! End-to-end session tests against a real OpenSSH server.
//!
//! Each test starts a private `sshd` as the current user on a loopback port,
//! so only public key authentication is exercised here. The tests skip
//! themselves where `/usr/sbin/sshd` is not available.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use myssh_core::keys::{self, KeyKind};
use myssh_core::known_hosts::KnownHosts;
use myssh_core::model::SshKey;
use myssh_core::ssh::{
    self, CloseReason, ConnectParams, InstallParams, KeyParams, LogEntry, Prompt, PromptReply,
    SessionEvent, SessionHandle, SessionOutput, Stage,
};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::timeout;

const SSHD: &str = "/usr/sbin/sshd";
const WAIT: Duration = Duration::from_secs(20);

struct Server {
    dir: tempfile::TempDir,
    port: u16,
    child: Option<Child>,
}

impl Server {
    /// Starts sshd accepting `client` keys. `None` if sshd is unavailable.
    fn start(client: &[&SshKey]) -> Option<Server> {
        if !Path::new(SSHD).exists() {
            eprintln!("skipping: {SSHD} not found");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let authorized: String = client
            .iter()
            .map(|k| format!("{}\n", k.public_key))
            .collect();
        // Sessions get a private home directory, so nothing a test does can
        // reach the real one.
        std::fs::create_dir_all(dir.path().join("home/.ssh")).unwrap();
        std::fs::write(dir.path().join("home/.ssh/authorized_keys"), authorized).unwrap();
        let mut server = Server {
            dir,
            port,
            child: None,
        };
        server.new_host_key();
        server.launch();
        Some(server)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn new_host_key(&self) {
        let key = self.path("host_key");
        let _ = std::fs::remove_file(&key);
        let _ = std::fs::remove_file(self.path("host_key.pub"));
        let status = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn launch(&mut self) {
        let config = format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {host_key}\nPidFile {pid}\n\
             AuthorizedKeysFile {auth}\nStrictModes no\nUsePAM no\n\
             PasswordAuthentication no\nKbdInteractiveAuthentication no\n\
             PubkeyAuthentication yes\nSubsystem sftp internal-sftp\n",
            port = self.port,
            host_key = self.path("host_key").display(),
            pid = self.path("sshd.pid").display(),
            auth = self.path("home/.ssh/authorized_keys").display(),
        ) + &format!("SetEnv HOME={}\n", self.path("home").display());
        std::fs::write(self.path("sshd_config"), config).unwrap();
        let child = Command::new(SSHD)
            .arg("-D")
            .arg("-e")
            .arg("-f")
            .arg(self.path("sshd_config"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        self.child = Some(child);
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("sshd did not start listening");
    }

    /// Starts sshd again with whatever `sshd_config` now says.
    fn relaunch(&mut self) {
        let child = Command::new(SSHD)
            .arg("-D")
            .arg("-e")
            .arg("-f")
            .arg(self.path("sshd_config"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        self.child = Some(child);
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("sshd did not start listening");
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Restarts sshd under a brand new host key.
    fn rotate_host_key(&mut self) {
        self.stop();
        self.new_host_key();
        self.launch();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Client {
    handle: SessionHandle,
    out: UnboundedReceiver<SessionOutput>,
    screen: Vec<u8>,
    /// The connection log so far.
    log: Vec<LogEntry>,
}

impl Client {
    fn connect(server: &Server, known: &Arc<Mutex<KnownHosts>>, key: Option<&SshKey>) -> Client {
        let (tx, out) = mpsc::unbounded_channel();
        let params = ConnectParams {
            host: "127.0.0.1".into(),
            port: server.port,
            username: std::env::var("USER").unwrap(),
            password: None,
            key: key.map(|k| KeyParams {
                id: k.id,
                label: k.label.clone(),
                private_key: k.private_key.clone(),
                passphrase: k.passphrase.clone(),
            }),
            startup: None,
            cols: 80,
            rows: 24,
        };
        Client {
            handle: ssh::spawn(params, known.clone(), tx),
            out,
            screen: Vec::new(),
            log: Vec::new(),
        }
    }

    /// Next event, collecting terminal output on the way.
    async fn event(&mut self) -> SessionEvent {
        loop {
            match timeout(WAIT, self.out.recv()).await {
                Ok(Some(SessionOutput::Event(event))) => return event,
                Ok(Some(SessionOutput::Data(data))) => {
                    self.handle.ack(data.len());
                    self.screen.extend(data);
                }
                Ok(Some(SessionOutput::Remember(_))) => {}
                Ok(None) => panic!("session ended without a Closed event"),
                Err(_) => panic!("timed out waiting for a session event"),
            }
        }
    }

    /// Skips progress events until something that needs a reaction.
    async fn milestone(&mut self) -> SessionEvent {
        loop {
            match self.event().await {
                SessionEvent::Stage { .. } | SessionEvent::Banner { .. } => continue,
                SessionEvent::Log { entry } => self.log.push(entry),
                other => return other,
            }
        }
    }

    async fn screen_contains(&mut self, needle: &str) {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if String::from_utf8_lossy(&self.screen).contains(needle) {
                return;
            }
            match tokio::time::timeout_at(deadline, self.out.recv()).await {
                Ok(Some(SessionOutput::Data(data))) => {
                    self.handle.ack(data.len());
                    self.screen.extend(data);
                }
                Ok(Some(SessionOutput::Event(SessionEvent::Closed { .. }))) | Ok(None) => {
                    panic!("session closed while waiting for {needle:?}")
                }
                Ok(Some(_)) => {}
                Err(_) => panic!(
                    "{needle:?} never appeared; screen: {}",
                    String::from_utf8_lossy(&self.screen)
                ),
            }
        }
    }

    fn type_line(&self, line: &str) {
        self.handle.write(format!("{line}\n").into_bytes()).unwrap();
    }
}

/// A log entry as a short word, for comparing sequences.
fn brief(entry: &LogEntry) -> String {
    match entry {
        LogEntry::Connecting { .. } => "connecting".into(),
        LogEntry::Reached { .. } => "reached".into(),
        LogEntry::HostKey { status, .. } => format!("host_key:{status}"),
        LogEntry::HostKeyAccepted => "host_key_accepted".into(),
        LogEntry::AuthOffered { .. } => "offered".into(),
        LogEntry::AuthNotRequired => "not_required".into(),
        LogEntry::AuthUnavailable { method } => format!("unavailable:{method}"),
        LogEntry::AuthTrying { method, saved, .. } => {
            format!("try:{method}:{}", if *saved { "saved" } else { "typed" })
        }
        LogEntry::AuthAccepted { method } => format!("accepted:{method}"),
        LogEntry::AuthRejected { method, partial, .. } => {
            format!("rejected:{method}{}", if *partial { ":partial" } else { "" })
        }
        LogEntry::Waiting { what } => format!("waiting:{what}"),
        LogEntry::ShellOpening => "shell_opening".into(),
        LogEntry::ShellReady => "shell_ready".into(),
    }
}

fn known_hosts(dir: &Path) -> Arc<Mutex<KnownHosts>> {
    Arc::new(Mutex::new(
        KnownHosts::open(dir.join("known_hosts.json")).unwrap(),
    ))
}

#[tokio::test(flavor = "multi_thread")]
async fn shell_session_with_key_and_host_key_lifecycle() {
    let key = keys::generate(KeyKind::Ed25519, "test").unwrap();
    let Some(mut server) = Server::start(&[&key]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(state.path());

    // First contact: the key is unknown and must be confirmed.
    let mut client = Client::connect(&server, &known, Some(&key));
    match client.milestone().await {
        SessionEvent::Prompt {
            id,
            prompt:
                Prompt::HostKey {
                    known, fingerprint, ..
                },
        } => {
            assert!(known.is_empty());
            assert!(fingerprint.starts_with("SHA256:"));
            client.handle.reply(id, PromptReply::Accept).unwrap();
        }
        other => panic!("expected a host key prompt, got {other:?}"),
    }
    assert!(matches!(client.milestone().await, SessionEvent::Connected));

    // The log tells the whole story of the connection, in order.
    assert_eq!(
        client.log.iter().map(brief).collect::<Vec<_>>(),
        vec![
            "connecting",
            "reached",
            "host_key:new",
            "waiting:host_key",
            "host_key_accepted",
            "offered",
            "try:publickey:saved",
            "accepted:publickey",
            "shell_opening",
            "shell_ready",
        ]
    );
    match &client.log[1] {
        LogEntry::Reached { address } => assert_eq!(address, &format!("127.0.0.1:{}", server.port)),
        other => panic!("{other:?}"),
    }
    match &client.log[5] {
        LogEntry::AuthOffered { methods } => assert_eq!(methods, &["publickey"]),
        other => panic!("{other:?}"),
    }
    match &client.log[6] {
        LogEntry::AuthTrying { detail, .. } => assert_eq!(detail.as_deref(), Some("test (ssh-ed25519)")),
        other => panic!("{other:?}"),
    }

    // A real interactive shell: commands run, the window size is live.
    client.type_line("echo myssh-$((6*7))");
    client.screen_contains("myssh-42").await;
    client.handle.resize(100, 30).unwrap();
    client.type_line("echo size=$(stty size)");
    client.screen_contains("size=30 100").await;

    // Exit status is reported.
    client.type_line("exit 3");
    match client.milestone().await {
        SessionEvent::Closed {
            reason,
            exit_status,
            error,
        } => {
            assert_eq!(reason, CloseReason::Exited);
            assert_eq!(exit_status, Some(3));
            assert!(error.is_none());
        }
        other => panic!("expected Closed, got {other:?}"),
    }

    // Second contact: trusted, no prompt. Closing from our side is `User`.
    let mut client = Client::connect(&server, &known, Some(&key));
    assert!(matches!(client.milestone().await, SessionEvent::Connected));
    assert_eq!(brief(&client.log[2]), "host_key:trusted");
    assert!(!client.log.iter().any(|e| matches!(e, LogEntry::Waiting { .. })));
    client.handle.close();
    match client.milestone().await {
        SessionEvent::Closed { reason, .. } => assert_eq!(reason, CloseReason::User),
        other => panic!("expected Closed, got {other:?}"),
    }

    // The server key changes: the old one is shown, declining aborts, and
    // the trusted key stays as it was.
    let trusted = known.lock().unwrap().entries()[0].fingerprint.clone();
    server.rotate_host_key();
    let mut client = Client::connect(&server, &known, Some(&key));
    match client.milestone().await {
        SessionEvent::Prompt {
            id,
            prompt:
                Prompt::HostKey {
                    known, fingerprint, ..
                },
        } => {
            assert_eq!(known.len(), 1);
            assert_eq!(known[0].fingerprint, trusted);
            assert_ne!(fingerprint, trusted);
            client.handle.reply(id, PromptReply::Cancel).unwrap();
        }
        other => panic!("expected a changed host key prompt, got {other:?}"),
    }
    match client.milestone().await {
        SessionEvent::Closed { reason, error, .. } => {
            assert_eq!(reason, CloseReason::Failed);
            assert_eq!(error.unwrap().code, "host_key_rejected");
        }
        other => panic!("expected Closed, got {other:?}"),
    }
    assert_eq!(known.lock().unwrap().entries()[0].fingerprint, trusted);

    // Accepting replaces it.
    let mut client = Client::connect(&server, &known, Some(&key));
    match client.milestone().await {
        SessionEvent::Prompt { id, .. } => client.handle.reply(id, PromptReply::Accept).unwrap(),
        other => panic!("expected a host key prompt, got {other:?}"),
    }
    assert!(matches!(client.milestone().await, SessionEvent::Connected));
    assert_eq!(known.lock().unwrap().entries().len(), 1);
    assert_ne!(known.lock().unwrap().entries()[0].fingerprint, trusted);
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_key_and_dead_port_fail_cleanly() {
    let accepted = keys::generate(KeyKind::Ed25519, "accepted").unwrap();
    let stranger = keys::generate(KeyKind::EcdsaP256, "stranger").unwrap();
    let Some(mut server) = Server::start(&[&accepted]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(state.path());

    // A key the server does not know, and nothing else to offer.
    let mut client = Client::connect(&server, &known, Some(&stranger));
    match client.milestone().await {
        SessionEvent::Prompt { id, .. } => client.handle.reply(id, PromptReply::Accept).unwrap(),
        other => panic!("expected a host key prompt, got {other:?}"),
    }
    match client.milestone().await {
        SessionEvent::Closed { reason, error, .. } => {
            assert_eq!(reason, CloseReason::Failed);
            assert_eq!(error.unwrap().code, "auth_failed");
        }
        other => panic!("expected Closed, got {other:?}"),
    }
    // The log shows why: the key was offered and the server said no.
    let story: Vec<_> = client.log.iter().map(brief).collect();
    assert_eq!(&story[story.len() - 2..], ["try:publickey:saved", "rejected:publickey"]);
    match client.log.last().unwrap() {
        LogEntry::AuthRejected { remaining, .. } => assert_eq!(remaining, &["publickey"]),
        other => panic!("{other:?}"),
    }

    // Nothing listening.
    server.stop();
    let mut client = Client::connect(&server, &known, Some(&accepted));
    match client.milestone().await {
        SessionEvent::Closed { reason, error, .. } => {
            assert_eq!(reason, CloseReason::Failed);
            let error = error.unwrap();
            assert_eq!(error.code, "connect");
            // The system's own reason is passed on for the log.
            assert!(error.detail.unwrap().to_lowercase().contains("refused"));
        }
        other => panic!("expected Closed, got {other:?}"),
    }
    // It never got past trying to reach the address.
    assert_eq!(client.log.iter().map(brief).collect::<Vec<_>>(), vec!["connecting"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn lost_connection_is_reported_and_flood_is_throttled() {
    let key = keys::generate(KeyKind::Ed25519, "test").unwrap();
    let Some(server) = Server::start(&[&key]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(state.path());

    let mut client = Client::connect(&server, &known, Some(&key));
    match client.milestone().await {
        SessionEvent::Prompt { id, .. } => client.handle.reply(id, PromptReply::Accept).unwrap(),
        other => panic!("expected a host key prompt, got {other:?}"),
    }
    assert!(matches!(client.milestone().await, SessionEvent::Connected));

    // Unacknowledged output stops being read once it passes the high-water
    // mark instead of growing without bound.
    client.type_line("yes myssh-flood-line");
    let mut unacked = 0usize;
    let mut stalled = false;
    for _ in 0..20_000 {
        match timeout(Duration::from_secs(2), client.out.recv()).await {
            Ok(Some(SessionOutput::Data(data))) => unacked += data.len(),
            Ok(Some(_)) => {}
            Ok(None) => panic!("session ended unexpectedly"),
            Err(_) => {
                stalled = true;
                break;
            }
        }
    }
    assert!(stalled, "output kept flowing without acknowledgement");
    assert!(unacked > 1024 * 1024 && unacked < 3 * 1024 * 1024, "{unacked}");

    // Input still gets through while paused, and acknowledging resumes.
    client.handle.write(vec![0x03]).unwrap();
    client.handle.ack(unacked);
    client.type_line("echo after-$((40+2))");
    client.screen_contains("after-42").await;

    // Killing the server-side process for this connection is a lost link.
    client.type_line("kill -9 $PPID");
    match client.milestone().await {
        SessionEvent::Closed { reason, .. } => assert_eq!(reason, CloseReason::Lost),
        other => panic!("expected Closed, got {other:?}"),
    }
}

async fn connected(server: &Server, known: &Arc<Mutex<KnownHosts>>, key: &SshKey) -> Client {
    let mut client = Client::connect(server, known, Some(key));
    loop {
        match client.milestone().await {
            SessionEvent::Prompt { id, .. } => {
                client.handle.reply(id, PromptReply::Accept).unwrap()
            }
            SessionEvent::Connected => return client,
            other => panic!("expected Connected, got {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn side_channel_commands_and_working_directory_per_session() {
    let key = keys::generate(KeyKind::Ed25519, "test").unwrap();
    let Some(server) = Server::start(&[&key]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(state.path());
    let work = tempfile::tempdir().unwrap();
    let work = work.path().canonicalize().unwrap();
    std::fs::create_dir(work.join("a dir")).unwrap();
    std::fs::create_dir(work.join("b")).unwrap();

    let mut first = connected(&server, &known, &key).await;
    let mut second = connected(&server, &known, &key).await;

    // A side-channel command returns its output and status, and leaves the
    // terminal untouched.
    let output = first
        .handle
        .exec("printf out; printf err >&2; exit 7", WAIT)
        .await
        .unwrap();
    assert_eq!(output.stdout_text(), "out");
    assert_eq!(output.stderr_text(), "err");
    assert_eq!(output.exit_status, Some(7));

    // Two sessions to the same host keep separate working directories.
    first.type_line(&format!("cd '{}/a dir' && echo moved-$((1+1))", work.display()));
    first.screen_contains("moved-2").await;
    second.type_line(&format!("cd '{}/b' && echo moved-$((1+1))", work.display()));
    second.screen_contains("moved-2").await;
    assert_eq!(
        first.handle.working_directory().await.unwrap().as_deref(),
        Some(work.join("a dir").to_str().unwrap())
    );
    assert_eq!(
        second.handle.working_directory().await.unwrap().as_deref(),
        Some(work.join("b").to_str().unwrap())
    );

    // A nested shell in the foreground is followed.
    first.type_line("sh");
    first.type_line(&format!("cd '{}/b' && echo nested-$((1+1))", work.display()));
    first.screen_contains("nested-2").await;
    assert_eq!(
        first.handle.working_directory().await.unwrap().as_deref(),
        Some(work.join("b").to_str().unwrap())
    );
    assert!(!String::from_utf8_lossy(&first.screen).contains("lsof"));

    // The server says what it runs; nothing shows up in the terminal.
    let os = second.handle.detect_os().await.unwrap().expect("an operating system");
    assert!(!os.id.is_empty() && !os.name.is_empty(), "{os:?}");
    if cfg!(target_os = "macos") {
        assert_eq!(os.id, "macos");
        assert!(os.name.starts_with("macOS "), "{os:?}");
    }
    assert!(!String::from_utf8_lossy(&second.screen).contains("os-release"));

    // Once the session is over there is no connection to use.
    first.handle.close();
    loop {
        if let SessionEvent::Closed { .. } = first.milestone().await {
            break;
        }
    }
    assert!(first.handle.exec("true", WAIT).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_script_is_typed_once_the_shell_is_up() {
    let key = keys::generate(KeyKind::Ed25519, "test").unwrap();
    let Some(server) = Server::start(&[&key]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = Arc::new(Mutex::new(
        KnownHosts::open(state.path().join("known_hosts.json")).unwrap(),
    ));
    let (tx, out) = mpsc::unbounded_channel();
    let params = ConnectParams {
        host: "127.0.0.1".into(),
        port: server.port,
        username: std::env::var("USER").unwrap(),
        password: None,
        key: Some(KeyParams {
            id: key.id,
            label: key.label.clone(),
            private_key: key.private_key.clone(),
            passphrase: None,
        }),
        startup: Some("A=4\necho first-$((A*10+2))\necho second-$((A+3))".into()),
        cols: 80,
        rows: 24,
    };
    let mut client = Client {
        handle: ssh::spawn(params, known, tx),
        out,
        screen: Vec::new(),
        log: Vec::new(),
    };
    loop {
        match client.milestone().await {
            SessionEvent::Prompt { id, .. } => {
                client.handle.reply(id, PromptReply::Accept).unwrap()
            }
            SessionEvent::Connected => break,
            other => panic!("expected Connected, got {other:?}"),
        }
    }
    client.screen_contains("first-42").await;
    client.screen_contains("second-7").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_browse_edit_and_transfer_on_the_terminal_connection() {
    use myssh_core::sftp::{CancelFlag, EntryKind, EDIT_LIMIT};
    use myssh_core::Error;
    use std::os::unix::fs::PermissionsExt;

    let key = keys::generate(KeyKind::Ed25519, "test").unwrap();
    let Some(server) = Server::start(&[&key]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(state.path());
    let mut client = connected(&server, &known, &key).await;

    let remote = tempfile::tempdir().unwrap();
    let root = remote.path().canonicalize().unwrap();
    let at = |name: &str| format!("{}/{name}", root.display());
    std::fs::write(root.join("notes.txt"), "one\ntwo\n").unwrap();
    std::fs::write(root.join("dos file.txt"), "a\r\nb\r\n").unwrap();
    std::fs::write(root.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
    std::fs::create_dir(root.join("папка")).unwrap();
    std::fs::write(root.join("папка/inner.txt"), "x").unwrap();
    std::os::unix::fs::symlink(root.join("папка"), root.join("link")).unwrap();

    // No second login: the channel opens on the live terminal connection.
    let sftp = client.handle.open_sftp().await.unwrap();
    assert!(sftp.home().await.unwrap().starts_with('/'));
    assert_eq!(sftp.resolve_dir(&at("link/..")).await.unwrap(), at(""). trim_end_matches('/'));
    assert!(matches!(
        sftp.resolve_dir(&at("notes.txt")).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        sftp.resolve_dir(&at("missing")).await,
        Err(Error::NoSuchFile)
    ));

    let mut listing = sftp.list(&at("")[..at("").len() - 1]).await.unwrap();
    listing.sort_by(|a, b| a.name.cmp(&b.name));
    let summary: Vec<_> = listing
        .iter()
        .map(|e| (e.name.as_str(), e.kind, e.is_dir))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("blob.bin", EntryKind::File, false),
            ("dos file.txt", EntryKind::File, false),
            ("link", EntryKind::Symlink, true),
            ("notes.txt", EntryKind::File, false),
            ("папка", EntryKind::Dir, true),
        ]
    );
    assert_eq!(listing[3].size, 8);
    assert_eq!(listing[3].path, at("notes.txt"));
    // A link says where it leads; nothing else has a target.
    assert_eq!(listing[2].target.as_deref(), Some(at("папка").as_str()));
    assert!(listing[3].target.is_none() && listing[4].target.is_none());

    // Directories and renames never replace what is already there.
    let root_str = root.to_str().unwrap();
    // Permissions change as chmod would do it, and nothing else does.
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |name: &str| std::fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o7777;
        let before = std::fs::metadata(root.join("notes.txt")).unwrap();
        sftp.set_permissions(&at("notes.txt"), 0o640).await.unwrap();
        assert_eq!(mode("notes.txt"), 0o640);
        // Type bits passed along with the mode are ignored.
        sftp.set_permissions(&at("notes.txt"), 0o100600).await.unwrap();
        assert_eq!(mode("notes.txt"), 0o600);
        sftp.set_permissions(&at("папка"), 0o750).await.unwrap();
        assert_eq!(mode("папка"), 0o750);
        let after = std::fs::metadata(root.join("notes.txt")).unwrap();
        assert_eq!((before.len(), before.modified().unwrap()), (after.len(), after.modified().unwrap()));
        assert_eq!(std::fs::read_to_string(root.join("notes.txt")).unwrap(), "one\ntwo\n");
        assert!(matches!(
            sftp.set_permissions(&at("missing"), 0o644).await,
            Err(Error::NoSuchFile)
        ));
        let listed = sftp.list(root_str).await.unwrap();
        let notes = listed.iter().find(|e| e.name == "notes.txt").unwrap();
        assert_eq!(notes.permissions.unwrap() & 0o7777, 0o600);
        assert_eq!(sftp.version(&at("notes.txt")).await.unwrap().size, 8);
        sftp.set_permissions(&at("notes.txt"), 0o644).await.unwrap();
        sftp.set_permissions(&at("папка"), 0o755).await.unwrap();
    }

    assert_eq!(sftp.create_dir(root_str, "new").await.unwrap(), at("new"));
    assert!(matches!(
        sftp.create_dir(root_str, "new").await,
        Err(Error::AlreadyExists(_))
    ));
    assert!(matches!(
        sftp.create_dir(root_str, "a/b").await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        sftp.rename(&at("new"), "notes.txt").await,
        Err(Error::AlreadyExists(_))
    ));
    assert_eq!(sftp.rename(&at("new"), "renamed").await.unwrap(), at("renamed"));
    assert!(root.join("renamed").is_dir() && !root.join("new").exists());

    // Editing: line endings survive, permissions survive, conflicts are caught.
    std::fs::set_permissions(root.join("notes.txt"), std::fs::Permissions::from_mode(0o600)).unwrap();
    let file = sftp.read_text(&at("notes.txt")).await.unwrap();
    assert_eq!((file.content.as_str(), file.crlf), ("one\ntwo\n", false));
    let saved = sftp
        .write_text(&at("notes.txt"), "one\ntwo\nthree\n", false, Some(file.version))
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(root.join("notes.txt")).unwrap(), "one\ntwo\nthree\n");
    assert_eq!(saved.size, 14);
    let mode = std::fs::metadata(root.join("notes.txt")).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);

    // Someone else changes the file: saving with the stale version is refused
    // and the other change is left intact.
    std::fs::write(root.join("notes.txt"), "changed elsewhere, longer\n").unwrap();
    assert!(matches!(
        sftp.write_text(&at("notes.txt"), "mine", false, Some(saved)).await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        std::fs::read_to_string(root.join("notes.txt")).unwrap(),
        "changed elsewhere, longer\n"
    );
    // The file vanished: also a conflict, not a silent re-creation.
    std::fs::remove_file(root.join("notes.txt")).unwrap();
    assert!(matches!(
        sftp.write_text(&at("notes.txt"), "mine", false, Some(saved)).await,
        Err(Error::Conflict)
    ));
    // Overwriting deliberately works, and creates new files.
    sftp.write_text(&at("notes.txt"), "mine", false, None).await.unwrap();
    assert_eq!(std::fs::read_to_string(root.join("notes.txt")).unwrap(), "mine");

    let dos = sftp.read_text(&at("dos file.txt")).await.unwrap();
    assert_eq!((dos.content.as_str(), dos.crlf), ("a\nb\n", true));
    sftp.write_text(&at("dos file.txt"), "a\nb\nc\n", true, Some(dos.version))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(root.join("dos file.txt")).unwrap(),
        b"a\r\nb\r\nc\r\n"
    );

    assert!(matches!(sftp.read_text(&at("blob.bin")).await, Err(Error::NotText)));
    std::fs::write(root.join("big.txt"), vec![b'a'; EDIT_LIMIT as usize + 1]).unwrap();
    assert!(matches!(
        sftp.read_text(&at("big.txt")).await,
        Err(Error::TooLarge(_))
    ));
    assert!(matches!(sftp.read_text(&at("папка")).await, Err(Error::Invalid(_))));

    // Transfers: single files.
    let local = tempfile::tempdir().unwrap();
    let payload: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(local.path().join("data.bin"), &payload).unwrap();
    let cancel = CancelFlag::default();
    let mut reported = Vec::new();
    let summary = sftp
        .upload(&local.path().join("data.bin"), root_str, false, &cancel, |done, total| {
            reported.push((done, total))
        })
        .await
        .unwrap();
    assert_eq!((summary.files, summary.bytes, summary.skipped), (1, 700_000, 0));
    assert_eq!(std::fs::read(root.join("data.bin")).unwrap(), payload);
    assert_eq!(reported.first(), Some(&(0, 700_000)));
    assert_eq!(reported.last(), Some(&(700_000, 700_000)));
    assert!(reported.windows(2).all(|w| w[0].0 <= w[1].0));

    std::fs::write(local.path().join("data.bin"), b"replacement").unwrap();
    assert!(matches!(
        sftp.upload(&local.path().join("data.bin"), root_str, false, &cancel, |_, _| {}).await,
        Err(Error::AlreadyExists(_))
    ));
    assert_eq!(std::fs::read(root.join("data.bin")).unwrap(), payload);
    sftp.upload(&local.path().join("data.bin"), root_str, true, &cancel, |_, _| {})
        .await
        .unwrap();
    assert_eq!(std::fs::read(root.join("data.bin")).unwrap(), b"replacement");

    std::fs::write(root.join("down.bin"), &payload).unwrap();
    let inbox = local.path().join("inbox");
    std::fs::create_dir(&inbox).unwrap();
    sftp.download(&at("down.bin"), &inbox, false, &cancel, |_, _| {}).await.unwrap();
    assert_eq!(std::fs::read(inbox.join("down.bin")).unwrap(), payload);
    // An existing local file is not replaced unless asked.
    std::fs::write(inbox.join("down.bin"), b"mine").unwrap();
    assert!(matches!(
        sftp.download(&at("down.bin"), &inbox, false, &cancel, |_, _| {}).await,
        Err(Error::AlreadyExists(_))
    ));
    assert_eq!(std::fs::read(inbox.join("down.bin")).unwrap(), b"mine");
    sftp.download(&at("down.bin"), &inbox, true, &cancel, |_, _| {}).await.unwrap();
    assert_eq!(std::fs::read(inbox.join("down.bin")).unwrap(), payload);

    // A cancelled download leaves nothing behind.
    let stopped = local.path().join("stopped");
    std::fs::create_dir(&stopped).unwrap();
    let cancelled = CancelFlag::default();
    let stopper = cancelled.clone();
    let result = sftp
        .download(&at("down.bin"), &stopped, false, &cancelled, move |done, _| {
            if done > 0 {
                stopper.cancel()
            }
        })
        .await;
    assert!(matches!(result, Err(Error::Cancelled)));
    assert_eq!(std::fs::read_dir(&stopped).unwrap().count(), 0);

    // Transfers: whole directory trees, both ways.
    let tree = local.path().join("project");
    std::fs::create_dir_all(tree.join("src/deep")).unwrap();
    std::fs::create_dir(tree.join("empty")).unwrap();
    std::fs::write(tree.join("README.md"), "readme").unwrap();
    std::fs::write(tree.join("src/main.rs"), "fn main() {}").unwrap();
    std::fs::write(tree.join("src/deep/data"), &payload[..5000]).unwrap();
    std::os::unix::fs::symlink(tree.join("README.md"), tree.join("link")).unwrap();
    let mut last = (0, 0);
    let summary = sftp
        .upload(&tree, root_str, false, &cancel, |done, total| last = (done, total))
        .await
        .unwrap();
    assert_eq!((summary.files, summary.skipped), (3, 1));
    assert_eq!(summary.bytes, 6 + 12 + 5000);
    assert_eq!(last, (summary.bytes, summary.bytes));
    assert_eq!(std::fs::read_to_string(root.join("project/src/main.rs")).unwrap(), "fn main() {}");
    assert_eq!(std::fs::read(root.join("project/src/deep/data")).unwrap(), &payload[..5000]);
    assert!(root.join("project/empty").is_dir());
    assert!(!root.join("project/link").exists());

    assert!(matches!(
        sftp.upload(&tree, root_str, false, &cancel, |_, _| {}).await,
        Err(Error::AlreadyExists(_))
    ));
    // Merging on request: changed files are replaced, others stay.
    std::fs::write(root.join("project/only-remote"), "keep").unwrap();
    std::fs::write(tree.join("README.md"), "readme v2").unwrap();
    sftp.upload(&tree, root_str, true, &cancel, |_, _| {}).await.unwrap();
    assert_eq!(std::fs::read_to_string(root.join("project/README.md")).unwrap(), "readme v2");
    assert_eq!(std::fs::read_to_string(root.join("project/only-remote")).unwrap(), "keep");

    let back = local.path().join("back");
    std::fs::create_dir(&back).unwrap();
    let summary = sftp
        .download(&at("project"), &back, false, &cancel, |_, _| {})
        .await
        .unwrap();
    assert_eq!(summary.files, 4);
    assert_eq!(std::fs::read_to_string(back.join("project/README.md")).unwrap(), "readme v2");
    assert_eq!(std::fs::read(back.join("project/src/deep/data")).unwrap(), &payload[..5000]);
    assert!(back.join("project/empty").is_dir());
    let leftovers = walk(&back).into_iter().filter(|p| p.ends_with(".part")).count();
    assert_eq!(leftovers, 0);

    // Many small files, a few at a time: all of them arrive, both ways,
    // and the progress adds up to the whole.
    let many = local.path().join("many");
    for i in 0..60 {
        let dir = many.join(format!("d{}", i % 7));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("f{i}.txt")), format!("file {i}\n").repeat(i + 1)).unwrap();
    }
    let expected: u64 = (0..60).map(|i| (format!("file {i}\n").len() * (i + 1)) as u64).sum();
    let mut last = (0, 0);
    let summary = sftp
        .upload(&many, root_str, false, &cancel, |done, total| last = (done, total))
        .await
        .unwrap();
    assert_eq!((summary.files, summary.bytes), (60, expected));
    assert_eq!(last, (expected, expected));
    let again = local.path().join("many-back");
    std::fs::create_dir(&again).unwrap();
    let summary = sftp.download(&at("many"), &again, false, &cancel, |_, _| {}).await.unwrap();
    assert_eq!((summary.files, summary.bytes), (60, expected));
    for i in 0..60 {
        let name = format!("many/d{}/f{i}.txt", i % 7);
        assert_eq!(std::fs::read(again.join(&name)).unwrap(), std::fs::read(root.join(&name)).unwrap());
    }
    // One file that cannot be read stops the rest, and that is the error reported.
    let locked = many.join("d3/locked");
    std::fs::write(&locked, "secret").unwrap();
    std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
    let failed = sftp.upload(&many, root_str, true, &cancel, |_, _| {}).await;
    assert!(matches!(failed, Err(Error::Io(_))), "{failed:?}");

    // Deleting a link leaves its target; deleting a directory takes its content.
    sftp.remove(&at("link")).await.unwrap();
    assert!(root.join("папка/inner.txt").exists());
    std::fs::create_dir_all(root.join("папка/deep/deeper")).unwrap();
    std::fs::write(root.join("папка/deep/deeper/f"), "x").unwrap();
    sftp.remove(&at("папка")).await.unwrap();
    assert!(!root.join("папка").exists());
    assert!(matches!(sftp.remove(&at("папка")).await, Err(Error::NoSuchFile)));
    assert!(matches!(sftp.remove("/").await, Err(Error::Invalid(_))));

    // When the terminal session ends, so does file access.
    client.handle.close();
    loop {
        if let SessionEvent::Closed { .. } = client.milestone().await {
            break;
        }
    }
    assert!(sftp.list(root_str).await.is_err());
    assert!(client.handle.open_sftp().await.is_err());
}

/// Every path under a directory, as strings.
#[tokio::test(flavor = "multi_thread")]
async fn folders_go_as_one_archive_and_a_stopped_one_leaves_nothing() {
    use myssh_core::sftp::CancelFlag;
    use myssh_core::Error;
    use std::os::unix::fs::PermissionsExt;

    let key = keys::generate(KeyKind::Ed25519, "test").unwrap();
    let Some(server) = Server::start(&[&key]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(state.path());
    let client = connected(&server, &known, &key).await;
    let remote = tempfile::tempdir().unwrap();
    let root = remote.path().canonicalize().unwrap();
    let root_str = root.to_str().unwrap();
    let local = tempfile::tempdir().unwrap();
    let cancel = CancelFlag::default();

    // A tree with small files, an empty folder, an odd name, a script and a link.
    let tree = local.path().join("site");
    for i in 0..40 {
        let dir = tree.join(format!("part {}/'q'", i % 5));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("f{i}.txt")), format!("line {i}\n").repeat(i + 1)).unwrap();
    }
    std::fs::create_dir_all(tree.join("empty")).unwrap();
    std::fs::write(tree.join("run.sh"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(tree.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink(tree.join("run.sh"), tree.join("link")).unwrap();
    let bytes: u64 = (0..40).map(|i| (format!("line {i}\n").len() * (i + 1)) as u64).sum::<u64>() + 10;

    let mut last = (0, 0);
    let summary = client
        .handle
        .upload_archive(&tree, root_str, false, &cancel, |done, total| last = (done, total))
        .await
        .unwrap()
        .expect("this server has tar");
    assert_eq!((summary.files, summary.bytes, summary.skipped), (41, bytes, 1));
    assert_eq!(last, (bytes, bytes));
    for i in 0..40 {
        let name = format!("site/part {}/'q'/f{i}.txt", i % 5);
        assert_eq!(std::fs::read(root.join(&name)).unwrap(), std::fs::read(local.path().join(&name)).unwrap());
    }
    assert!(root.join("site/empty").is_dir());
    assert!(!root.join("site/link").exists());
    assert_eq!(std::fs::metadata(root.join("site/run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
    let hidden = |dir: &Path| walk(dir).into_iter().filter(|p| p.contains(".myssh-")).count();
    assert_eq!(hidden(&root), 0);

    // Not over what is there, unless asked; then merged.
    assert!(matches!(
        client.handle.upload_archive(&tree, root_str, false, &cancel, |_, _| {}).await,
        Err(Error::AlreadyExists(_))
    ));
    std::fs::write(root.join("site/only-remote"), "keep").unwrap();
    std::fs::write(tree.join("run.sh"), "#!/bin/sh\necho v2\n").unwrap();
    client.handle.upload_archive(&tree, root_str, true, &cancel, |_, _| {}).await.unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(root.join("site/run.sh")).unwrap(), "#!/bin/sh\necho v2\n");
    assert_eq!(std::fs::read_to_string(root.join("site/only-remote")).unwrap(), "keep");

    // Back down, whole.
    let back = local.path().join("back");
    std::fs::create_dir(&back).unwrap();
    let summary = client
        .handle
        .download_archive(&format!("{root_str}/site"), &back, false, &cancel, |_, _| {})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.files, 42);
    assert_eq!(std::fs::read_to_string(back.join("site/only-remote")).unwrap(), "keep");
    assert_eq!(std::fs::read(back.join("site/part 3/'q'/f8.txt")).unwrap(), std::fs::read(tree.join("part 3/'q'/f8.txt")).unwrap());
    assert!(back.join("site/empty").is_dir());
    assert_eq!(std::fs::metadata(back.join("site/run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(hidden(&back), 0);
    assert!(matches!(
        client.handle.download_archive(&format!("{root_str}/missing"), &back, false, &cancel, |_, _| {}).await,
        Err(Error::NoSuchFile)
    ));

    // Stopped halfway up: nothing of it on the server, not even hidden.
    let big = local.path().join("big");
    std::fs::create_dir(&big).unwrap();
    for i in 0..20 {
        std::fs::write(big.join(format!("b{i}")), vec![i as u8; 1 << 20]).unwrap();
    }
    let stop = CancelFlag::default();
    let stopper = stop.clone();
    let result = client
        .handle
        .upload_archive(&big, root_str, false, &stop, move |done, _| {
            if done > 3 << 20 {
                stopper.cancel()
            }
        })
        .await;
    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    assert!(!root.join("big").exists());
    assert_eq!(hidden(&root), 0);

    // Stopped halfway down: nothing of it here.
    std::fs::rename(&big, root.join("big")).unwrap();
    let inbox = local.path().join("inbox");
    std::fs::create_dir(&inbox).unwrap();
    let stop = CancelFlag::default();
    let stopper = stop.clone();
    let result = client
        .handle
        .download_archive(&format!("{root_str}/big"), &inbox, false, &stop, move |done, _| {
            if done > 3 << 20 {
                stopper.cancel()
            }
        })
        .await;
    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    assert_eq!(std::fs::read_dir(&inbox).unwrap().count(), 0);

    // An unreadable file on the server spoils the whole download: nothing kept.
    let locked = root.join("site/part 1/locked");
    std::fs::write(&locked, "secret").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = client
        .handle
        .download_archive(&format!("{root_str}/site"), &inbox, false, &cancel, |_, _| {})
        .await;
    assert!(matches!(result, Err(Error::Remote(_))), "{result:?}");
    assert_eq!(std::fs::read_dir(&inbox).unwrap().count(), 0);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn walk(dir: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        for item in std::fs::read_dir(&current).unwrap().flatten() {
            found.push(item.path().display().to_string());
            if item.path().is_dir() {
                pending.push(item.path());
            }
        }
    }
    found
}

fn key_params(key: &SshKey) -> KeyParams {
    KeyParams {
        id: key.id,
        label: key.label.clone(),
        private_key: key.private_key.clone(),
        passphrase: key.passphrase.clone(),
    }
}

/// Runs one installation of `new` through a login with `current`, and
/// returns the events that matter, in order.
async fn install(
    server: &Server,
    known: &Arc<Mutex<KnownHosts>>,
    current: &SshKey,
    new: &SshKey,
) -> Vec<String> {
    let (tx, mut out) = mpsc::unbounded_channel();
    let params = InstallParams {
        connect: ConnectParams {
            host: "127.0.0.1".into(),
            port: server.port,
            username: std::env::var("USER").unwrap(),
            password: None,
            key: Some(key_params(current)),
            startup: None,
            cols: 80,
            rows: 24,
        },
        key: key_params(new),
        public_key: new.public_key.clone(),
        comment: "work laptop".into(),
    };
    let handle = ssh::spawn_install(params, known.clone(), tx);
    let mut seen = Vec::new();
    loop {
        match timeout(WAIT, out.recv()).await.expect("install timed out") {
            Some(SessionOutput::Event(event)) => match event {
                SessionEvent::Prompt { id, .. } => handle.reply(id, PromptReply::Accept).unwrap(),
                SessionEvent::Stage { stage } => {
                    if matches!(stage, Stage::InstallingKey | Stage::VerifyingKey) {
                        seen.push(format!("{stage:?}"));
                    }
                }
                SessionEvent::KeyInstalled { already_present } => {
                    seen.push(format!("installed(already={already_present})"))
                }
                SessionEvent::KeyVerified => seen.push("verified".into()),
                SessionEvent::Closed { reason, error, .. } => {
                    seen.push(format!("closed({reason:?},{:?})", error.map(|e| e.code)));
                    return seen;
                }
                _ => {}
            },
            Some(_) => {}
            None => panic!("install ended without a Closed event"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn key_installation_appends_once_and_proves_the_key() {
    let current = keys::generate(KeyKind::Ed25519, "current").unwrap();
    let new = keys::generate(KeyKind::Ed25519, "new").unwrap();
    let restricted = keys::generate(KeyKind::EcdsaP256, "restricted").unwrap();
    let Some(server) = Server::start(&[&current]) else {
        return;
    };
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(state.path());
    let authorized = server.path("home/.ssh/authorized_keys");

    // Safety net: the server must really confine sessions to the private
    // home, or this test would edit the real authorized_keys.
    let probe = connected(&server, &known, &current).await;
    let home = probe.handle.exec("printf %s \"$HOME\"", WAIT).await.unwrap();
    if home.stdout_text() != server.path("home").display().to_string() {
        eprintln!("skipping: sshd did not apply SetEnv HOME");
        return;
    }
    probe.handle.close();

    // An existing entry with restrictions, a comment line, and no final
    // newline: all of it must survive untouched.
    let before = format!(
        "{}\n# {} old\nfrom=\"127.0.0.1\",no-agent-forwarding {} boss@work",
        current.public_key, new.public_key, restricted.public_key
    );
    std::fs::write(&authorized, &before).unwrap();

    assert_eq!(
        install(&server, &known, &current, &new).await,
        vec![
            "InstallingKey",
            "installed(already=false)",
            "VerifyingKey",
            "verified",
            "closed(Exited,None)"
        ]
    );
    let after = std::fs::read_to_string(&authorized).unwrap();
    assert_eq!(
        after,
        format!("{before}\n{} work-laptop\n", new.public_key),
        "only one line may be appended"
    );

    // Again: recognized, nothing written, still verified.
    assert_eq!(
        install(&server, &known, &current, &new).await,
        vec![
            "InstallingKey",
            "installed(already=true)",
            "VerifyingKey",
            "verified",
            "closed(Exited,None)"
        ]
    );
    assert_eq!(std::fs::read_to_string(&authorized).unwrap(), after);

    // A key present only with restrictions counts as present and keeps them.
    // (Its `from=` allows this host, so the check passes too.)
    let events = install(&server, &known, &current, &restricted).await;
    assert_eq!(events[1], "installed(already=true)");
    assert_eq!(std::fs::read_to_string(&authorized).unwrap(), after);

    // The new key now gets in by itself.
    let mut client = connected(&server, &known, &new).await;
    client.type_line("echo with-new-key-$((2+2))");
    client.screen_contains("with-new-key-4").await;

    // The file is there but the server ignores it: installed, yet the proof
    // fails, and that is what gets reported.
    let stranger = keys::generate(KeyKind::Ed25519, "stranger").unwrap();
    let mut blind = Server::start(&[&current]).unwrap();
    blind.stop();
    std::fs::write(
        blind.path("sshd_config"),
        std::fs::read_to_string(blind.path("sshd_config"))
            .unwrap()
            .replace("home/.ssh/authorized_keys", "home/.ssh/elsewhere"),
    )
    .unwrap();
    std::fs::copy(
        blind.path("home/.ssh/authorized_keys"),
        blind.path("home/.ssh/elsewhere"),
    )
    .unwrap();
    blind.relaunch();
    let events = install(&blind, &known_hosts(state.path()), &current, &stranger).await;
    assert_eq!(
        events,
        vec![
            "InstallingKey",
            "installed(already=false)",
            "VerifyingKey",
            "closed(Failed,Some(\"key_not_accepted\"))"
        ]
    );

    // No way in at all: fails before anything is written.
    let events = install(&server, &known, &stranger, &stranger).await;
    assert_eq!(events, vec!["closed(Failed,Some(\"auth_failed\"))"]);
    assert_eq!(std::fs::read_to_string(&authorized).unwrap(), after);
}
