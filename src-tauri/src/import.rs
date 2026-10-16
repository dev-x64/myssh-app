//! The import from other SSH clients: where each keeps its hosts on this
//! computer, and saving the ones chosen into the vault, with their keys.
//! Reading the formats themselves is `myssh_core::import`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use myssh_core::import::{self, FoundHost, SourceKind};
use myssh_core::keys;
use myssh_core::model::{GroupInput, HostAuthInput, HostAuthView, HostInput, Id, SecretInput};
use myssh_core::{Error, Result};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// One app's hosts, found on this computer or in a file chosen by hand.
#[derive(Serialize)]
pub struct ImportSource {
    kind: SourceKind,
    /// Where they were read from: a file, or the Windows registry.
    location: String,
    hosts: Vec<Candidate>,
}

/// A host on offer, with what is known of it here.
#[derive(Serialize)]
pub struct Candidate {
    #[serde(flatten)]
    host: FoundHost,
    /// A host with the same address, port and user is saved already.
    exists: bool,
    /// The key file's name, when it names one.
    key_name: Option<String>,
    /// That file is on this computer and can be read.
    key_found: bool,
}

/// What the import did.
#[derive(Serialize, Default)]
pub struct ImportReport {
    hosts: usize,
    groups: usize,
    keys: usize,
    /// Key files that could not be taken: missing, unreadable, or encrypted
    /// in a form whose public half cannot be read without the passphrase.
    keys_skipped: Vec<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// A key file's path as this computer knows it: `~`, `%d` and MobaXterm's
/// folder names put in. A relative path is taken from the home folder.
fn resolve_key(kind: SourceKind, file: &str) -> Option<PathBuf> {
    let home = home()?;
    let mut text = file.trim().to_string();
    if kind == SourceKind::MobaXterm {
        let env = |name: &str| std::env::var(name).unwrap_or_default();
        for (token, value) in [
            ("_ProfileDir_", home.to_string_lossy().into_owned()),
            ("_MyDocuments_", home.join("Documents").to_string_lossy().into_owned()),
            ("_Desktop_", home.join("Desktop").to_string_lossy().into_owned()),
            ("_AppDataDir_", env("APPDATA")),
            ("_CurrentDrive_", env("SystemDrive")),
        ] {
            text = text.replace(token, &value);
        }
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        return Some(home.join(rest));
    }
    text = text.replace("%d", &home.to_string_lossy());
    let path = PathBuf::from(&text);
    Some(if path.is_absolute() { path } else { home.join(path) })
}

/// The key ssh itself would try first for a host that names none.
fn default_key() -> Option<String> {
    let dir = home()?.join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Puts each host's key file in this computer's terms and says what is known of it.
fn candidates(state: &AppState, kind: SourceKind, hosts: Vec<FoundHost>) -> Result<Vec<Candidate>> {
    let snapshot = state.with_vault(|v| Ok(v.snapshot()))?;
    // Each saved host's address, port and user, to tell what is here already.
    let saved: Vec<(String, u16, String)> = snapshot
        .hosts
        .iter()
        .map(|h| {
            let user = match &h.auth {
                HostAuthView::Inline { username, .. } => username.clone(),
                HostAuthView::Identity { identity_id } => snapshot
                    .identities
                    .iter()
                    .find(|i| i.id == *identity_id)
                    .map(|i| i.username.clone())
                    .unwrap_or_default(),
            };
            (h.address.to_ascii_lowercase(), h.port, user)
        })
        .collect();
    let fallback = if kind == SourceKind::OpenSsh { default_key() } else { None };
    Ok(hosts
        .into_iter()
        .map(|mut host| {
            if host.key_file.is_none() && host.password.is_none() {
                host.key_file = fallback.clone();
            }
            let path = host.key_file.as_deref().and_then(|f| resolve_key(kind, f));
            if let Some(path) = &path {
                host.key_file = Some(path.to_string_lossy().into_owned());
            }
            let exists = saved.iter().any(|(address, port, user)| {
                *address == host.address.to_ascii_lowercase()
                    && *port == host.port
                    && (host.username.is_empty() || *user == host.username)
            });
            Candidate {
                key_name: host
                    .key_file
                    .as_deref()
                    .map(|f| f.rsplit(['/', '\\']).next().unwrap_or(f).to_string()),
                key_found: path.is_some_and(|p| p.is_file()),
                exists,
                host,
            }
        })
        .collect())
}

// ----------------------------------------------------------- Tailscale ---

/// Where the Tailscale command line is, when Tailscale is installed.
fn tailscale_cli() -> Option<PathBuf> {
    let places: &[&str] = if cfg!(target_os = "macos") {
        &["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
    } else if cfg!(windows) {
        &[r"C:\Program Files\Tailscale\tailscale.exe", r"C:\Program Files (x86)\Tailscale\tailscale.exe"]
    } else {
        &["/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale", "/snap/bin/tailscale"]
    };
    places.iter().map(PathBuf::from).find(|path| path.is_file())
}

/// `tailscale status --json`, when Tailscale is installed and running;
/// given up on after a few seconds rather than waited for.
pub fn tailscale_status() -> Option<String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut command = Command::new(tailscale_cli()?);
    command.args(["status", "--json"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        // No console window flashing up for it.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if started.elapsed() > Duration::from_secs(4) => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
        }
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut text).ok()?;
    Some(text)
}

/// A machine of the tailnet as the hosts' tiles need it.
#[derive(Serialize)]
pub struct TailscalePeer {
    /// Its MagicDNS name, without the final dot, and its short name.
    dns: String,
    name: String,
    ips: Vec<String>,
    online: bool,
    /// It runs Tailscale SSH: it lets people of the tailnet in without keys.
    ssh: bool,
}

/// The machines of the tailnet and which of them are online, as Tailscale
/// on this computer knows it; empty when it is not installed or not running.
#[tauri::command]
pub async fn tailscale_peers() -> Vec<TailscalePeer> {
    let text = tauri::async_runtime::spawn_blocking(tailscale_status).await.ok().flatten();
    let Some(status) = text.and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
        return Vec::new();
    };
    status["Peer"]
        .as_object()
        .map(|peers| {
            peers
                .values()
                .map(|peer| TailscalePeer {
                    dns: peer["DNSName"].as_str().unwrap_or("").trim_end_matches('.').to_lowercase(),
                    name: peer["HostName"].as_str().unwrap_or("").to_lowercase(),
                    ips: peer["TailscaleIPs"]
                        .as_array()
                        .map(|ips| ips.iter().filter_map(|ip| ip.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    online: peer["Online"].as_bool().unwrap_or(false),
                    ssh: peer["sshHostKeys"].as_array().is_some_and(|keys| !keys.is_empty()),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ------------------------------------------------------------- finding ---

/// The files an OpenSSH `Include` names, read: `~` and paths relative to
/// `~/.ssh`, and a `*` in the file's name.
fn read_include(path: &str) -> Option<Vec<String>> {
    let home = home()?;
    let path = match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if Path::new(path).is_absolute() => PathBuf::from(path),
        None => home.join(".ssh").join(path),
    };
    let name = path.file_name()?.to_string_lossy().into_owned();
    if !name.contains('*') {
        return std::fs::read_to_string(&path).ok().map(|text| vec![text]);
    }
    let (before, after) = name.split_once('*')?;
    let mut files: Vec<PathBuf> = std::fs::read_dir(path.parent()?)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| {
            let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            n.starts_with(before) && n.ends_with(after) && n.len() >= before.len() + after.len()
        })
        .collect();
    files.sort();
    Some(files.iter().filter_map(|p| std::fs::read_to_string(p).ok()).collect())
}

fn read_file(kind: SourceKind, path: &Path) -> Option<ImportSourceRaw> {
    let text = std::fs::read_to_string(path).ok()?;
    let hosts = match kind {
        SourceKind::OpenSsh => import::parse_ssh_config(&text, &read_include),
        _ => import::parse_text(kind, &text),
    };
    Some(ImportSourceRaw { kind, location: path.to_string_lossy().into_owned(), hosts })
}

struct ImportSourceRaw {
    kind: SourceKind,
    location: String,
    hosts: Vec<FoundHost>,
}

/// Every place on this computer where a known app keeps hosts, read.
fn find_all() -> Vec<ImportSourceRaw> {
    let mut found = Vec::new();
    let Some(home) = home() else { return found };
    found.extend(read_file(SourceKind::OpenSsh, &home.join(".ssh").join("config")));
    if let Some(text) = tailscale_status() {
        found.push(ImportSourceRaw {
            kind: SourceKind::Tailscale,
            location: "tailscale status".into(),
            hosts: import::parse_tailscale(&text),
        });
    }

    #[cfg(not(windows))]
    found.extend(read_file(SourceKind::FileZilla, &home.join(".config/filezilla/sitemanager.xml")));

    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
        if let Some(appdata) = &appdata {
            found.extend(read_file(SourceKind::FileZilla, &appdata.join("FileZilla").join("sitemanager.xml")));
        }
        // MobaXterm: its ini file, installed or portable in Documents; else the registry.
        let moba = appdata
            .iter()
            .map(|a| a.join("MobaXterm").join("MobaXterm.ini"))
            .chain([home.join("Documents").join("MobaXterm").join("MobaXterm.ini")])
            .filter_map(|p| read_file(SourceKind::MobaXterm, &p))
            .find(|s| !s.hosts.is_empty())
            .or_else(registry::mobaxterm);
        found.extend(moba);
        found.extend(registry::putty());
        let winscp = appdata
            .iter()
            .filter_map(|a| read_file(SourceKind::WinScp, &a.join("WinSCP.ini")))
            .find(|s| !s.hosts.is_empty())
            .or_else(registry::winscp);
        found.extend(winscp);
    }
    found.retain(|source| !source.hosts.is_empty());
    found
}

#[cfg(windows)]
mod registry {
    //! What PuTTY, WinSCP and MobaXterm keep in the registry, read into the
    //! shapes their readers take.

    use std::collections::BTreeMap;

    use myssh_core::import::{self, Ini, SourceKind};
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    use super::ImportSourceRaw;

    fn values(key: &RegKey) -> Vec<(String, String)> {
        key.enum_values()
            .flatten()
            .map(|(name, value)| {
                let text = String::from_reg_value(&value)
                    .or_else(|_| u32::from_reg_value(&value).map(|n| n.to_string()))
                    .unwrap_or_default();
                (name, text)
            })
            .collect()
    }

    fn open(path: &str) -> Option<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(path).ok()
    }

    pub fn putty() -> Option<ImportSourceRaw> {
        const PATH: &str = r"Software\SimonTatham\PuTTY\Sessions";
        let root = open(PATH)?;
        let sessions: Vec<(String, BTreeMap<String, String>)> = root
            .enum_keys()
            .flatten()
            .filter_map(|name| Some((name.clone(), values(&root.open_subkey(&name).ok()?).into_iter().collect())))
            .collect();
        Some(ImportSourceRaw {
            kind: SourceKind::Putty,
            location: format!(r"HKEY_CURRENT_USER\{PATH}"),
            hosts: import::parse_putty(&sessions),
        })
    }

    pub fn winscp() -> Option<ImportSourceRaw> {
        const PATH: &str = r"Software\Martin Prikryl\WinSCP 2\Sessions";
        let root = open(PATH)?;
        let ini: Ini = root
            .enum_keys()
            .flatten()
            .filter_map(|name| Some((format!("Sessions\\{name}"), values(&root.open_subkey(&name).ok()?))))
            .collect();
        Some(ImportSourceRaw {
            kind: SourceKind::WinScp,
            location: format!(r"HKEY_CURRENT_USER\{PATH}"),
            hosts: import::parse_winscp(&ini),
        })
    }

    pub fn mobaxterm() -> Option<ImportSourceRaw> {
        const PATH: &str = r"Software\Mobatek\MobaXterm";
        let root = open(PATH)?;
        let ini: Ini = root
            .enum_keys()
            .flatten()
            .filter(|name| name.starts_with("Bookmarks"))
            .filter_map(|name| Some((name.clone(), values(&root.open_subkey(&name).ok()?))))
            .collect();
        Some(ImportSourceRaw {
            kind: SourceKind::MobaXterm,
            location: format!(r"HKEY_CURRENT_USER\{PATH}"),
            hosts: import::parse_mobaxterm(&ini),
        })
    }
}

// ------------------------------------------------------------ commands ---

/// Every known app's hosts found on this computer.
#[tauri::command]
pub async fn import_scan(state: State<'_, AppState>) -> Result<Vec<ImportSource>> {
    let found = tauri::async_runtime::spawn_blocking(find_all)
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;
    found
        .into_iter()
        .map(|raw| {
            Ok(ImportSource {
                kind: raw.kind,
                location: raw.location,
                hosts: candidates(&state, raw.kind, raw.hosts)?,
            })
        })
        .collect()
}

/// The hosts in a file chosen by hand; which app it is from is told by
/// what is in it.
#[tauri::command]
pub fn import_file(state: State<'_, AppState>, path: String) -> Result<ImportSource> {
    let text = std::fs::read_to_string(&path).map_err(|e| Error::Invalid(format!("cannot read the file: {e}")))?;
    let kind = import::guess_kind(&text);
    let hosts = match kind {
        SourceKind::OpenSsh => import::parse_ssh_config(&text, &read_include),
        _ => import::parse_text(kind, &text),
    };
    Ok(ImportSource { kind, location: path, hosts: candidates(&state, kind, hosts)? })
}

/// Saves the chosen hosts: their folders as groups (joining groups of the
/// same name where they are), their key files into the keychain (one
/// already there is used, not copied), and a password where one came along.
#[tauri::command]
pub async fn import_apply(state: State<'_, AppState>, hosts: Vec<FoundHost>) -> Result<ImportReport> {
    // Key files are read and parsed before the vault is touched.
    let files: Vec<String> = {
        let mut files: Vec<String> = hosts.iter().filter_map(|h| h.key_file.clone()).collect();
        files.sort();
        files.dedup();
        files
    };
    let read = tauri::async_runtime::spawn_blocking(move || {
        files
            .into_iter()
            .map(|file| {
                let label = Path::new(&file)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| file.clone());
                let key = std::fs::read_to_string(&file).ok().and_then(|text| keys::import_found(&text, &label).ok());
                (file, label, key)
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?;

    state.with_vault(|vault| {
        let mut report = ImportReport::default();
        let snapshot = vault.snapshot();

        let mut key_ids: HashMap<String, Id> = HashMap::new();
        for (file, label, key) in read {
            let Some(key) = key else {
                report.keys_skipped.push(label);
                continue;
            };
            let id = match snapshot.keys.iter().find(|k| k.fingerprint == key.fingerprint) {
                Some(existing) => existing.id,
                None => {
                    report.keys += 1;
                    vault.add_key(key)?.id
                }
            };
            key_ids.insert(file, id);
        }

        let mut groups: BTreeMap<Vec<String>, Id> = BTreeMap::new();
        let mut known = snapshot.groups.clone();
        for host in hosts {
            let mut parent: Option<Id> = None;
            for depth in 1..=host.folder.len() {
                let path = host.folder[..depth].to_vec();
                let name = path[depth - 1].clone();
                let id = match groups.get(&path) {
                    Some(id) => *id,
                    None => {
                        let id = match known.iter().find(|g| g.parent_id == parent && g.name == name) {
                            Some(group) => group.id,
                            None => {
                                report.groups += 1;
                                let group = vault.save_group(GroupInput { id: None, name, parent_id: parent })?;
                                known.push(group.clone());
                                group.id
                            }
                        };
                        groups.insert(path, id);
                        id
                    }
                };
                parent = Some(id);
            }
            vault.save_host(HostInput {
                id: None,
                label: host.label,
                address: host.address,
                port: Some(host.port),
                group_id: parent,
                tags: host.tags,
                auth: HostAuthInput::Inline {
                    username: host.username,
                    password: host.password.map(SecretInput::Set).unwrap_or_default(),
                    key_id: host.key_file.and_then(|f| key_ids.get(&f).copied()),
                },
                startup_snippet_id: None,
            })?;
            report.hosts += 1;
        }
        Ok(report)
    })
}
