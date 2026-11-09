// Coding agents (Claude Code, Codex…) at the terminals the user opens to them.
//
// An agent starts `myssh mcp` as its MCP server; its tool calls come here
// through the core (see src-tauri/src/agents.rs) and are carried out on the
// tab named, if, and only as far as, the user has let agents at that tab.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { MOBILE } from "./platform";
import { useSettings } from "./settings";
import { getSession, type TermSession } from "./sessions";
import { hostSubtitle, isLocalTab, useUi, useVault, type Tab } from "./store";

/** `read`: agents see the terminal; `control`: they also type into it. */
export type AgentAccess = "read" | "control";

/**
 * An agent connected: one of its chats or sessions, which connects as soon
 * as it starts, whether it uses MySSH or not.
 */
export interface AgentClient {
  /** The name it gives itself. */
  name: string;
  /** When it last called a tool (ms since 1970), if ever. */
  lastCall: number | null;
}

/** How long after its last call an agent still counts as at work. */
export const AGENT_ACTIVE_MS = 10 * 60_000;

interface AgentStore {
  /** The tabs open to agents, and how far. */
  access: Record<string, AgentAccess>;
  /** The agents connected now. */
  clients: AgentClient[];
  /** When an agent last did something at each tab. */
  touched: Record<string, number>;
  setAccess: (tabId: string, access: AgentAccess | null) => void;
}

export const useAgents = create<AgentStore>((set) => ({
  access: {},
  clients: [],
  touched: {},
  setAccess: (tabId, access) =>
    set((s) => {
      const next = { ...s.access };
      if (access) next[tabId] = access;
      else delete next[tabId];
      return { access: next };
    }),
}));

export interface AgentInfo {
  program: string;
  clients: AgentClient[];
}

export const agentInfo = () => invoke<AgentInfo>("agent_info");

/** How an agent called itself, as people know it. */
export function agentName(client: string): string {
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    "codex-mcp-client": "Codex",
    codex: "Codex",
    cursor: "Cursor",
    "gemini-cli-mcp-client": "Gemini CLI",
  };
  return known[client.toLowerCase()] ?? client;
}

interface CallEvent {
  id: number;
  client: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** A tool's answer: its text, and whether it is an error. */
type Result = { text: string; error?: boolean };

class Refused extends Error {}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** How a terminal's prompt ends: the line the cursor is on, once the output pauses. */
const PROMPT_END = /[$#%>❯»]\s?$/;
/** How long the output stays quiet before a command is looked at as maybe done. */
const SETTLE_MS = 800;
/** The most of a command's output given back, the end of it being kept. */
const OUTPUT_LIMIT = 40_000;

function tabFor(args: Record<string, unknown>, need: AgentAccess): { tab: Tab; session: TermSession } {
  if (!useSettings.getState().agents) throw new Refused("The user has turned agents off in MySSH.");
  const id = typeof args.terminal === "string" ? args.terminal : "";
  const tab = useUi.getState().tabs.find((candidate) => candidate.id === id);
  const access = useAgents.getState().access[id];
  if (!tab || !access) {
    throw new Refused(`No terminal "${id}" is open to agents. Call list_terminals to see the ones that are.`);
  }
  if (need === "control" && access !== "control") {
    throw new Refused(
      `The user lets agents read terminal "${id}" but not type into it. Ask them to allow typing in MySSH if it is needed.`,
    );
  }
  const session = getSession(id);
  if (!session) throw new Refused(`Terminal "${id}" is gone.`);
  useAgents.setState((s) => ({ touched: { ...s.touched, [id]: Date.now() } }));
  return { tab, session };
}

function needConnected(tab: Tab) {
  if (tab.status !== "connected") {
    throw new Refused(`Terminal "${tab.id}" is not connected (${tab.status}); nothing can be typed into it now.`);
  }
}

/** The terminal's lines from `from` (an index into its buffer) to the end, wrapped lines joined. */
function linesFrom(session: TermSession, from: number): string[] {
  const buffer = session.term.buffer.active;
  const lines: string[] = [];
  for (let y = Math.max(0, from); y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function lastLines(session: TermSession, count: number): string {
  const buffer = session.term.buffer.active;
  // The empty rows under the cursor are not lines: the count starts above them.
  const lines = linesFrom(session, buffer.length - session.term.rows - count * 2);
  return lines.slice(-count).join("\n");
}

function cursorLine(session: TermSession): string {
  const buffer = session.term.buffer.active;
  return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true, 0, buffer.cursorX) ?? "";
}

function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `[…${text.length - OUTPUT_LIMIT} earlier characters cut…]\n${text.slice(-OUTPUT_LIMIT)}`;
}

async function listTerminals(): Promise<Result> {
  const { access } = useAgents.getState();
  const tabs = useUi.getState().tabs.filter((tab) => access[tab.id]);
  if (tabs.length === 0) {
    return {
      text:
        "No terminal is open to agents. Ask the user to open one in MySSH: the robot button in a terminal tab's toolbar.",
    };
  }
  const snapshot = useVault.getState().snapshot;
  const list = await Promise.all(
    tabs.map(async (tab) => {
      const host = snapshot.hosts.find((h) => h.id === tab.hostId);
      const session = getSession(tab.id);
      const cwd = tab.status === "connected" && !isLocalTab(tab) ? await session?.workingDirectory() : null;
      return {
        terminal: tab.id,
        title: tab.title,
        server: isLocalTab(tab) ? "this computer (local shell)" : host ? hostSubtitle(host, snapshot) : tab.title,
        status: tab.status,
        access: access[tab.id] === "control" ? "read and type" : "read only",
        ...(cwd ? { cwd } : {}),
        ...(session?.term.buffer.active.type === "alternate" ? { screen: "a full-screen program is open" } : {}),
      };
    }),
  );
  return { text: JSON.stringify(list, null, 2) };
}

function readTerminal(args: Record<string, unknown>): Result {
  const { tab, session } = tabFor(args, "read");
  const count = Math.max(1, Math.min(5000, Number(args.lines) || 100));
  const head = `[${tab.title} — ${tab.status}${session.term.buffer.active.type === "alternate" ? ", full-screen program" : ""}]`;
  return { text: `${head}\n${lastLines(session, count)}` };
}

async function sendInput(args: Record<string, unknown>): Promise<Result> {
  const { tab, session } = tabFor(args, "control");
  needConnected(tab);
  const text = typeof args.text === "string" ? args.text : "";
  if (!text) throw new Refused("Nothing to type: `text` is empty.");
  session.forgetLine();
  session.type(text);
  // A moment for the terminal to answer, then what it shows.
  const sent = Date.now();
  await sleep(300);
  while (Date.now() - sent < 3000 && Date.now() - session.lastOutputAt < 300) await sleep(100);
  return { text: lastLines(session, 40) };
}

async function runCommand(args: Record<string, unknown>): Promise<Result> {
  const { tab, session } = tabFor(args, "control");
  needConnected(tab);
  const command = typeof args.command === "string" ? args.command.replace(/\r?\n+$/, "") : "";
  if (!command.trim()) throw new Refused("No command: `command` is empty.");
  if (session.term.buffer.active.type === "alternate") {
    throw new Refused(
      "A full-screen program is open in this terminal. Read it with read_terminal and use send_input instead.",
    );
  }
  const timeout = Math.max(1, Math.min(600, Number(args.timeout_seconds) || 60)) * 1000;
  // Where the command starts, followed as the output scrolls.
  const marker = session.term.registerMarker(0);
  const sent = Date.now();
  session.forgetLine();
  session.type(`${command.replace(/\r?\n/g, "\r")}\r`);
  let done = false;
  while (Date.now() - sent < timeout) {
    await sleep(150);
    if (useUi.getState().tabs.find((t) => t.id === tab.id)?.status !== "connected") break;
    const quiet = Date.now() - session.lastOutputAt;
    if (session.lastOutputAt > sent && quiet >= SETTLE_MS && session.term.buffer.active.type === "normal") {
      if (PROMPT_END.test(cursorLine(session))) {
        done = true;
        break;
      }
    }
  }
  const from = marker && !marker.isDisposed ? marker.line : 0;
  marker?.dispose();
  const output = linesFrom(session, from).join("\n");
  if (done) return { text: clip(output) };
  const status = useUi.getState().tabs.find((t) => t.id === tab.id)?.status;
  const why =
    status !== "connected"
      ? "The terminal lost its connection."
      : `Still running after ${Math.round(timeout / 1000)} s (or waiting for input). It goes on; read_terminal to look again, send_input "\\u0003" to stop it.`;
  return { text: `${clip(output)}\n\n[${why}]`, error: status !== "connected" };
}

async function carryOut(call: CallEvent): Promise<Result> {
  switch (call.tool) {
    case "list_terminals":
      return listTerminals();
    case "read_terminal":
      return readTerminal(call.arguments);
    case "send_input":
      return sendInput(call.arguments);
    case "run_command":
      return runCommand(call.arguments);
    default:
      return { text: `Unknown tool "${call.tool}".`, error: true };
  }
}

/** Listens for agents' calls, and keeps the access in step with the open tabs. */
export function startAgents() {
  if (MOBILE) return;
  void listen<CallEvent>("agent-call", (event) => {
    const call = event.payload;
    void carryOut({ ...call, arguments: call.arguments ?? {} })
      .catch((e: unknown) => ({ text: e instanceof Error ? e.message : String(e), error: true }))
      .then((result) => invoke("agent_reply", { id: call.id, text: result.text, error: result.error ?? false }))
      .catch(() => {});
  });
  void listen<AgentClient[]>("agent-clients", (event) => useAgents.setState({ clients: event.payload }));
  // Listening for agents, or not, as Settings say; turned off, no tab stays open to them.
  const follow = (on: boolean) => {
    if (!on) useAgents.setState({ access: {}, clients: [] });
    void invoke("agent_listen", { on }).catch(() => {});
  };
  follow(useSettings.getState().agents);
  // After the window is reloaded: the agents still connected.
  void agentInfo()
    .then((info) => useAgents.setState({ clients: info.clients }))
    .catch(() => {});
  useSettings.subscribe((now, before) => {
    if (now.agents !== before.agents) follow(now.agents);
  });
  // A closed tab's access goes with it.
  useUi.subscribe((ui) => {
    const { access } = useAgents.getState();
    const gone = Object.keys(access).filter((id) => !ui.tabs.some((tab) => tab.id === id));
    if (gone.length === 0) return;
    const next = { ...access };
    for (const id of gone) delete next[id];
    useAgents.setState({ access: next });
  });
}
