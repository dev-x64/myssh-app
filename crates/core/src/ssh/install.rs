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

/// Builds the script that appends the key to `~/.ssh/authorized_keys`.
///
/// It only ever appends. Existing lines, including their options such as
/// `from=` or `command=`, are never rewritten, and a key that is already
/// present in any form is left as it is.
fn install_script(public_key: &str, comment: &str) -> Result<String> {
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
if [ ! -d "$dir" ]; then
  mkdir -p "$dir" && chmod 700 "$dir" || {{ echo "cannot create $dir" >&2; exit 2; }}
fi
if [ -f "$file" ] && awk -v key='{blob}' '
  /^[[:space:]]*#/ {{ next }}
  {{ for (i = 1; i <= NF; i++) if ($i == key) found = 1 }}
  END {{ exit !found }}' "$file"; then
  echo MYSSH_KEY_PRESENT
  exit 0
fi
if [ -s "$file" ] && [ "$(tail -c 1 "$file" | wc -l)" -eq 0 ]; then
  printf '\n' >> "$file" || {{ echo "cannot write $file" >&2; exit 3; }}
fi
printf '%s\n' '{line}' >> "$file" || {{ echo "cannot write $file" >&2; exit 3; }}
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
}
