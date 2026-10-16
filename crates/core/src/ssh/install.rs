//! Installing a public key on a server through a connection that already
//! works, then proving the key by signing in with it alone.

use super::*;

const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);

pub struct InstallParams {
    /// How to get into the account today.
    pub connect: ConnectParams,
    /// The key being installed; its private part is used only for the check.
    pub key: KeyParams,
    /// The key's `authorized_keys` form: `type base64`.
    pub public_key: String,
    /// A note stored next to the key on the server.
    pub comment: String,
}

/// The note stored next to a key on the server: `myssh-` and its name.
pub fn install_comment(label: &str) -> String {
    format!("myssh-{label}")
}

/// Builds the script that appends the key to `~/.ssh/authorized_keys`. The
/// app shows it before installing, word for word what each server runs.
///
/// It only ever appends. Existing lines, including their options such as
/// `from=` or `command=`, are never rewritten, and a key that is already
/// present in any form is left as it is. Two things are set right either
/// way, without which sshd would refuse the key: others lose the right to
/// write to the folder and the file (nothing else of their permissions
/// changes, and where that is not allowed, as with a file root keeps, it
/// is let be), and where SELinux is at work both get their proper labels,
/// as `ssh-copy-id` gives them (only the type, not the rest of the
/// context).
///
/// The key counts as present only where it stands as a key, after its
/// type, not as some other line's comment; a file that cannot be read is
/// said so, rather than taken for one without the key.
pub fn install_script(public_key: &str, comment: &str) -> Result<String> {
    let mut parts = public_key.split_whitespace();
    let (Some(kind), Some(blob), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(Error::Invalid("the public key is malformed".into()));
    };
    // Both values are placed inside single quotes; nothing that could end
    // the quoting is allowed through.
    let plain = |text: &str, extra: &str| {
        !text.is_empty()
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
    };
    if !plain(kind, "-@.") || !plain(blob, "+/=") {
        return Err(Error::Invalid("the public key is malformed".into()));
    }
    let comment: String = comment
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || "-_.@".contains(*c))
        .take(64)
        .collect();
    let line = format!("{kind} {blob} {comment}");
    let line = line.trim_end();

    Ok(format!(
        r#"umask 077
dir="${{HOME:?}}/.ssh"
file="$dir/authorized_keys"
settle() {{
  chmod go-w "$dir" "$file" 2>/dev/null
  if command -v restorecon >/dev/null 2>&1; then restorecon "$dir" "$file" >/dev/null 2>&1; fi
  return 0
}}
if [ ! -d "$dir" ]; then
  mkdir -p "$dir" && chmod 700 "$dir" || {{ echo "cannot create $dir" >&2; exit 2; }}
fi
if [ -f "$file" ]; then
  awk -v key='{blob}' '
    /^[[:space:]]*#/ {{ next }}
    {{ for (i = 2; i <= NF; i++) if ($i == key && $(i - 1) ~ /^(ssh-|ecdsa-|sk-)/) found = 1 }}
    END {{ exit !found }}' "$file" 2>/dev/null
  case $? in
    0) settle; echo MYSSH_KEY_PRESENT; exit 0 ;;
    1) ;;
    *) echo "cannot read $file" >&2; exit 3 ;;
  esac
fi
if [ -s "$file" ] && [ "$(tail -c 1 "$file" | wc -l)" -eq 0 ]; then
  printf '\n' >> "$file" || {{ echo "cannot write $file" >&2; exit 3; }}
fi
printf '%s\n' '{line}' >> "$file" || {{ echo "cannot write $file" >&2; exit 3; }}
settle
echo MYSSH_KEY_ADDED
"#
    ))
}

/// Starts a key installation. Progress and the outcome arrive as session
/// events: `KeyInstalled`, then `KeyVerified`, then `Closed` — with reason
/// `Exited` on success or `Failed` with the error otherwise.
///
/// Must be called from within a Tokio runtime.
pub fn spawn_install(
    params: InstallParams,
    known_hosts: Arc<Mutex<KnownHosts>>,
    out: mpsc::UnboundedSender<SessionOutput>,
) -> SessionHandle {
    let (commands, mut command_rx) = mpsc::unbounded_channel();
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
    tokio::spawn(async move {
        let closed = async {
            loop {
                match command_rx.recv().await {
                    None | Some(Command::Close) => return,
                    Some(_) => {}
                }
            }
        };
        let outcome = tokio::select! {
            result = install(&params, known_hosts, &io) => result,
            _ = closed => Err(Error::Cancelled),
        };
        let (reason, error) = match outcome {
            Ok(()) => (CloseReason::Exited, None),
            Err(Error::Cancelled) => (CloseReason::User, None),
            Err(e) => (CloseReason::Failed, Some(e.info())),
        };
        io.shared.prompts.lock().unwrap().clear();
        io.event(SessionEvent::Closed {
            reason,
            exit_status: None,
            error,
        });
    });
    SessionHandle { commands, shared }
}

async fn install(
    params: &InstallParams,
    known_hosts: Arc<Mutex<KnownHosts>>,
    io: &Io,
) -> Result<()> {
    let script = install_script(&params.public_key, &params.comment)?;
    let (handle, username) = establish(&params.connect, known_hosts.clone(), io).await?;

    io.stage(Stage::InstallingKey);
    let output = timeout(INSTALL_TIMEOUT, run_script(&handle, &script))
        .await
        .map_err(|_| Error::Timeout)?;
    let _ = handle
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;
    let output = output?;
    let stdout = output.stdout_text();
    let already_present = if stdout.contains("MYSSH_KEY_PRESENT") {
        true
    } else if stdout.contains("MYSSH_KEY_ADDED") {
        false
    } else {
        let stderr = output.stderr_text();
        let cause = stderr.trim();
        return Err(Error::Remote(if cause.is_empty() {
            format!("exit status {:?}", output.exit_status)
        } else {
            cause.to_string()
        }));
    };
    io.event(SessionEvent::KeyInstalled { already_present });

    // The proof: a brand new connection that offers this key and nothing
    // else.
    io.stage(Stage::VerifyingKey);
    let host = &params.connect;
    let mut check = open_transport(&host.host, host.port, known_hosts, io).await?;
    let private = load_key(&params.key, io).await?;
    let hash = check.best_supported_rsa_hash().await?.flatten();
    let key = PrivateKeyWithHashAlg::new(Arc::new(private), hash);
    let accepted = check.authenticate_publickey(&username, key).await?.success();
    let _ = check.disconnect(Disconnect::ByApplication, "", "en").await;
    if !accepted {
        return Err(Error::KeyNotAccepted);
    }
    io.event(SessionEvent::KeyVerified);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_embeds_only_safe_key_text() {
        let script = install_script("ssh-ed25519 AAAAC3Nza+/=", "my laptop; rm -rf ~ 'x'").unwrap();
        assert!(script.contains("'ssh-ed25519 AAAAC3Nza+/= my-laptop-rm--rf--x'"));
        assert!(script.contains("-v key='AAAAC3Nza+/='"));

        for bad in [
            "",
            "ssh-ed25519",
            "ssh-ed25519 AAAA extra",
            "ssh-ed25519 AA'AA",
            "ssh-ed25519 $(id)",
            "ssh-ed'25519 AAAA",
            "ssh-ed25519 AAAA\nssh-rsa BBBB",
        ] {
            assert!(install_script(bad, "c").is_err(), "{bad:?}");
        }
        // An empty comment leaves no trailing space.
        let script = install_script("ssh-ed25519 AAAA", "").unwrap();
        assert!(script.contains("'ssh-ed25519 AAAA'"));
    }

    /// The script itself, run by `sh` in a home of its own.
    #[cfg(unix)]
    #[test]
    fn script_appends_once_and_takes_away_others_write() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};

        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".ssh");
        let file = dir.join("authorized_keys");
        std::fs::create_dir(&dir).unwrap();
        // Another key, its line not ended, and both writable by the group.
        std::fs::write(&file, "ssh-rsa BBBB old").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o775)).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o664)).unwrap();

        let script = install_script("ssh-ed25519 AAAAC3Nza+/=", "laptop").unwrap();
        let run = || {
            let mut child = Command::new("sh")
                .env("HOME", home.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
        };

        assert!(run().contains("MYSSH_KEY_ADDED"));
        assert!(run().contains("MYSSH_KEY_PRESENT"));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "ssh-rsa BBBB old\nssh-ed25519 AAAAC3Nza+/= laptop\n"
        );
        // Only the others' right to write is gone; reading stays as it was.
        let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o755);
        assert_eq!(mode(&file), 0o644);

        // The key as another line's comment, or commented out, is not the key.
        std::fs::write(&file, "ssh-rsa BBBB AAAAC3Nza+/=\n# ssh-ed25519 AAAAC3Nza+/=\n").unwrap();
        assert!(run().contains("MYSSH_KEY_ADDED"));
        // With options before it, it is.
        std::fs::write(&file, "from=\"10.0.0.1\",no-pty ssh-ed25519 AAAAC3Nza+/= old\n").unwrap();
        assert!(run().contains("MYSSH_KEY_PRESENT"));

        // A file that cannot be read is said so, and nothing is added to it.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o200)).unwrap();
        assert!(!run().contains("MYSSH_KEY"));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "from=\"10.0.0.1\",no-pty ssh-ed25519 AAAAC3Nza+/= old\n"
        );
    }
}
