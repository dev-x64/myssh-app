//! Reading hosts out of other SSH clients, for the import.
//!
//! Each reader takes what the other app keeps (a file's text, or what the
//! app layer read from the Windows registry, in the same shape) and returns
//! the hosts in it: address, port, user, the folder they sit in, the private
//! key file they use, and a password where the other app keeps one readable.
//! Nothing here touches the disk or the vault; finding the files and saving
//! what was chosen is the app's part.

use std::collections::BTreeMap;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

/// A host found in another app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoundHost {
    pub label: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    /// The folders it sits in, outermost first.
    pub folder: Vec<String>,
    /// The private key file it signs in with, as the other app names it.
    pub key_file: Option<String>,
    /// A password the other app keeps in a form that can be read back.
    pub password: Option<String>,
}

/// The other apps the import knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    OpenSsh,
    MobaXterm,
    Putty,
    WinScp,
    FileZilla,
}

/// An ini file's sections, in order, each with its entries in order.
pub type Ini = Vec<(String, Vec<(String, String)>)>;

/// Reads an ini file. Lines outside any section, comments and lines with
/// no `=` are left out.
pub fn parse_ini(text: &str) -> Ini {
    let mut sections: Ini = Vec::new();
    for line in text.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.to_string(), Vec::new()));
        } else if let (Some((key, value)), Some(section)) = (line.split_once('='), sections.last_mut()) {
            section.1.push((key.trim().to_string(), value.trim().to_string()));
        }
    }
    sections
}

/// Which app a file chosen by hand comes from, by what is in it.
pub fn guess_kind(text: &str) -> SourceKind {
    let head: String = text.chars().take(4000).collect();
    if head.contains("<FileZilla3") {
        SourceKind::FileZilla
    } else if head.contains("[Bookmarks") {
        SourceKind::MobaXterm
    } else if head.contains("[Sessions\\") {
        SourceKind::WinScp
    } else {
        SourceKind::OpenSsh
    }
}

/// Reads a file of any kind the import knows.
pub fn parse_text(kind: SourceKind, text: &str) -> Vec<FoundHost> {
    match kind {
        SourceKind::OpenSsh => parse_ssh_config(text, &|_| None),
        SourceKind::MobaXterm => parse_mobaxterm(&parse_ini(text)),
        SourceKind::WinScp => parse_winscp(&parse_ini(text)),
        SourceKind::FileZilla => parse_filezilla(text),
        SourceKind::Putty => Vec::new(),
    }
}

// ------------------------------------------------------------ OpenSSH ---

/// Reads an OpenSSH client config: one host per name in each `Host` line,
/// leaving out patterns (`*`, `?`, `!`). What a `Host *` block sets is taken
/// for the hosts that do not set it themselves. `include` reads the files an
/// `Include` line names (already resolved by the caller); `None` leaves it.
pub fn parse_ssh_config(text: &str, include: &dyn Fn(&str) -> Option<Vec<String>>) -> Vec<FoundHost> {
    #[derive(Default, Clone)]
    struct Block {
        names: Vec<String>,
        pattern: bool,
        options: BTreeMap<String, String>,
    }
    fn read(text: &str, include: &dyn Fn(&str) -> Option<Vec<String>>, blocks: &mut Vec<Block>, depth: usize) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // `Key value`, `Key=value` or `Key = value`.
            let (key, value) = match line.find(|c: char| c.is_whitespace() || c == '=') {
                Some(at) => (&line[..at], line[at..].trim_start_matches(|c: char| c.is_whitespace() || c == '=')),
                None => continue,
            };
            let key = key.to_ascii_lowercase();
            let value = value.trim().trim_matches('"').to_string();
            match key.as_str() {
                "host" => {
                    let words: Vec<String> = value.split_whitespace().map(str::to_string).collect();
                    let pattern = words.iter().any(|w| w.contains(['*', '?', '!']));
                    blocks.push(Block { names: words, pattern, options: BTreeMap::new() });
                }
                // A `Match` block applies by conditions this cannot weigh; its options are left out.
                "match" => blocks.push(Block { names: Vec::new(), pattern: true, options: BTreeMap::new() }),
                "include" if depth < 5 => {
                    for path in value.split_whitespace() {
                        for text in include(path).unwrap_or_default() {
                            read(&text, include, blocks, depth + 1);
                        }
                    }
                }
                _ => {
                    if blocks.is_empty() {
                        // Options before any `Host` line apply to every host.
                        blocks.push(Block { names: vec!["*".into()], pattern: true, options: BTreeMap::new() });
                    }
                    // The first value given wins, as in ssh itself.
                    blocks.last_mut().unwrap().options.entry(key).or_insert(value);
                }
            }
        }
    }

    let mut blocks = Vec::new();
    read(text, include, &mut blocks, 0);
    let everyone: BTreeMap<String, String> = blocks
        .iter()
        .filter(|b| b.names.iter().any(|n| n == "*") && b.names.len() == 1)
        .flat_map(|b| b.options.clone())
        .collect();

    let mut hosts = Vec::new();
    for block in blocks.iter().filter(|b| !b.pattern) {
        let option = |key: &str| block.options.get(key).or_else(|| everyone.get(key)).cloned();
        for name in &block.names {
            let address = option("hostname").unwrap_or_else(|| name.clone()).replace("%h", name);
            hosts.push(FoundHost {
                label: name.clone(),
                address,
                port: option("port").and_then(|p| p.parse().ok()).unwrap_or(22),
                username: option("user").unwrap_or_default(),
                folder: Vec::new(),
                key_file: option("identityfile").filter(|f| !f.eq_ignore_ascii_case("none")),
                password: None,
            });
        }
    }
    hosts
}

// ---------------------------------------------------------- MobaXterm ---

/// What MobaXterm writes in place of characters its format uses itself.
fn moba_unescape(text: &str) -> String {
    text.replace("__DIEZE__", "#")
        .replace("__PIPE__", "|")
        .replace("__PTVIRG__", ";")
        .replace("__DBLQUO__", "\"")
        .replace("__QUOTE__", "'")
        .replace("__PERCENT__", "%")
}

/// Reads MobaXterm's sessions: `MobaXterm.ini`, an exported
/// `.mxtsessions` file, or the same read from the registry. Only SSH
/// sessions are taken; the folder is the bookmark section's `SubRep`.
/// MobaXterm keeps passwords encrypted under its master password; they
/// are not read.
pub fn parse_mobaxterm(ini: &Ini) -> Vec<FoundHost> {
    let mut hosts = Vec::new();
    for (section, entries) in ini {
        if !section.starts_with("Bookmarks") {
            continue;
        }
        let folder: Vec<String> = entries
            .iter()
            .find(|(k, _)| k == "SubRep")
            .map(|(_, v)| v.split('\\').filter(|p| !p.is_empty()).map(moba_unescape).collect())
            .unwrap_or_default();
        for (name, value) in entries {
            if name == "SubRep" || name == "ImgNum" {
                continue;
            }
            // `#icon#type%host%port%user%…%keyfile%…#font…#…`
            let Some(settings) = value.split('#').nth(2) else { continue };
            let fields: Vec<&str> = settings.split('%').collect();
            if fields.first() != Some(&"0") || fields.len() < 4 {
                continue;
            }
            let address = moba_unescape(fields[1].trim());
            if address.is_empty() {
                continue;
            }
            hosts.push(FoundHost {
                label: moba_unescape(name.trim()),
                address,
                port: fields[2].parse().unwrap_or(22),
                username: moba_unescape(fields[3].trim()),
                folder: folder.clone(),
                key_file: fields.get(14).map(|f| moba_unescape(f.trim())).filter(|f| !f.is_empty()),
                password: None,
            });
        }
    }
    hosts
}

// -------------------------------------------------------------- PuTTY ---

/// Undoes the `%XX` escapes PuTTY and WinSCP use in session names.
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = text.get(i + 1..i + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `user@host` in a host field, as PuTTY allows.
fn split_user(host: &str) -> (Option<&str>, &str) {
    match host.rsplit_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, host),
    }
}

/// Reads PuTTY's saved sessions, as the app layer read them from the
/// registry: each session's name with its values. Only SSH sessions with
/// an address are taken, and not the default settings.
pub fn parse_putty(sessions: &[(String, BTreeMap<String, String>)]) -> Vec<FoundHost> {
    let mut hosts = Vec::new();
    for (name, values) in sessions {
        let name = percent_decode(name);
        let get = |key: &str| values.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if name == "Default Settings" || get("Protocol").is_some_and(|p| p != "ssh") {
            continue;
        }
        let Some(host) = get("HostName") else { continue };
        let (user, address) = split_user(&host);
        hosts.push(FoundHost {
            label: name,
            address: address.to_string(),
            port: get("PortNumber").and_then(|p| p.parse().ok()).unwrap_or(22),
            username: get("UserName").or(user.map(str::to_string)).unwrap_or_default(),
            folder: Vec::new(),
            key_file: get("PublicKeyFile"),
            password: None,
        });
    }
    hosts
}

// ------------------------------------------------------------- WinSCP ---

/// Reads WinSCP's sites, from `WinSCP.ini` or the same read from the
/// registry (`[Sessions\Folder/Site]`). SFTP and SCP sites are taken;
/// FTP and WebDAV ones are not. Passwords are left: WinSCP only hides them.
pub fn parse_winscp(ini: &Ini) -> Vec<FoundHost> {
    let mut hosts = Vec::new();
    for (section, entries) in ini {
        let Some(path) = section.strip_prefix("Sessions\\") else { continue };
        let get = |key: &str| {
            entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty())
        };
        // 0 SCP, 1 SFTP (with SCP fallback), 2 SFTP, 5 FTP, 6 WebDAV, 7 S3.
        if get("FSProtocol").and_then(|p| p.parse::<u8>().ok()).is_some_and(|p| p > 2) {
            continue;
        }
        let Some(host) = get("HostName") else { continue };
        let mut parts: Vec<String> = percent_decode(path).split('/').map(str::to_string).collect();
        let label = parts.pop().unwrap_or_default();
        if label == "Default Settings" {
            continue;
        }
        let (user, address) = split_user(&host);
        hosts.push(FoundHost {
            label,
            address: address.to_string(),
            port: get("PortNumber").and_then(|p| p.parse().ok()).unwrap_or(22),
            username: get("UserName").or(user.map(str::to_string)).unwrap_or_default(),
            folder: parts.into_iter().filter(|p| !p.is_empty()).collect(),
            key_file: get("PublicKeyFile").map(|f| percent_decode(&f)),
            password: None,
        });
    }
    hosts
}

// ---------------------------------------------------------- FileZilla ---

/// Reads FileZilla's Site Manager (`sitemanager.xml`). Only SFTP sites are
/// taken. A password is read when FileZilla keeps it as plain base64; one
/// protected by FileZilla's master password is left.
pub fn parse_filezilla(text: &str) -> Vec<FoundHost> {
    use base64::Engine;

    let mut reader = Reader::from_str(text);
    let mut hosts = Vec::new();
    // Folders open around the current position, each with its name once read.
    let mut folders: Vec<String> = Vec::new();
    let mut in_folder_name = false;
    let mut server: Option<BTreeMap<String, String>> = None;
    let mut field: Option<String> = None;
    let mut base64_pass = false;

    loop {
        let event = match reader.read_event() {
            Ok(event) => event,
            Err(_) => break,
        };
        match event {
            Event::Start(tag) => {
                let name = String::from_utf8_lossy(tag.name().as_ref()).into_owned();
                match name.as_str() {
                    "Folder" => {
                        folders.push(String::new());
                        in_folder_name = true;
                    }
                    "Server" => {
                        in_folder_name = false;
                        server = Some(BTreeMap::new());
                    }
                    _ if server.is_some() => {
                        base64_pass = name == "Pass"
                            && tag.attributes().flatten().any(|a| {
                                a.key.as_ref() == b"encoding" && a.value.as_ref() == b"base64"
                            });
                        field = Some(name);
                    }
                    _ => {}
                }
            }
            Event::Text(text) => {
                let value = text.unescape().map(|t| t.into_owned()).unwrap_or_default();
                if let (Some(server), Some(field)) = (server.as_mut(), field.as_ref()) {
                    let value = if field == "Pass" {
                        if !base64_pass {
                            continue;
                        }
                        let decoded = base64::engine::general_purpose::STANDARD.decode(value.trim()).unwrap_or_default();
                        String::from_utf8(decoded).unwrap_or_default()
                    } else {
                        value
                    };
                    server.insert(field.clone(), value);
                } else if in_folder_name {
                    if let Some(folder) = folders.last_mut() {
                        if folder.is_empty() {
                            *folder = value.trim().to_string();
                        }
                    }
                }
            }
            Event::End(tag) => match tag.name().as_ref() {
                b"Folder" => {
                    folders.pop();
                    in_folder_name = false;
                }
                b"Server" => {
                    if let Some(values) = server.take() {
                        let get = |key: &str| values.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
                        // Protocol 1 is SFTP; the others are FTP of one kind or another.
                        if get("Protocol").as_deref() == Some("1") {
                            if let Some(address) = get("Host") {
                                hosts.push(FoundHost {
                                    label: get("Name").unwrap_or_else(|| address.clone()),
                                    address,
                                    port: get("Port").and_then(|p| p.parse().ok()).unwrap_or(22),
                                    username: get("User").unwrap_or_default(),
                                    folder: folders.iter().filter(|f| !f.is_empty()).cloned().collect(),
                                    key_file: get("Keyfile"),
                                    password: get("Pass"),
                                });
                            }
                        }
                    }
                }
                _ => field = None,
            },
            Event::Eof => break,
            _ => {}
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_hosts_with_defaults_and_includes() {
        let text = r#"
# A comment
Host web prod-web
  HostName 10.0.0.5
  User deploy
  IdentityFile ~/.ssh/deploy_ed25519

Host db
  HostName=db.example.com
  Port 2222

Host *.internal !bastion
  User nobody

Match host foo
  User matcher

Include ~/.orbstack/ssh/config

Host *
  User root
  IdentityFile ~/.ssh/id_ed25519
"#;
        let hosts = parse_ssh_config(text, &|path| {
            (path == "~/.orbstack/ssh/config").then(|| vec!["Host orb\n  HostName 127.0.0.1\n  Port 32222\n".to_string()])
        });
        let labels: Vec<&str> = hosts.iter().map(|h| h.label.as_str()).collect();
        assert_eq!(labels, ["web", "prod-web", "db", "orb"]);
        assert_eq!(hosts[0].address, "10.0.0.5");
        assert_eq!(hosts[0].username, "deploy");
        assert_eq!(hosts[0].key_file.as_deref(), Some("~/.ssh/deploy_ed25519"));
        // What `Host *` sets fills what a host leaves.
        assert_eq!(hosts[2].port, 2222);
        assert_eq!(hosts[2].username, "root");
        assert_eq!(hosts[2].key_file.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(hosts[3].port, 32222);
    }

    #[test]
    fn mobaxterm_sessions_in_folders() {
        let text = "[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\n\
web=#109#0%10.0.0.5%22%root%%-1%-1%%%22%%0%0%0%_ProfileDir_\\.ssh\\id_rsa%%-1%0%0%0%%1080%%0%0%1#MobaFont%10#0# #-1\r\n\
rdp=#91#4%10.0.0.9%3389%admin%0%0%-1%0#MobaFont%10#0# #-1\r\n\
[Bookmarks_1]\r\nSubRep=Clients\\Acme\r\nImgNum=41\r\n\
api__DIEZE__1=#109#0%api.acme.com%2200%deploy%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10#0# #-1\r\n";
        let hosts = parse_mobaxterm(&parse_ini(text));
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].address, "10.0.0.5");
        assert_eq!(hosts[0].username, "root");
        assert_eq!(hosts[0].key_file.as_deref(), Some("_ProfileDir_\\.ssh\\id_rsa"));
        assert!(hosts[0].folder.is_empty());
        assert_eq!(hosts[1].label, "api#1");
        assert_eq!(hosts[1].port, 2200);
        assert_eq!(hosts[1].folder, ["Clients", "Acme"]);
        assert_eq!(hosts[1].key_file, None);
        assert_eq!(guess_kind(text), SourceKind::MobaXterm);
    }

    #[test]
    fn putty_sessions() {
        let mut web = BTreeMap::new();
        web.insert("HostName".into(), "admin@web.example.com".into());
        web.insert("PortNumber".into(), "2222".into());
        web.insert("Protocol".into(), "ssh".into());
        web.insert("PublicKeyFile".into(), "C:\\keys\\web.ppk".into());
        let mut telnet = BTreeMap::new();
        telnet.insert("HostName".into(), "old".into());
        telnet.insert("Protocol".into(), "telnet".into());
        let hosts = parse_putty(&[
            ("My%20Web".into(), web),
            ("old".into(), telnet),
            ("Default%20Settings".into(), BTreeMap::new()),
        ]);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "My Web");
        assert_eq!(hosts[0].username, "admin");
        assert_eq!(hosts[0].address, "web.example.com");
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].key_file.as_deref(), Some("C:\\keys\\web.ppk"));
    }

    #[test]
    fn winscp_sites_in_folders() {
        let text = "[Sessions\\Work/db%20main]\nHostName=db.example.com\nUserName=ops\nPortNumber=2022\nFSProtocol=2\n\
[Sessions\\ftp-site]\nHostName=ftp.example.com\nFSProtocol=5\n[Configuration\\Interface]\nFoo=1\n";
        let hosts = parse_winscp(&parse_ini(text));
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "db main");
        assert_eq!(hosts[0].folder, ["Work"]);
        assert_eq!(hosts[0].port, 2022);
        assert_eq!(guess_kind(text), SourceKind::WinScp);
    }

    #[test]
    fn filezilla_sftp_sites_with_passwords() {
        let text = r#"<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3 version="3.66">
  <Servers>
    <Folder expanded="1">Clients &amp; co
      <Server>
        <Host>sftp.example.com</Host><Port>2222</Port><Protocol>1</Protocol>
        <User>me</User><Pass encoding="base64">c2VjcmV0</Pass><Name>Shop</Name>
      </Server>
      <Server>
        <Host>ftp.example.com</Host><Port>21</Port><Protocol>0</Protocol><Name>Old FTP</Name>
      </Server>
    </Folder>
    <Server>
      <Host>box.example.com</Host><Port>22</Port><Protocol>1</Protocol><User>root</User>
      <Pass encoding="crypt" pubkey="x">abc</Pass><Keyfile>/Users/me/.ssh/box</Keyfile><Name>Box</Name>
    </Server>
  </Servers>
</FileZilla3>"#;
        let hosts = parse_filezilla(text);
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].label, "Shop");
        assert_eq!(hosts[0].folder, ["Clients & co"]);
        assert_eq!(hosts[0].password.as_deref(), Some("secret"));
        assert_eq!(hosts[1].folder, Vec::<String>::new());
        assert_eq!(hosts[1].password, None);
        assert_eq!(hosts[1].key_file.as_deref(), Some("/Users/me/.ssh/box"));
        assert_eq!(guess_kind(text), SourceKind::FileZilla);
    }
}
