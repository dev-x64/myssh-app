//! The app's server-side assumptions, checked on real Linux distributions.
//!
//! Needs the containers from `tests/linux/docker-compose.yml` and
//! `MYSSH_LINUX_TESTS=1`; otherwise the tests skip themselves.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use myssh_core::keys::{self, KeyKind};
use myssh_core::known_hosts::KnownHosts;
use myssh_core::model::SshKey;
use myssh_core::ssh::{
    self, CloseReason, ConnectParams, InstallParams, KeyParams, Prompt, PromptReply, SessionEvent,
    SessionHandle, SessionOutput,
};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::timeout;

const USER: &str = "tester";
const PASSWORD: &str = "myssh-test";
const WAIT: Duration = Duration::from_secs(25);

struct Distro {
    name: &'static str,
    port: u16,
    os_id: &'static str,
}

const DISTROS: &[Distro] = &[
    Distro { name: "ubuntu", port: 2301, os_id: "ubuntu" },
    Distro { name: "debian", port: 2302, os_id: "debian" },
    // BusyBox userland, no procps: only /proc to go by.
    Distro { name: "alpine", port: 2303, os_id: "alpine" },
    Distro { name: "rocky", port: 2304, os_id: "rocky" },
];
const INTERACTIVE_PORT: u16 = 2305;

fn enabled() -> bool {
    if std::env::var_os("MYSSH_LINUX_TESTS").is_none() {
        eprintln!("skipping: set MYSSH_LINUX_TESTS=1 with the test servers running");
        return false;
    }
    true
}

struct Client {
    handle: SessionHandle,
    out: UnboundedReceiver<SessionOutput>,
    screen: Vec<u8>,
}

fn key_params(key: &SshKey) -> KeyParams {
    KeyParams {
        id: key.id,
        label: key.label.clone(),
        private_key: key.private_key.clone(),
        passphrase: None,
    }
}

fn params(port: u16, password: Option<&str>, key: Option<&SshKey>) -> ConnectParams {
    ConnectParams {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        password: password.map(str::to_string),
        key: key.map(key_params),
        startup: None,
        cols: 100,
        rows: 30,
        agent: Vec::new(),
    }
}

impl Client {
    fn start(known: &Arc<Mutex<KnownHosts>>, params: ConnectParams) -> Client {
        let (tx, out) = mpsc::unbounded_channel();
        Client {
            handle: ssh::spawn(params, known.clone(), tx),
            out,
            screen: Vec::new(),
        }
    }

    /// Next event that needs a reaction; host keys are accepted on the way.
    async fn next(&mut self) -> SessionEvent {
        loop {
            match timeout(WAIT, self.out.recv()).await.expect("timed out") {
                Some(SessionOutput::Event(event)) => match event {
                    SessionEvent::Stage { .. }
                    | SessionEvent::Banner { .. }
                    | SessionEvent::Log { .. } => {}
                    SessionEvent::Prompt {
                        id,
                        prompt: Prompt::HostKey { .. },
                    } => self.handle.reply(id, PromptReply::Accept).unwrap(),
                    other => return other,
                },
                Some(SessionOutput::Data(data)) => {
                    self.handle.ack(data.len());
                    self.screen.extend(data);
                }
                Some(SessionOutput::Remember(_)) => {}
                None => panic!("session ended without a Closed event"),
            }
        }
    }

    async fn connected(mut self) -> Client {
        match self.next().await {
            SessionEvent::Connected => self,
            other => panic!("expected Connected, got {other:?}"),
        }
    }

    async fn run(&mut self, command: &str, expect: &str) {
        self.handle
            .write(format!("{command}\n").into_bytes())
            .unwrap();
        let deadline = tokio::time::Instant::now() + WAIT;
        while !String::from_utf8_lossy(&self.screen).contains(expect) {
            match tokio::time::timeout_at(deadline, self.out.recv()).await {
                Ok(Some(SessionOutput::Data(data))) => {
                    self.handle.ack(data.len());
                    self.screen.extend(data);
                }
                Ok(Some(_)) => {}
                _ => panic!(
                    "{expect:?} never appeared; screen: {}",
                    String::from_utf8_lossy(&self.screen)
                ),
            }
        }
    }
}

fn known_hosts(dir: &tempfile::TempDir) -> Arc<Mutex<KnownHosts>> {
    Arc::new(Mutex::new(
        KnownHosts::open(dir.path().join("known_hosts.json")).unwrap(),
    ))
}

/// Events of one key installation, in order.
async fn install(
    known: &Arc<Mutex<KnownHosts>>,
    port: u16,
    key: &SshKey,
) -> Vec<String> {
    let (tx, mut out) = mpsc::unbounded_channel();
    let handle = ssh::spawn_install(
        InstallParams {
            connect: params(port, Some(PASSWORD), None),
            key: key_params(key),
            public_key: key.public_key.clone(),
            comment: "linux test".into(),
        },
        known.clone(),
        tx,
    );
    let mut seen = Vec::new();
    loop {
        match timeout(WAIT, out.recv()).await.expect("install timed out") {
            Some(SessionOutput::Event(event)) => match event {
                SessionEvent::Prompt { id, .. } => handle.reply(id, PromptReply::Accept).unwrap(),
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
async fn every_distribution_supports_what_the_app_relies_on() {
    if !enabled() {
        return;
    }
    for distro in DISTROS {
        eprintln!("--- {}", distro.name);
        let state = tempfile::tempdir().unwrap();
        let known = known_hosts(&state);

        // Password sign-in and an interactive shell.
        let mut client = Client::start(&known, params(distro.port, Some(PASSWORD), None))
            .connected()
            .await;
        client.run("echo shell-$((40+2))", "shell-42").await;

        // The system identifies itself.
        let os = client.handle.detect_os().await.unwrap().expect("an operating system");
        assert_eq!(os.id, distro.os_id, "{}: {os:?}", distro.name);
        assert!(os.name.len() > distro.os_id.len(), "{}: {os:?}", distro.name);
        eprintln!("    os: {} ({:?})", os.name, os.family);

        // The terminal's directory, per session.
        client.run("mkdir -p '/tmp/my dir' && cd '/tmp/my dir' && echo moved-$((1+1))", "moved-2").await;
        let cwd = client.handle.working_directory().await.unwrap();
        eprintln!("    cwd: {cwd:?}");
        assert_eq!(cwd.as_deref(), Some("/tmp/my dir"), "{}", distro.name);
        // A nested shell in the foreground is followed.
        client.run("sh", "").await;
        client.run("cd /var && echo nested-$((2+2))", "nested-4").await;
        assert_eq!(
            client.handle.working_directory().await.unwrap().as_deref(),
            Some("/var"),
            "{}",
            distro.name
        );
        client.run("exit", "").await;
        assert!(!String::from_utf8_lossy(&client.screen).contains("os-release"));

        // Files over the same connection.
        let sftp = client.handle.open_sftp().await.unwrap();
        assert_eq!(sftp.home().await.unwrap(), "/home/tester", "{}", distro.name);
        let etc = sftp.list("/etc").await.unwrap();
        assert!(etc.iter().any(|e| e.name == "os-release"), "{}", distro.name);
        assert!(etc.iter().any(|e| e.name == "ssh" && e.is_dir), "{}", distro.name);
        let path = "/home/tester/notes.txt";
        let saved = sftp.write_text(path, "one\ntwo\n", false, None).await.unwrap();
        let file = sftp.read_text(path).await.unwrap();
        assert_eq!((file.content.as_str(), file.version), ("one\ntwo\n", saved));
        client.run("cat ~/notes.txt | tr '\\n' '+'", "one+two+").await;
        // Reading a file the user may not read is a clear refusal.
        assert!(matches!(
            sftp.read_text("/etc/shadow").await,
            Err(myssh_core::Error::PermissionDenied)
        ), "{}", distro.name);
        sftp.remove(path).await.unwrap();

        // A folder as one archive, where the server has tar; all or nothing.
        archive_round_trip(&client.handle, distro.name).await;

        // Install a key through the password login, prove it, and use it.
        let key = keys::generate(KeyKind::Ed25519, "linux").unwrap();
        assert_eq!(
            install(&known, distro.port, &key).await,
            vec!["installed(already=false)", "verified", "closed(Exited,None)"],
            "{}",
            distro.name
        );
        assert_eq!(
            install(&known, distro.port, &key).await,
            vec!["installed(already=true)", "verified", "closed(Exited,None)"],
            "{}",
            distro.name
        );
        let mut with_key = Client::start(&known, params(distro.port, None, Some(&key)))
            .connected()
            .await;
        with_key.run("wc -l < ~/.ssh/authorized_keys", "1").await;
        with_key.run("stat -c %a ~/.ssh ~/.ssh/authorized_keys | tr '\\n' ' '", "700 600").await;
        // Leave the account as it was found.
        with_key.run("rm -rf ~/.ssh '/tmp/my dir' && echo cleaned-$((1+1))", "cleaned-2").await;

        // A clean exit reports its status.
        with_key.handle.write(b"exit 4\n".to_vec()).unwrap();
        match with_key.next().await {
            SessionEvent::Closed { reason, exit_status, .. } => {
                assert_eq!((reason, exit_status), (CloseReason::Exited, Some(4)), "{}", distro.name);
            }
            other => panic!("expected Closed, got {other:?}"),
        }

        // A wrong saved password ends in a password prompt, not a hang.
        let mut wrong = Client::start(&known, params(distro.port, Some("not it"), None));
        match wrong.next().await {
            SessionEvent::Prompt { prompt: Prompt::Password { attempt: 1, .. }, .. } => {}
            other => panic!("{}: expected a password prompt, got {other:?}", distro.name),
        }
        wrong.handle.close();
        client.handle.close();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn password_through_keyboard_interactive_only() {
    if !enabled() {
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let known = known_hosts(&state);

    // A saved password answers PAM's single hidden question by itself.
    let mut client = Client::start(&known, params(INTERACTIVE_PORT, Some(PASSWORD), None))
        .connected()
        .await;
    client.run("echo interactive-$((5+5))", "interactive-10").await;
    client.handle.close();

    // Without one, the server's question reaches the user as asked.
    let mut client = Client::start(&known, params(INTERACTIVE_PORT, None, None));
    let (id, prompts) = match client.next().await {
        SessionEvent::Prompt {
            id,
            prompt: Prompt::KeyboardInteractive { prompts, .. },
        } => (id, prompts),
        other => panic!("expected a keyboard-interactive prompt, got {other:?}"),
    };
    assert_eq!(prompts.len(), 1);
    assert!(!prompts[0].echo);
    assert!(prompts[0].prompt.to_lowercase().contains("password"), "{:?}", prompts[0]);
    // A wrong answer brings the question back.
    client
        .handle
        .reply(id, PromptReply::Answers { values: vec!["wrong".into()] })
        .unwrap();
    let id = match client.next().await {
        SessionEvent::Prompt { id, prompt: Prompt::KeyboardInteractive { .. } } => id,
        other => panic!("expected the question again, got {other:?}"),
    };
    client
        .handle
        .reply(id, PromptReply::Answers { values: vec![PASSWORD.into()] })
        .unwrap();
    let mut client = client.connected().await;
    client.run("echo answered-$((6+6))", "answered-12").await;
}

async fn archive_round_trip(handle: &SessionHandle, name: &str) {
    use myssh_core::sftp::CancelFlag;
    let local = tempfile::tempdir().unwrap();
    let tree = local.path().join("pack");
    for i in 0..30 {
        let dir = tree.join(format!("d {}", i % 4));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("f{i}")), format!("{i}\n").repeat(i + 1)).unwrap();
    }
    let cancel = CancelFlag::default();
    let Some(up) = handle.upload_archive(&tree, "/home/tester", false, &cancel, |_, _| {}).await.unwrap() else {
        eprintln!("    archive: no tar here, SFTP is used instead");
        let back = local.path().join("back");
        std::fs::create_dir(&back).unwrap();
        assert!(handle.download_archive("/etc", &back, false, &cancel, |_, _| {}).await.unwrap().is_none());
        return;
    };
    assert_eq!(up.files, 30, "{name}");
    let back = local.path().join("back");
    std::fs::create_dir(&back).unwrap();
    let down = handle
        .download_archive("/home/tester/pack", &back, false, &cancel, |_, _| {})
        .await
        .unwrap()
        .unwrap();
    assert_eq!((down.files, down.bytes), (30, up.bytes), "{name}");
    assert_eq!(std::fs::read(back.join("pack/d 3/f7")).unwrap(), std::fs::read(tree.join("d 3/f7")).unwrap());

    // Stopped halfway up: nothing left on the server, hidden or not.
    let big = local.path().join("big");
    std::fs::create_dir(&big).unwrap();
    for i in 0..12 {
        std::fs::write(big.join(format!("b{i}")), vec![i as u8; 1 << 20]).unwrap();
    }
    let stop = CancelFlag::default();
    let stopper = stop.clone();
    let stopped = handle
        .upload_archive(&big, "/home/tester", false, &stop, move |done, _| {
            if done > 3 << 20 {
                stopper.cancel()
            }
        })
        .await;
    assert!(matches!(stopped, Err(myssh_core::Error::Cancelled)), "{name}: {stopped:?}");
    let left = handle
        .exec("ls -A /home/tester; pgrep -x tar || echo no-tar", Duration::from_secs(10))
        .await
        .unwrap()
        .stdout_text();
    assert!(!left.contains("big") && !left.contains(".myssh-"), "{name}: {left}");
    eprintln!("    archive: {} files up and back; a stopped upload left nothing", up.files);
    handle.exec("rm -rf /home/tester/pack", Duration::from_secs(10)).await.unwrap();
}
