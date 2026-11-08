<div align="center">

<img src=".github/assets/icon.png" width="96" height="96" alt="MySSH icon">

# MySSH

**A fast, lightweight SSH and SFTP client for macOS, Windows and Linux.**<br>
Hosts, terminal, SFTP, port forwarding, snippets and SSH keys in one small app, with end-to-end encrypted sync between devices.

[![Latest release](https://img.shields.io/github/v/release/dev-x64/myssh-app?label=release&color=ff7a45&style=flat-square)](https://github.com/dev-x64/myssh-app/releases/latest)
![macOS](https://img.shields.io/badge/macOS-Apple%20silicon%20%7C%20Intel-1f242c?style=flat-square&logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-1f242c?style=flat-square&logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-x86__64%20AppImage-1f242c?style=flat-square&logo=linux&logoColor=white)
![Built with Rust](https://img.shields.io/badge/core-Rust-1f242c?style=flat-square&logo=rust&logoColor=white)
[![License](https://img.shields.io/badge/license-PolyForm%20Strict-1f242c?style=flat-square)](LICENSE)

[**Website**](https://myssh.app) · [**Download**](https://myssh.app/download/) · [**Security**](https://myssh.app/security/) · [**MySSH vs Termius**](https://myssh.app/vs-termius/) · [**Release notes**](https://github.com/dev-x64/myssh-app/releases)

<br>

<img src=".github/assets/banner.png" alt="MySSH — the lightweight Termius alternative, under 20 MB on Mac" width="820">

</div>

<br>

## Download

| Platform | Requirements | Get it |
| --- | --- | --- |
| **macOS** | macOS 11 or newer, Apple silicon or Intel (one universal app) | [`.dmg`](https://cloud.myssh.app/download?os=mac) |
| **Windows** | Windows 10 or 11, 64-bit | [`setup.exe`](https://cloud.myssh.app/download?os=windows) |
| **Linux** | x86_64 desktop: Ubuntu 22.04+, Debian 12+, Fedora 36+ and other current distributions | [`.AppImage`](https://cloud.myssh.app/download?os=linux) |

Every build is also attached to the [latest release](https://github.com/dev-x64/myssh-app/releases/latest). The app updates itself: updates are signed and checked against a key built into the app before they are installed.

<details>
<summary><b>Install on Linux with one command</b></summary>

<br>

Run as your regular user, without `sudo`:

```sh
curl -q -fsSL https://myssh.app/install.sh | sh
```

The script downloads the latest AppImage to `~/Applications/MySSH.AppImage` and makes it executable. It installs no system packages, touches no SSH keys or settings, and does not launch the app. [Read it](https://myssh.app/install.sh) before running it if you like.

Manual install: download the AppImage, keep it in a permanent folder, run `chmod +x MySSH_*.AppImage` and open it. Some distributions need FUSE 2 installed separately; see the [manual instructions](https://myssh.app/download/#linux-fuse).

</details>

## Why MySSH

- **Small and quick.** The core is written in Rust, with no Electron and no browser bundled inside. The Windows installer is under 7 MB.
- **Free for everything on your computer.** No account needed: hosts, terminal, SFTP, port forwarding, snippets and keys all work locally, and nothing leaves the computer but update checks.
- **Private by design.** Sync is end-to-end encrypted; the server stores only ciphertext. SSH and SFTP go straight from your computer to the server, never through the MySSH cloud.
- **No analytics, no telemetry, no advertising.**
- **Source code in the open.** Everything that runs on your computer is in this repository, so what the app does with your hosts, passwords and keys can be checked rather than taken on trust.

## A look inside

<p align="center">
  <img src=".github/assets/hosts.png" alt="Hosts in a group, with each server's processor, memory and disk load" width="820">
  <br><sub><b>Hosts</b> — groups, tags, search, and each server's load at a glance</sub>
</p>

<p align="center">
  <img src=".github/assets/terminal.png" alt="Terminal suggesting docker commands while typing" width="820">
  <br><sub><b>Terminal</b> — suggestions from history, snippets and the subcommands of docker, git and more</sub>
</p>

<p align="center">
  <img src=".github/assets/sftp.png" alt="Two-pane SFTP file manager: this computer and the server side by side" width="820">
  <br><sub><b>SFTP</b> — over the connection already open, in the folder the terminal is in</sub>
</p>

<p align="center">
  <img src=".github/assets/forwarding.png" alt="Port forwarding: each forward's route drawn from this Mac through the SSH tunnel to the service" width="820">
  <br><sub><b>Port forwarding</b> — every forward in one place, its route drawn as it will work</sub>
</p>

## Features

| | |
| --- | --- |
| 🖥️ **Hosts** | Groups, tags and search by name, address, user, tag or OS. MySSH detects each server's OS, notices hosts that share a login so a password is changed once for all of them, and lets you pin the ones you use most. Advanced mode shows each server's CPU, memory and disk load and whether it is online, read over one connection kept open between looks and paused while the window is hidden. |
| ⌨️ **Terminal** | Suggestions while you type: command history, paths on the server, snippets, container names, and the subcommands of `docker`, `git`, `systemctl`, `apt`, `kubectl` and `npm` with the arguments each takes. Errors, warnings, IP addresses and links stand out. Tabs can be dragged, duplicated, renamed and reconnected, and come back after an update restart. |
| 🔁 **Reconnection** | A dropped connection is noticed within half a minute, or at once when the network changes or the computer wakes, and comes back by itself. |
| 🔐 **Password prompts** | When `sudo`, `su`, `ssh` or another program asks for a password, the saved ones are offered under the prompt: this host's first, the one used there last on top. A click types it in, and it is never kept in the command history. |
| 🎨 **Colour schemes** | MySSH Dark and Light, Nord, Dracula, Aura, Solarized Dark and Light, Monokai, Night Owl. |
| 📁 **SFTP** | Part of every session: one button opens it over the SSH connection already open, with no second sign-in. Two panes, copy both ways, drag files in from Finder or Explorer, change permissions, edit files in the built-in editor or any app on your computer. Copies queue up and run three at a time; a folder can go as a single tar stream, much faster for many small files. |
| 🔀 **Port forwarding** | Local forwards (`ssh -L`) in a section of their own: every host's forwards in view with how each is doing, opened with the session or by hand, and brought back after a reconnection. Forwards from `~/.ssh/config` (`LocalForward`) come along on import. |
| 🪪 **Agent forwarding** | Per host, a server can sign in onwards with your keys (`ssh -A`) for `git pull` or a hop to the next server; each signature is made on your computer and reported in the terminal. Off by default. |
| 🤖 **Coding agents** | Claude Code, Codex and other MCP agents can read, or also type into, the terminal tabs you open to them, and only those. Off until turned on in Settings; then each tab is opened to agents with its own button. |
| ✨ **AI suggestions** | Write what you want in plain words, in any language, and get a command. It is only put on the line — nothing runs until you press Enter — and risky commands are marked. Passwords, tokens and keys are removed on the device before sending. Needs an account; can be turned off. |
| 💻 **Local terminal** | Your own shell — zsh or bash on a Mac, PowerShell on Windows, your shell on Linux — in a tab beside your servers. |
| 📋 **Snippets** | Saved commands and scripts, inserted or run in one click on one host or many at once, each host's progress shown beside its terminal. Scripts are checked as you type (`bash -n`, typos, risky commands, prompts that would wait). MySSH notices commands you run often and offers to save them. |
| 📥 **Import** | From `~/.ssh/config`, FileZilla, MobaXterm, PuTTY and WinSCP found on the computer, or from an export file. Folders become groups, key files go into the keychain. |
| 🔗 **Tailscale** | Import the machines of your tailnet; their tiles show whether they are online and whether they run Tailscale SSH. |
| 🔑 **SSH keys** | Generate Ed25519, ECDSA or RSA keys or import your own (OpenSSH, PEM, PuTTY). Install a key on many servers at once; MySSH confirms each one by signing in with it, and shows which hosts use each key. |
| ☁️ **Sync** <sup>Pro</sup> | Hosts, snippets, settings and trusted server keys follow you between Mac, Windows and Linux, encrypted on the device before they are sent. Different changes to the same host on two devices are merged field by field. |
| 👥 **Shared sessions** <sup>Pro</sup> | Invite someone into your terminal with a link; one person types at a time. Off until you turn it on. |

## Security

- **End-to-end encryption.** Records are encrypted on the device with XChaCha20-Poly1305 before they are sent.
- **Master password never leaves the device.** Argon2id derives an encryption key that stays on the device and a sign-in key, of which the server keeps only a hash.
- **The server sees almost nothing.** Not host names or addresses, logins, passwords, SSH keys, snippets or settings — not even the type of a record.
- **SSH keys sync only if you turn it on** for each key; off by default.
- **Server keys are checked.** A server's fingerprint is shown on first contact, and a changed key stops the connection.
- **Local vault** is one file encrypted with XChaCha20-Poly1305 under a random 256-bit key.
- **Agents are fenced in.** The bridge for coding agents listens only on this computer's loopback, every connection must present a token from a file only your user can read, and it reaches only the tabs you opened to agents.

Where to check it in the code:

| What | Where |
| --- | --- |
| Key derivation, sign-in, what is sent to the server | [`crates/core/src/cloud.rs`](crates/core/src/cloud.rs) |
| Merging synced records | [`crates/core/src/sync.rs`](crates/core/src/sync.rs) |
| The local vault | [`crates/core/src/vault.rs`](crates/core/src/vault.rs), [`crates/core/src/keystore.rs`](crates/core/src/keystore.rs) |
| Server key checks | [`crates/core/src/known_hosts.rs`](crates/core/src/known_hosts.rs) |
| Coding agents' bridge | [`src-tauri/src/agents.rs`](src-tauri/src/agents.rs) |
| A test that the server is never sent names, addresses or secrets | [`crates/core/tests/cloud_sync.rs`](crates/core/tests/cloud_sync.rs) |

The full write-up, including what none of this protects against, is on the [security page](https://myssh.app/security/). Found a vulnerability? Please write to [support@myssh.app](mailto:support@myssh.app) rather than opening a public issue.

## Source code

This repository holds the whole app: the Rust core (`crates/core`), the desktop and Android shell built on [Tauri](https://tauri.app) (`src-tauri`) and the interface in React and TypeScript (`src`). The sync server is not part of it; the app talks to it only through the API in `crates/core/src/cloud.rs`.

To build it yourself you need [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 22 or newer and the [system packages Tauri needs](https://tauri.app/start/prerequisites/) on your platform.

```sh
npm install
npm run tauri dev               # the app, reloading as the sources change
npm run tauri build             # an installer for this system, in target/release/bundle
cargo test -p myssh-core        # the core's tests
npm run ui                      # the interface alone in a browser, with made-up data
```

The sync server's address and the key updates are checked against are taken from `app.config.json` at build time.

## Free and Pro

**Free** covers everything MySSH does on your own computer, with no account and no time limit.<br>
**Pro** is an optional yearly subscription that adds end-to-end encrypted sync, shared terminal sessions and many more AI suggestions. It pays for the sync servers and funds further development. See [myssh.app](https://myssh.app) for the current price.

## License

The source code is published under the [PolyForm Strict License 1.0.0](LICENSE): you may read it, build it and run it for personal and other noncommercial purposes. Copying it into other products, distributing it or modified versions of it, and selling it or anything based on it are not allowed.

The official builds from [myssh.app](https://myssh.app) and the releases here are free to use for any purpose, at work too.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/dev-x64/myssh-app/issues) or write to [support@myssh.app](mailto:support@myssh.app).

<br>

<div align="center">
<sub>MySSH is made by one solo developer. It is not affiliated with Termius; Termius is a trademark of its owner.</sub>
</div>
