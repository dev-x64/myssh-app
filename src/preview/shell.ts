// A pretend shell for the interface preview: connects with the stages and
// log lines a real session reports, echoes what is typed and answers a
// handful of commands, so that terminals, tabs and the files beside them
// can be looked at without a server.

import type { Channel } from "@tauri-apps/api/core";
import type { HostView, PromptReply, SessionEvent } from "../lib/api";

interface Session {
  host: HostView;
  events: Channel<SessionEvent>;
  output: Channel<ArrayBuffer>;
  line: string;
  cwd: string;
  /** A prompt waiting for an answer: what to do once it comes. */
  waiting: ((reply: PromptReply) => void) | null;
  closed: boolean;
}

const sessions = new Map<number, Session>();
let nextId = 1;
const encoder = new TextEncoder();

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function write(session: Session, text: string) {
  if (session.closed) return;
  const bytes = encoder.encode(text);
  session.output.onmessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function user(session: Session): string {
  return session.host.auth.kind === "inline" ? session.host.auth.username || "root" : "ops";
}

function prompt(session: Session) {
  const home = user(session) === "root" ? "/root" : `/home/${user(session)}`;
  const where = session.cwd === home ? "~" : session.cwd;
  const mark = user(session) === "root" ? "#" : "$";
  write(session, `\x1b[1;32m${user(session)}@${session.host.label}\x1b[0m:\x1b[1;34m${where}\x1b[0m${mark} `);
}

const ANSWERS: Record<string, (s: Session) => string> = {
  ls: () =>
    "\x1b[1;34mapp\x1b[0m  \x1b[1;34mbackups\x1b[0m  \x1b[1;34mlogs\x1b[0m  docker-compose.yml  README.md  \x1b[1;32mdeploy.sh\x1b[0m  \x1b[1;31mdump-2026-10-01.sql.gz\x1b[0m\r\n",
  pwd: (s) => `${s.cwd}\r\n`,
  whoami: (s) => `${user(s)}\r\n`,
  hostname: (s) => `${s.host.label}\r\n`,
  "uname -a": (s) => `Linux ${s.host.label} 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux\r\n`,
  uptime: () => " 10:42:17 up 41 days,  3:12,  1 user,  load average: 0.08, 0.12, 0.09\r\n",
  "df -h": () =>
    "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1        79G   31G   45G  41% /\r\ntmpfs           2.0G     0  2.0G   0% /dev/shm\r\n",
  "docker compose ps": () =>
    "NAME        IMAGE                          STATUS          PORTS\r\napp-app-1   ghcr.io/example/app:latest     Up 3 days       127.0.0.1:8080->8080/tcp\r\napp-db-1    postgres:16                    Up 3 days       5432/tcp\r\n",
  "systemctl status nginx": () =>
    "\x1b[1;32m●\x1b[0m nginx.service - A high performance web server\r\n     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\r\n     Active: \x1b[1;32mactive (running)\x1b[0m since Mon 2026-09-04 07:30:12 UTC; 1 month 11 days ago\r\n",
  "cat /etc/os-release": (s) => `PRETTY_NAME="${s.host.os?.name ?? "Linux"}"\r\n`,
};

function run(session: Session, command: string) {
  const trimmed = command.trim();
  if (!trimmed) return prompt(session);
  if (trimmed === "exit" || trimmed === "logout") {
    write(session, "logout\r\n");
    session.closed = true;
    session.events.onmessage({ type: "closed", reason: "exited", exit_status: 0, error: null });
    sessions.forEach((value, key) => value === session && sessions.delete(key));
    return;
  }
  if (trimmed === "clear") {
    write(session, "\x1b[H\x1b[2J");
    return prompt(session);
  }
  if (trimmed.startsWith("cd")) {
    const to = trimmed.slice(2).trim();
    session.cwd = !to || to === "~" ? (user(session) === "root" ? "/root" : `/home/${user(session)}`) : to.startsWith("/") ? to : `${session.cwd.replace(/\/$/, "")}/${to}`;
    return prompt(session);
  }
  if (trimmed.startsWith("echo ")) {
    write(session, `${trimmed.slice(5)}\r\n`);
    return prompt(session);
  }
  const answer = ANSWERS[trimmed];
  write(session, answer ? answer(session) : `${trimmed.split(" ")[0]}: this is the interface preview, the command did not run\r\n`);
  prompt(session);
}

async function connect(session: Session) {
  const { host, events } = session;
  const say = (event: SessionEvent) => !session.closed && events.onmessage(event);
  await later(30);
  say({ type: "stage", stage: "connecting" });
  say({ type: "log", entry: { code: "connecting", host: host.address, port: host.port } });
  await later(250);
  say({ type: "log", entry: { code: "reached", address: `${host.address}:${host.port}` } });
  say({ type: "stage", stage: "handshake" });
  await later(200);
  // A host the app has never seen asks whether to trust its key.
  if (!host.os) {
    say({ type: "log", entry: { code: "host_key", algorithm: "ssh-ed25519", fingerprint: "SHA256:PreviewNewHostKeyF1ngerpr1ntXyZ0123456789ab", status: "new" } });
    say({ type: "log", entry: { code: "waiting", what: "host_key" } });
    const reply = await new Promise<PromptReply>((resolve) => {
      session.waiting = resolve;
      say({
        type: "prompt",
        id: 1,
        prompt: {
          kind: "host_key",
          host: host.address,
          port: host.port,
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:PreviewNewHostKeyF1ngerpr1ntXyZ0123456789ab",
          known: [],
        },
      });
    });
    if (reply.kind === "cancel") {
      say({ type: "closed", reason: "user", exit_status: null, error: null });
      return;
    }
    say({ type: "log", entry: { code: "host_key_accepted" } });
  } else {
    say({ type: "log", entry: { code: "host_key", algorithm: "ssh-ed25519", fingerprint: "SHA256:3bR0f7Yp2kq9LwB8m1Zc4uXv6nT5sQe0aHjKdPiGo2E", status: "trusted" } });
  }
  say({ type: "stage", stage: "authenticating" });
  say({ type: "log", entry: { code: "auth_offered", methods: ["publickey", "password"] } });
  say({ type: "log", entry: { code: "auth_trying", method: "publickey", detail: "MacBook", saved: true } });
  await later(250);
  say({ type: "log", entry: { code: "auth_accepted", method: "publickey" } });
  say({ type: "stage", stage: "opening_shell" });
  say({ type: "log", entry: { code: "shell_opening" } });
  await later(150);
  say({ type: "log", entry: { code: "shell_ready" } });
  say({ type: "connected" });
  write(
    session,
    `Welcome to ${host.os?.name ?? "Linux"} (GNU/Linux 6.8.0-45-generic x86_64)\r\n\r\n` +
      "\x1b[2m * This is the MySSH interface preview: nothing here reaches a server.\x1b[0m\r\n\r\n" +
      "Last login: Thu Oct 15 09:58:02 2026 from 198.51.100.7\r\n",
  );
  prompt(session);
}

export function open(
  host: HostView,
  events: Channel<SessionEvent>,
  output: Channel<ArrayBuffer>,
  local = false,
): number {
  const id = nextId++;
  const session: Session = {
    host,
    events,
    output,
    line: "",
    cwd: host.auth.kind === "inline" && host.auth.username !== "root" ? `/home/${host.auth.username}` : "/root",
    waiting: null,
    closed: false,
  };
  sessions.set(id, session);
  if (local) {
    // This computer's own shell: no connection, no keys, no signing in.
    void later(30).then(() => {
      if (session.closed) return;
      events.onmessage({ type: "connected" });
      write(session, "Last login: Thu Oct 15 09:41:10 on ttys002\r\n");
      prompt(session);
    });
  } else {
    void connect(session);
  }
  return id;
}

export function reply(id: number, answer: PromptReply) {
  const session = sessions.get(id);
  const waiting = session?.waiting;
  if (!session || !waiting) return;
  session.waiting = null;
  waiting(answer);
}

export function input(id: number, data: string) {
  const session = sessions.get(id);
  if (!session || session.closed) return;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === "\x1b") {
      // Arrow keys and the like: swallowed whole.
      const match = /^\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i));
      i += match ? match[0].length - 1 : 0;
    } else if (ch === "\r") {
      write(session, "\r\n");
      const line = session.line;
      session.line = "";
      run(session, line);
    } else if (ch === "\x7f" || ch === "\b") {
      if (session.line) {
        session.line = session.line.slice(0, -1);
        write(session, "\b \b");
      }
    } else if (ch === "\x15") {
      // Ctrl+U: the line typed so far goes, as in a real shell.
      write(session, "\b \b".repeat([...session.line].length));
      session.line = "";
    } else if (ch === "\x03") {
      session.line = "";
      write(session, "^C\r\n");
      prompt(session);
    } else if (ch === "\x0c") {
      write(session, "\x1b[H\x1b[2J");
      prompt(session);
      write(session, session.line);
    } else if (ch >= " ") {
      session.line += ch;
      write(session, ch);
    }
  }
}

export function cwd(id: number): string | null {
  return sessions.get(id)?.cwd ?? null;
}

export function close(id: number) {
  const session = sessions.get(id);
  if (!session) return;
  session.closed = true;
  sessions.delete(id);
}

export function closeAll() {
  for (const id of [...sessions.keys()]) close(id);
}
