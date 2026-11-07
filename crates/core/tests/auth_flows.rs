//! Authentication flows against an in-process SSH server.
//!
//! Covers what a private `sshd` cannot offer to an unprivileged test:
//! passwords, keyboard-interactive challenges and their prompts.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use myssh_core::keys::{self, KeyKind};
use myssh_core::known_hosts::KnownHosts;
use myssh_core::ssh::{
    self, CloseReason, ConnectParams, KeyParams, LogEntry, Prompt, PromptReply, Remember, SessionEvent,
    SessionHandle, SessionOutput,
};
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Response, Server as _, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::timeout;

const PASSWORD: &str = "correct-horse";
const CODE: &str = "123456";
const WAIT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy)]
enum Mode {
    Password,
    /// Keyboard-interactive with one hidden question, as PAM servers do.
    InteractivePassword,
    /// Keyboard-interactive asking for a password and a visible code.
    InteractiveTwoFactor,
    /// Only the given public key is accepted.
    PublicKey,
}

#[derive(Clone)]
struct TestServer {
    mode: Mode,
    accepted_key: Option<PublicKey>,
    /// How many times someone has signed in.
    sign_ins: Arc<std::sync::atomic::AtomicUsize>,
}

impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

fn methods(mode: Mode) -> MethodSet {
    let kinds: &[MethodKind] = match mode {
        Mode::Password => &[MethodKind::Password],
        Mode::PublicKey => &[MethodKind::PublicKey],
        _ => &[MethodKind::KeyboardInteractive],
    };
    MethodSet::from(kinds)
}

impl TestServer {
    /// Rejects the way OpenSSH does: the failed method stays on offer.
    fn reject(&self) -> Auth {
        Auth::Reject {
            proceed_with_methods: Some(methods(self.mode)),
            partial_success: false,
        }
    }
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(match self.mode {
            Mode::Password if password == PASSWORD => {
                self.sign_ins.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Auth::Accept
            }
            _ => self.reject(),
        })
    }

    async fn auth_publickey(&mut self, _user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(match &self.accepted_key {
            Some(accepted) if accepted.key_data() == key.key_data() => Auth::Accept,
            _ => self.reject(),
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let questions: &'static [(Cow<'static, str>, bool)] = match self.mode {
            Mode::InteractivePassword => &[(Cow::Borrowed("Password: "), false)],
            Mode::InteractiveTwoFactor => &[
                (Cow::Borrowed("Password: "), false),
                (Cow::Borrowed("Verification code: "), true),
            ],
            _ => return Ok(self.reject()),
        };
        let Some(response) = response else {
            return Ok(Auth::Partial {
                name: Cow::Borrowed("Sign in"),
                instructions: Cow::Borrowed("Answer to continue"),
                prompts: Cow::Borrowed(questions),
            });
        };
        let answers: Vec<String> = response
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .collect();
        let expected: &[&str] = match self.mode {
            Mode::InteractivePassword => &[PASSWORD],
            _ => &[PASSWORD, CODE],
        };
        Ok(if answers == expected {
            Auth::Accept
        } else {
            self.reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, b"welcome\r\n".to_vec())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, [b"echo:", data].concat())?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    /// A script sent to `sh` has been read: answer as a busy Linux would.
    async fn channel_eof(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.data(channel, b"\ncpu=125\ncores=2\nmem=4000 1000\nuptime=90\ndisk=100 40\n".to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

/// Starts the server on a loopback port and returns that port.
async fn serve(mode: Mode, accepted_key: Option<PublicKey>) -> u16 {
    serve_counting(mode, accepted_key).await.0
}

/// A server, and how many times someone has signed in to it.
async fn serve_counting(mode: Mode, accepted_key: Option<PublicKey>) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    let sign_ins = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let config = Arc::new(server::Config {
        methods: methods(mode),
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        keys: vec![
            PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap(),
        ],
        ..Default::default()
    });
    let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let counted = sign_ins.clone();
    tokio::spawn(async move {
        let mut server = TestServer { mode, accepted_key, sign_ins: counted };
        let _ = server.run_on_socket(config, &socket).await;
    });
    (port, sign_ins)
}

struct Client {
    handle: SessionHandle,
    out: UnboundedReceiver<SessionOutput>,
    screen: Vec<u8>,
    log: Vec<LogEntry>,
    remembered: Vec<Remember>,
    _state: tempfile::TempDir,
}

impl Client {
    fn connect(
        port: u16,
        username: &str,
        password: Option<&str>,
        key: Option<KeyParams>,
    ) -> Client {
        let state = tempfile::tempdir().unwrap();
        let known = Arc::new(Mutex::new(
            KnownHosts::open(state.path().join("known_hosts.json")).unwrap(),
        ));
        let (tx, out) = mpsc::unbounded_channel();
        let params = ConnectParams {
            host: "127.0.0.1".into(),
            port,
            username: username.into(),
            password: password.map(str::to_string),
            key,
            startup: None,
            cols: 80,
            rows: 24,
            agent: Vec::new(),
        };
        Client {
            handle: ssh::spawn(params, known, tx),
            out,
            screen: Vec::new(),
            log: Vec::new(),
            remembered: Vec::new(),
            _state: state,
        }
    }

    /// Next event that needs a reaction. The first-contact host key prompt
    /// is accepted on the way.
    async fn next(&mut self) -> SessionEvent {
        loop {
            match timeout(WAIT, self.out.recv()).await {
                Ok(Some(SessionOutput::Event(event))) => match event {
                    SessionEvent::Stage { .. } | SessionEvent::Banner { .. } => {}
                    SessionEvent::Log { entry } => self.log.push(entry),
                    SessionEvent::Prompt {
                        id,
                        prompt: Prompt::HostKey { .. },
                    } => self.handle.reply(id, PromptReply::Accept).unwrap(),
                    other => return other,
                },
                Ok(Some(SessionOutput::Data(data))) => {
                    self.handle.ack(data.len());
                    self.screen.extend(data);
                }
                Ok(Some(SessionOutput::Remember(secret))) => self.remembered.push(secret),
                Ok(None) => panic!("session ended without a Closed event"),
                Err(_) => panic!("timed out waiting for a session event"),
            }
        }
    }

    async fn expect_connected(&mut self) {
        match self.next().await {
            SessionEvent::Connected => {}
            other => panic!("expected Connected, got {other:?}"),
        }
        // The shell is really usable.
        self.handle.write(b"ping".to_vec()).unwrap();
        let deadline = tokio::time::Instant::now() + WAIT;
        while !String::from_utf8_lossy(&self.screen).contains("echo:ping") {
            match tokio::time::timeout_at(deadline, self.out.recv()).await {
                Ok(Some(SessionOutput::Data(data))) => self.screen.extend(data),
                Ok(Some(SessionOutput::Remember(secret))) => self.remembered.push(secret),
                Ok(Some(_)) => {}
                _ => panic!("no echo from the shell"),
            }
        }
        assert!(String::from_utf8_lossy(&self.screen).contains("welcome"));
    }

    async fn expect_prompt(&mut self) -> (u64, Prompt) {
        match self.next().await {
            SessionEvent::Prompt { id, prompt } => (id, prompt),
            other => panic!("expected a prompt, got {other:?}"),
        }
    }

    async fn expect_closed(&mut self) -> (CloseReason, Option<&'static str>) {
        match self.next().await {
            SessionEvent::Closed { reason, error, .. } => (reason, error.map(|e| e.code)),
            other => panic!("expected Closed, got {other:?}"),
        }
    }

    fn text(&self, id: u64, value: &str, remember: bool) {
        let reply = PromptReply::Text {
            value: value.into(),
            remember,
        };
        self.handle.reply(id, reply).unwrap();
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

impl Client {
    /// The sign-in part of the log, as short words.
    fn auth_story(&self) -> Vec<String> {
        self.log
            .iter()
            .map(brief)
            .filter(|w| !matches!(w.as_str(), "connecting" | "reached" | "host_key:new" | "waiting:host_key" | "host_key_accepted" | "offered" | "shell_opening" | "shell_ready"))
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_log_explains_what_was_tried_and_why_it_failed() {
    // A key is configured, but this server takes passwords only: the log
    // says the key could not even be offered, then how the password fared.
    let port = serve(Mode::Password, None).await;
    let unused = keys::generate(KeyKind::Ed25519, "laptop").unwrap();
    let key = KeyParams {
        id: unused.id,
        label: unused.label.clone(),
        private_key: unused.private_key.clone(),
        passphrase: None,
    };
    let mut client = Client::connect(port, "alice", Some("stale"), Some(key));
    let (id, _) = client.expect_prompt().await;
    assert_eq!(
        client.auth_story(),
        vec!["unavailable:publickey", "try:password:saved", "rejected:password", "waiting:password"]
    );
    match client.log.iter().find(|e| matches!(e, LogEntry::AuthOffered { .. })) {
        Some(LogEntry::AuthOffered { methods }) => assert_eq!(methods, &["password"]),
        other => panic!("{other:?}"),
    }
    client.text(id, PASSWORD, false);
    client.expect_connected().await;
    assert_eq!(
        client.auth_story()[4..],
        ["try:password:typed", "accepted:password"]
    );

    // Giving up after three wrong passwords leaves the trail of all three.
    let mut client = Client::connect(port, "alice", None, None);
    for _ in 0..3 {
        let (id, _) = client.expect_prompt().await;
        client.text(id, "nope", false);
    }
    client.expect_closed().await;
    assert_eq!(
        client.auth_story(),
        vec![
            "waiting:password", "try:password:typed", "rejected:password",
            "waiting:password", "try:password:typed", "rejected:password",
            "waiting:password", "try:password:typed", "rejected:password",
        ]
    );

    // Secrets never appear in the log.
    let text = format!("{:?}", client.log);
    assert!(!text.contains("nope") && !text.contains(PASSWORD));
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_password_connects_without_asking() {
    let port = serve(Mode::Password, None).await;
    let mut client = Client::connect(port, "alice", Some(PASSWORD), None);
    client.expect_connected().await;
    assert!(client.remembered.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_saved_password_falls_back_to_asking() {
    let port = serve(Mode::Password, None).await;
    let mut client = Client::connect(port, "alice", Some("stale"), None);

    let (id, prompt) = client.expect_prompt().await;
    assert!(matches!(prompt, Prompt::Password { ref username, attempt: 1 } if username == "alice"));
    client.text(id, "also wrong", true);

    // A rejected password is never offered for saving.
    let (id, prompt) = client.expect_prompt().await;
    assert!(matches!(prompt, Prompt::Password { attempt: 2, .. }));
    assert!(client.remembered.is_empty());
    client.text(id, PASSWORD, true);

    client.expect_connected().await;
    assert!(matches!(&client.remembered[..], [Remember::Password(p)] if p == PASSWORD));
}

#[tokio::test(flavor = "multi_thread")]
async fn password_is_not_remembered_unless_asked() {
    let port = serve(Mode::Password, None).await;
    let mut client = Client::connect(port, "alice", None, None);
    let (id, _) = client.expect_prompt().await;
    client.text(id, PASSWORD, false);
    client.expect_connected().await;
    assert!(client.remembered.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_username_is_asked_first() {
    let port = serve(Mode::Password, None).await;
    let mut client = Client::connect(port, "  ", Some(PASSWORD), None);
    let (id, prompt) = client.expect_prompt().await;
    assert!(matches!(prompt, Prompt::Username));
    client.text(id, " bob ", true);
    client.expect_connected().await;
    assert!(matches!(&client.remembered[..], [Remember::Username(u)] if u == "bob"));
}

#[tokio::test(flavor = "multi_thread")]
async fn repeated_wrong_passwords_end_in_auth_failure() {
    let port = serve(Mode::Password, None).await;
    let mut client = Client::connect(port, "alice", None, None);
    for attempt in 1..=3 {
        let (id, prompt) = client.expect_prompt().await;
        assert!(matches!(prompt, Prompt::Password { attempt: a, .. } if a == attempt));
        client.text(id, "nope", true);
    }
    assert_eq!(
        client.expect_closed().await,
        (CloseReason::Failed, Some("auth_failed"))
    );
    assert!(client.remembered.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_prompt_closes_quietly() {
    let port = serve(Mode::Password, None).await;
    let mut client = Client::connect(port, "alice", None, None);
    let (id, _) = client.expect_prompt().await;
    client.handle.reply(id, PromptReply::Cancel).unwrap();
    assert_eq!(client.expect_closed().await, (CloseReason::User, None));

    // Closing the session while a prompt is open does the same.
    let mut client = Client::connect(port, "alice", None, None);
    let (id, _) = client.expect_prompt().await;
    client.handle.close();
    assert_eq!(client.expect_closed().await, (CloseReason::User, None));
    assert!(client.handle.reply(id, PromptReply::Cancel).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_password_answers_a_lone_hidden_question() {
    let port = serve(Mode::InteractivePassword, None).await;
    let mut client = Client::connect(port, "alice", Some(PASSWORD), None);
    client.expect_connected().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn two_factor_questions_go_to_the_user() {
    let port = serve(Mode::InteractiveTwoFactor, None).await;
    // The saved password must not be sent blindly into a multi-question form.
    let mut client = Client::connect(port, "alice", Some(PASSWORD), None);

    let (id, prompt) = client.expect_prompt().await;
    match prompt {
        Prompt::KeyboardInteractive {
            name,
            instructions,
            prompts,
        } => {
            assert_eq!(name, "Sign in");
            assert_eq!(instructions, "Answer to continue");
            assert_eq!(prompts.len(), 2);
            assert!(!prompts[0].echo && prompts[1].echo);
            assert_eq!(prompts[1].prompt, "Verification code: ");
        }
        other => panic!("expected a keyboard-interactive prompt, got {other:?}"),
    }
    let reply = PromptReply::Answers {
        values: vec![PASSWORD.into(), "000000".into()],
    };
    client.handle.reply(id, reply).unwrap();

    // Wrong code: asked again, then accepted.
    let (id, _) = client.expect_prompt().await;
    let reply = PromptReply::Answers {
        values: vec![PASSWORD.into(), CODE.into()],
    };
    client.handle.reply(id, reply).unwrap();
    client.expect_connected().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn encrypted_key_asks_for_its_passphrase() {
    let mut rng = russh::keys::key::safe_rng();
    let plain = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
    let locked = plain.encrypt(&mut rng, "open sesame").unwrap();
    let key = || KeyParams {
        id: uuid::Uuid::nil(),
        label: "laptop".into(),
        private_key: locked.to_openssh(LineEnding::LF).unwrap().to_string(),
        passphrase: None,
    };
    let port = serve(Mode::PublicKey, Some(plain.public_key().clone())).await;

    let mut client = Client::connect(port, "alice", None, Some(key()));
    let (id, prompt) = client.expect_prompt().await;
    assert!(
        matches!(prompt, Prompt::KeyPassphrase { ref key_label, attempt: 1 } if key_label == "laptop")
    );
    client.text(id, "wrong", true);
    let (id, prompt) = client.expect_prompt().await;
    assert!(matches!(prompt, Prompt::KeyPassphrase { attempt: 2, .. }));
    client.text(id, "open sesame", true);
    client.expect_connected().await;
    assert!(matches!(
        &client.remembered[..],
        [Remember::Passphrase { passphrase, .. }] if passphrase == "open sesame"
    ));

    // With the passphrase saved there is nothing to ask.
    let mut saved = key();
    saved.passphrase = Some("open sesame".into());
    let mut client = Client::connect(port, "alice", None, Some(saved));
    client.expect_connected().await;

    // A key the server does not accept is a plain authentication failure.
    let other = keys::generate(KeyKind::Ed25519, "other").unwrap();
    let params = KeyParams {
        id: other.id,
        label: other.label,
        private_key: other.private_key,
        passphrase: None,
    };
    let mut client = Client::connect(port, "alice", None, Some(params));
    assert_eq!(
        client.expect_closed().await,
        (CloseReason::Failed, Some("auth_failed"))
    );
}


/// A known-hosts file in which the test server's key is trusted, the way
/// it is once someone has connected and accepted it.
async fn trusting(port: u16) -> (tempfile::TempDir, Arc<Mutex<KnownHosts>>) {
    let state = tempfile::tempdir().unwrap();
    let known = Arc::new(Mutex::new(KnownHosts::open(state.path().join("known_hosts.json")).unwrap()));
    let (tx, out) = mpsc::unbounded_channel();
    let params = ConnectParams {
        host: "127.0.0.1".into(),
        port,
        username: "alice".into(),
        password: Some(PASSWORD.into()),
        key: None,
        startup: None,
        cols: 80,
        rows: 24,
        agent: Vec::new(),
    };
    let mut client = Client {
        handle: ssh::spawn(params, known.clone(), tx),
        out,
        screen: Vec::new(),
        log: Vec::new(),
        remembered: Vec::new(),
        _state: tempfile::tempdir().unwrap(),
    };
    client.expect_connected().await;
    client.handle.close();
    (state, known)
}

fn probe_params(port: u16, password: Option<&str>) -> ConnectParams {
    ConnectParams {
        host: "127.0.0.1".into(),
        port,
        username: "alice".into(),
        password: password.map(str::to_string),
        key: None,
        startup: None,
        cols: 80,
        rows: 24,
        agent: Vec::new(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quiet_look_never_trusts_an_unknown_server() {
    let port = serve(Mode::Password, None).await;
    let state = tempfile::tempdir().unwrap();
    let known = Arc::new(Mutex::new(KnownHosts::open(state.path().join("known_hosts.json")).unwrap()));
    let looked = timeout(WAIT, ssh::probe_stats(probe_params(port, Some(PASSWORD)), known.clone())).await.unwrap();
    assert_eq!(looked.unwrap_err().code(), "host_key_rejected");
    // And nothing was written down about it.
    assert!(known.lock().unwrap().entries().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quiet_look_reads_a_trusted_server_with_what_is_saved() {
    let port = serve(Mode::Password, None).await;
    let (_state, known) = trusting(port).await;
    let stats = timeout(WAIT, ssh::probe_stats(probe_params(port, Some(PASSWORD)), known)).await.unwrap().unwrap();
    assert_eq!(stats.cpu_percent, Some(12.5));
    assert_eq!((stats.mem_total, stats.mem_available, stats.disk_free), (Some(4000), Some(1000), Some(40)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quiet_look_gives_up_rather_than_ask() {
    let port = serve(Mode::Password, None).await;
    let (_state, known) = trusting(port).await;
    // No password saved: a terminal would ask for one; the look ends instead.
    let looked = timeout(WAIT, ssh::probe_stats(probe_params(port, None), known)).await.unwrap();
    assert_eq!(looked.unwrap_err().code(), "cancelled");
}

#[tokio::test(flavor = "multi_thread")]
async fn looks_again_over_the_connection_kept_from_the_last() {
    let (port, sign_ins) = serve_counting(Mode::Password, None).await;
    let (_state, known) = trusting(port).await;
    let before = sign_ins.load(std::sync::atomic::Ordering::SeqCst);
    let probes = Arc::new(ssh::StatsProbes::default());
    for _ in 0..3 {
        let stats = timeout(WAIT, probes.read("h1", probe_params(port, Some(PASSWORD)), known.clone()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stats.cpu_percent, Some(12.5));
    }
    // Three looks, one sign-in.
    assert_eq!(sign_ins.load(std::sync::atomic::Ordering::SeqCst) - before, 1);

    // A host changed since is connected to anew.
    let mut changed = probe_params(port, Some(PASSWORD));
    changed.username = "bob".into();
    timeout(WAIT, probes.read("h1", changed, known.clone())).await.unwrap().unwrap();
    assert_eq!(sign_ins.load(std::sync::atomic::Ordering::SeqCst) - before, 2);
}
