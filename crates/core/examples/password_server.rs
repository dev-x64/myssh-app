//! A throwaway SSH server for trying password logins by hand.
//!
//!     cargo run -p myssh-core --example password_server -- 2223 secret
//!
//! Accepts any user with the given password and echoes input back. It has a
//! fresh host key on every start, so reconnecting after a restart also shows
//! the "server key changed" warning.

use std::sync::Arc;
use std::time::Duration;

use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use tokio::net::TcpListener;

#[derive(Clone)]
struct EchoServer {
    password: String,
}

impl server::Server for EchoServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for EchoServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == self.password {
            Auth::Accept
        } else {
            // Like OpenSSH, keep offering the password method after a miss.
            Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[MethodKind::Password][..])),
                partial_success: false,
            }
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
        session.data(channel, b"echo server: type to see it back, Ctrl+D to exit\r\n".to_vec())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if data == [4] {
            session.exit_status_request(channel, 0)?;
            session.close(channel)?;
            return Ok(());
        }
        let echoed: Vec<u8> = data
            .iter()
            .flat_map(|&b| if b == b'\r' { vec![b'\r', b'\n'] } else { vec![b] })
            .collect();
        session.data(channel, echoed)?;
        Ok(())
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(2223);
    let password = args.next().unwrap_or_else(|| "secret".to_string());

    let config = Arc::new(server::Config {
        methods: MethodSet::from(&[MethodKind::Password][..]),
        auth_rejection_time: Duration::from_millis(300),
        auth_rejection_time_initial: Some(Duration::ZERO),
        keys: vec![PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519)
            .expect("host key")],
        ..Default::default()
    });
    let socket = TcpListener::bind(("127.0.0.1", port)).await?;
    println!("listening on 127.0.0.1:{port}, password: {password}");
    EchoServer { password }.run_on_socket(config, &socket).await
}
