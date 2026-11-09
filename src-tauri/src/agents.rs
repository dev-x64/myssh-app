//! Coding agents at the terminals the user lets them use.
//!
//! An agent such as Claude Code or Codex starts this very program as its
//! MCP server: `myssh mcp`, speaking JSON-RPC on its standard input and
//! output (see [`bridge`]). That process answers the agent's questions
//! about the server by itself, and passes each tool call on to the running
//! app over a socket on this computer's loopback, where the window carries
//! it out on a terminal the user has opened to agents, and only there.
//!
//! The app says where it listens in a file of its data folder that only
//! this user can read: the port, and a token every connection opens with.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

/// Where the running app says it listens, in its data folder.
const ENDPOINT_FILE: &str = "agents.json";
/// The app's identifier, as its data folder is named.
const IDENTIFIER: &str = "app.myssh.desktop";
/// The window carries out a tool call.
const CALL_EVENT: &str = "agent-call";
/// The agents connected have changed.
const CLIENTS_EVENT: &str = "agent-clients";

#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

/// What opens every connection to the app.
#[derive(Serialize, Deserialize)]
struct Hello {
    token: String,
    /// The agent's own name for itself, as it introduced itself over MCP.
    client: String,
}

/// A tool call passed on to the app, and its answer.
#[derive(Serialize, Deserialize)]
struct Call {
    id: u64,
    tool: String,
    arguments: Value,
}

#[derive(Serialize, Deserialize, Clone)]
struct Answer {
    id: u64,
    text: String,
    error: bool,
}

/// An agent connected, as the window is told of it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    /// The agent's own name for itself.
    name: String,
    /// When it last called a tool, in milliseconds since 1970: an agent
    /// connects as soon as its session starts, whether it uses MySSH or not.
    last_call: Option<u64>,
}

/// The tool calls waiting for the window, and the agents connected.
#[derive(Default)]
pub struct Agents {
    pending: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
    next: AtomicU64,
    clients: Mutex<HashMap<u64, Client>>,
    /// Held while the app listens for agents; dropped, it stops listening
    /// and lets go of every agent connected.
    running: Mutex<Option<tokio::sync::watch::Sender<()>>>,
}

impl Agents {
    fn clients(&self) -> Vec<Client> {
        let mut clients: Vec<Client> = self.clients.lock().unwrap().values().cloned().collect();
        clients.sort_by(|a, b| a.name.cmp(&b.name));
        clients
    }
}

/// Notes that a connection's agent is at work, and tells the window.
fn touch(app: &AppHandle, connection: u64) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64);
    let agents = app.state::<Agents>();
    if let Some(client) = agents.clients.lock().unwrap().get_mut(&connection) {
        client.last_call = Some(now);
    }
    let _ = app.emit(CLIENTS_EVENT, agents.clients());
}

/// The app's data folder, as the app itself has it.
fn data_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(dir) = std::env::var_os("MYSSH_DATA_DIR") {
            return Some(PathBuf::from(dir));
        }
    }
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        home()?.join("Library/Application Support")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| home().map(|home| home.join(".local/share")))?
    };
    let dir = base.join(IDENTIFIER);
    Some(if cfg!(debug_assertions) { dir.join("dev") } else { dir })
}

/// Writes a file only this user can read.
fn write_private(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&tmp)?.write_all(content)?;
    std::fs::rename(&tmp, path)
}

// ------------------------------------------------------------------ app ---

/// Starts listening for agents, and says where in the data folder. Does
/// nothing if the app listens already.
fn start(app: &AppHandle, data_dir: PathBuf) {
    let agents = app.state::<Agents>();
    let mut running = agents.running.lock().unwrap();
    if running.is_some() {
        return;
    }
    let (stop, stopped) = tokio::sync::watch::channel(());
    *running = Some(stop);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(listener) => listener,
            Err(e) => {
                log::error!("agents: cannot listen: {e}");
                return;
            }
        };
        let Ok(address) = listener.local_addr() else { return };
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let endpoint = Endpoint { port: address.port(), token: token.clone() };
        let path = data_dir.join(ENDPOINT_FILE);
        let written = serde_json::to_vec(&endpoint)
            .map_err(std::io::Error::other)
            .and_then(|json| write_private(&path, &json));
        if let Err(e) = written {
            log::error!("agents: cannot write the endpoint: {e}");
            return;
        }
        let token = Arc::new(token);
        let mut until = stopped.clone();
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = until.changed() => break,
            };
            let Ok((stream, peer)) = accepted else { continue };
            if !peer.ip().is_loopback() {
                continue;
            }
            let app = app.clone();
            let token = token.clone();
            let mut until = stopped.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = serve(app, stream, &token) => {}
                    _ = until.changed() => {}
                }
            });
        }
        // Turned off: nobody is to find the way in any more.
        let _ = std::fs::remove_file(&path);
    });
}

/// What a run before this one said about where it listened: no longer true.
pub fn forget(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(ENDPOINT_FILE));
}

/// Stops listening, and lets go of the agents connected.
fn stop(app: &AppHandle) {
    let agents = app.state::<Agents>();
    let Some(running) = agents.running.lock().unwrap().take() else { return };
    drop(running);
    agents.clients.lock().unwrap().clear();
    for (id, send) in agents.pending.lock().unwrap().drain() {
        let _ = send.send(Answer {
            id,
            text: "The user has turned agents off in MySSH.".into(),
            error: true,
        });
    }
    let _ = app.emit(CLIENTS_EVENT, Vec::<Client>::new());
}

/// Agents are let in, or kept out, as the user turns them on or off in Settings.
#[tauri::command]
pub fn agent_listen(app: AppHandle, state: tauri::State<'_, crate::state::AppState>, on: bool) {
    if on {
        start(&app, state.data_dir.clone());
    } else {
        stop(&app);
    }
}

/// One agent's connection: its hello, then tool calls, each answered when
/// the window has carried it out, in whatever order they finish.
async fn serve(app: AppHandle, stream: tokio::net::TcpStream, token: &str) {
    let (read, write) = stream.into_split();
    let mut lines = tokio::io::BufReader::new(read).lines();
    let hello = match tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await {
        Ok(Ok(Some(line))) => serde_json::from_str::<Hello>(&line).ok(),
        _ => None,
    };
    let Some(hello) = hello.filter(|hello| hello.token == token) else { return };
    let agents = app.state::<Agents>();
    let connection = agents.next.fetch_add(1, Ordering::Relaxed);
    let client = hello.client.chars().take(60).collect::<String>();
    agents.clients.lock().unwrap().insert(connection, Client { name: client.clone(), last_call: None });
    let _ = app.emit(CLIENTS_EVENT, agents.clients());

    let write = Arc::new(tokio::sync::Mutex::new(write));
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(call) = serde_json::from_str::<Call>(&line) else { continue };
        let app = app.clone();
        let write = write.clone();
        let client = client.clone();
        touch(&app, connection);
        tauri::async_runtime::spawn(async move {
            let answer = carry_out(&app, &client, call).await;
            // A long command counts as work until it is done.
            touch(&app, connection);
            let Ok(mut json) = serde_json::to_vec(&answer) else { return };
            json.push(b'\n');
            let _ = write.lock().await.write_all(&json).await;
        });
    }

    let agents = app.state::<Agents>();
    agents.clients.lock().unwrap().remove(&connection);
    let _ = app.emit(CLIENTS_EVENT, agents.clients());
}

/// Hands a call to the window and waits for what it says: longer for a
/// command, which may take its time.
async fn carry_out(app: &AppHandle, client: &str, call: Call) -> Answer {
    let agents = app.state::<Agents>();
    let id = agents.next.fetch_add(1, Ordering::Relaxed);
    let (send, receive) = oneshot::channel();
    agents.pending.lock().unwrap().insert(id, send);
    let wait = call
        .arguments
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .map_or(30, |seconds| seconds.clamp(1, 600) + 15);
    let emitted = app.emit(
        CALL_EVENT,
        json!({ "id": id, "client": client, "tool": call.tool, "arguments": call.arguments }),
    );
    let answer = match emitted {
        Ok(()) => tokio::time::timeout(Duration::from_secs(wait), receive).await.ok().and_then(Result::ok),
        Err(_) => None,
    };
    agents.pending.lock().unwrap().remove(&id);
    match answer {
        Some(answer) => Answer { id: call.id, ..answer },
        None => Answer {
            id: call.id,
            text: "MySSH did not answer in time. Is its window open?".into(),
            error: true,
        },
    }
}

/// The window's answer to a tool call.
#[tauri::command]
pub fn agent_reply(agents: tauri::State<'_, Agents>, id: u64, text: String, error: bool) {
    if let Some(send) = agents.pending.lock().unwrap().remove(&id) {
        let _ = send.send(Answer { id, text, error });
    }
}

#[derive(Serialize)]
pub struct AgentInfo {
    /// The program an agent is to start as its MCP server, with `mcp`.
    program: String,
    /// The agents connected now.
    clients: Vec<Client>,
}

#[tauri::command]
pub fn agent_info(agents: tauri::State<'_, Agents>) -> AgentInfo {
    AgentInfo {
        program: std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "myssh".into()),
        clients: agents.clients(),
    }
}

// --------------------------------------------------------------- bridge ---

const INSTRUCTIONS: &str = "MySSH is the user's SSH client. These tools reach only the terminal tabs \
the user has opened to agents in MySSH (the robot button in a tab's toolbar), each either to be read \
or also to be typed into. Start with list_terminals. Commands run in the user's own live session, as \
the user: they are visible to them, and they act on real servers, so be careful with anything that \
changes or deletes. Prefer run_command for ordinary commands; use send_input for answering prompts, \
pressing keys (\\u0003 is Ctrl+C) or working in full-screen programs, then read_terminal.";

fn tools() -> Value {
    let terminal = json!({
        "type": "string",
        "description": "The terminal's id, as list_terminals gives it."
    });
    json!([
        {
            "name": "list_terminals",
            "title": "List terminals",
            "description": "Lists the MySSH terminal tabs the user has opened to agents: id, title, server, \
                whether connected, the access given (read, or read and type) and the working directory.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_terminal",
            "title": "Read terminal",
            "description": "Returns the text of a terminal: its last lines, scrollback included, as the user sees them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal": terminal,
                    "lines": {
                        "type": "integer",
                        "description": "How many of the last lines to return (default 100, at most 5000).",
                        "minimum": 1,
                        "maximum": 5000
                    }
                },
                "required": ["terminal"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "run_command",
            "title": "Run command",
            "description": "Types a shell command into a terminal and presses Enter, waits until the shell's \
                prompt is back, and returns what the command printed. Needs the access to type. If the \
                command is still running when the time is up, says so and returns what it has printed so \
                far; it keeps running (stop it with send_input \\u0003).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal": terminal,
                    "command": { "type": "string", "description": "The command line to run." },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "How long to wait for it to finish (default 60, at most 600).",
                        "minimum": 1,
                        "maximum": 600
                    }
                },
                "required": ["terminal", "command"]
            },
            "annotations": { "destructiveHint": true, "openWorldHint": true }
        },
        {
            "name": "send_input",
            "title": "Send input",
            "description": "Types text into a terminal exactly as given, as keys pressed: nothing is added, so \
                end it with \\r to press Enter. Control keys are characters: \\u0003 is Ctrl+C, \\u0004 \
                Ctrl+D, \\u001b Escape, \\u001b[A the up arrow. Needs the access to type. Returns the \
                terminal's last lines a moment later.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal": terminal,
                    "text": { "type": "string", "description": "What to type." }
                },
                "required": ["terminal", "text"]
            },
            "annotations": { "destructiveHint": true, "openWorldHint": true }
        }
    ])
}

/// How often a bridge with no connection looks for the app: a file read
/// and a refused connection on this computer, nothing more.
const RECONNECT_EVERY: Duration = Duration::from_secs(3);

/// The connection to the running app, made when the agent says hello and
/// again whenever it has gone (the app was closed and opened again).
struct Link {
    client: Mutex<String>,
    /// The connection calls go out on, numbered: the one it was is let go
    /// of when the app closes it, and the next call makes another.
    write: Arc<Mutex<Option<(u64, std::net::TcpStream)>>>,
    connections: AtomicU64,
    /// Whether the thread that keeps the connection up is running.
    watching: AtomicBool,
    waiting: Arc<Mutex<HashMap<u64, mpsc::Sender<Answer>>>>,
    next: AtomicU64,
}

/// What a call waiting when the app let go of the connection is told.
const CUT_OFF: &str = "MySSH closed the connection while the call was running: it was quit, \
    or agents were turned off in its Settings.";

impl Link {
    fn connect(&self) -> Result<(u64, std::net::TcpStream), String> {
        let not_running = "MySSH is not running, or agents are turned off in its Settings. Ask the user to open MySSH \
            and turn on Settings → Agents."
            .to_string();
        let path = data_dir().ok_or_else(|| not_running.clone())?.join(ENDPOINT_FILE);
        let endpoint: Endpoint = std::fs::read(&path)
            .ok()
            .and_then(|json| serde_json::from_slice(&json).ok())
            .ok_or_else(|| not_running.clone())?;
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", endpoint.port)).map_err(|_| not_running)?;
        let hello = Hello { token: endpoint.token, client: self.client.lock().unwrap().clone() };
        let mut line = serde_json::to_vec(&hello).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stream.write_all(&line).map_err(|e| e.to_string())?;
        // Answers come back in their own time, each to the call waiting for it.
        let read = stream.try_clone().map_err(|e| e.to_string())?;
        let number = self.connections.fetch_add(1, Ordering::Relaxed);
        let waiting = self.waiting.clone();
        let write = self.write.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(read).lines() {
                let Ok(line) = line else { break };
                if let Ok(answer) = serde_json::from_str::<Answer>(&line) {
                    if let Some(send) = waiting.lock().unwrap().remove(&answer.id) {
                        let _ = send.send(answer);
                    }
                }
            }
            // The app has let go: no call goes out on this connection any
            // more, and whoever still waits is told so. In this order, so
            // that a call either finds no connection and makes one, or went
            // out on this one and is waiting, to be told now.
            {
                let mut write = write.lock().unwrap();
                if write.as_ref().is_some_and(|(current, _)| *current == number) {
                    *write = None;
                }
            }
            for (id, send) in waiting.lock().unwrap().drain() {
                let _ = send.send(Answer { id, text: CUT_OFF.into(), error: true });
            }
        });
        Ok((number, stream))
    }

    fn call(&self, tool: &str, arguments: Value) -> Answer {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let failed = |text: String| Answer { id, text, error: true };
        let (send, receive) = mpsc::channel();
        self.waiting.lock().unwrap().insert(id, send);
        let mut line = match serde_json::to_vec(&Call { id, tool: tool.into(), arguments }) {
            Ok(line) => line,
            Err(e) => return failed(e.to_string()),
        };
        line.push(b'\n');
        let sent = {
            let mut write = self.write.lock().unwrap();
            let attempt = |write: &mut Option<(u64, std::net::TcpStream)>| -> Result<(), String> {
                if write.is_none() {
                    *write = Some(self.connect()?);
                }
                write.as_mut().unwrap().1.write_all(&line).map_err(|e| e.to_string())
            };
            // A connection to an app that has since been closed fails once; then a new one is made.
            attempt(&mut write).or_else(|_| {
                *write = None;
                attempt(&mut write)
            })
        };
        if let Err(e) = sent {
            self.waiting.lock().unwrap().remove(&id);
            return failed(e);
        }
        receive
            .recv()
            .unwrap_or_else(|_| failed(CUT_OFF.into()))
    }
}

/// `myssh mcp`: an MCP server on standard input and output, for an agent
/// to start. Runs until the agent closes its input.
pub fn bridge() {
    let link = Arc::new(Link {
        client: Mutex::new("agent".into()),
        write: Arc::default(),
        connections: AtomicU64::new(1),
        watching: AtomicBool::new(false),
        waiting: Arc::default(),
        next: AtomicU64::new(1),
    });
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let send = |out: &Mutex<std::io::Stdout>, message: Value| {
        let mut out = out.lock().unwrap();
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    };

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            send(
                &out,
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }),
            );
            continue;
        };
        // Notifications want no answer.
        let Some(id) = message.get("id").cloned() else { continue };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
        match method {
            "initialize" => {
                if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                    *link.client.lock().unwrap() = name.to_string();
                }
                // The app shows the agent as connected from now on, if it is
                // running, and again a few seconds after it is started anew
                // or agents are turned back on: whenever no connection is
                // held, one is tried. Once only, however often the agent says hello.
                if !link.watching.swap(true, Ordering::SeqCst) {
                    let watch = link.clone();
                    std::thread::spawn(move || loop {
                        {
                            let mut write = watch.write.lock().unwrap();
                            if write.is_none() {
                                *write = watch.connect().ok();
                            }
                        }
                        std::thread::sleep(RECONNECT_EVERY);
                    });
                }
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = if ["2024-11-05", "2025-03-26", "2025-06-18"].contains(&asked) {
                    asked
                } else {
                    "2025-06-18"
                };
                send(
                    &out,
                    reply(json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "myssh", "title": "MySSH", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": INSTRUCTIONS,
                    })),
                );
            }
            "ping" => send(&out, reply(json!({}))),
            "tools/list" => send(&out, reply(json!({ "tools": tools() }))),
            "tools/call" => {
                // Calls run side by side: a long command does not hold up a read.
                let link = link.clone();
                let out = out.clone();
                std::thread::spawn(move || {
                    let tool = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    let answer = link.call(&tool, arguments);
                    send(
                        &out,
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{ "type": "text", "text": answer.text }],
                                "isError": answer.error,
                            }
                        }),
                    );
                });
            }
            _ => send(
                &out,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("Method not found: {method}") }
                }),
            ),
        }
    }
}
