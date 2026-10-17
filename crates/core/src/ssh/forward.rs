//! Port forwarding over a session's connection, as `ssh -L` does it: a port
//! on this computer whose connections are carried through the session to an
//! address as the server sees it.
//!
//! The port listens on this computer only (127.0.0.1, and ::1 where there
//! is IPv6), never on the network. Each connection to it opens a channel of
//! the session's connection; no new sign-in happens. The forward lives as
//! long as its [`Forward`]: dropping it closes the port and every connection
//! it carries.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::timeout;

use super::{SessionHandle, Shared};
use crate::{now_ms, Error, Result};

/// How long the server may take to reach the address on its side.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// Where a forwarded port leads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForwardTarget {
    /// The port on this computer; 0 lets the system choose one.
    pub local_port: u16,
    /// As the server sees it: `localhost` is the server itself.
    pub remote_host: String,
    pub remote_port: u16,
}

/// How a forward is doing.
#[derive(Debug, Clone, Serialize)]
pub struct ForwardStatus {
    /// The port it listens on here.
    pub local_port: u16,
    /// Connections being carried now.
    pub open: usize,
    /// Connections carried since it was opened.
    pub total: u64,
    /// Why the latest connection could not be put through; cleared by the
    /// next one that is.
    pub failure: Option<ForwardFailure>,
}

/// A connection the server could not put through.
#[derive(Debug, Clone, Serialize)]
pub struct ForwardFailure {
    /// `refused`: nothing answered at the address on the server's side;
    /// `prohibited`: the server does not allow forwarding; `timeout`;
    /// `closed`: the session is not connected; `other`.
    pub code: &'static str,
    pub detail: Option<String>,
    pub at: i64,
}

#[derive(Default)]
struct Counters {
    open: AtomicUsize,
    total: AtomicU64,
    failure: Mutex<Option<ForwardFailure>>,
}

impl Counters {
    fn fail(&self, code: &'static str, detail: Option<String>) {
        *self.failure.lock().unwrap() = Some(ForwardFailure {
            code,
            detail,
            at: now_ms(),
        });
    }
}

/// An open forward. Dropping it closes the port and its connections.
pub struct Forward {
    port: u16,
    counters: Arc<Counters>,
    // Its receivers learn of the drop and stop.
    _stop: watch::Sender<()>,
}

impl std::fmt::Debug for Forward {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Forward").field("port", &self.port).finish_non_exhaustive()
    }
}

impl Forward {
    pub fn local_port(&self) -> u16 {
        self.port
    }

    pub fn status(&self) -> ForwardStatus {
        ForwardStatus {
            local_port: self.port,
            open: self.counters.open.load(Ordering::Acquire),
            total: self.counters.total.load(Ordering::Acquire),
            failure: self.counters.failure.lock().unwrap().clone(),
        }
    }
}

impl SessionHandle {
    /// Opens a port on this computer that leads through this session's
    /// connection to `target`. The session must be connected; the port is
    /// taken at once, so a port in use is reported here.
    pub async fn forward_local(&self, target: ForwardTarget) -> Result<Forward> {
        self.connection()?;
        if target.remote_host.is_empty() || target.remote_port == 0 {
            return Err(Error::Invalid("the forward has no destination".into()));
        }
        let (listeners, port) = bind(target.local_port).await?;
        let (stop, stopped) = watch::channel(());
        let counters = Arc::new(Counters::default());
        let target = Arc::new(target);
        for listener in listeners {
            tokio::spawn(listen(
                listener,
                self.shared.clone(),
                target.clone(),
                counters.clone(),
                stopped.clone(),
            ));
        }
        Ok(Forward {
            port,
            counters,
            _stop: stop,
        })
    }
}

/// Listens on the loopback addresses: IPv4 always, IPv6 as well where the
/// system has it, on the same port, since `localhost` may mean either.
async fn bind(port: u16) -> Result<(Vec<TcpListener>, u16)> {
    // A forward just closed on this port lets go of it a moment later, as
    // its listener notices: a port in use is tried again for that long.
    let mut tries = 0;
    let v4 = loop {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => break listener,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && port != 0 && tries < 10 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => return Err(bind_error(e, port)),
        }
    };
    let port = v4.local_addr()?.port();
    let mut listeners = vec![v4];
    if let Ok(v6) = TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await {
        listeners.push(v6);
    }
    Ok((listeners, port))
}

fn bind_error(e: std::io::Error, port: u16) -> Error {
    match e.kind() {
        std::io::ErrorKind::AddrInUse => Error::PortInUse(port),
        _ => Error::Io(e),
    }
}

async fn listen(
    listener: TcpListener,
    shared: Arc<Shared>,
    target: Arc<ForwardTarget>,
    counters: Arc<Counters>,
    mut stopped: watch::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = stopped.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((socket, peer)) => {
                    tokio::spawn(carry(
                        socket,
                        peer,
                        shared.clone(),
                        target.clone(),
                        counters.clone(),
                        stopped.clone(),
                    ));
                }
                // Out of file handles and the like: let it pass, not spin.
                Err(e) => {
                    log::warn!("port {} could not accept a connection: {e}", target.local_port);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            },
        }
    }
}

/// Puts one connection through to the server's side and carries it both
/// ways until either end closes it or the forward is closed.
async fn carry(
    mut socket: TcpStream,
    peer: SocketAddr,
    shared: Arc<Shared>,
    target: Arc<ForwardTarget>,
    counters: Arc<Counters>,
    mut stopped: watch::Receiver<()>,
) {
    let _ = socket.set_nodelay(true);
    let connection = shared.connection.lock().unwrap().clone();
    let Some(connection) = connection else {
        counters.fail("closed", None);
        return;
    };
    let opening = connection.channel_open_direct_tcpip(
        target.remote_host.clone(),
        u32::from(target.remote_port),
        peer.ip().to_string(),
        u32::from(peer.port()),
    );
    let channel = tokio::select! {
        _ = stopped.changed() => return,
        opened = timeout(OPEN_TIMEOUT, opening) => match opened {
            Ok(Ok(channel)) => channel,
            Ok(Err(e)) => {
                let (code, detail) = describe(e);
                counters.fail(code, detail);
                return;
            }
            Err(_) => {
                counters.fail("timeout", None);
                return;
            }
        },
    };
    drop(connection);

    counters.open.fetch_add(1, Ordering::AcqRel);
    counters.total.fetch_add(1, Ordering::AcqRel);
    *counters.failure.lock().unwrap() = None;
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = stopped.changed() => {}
        _ = tokio::io::copy_bidirectional(&mut socket, &mut stream) => {}
    }
    counters.open.fetch_sub(1, Ordering::AcqRel);
}

fn describe(e: russh::Error) -> (&'static str, Option<String>) {
    use russh::ChannelOpenFailure as Why;
    match e {
        russh::Error::ChannelOpenFailure(Why::ConnectFailed) => ("refused", None),
        russh::Error::ChannelOpenFailure(Why::AdministrativelyProhibited) => ("prohibited", None),
        russh::Error::ChannelOpenFailure(Why::Other { reason, .. }) if !reason.is_empty() => {
            ("other", Some(reason))
        }
        russh::Error::Disconnect | russh::Error::SendError | russh::Error::HUP => ("closed", None),
        other => ("other", Some(other.to_string())),
    }
}
