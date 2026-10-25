// Application state: vault snapshot, navigation, tabs, toasts.

import { create } from "zustand";
import {
  api,
  asApiError,
  type ApiError,
  type AppStatus,
  type CloseReason,
  type HostView,
  type Id,
  type Prompt,
  type SecretInput,
  type Snapshot,
  type Stage,
  type LogEntry,
} from "./api";

// ---------------------------------------------------------------- vault ---

interface VaultStore {
  status: AppStatus | null;
  snapshot: Snapshot;
  loaded: boolean;
  loadError: ApiError | null;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
}

const EMPTY: Snapshot = {
  hosts: [],
  groups: [],
  identities: [],
  keys: [],
  snippets: [],
  settings: null,
  cloud: null,
};

export const useVault = create<VaultStore>((set, get) => ({
  status: null,
  snapshot: EMPTY,
  loaded: false,
  loadError: null,
  init: async () => {
    try {
      const status = await api.appStatus();
      set({ status });
      if (status.vault_error) {
        set({ loaded: true, loadError: status.vault_error });
        return;
      }
      await get().refresh();
    } catch (e) {
      set({ loaded: true, loadError: asApiError(e) });
    }
  },
  refresh: async () => {
    try {
      const snapshot = await api.snapshot();
      set({ snapshot, loaded: true, loadError: null });
    } catch (e) {
      set({ loaded: true, loadError: asApiError(e) });
    }
  },
}));

/**
 * The "host" of a terminal on this computer. The nil id is never a real
 * host's, and lets the command history keep the local terminal's commands
 * apart from every server's.
 */
export const LOCAL_HOST_ID = "00000000-0000-0000-0000-000000000000";

export function isLocalTab(tab: { hostId: Id }): boolean {
  return tab.hostId === LOCAL_HOST_ID;
}

export function hostTitle(host: HostView): string {
  return host.label || host.address;
}

/** The order hosts are listed in: pinned ones first, then by name. */
export function compareHosts(a: HostView, b: HostView): number {
  return Number(b.pinned) - Number(a.pinned) || hostTitle(a).localeCompare(hostTitle(b));
}

/** `user@address[:port]` as resolved through the host's identity, if any. */
export function hostSubtitle(host: HostView, snapshot: Snapshot): string {
  const username =
    host.auth.kind === "inline"
      ? host.auth.username
      : (snapshot.identities.find(
          (i) => host.auth.kind === "identity" && i.id === host.auth.identity_id,
        )?.username ?? "");
  const target = host.port === 22 ? host.address : `${host.address}:${host.port}`;
  return username ? `${username}@${target}` : target;
}

// ------------------------------------------------------------------- ui ---

/** `sessions` and `more` are a phone's: its open terminals, and what does not fit along its bottom. */
export type View =
  | "hosts"
  | "keychain"
  | "snippets"
  | "forwards"
  | "known_hosts"
  | "cloud"
  | "settings"
  | "sessions"
  | "more";

export interface TabClosed {
  reason: CloseReason;
  exit_status: number | null;
  error: ApiError | null;
  at: number;
}

/** A step of the current connection attempt and when it happened. */
export interface LogLine {
  at: number;
  entry: LogEntry;
}

export interface Tab {
  id: string;
  hostId: Id;
  title: string;
  status: "connecting" | "connected" | "closed";
  stage: Stage | null;
  prompt: { id: number; prompt: Prompt } | null;
  closed: TabClosed | null;
  /** What the current, or last, connection attempt went through. */
  log: LogLine[];
  /** The tab has had a working session; until then it shows the connection screen. */
  everConnected: boolean;
  /** A scheduled automatic reconnection. */
  reconnect: { attempt: number; at: number; network?: boolean } | null;
  /** The connection is being asked whether it still answers (the network changed). */
  checking?: boolean;
  /**
   * The shell asks for a password on this cell: the saved ones are listed
   * there. `index` is the row chosen with the arrows (-1: none); `user` the
   * account the prompt (or the command above it) names; `failed` the saved
   * one just typed here and refused.
   */
  passwordOffer?: {
    row: number;
    col: number;
    index: number;
    user: string | null;
    failed: string | null;
    prompt: string;
  } | null;
  /**
   * A password from the terminal is being kept: one added from the list,
   * or one refused and being updated.
   */
  passwordSave?: {
    reason: "add" | "update";
    target: { kind: "host"; id: Id } | { kind: "identity"; id: Id } | { kind: "new"; username: string };
  } | null;
  /** Automatic reconnection gave up after this many attempts. */
  gaveUp: number | null;
  searchOpen: boolean;
  /** The panel shown beside the terminal. */
  side: "snippets" | null;
  /** The two-pane file manager is shown over the terminal. */
  files: boolean;
  /** The remote directory last shown in the file manager. */
  filesDir: string | null;
  /** The remote file open in the editor. */
  editor: { path: string; name: string } | null;
  editorDirty: boolean;
  /** A close was requested while the editor has unsaved changes. */
  editorClosing: "editor" | "tab" | null;
  /** Suggestions for the command being typed. */
  suggest: SuggestState | null;
  /** One of the terminals a snippet was run in on several hosts: they share one tab. */
  group?: TabGroup | null;
  /** A snippet sent to the shell: still at it, or done (the prompt is back). */
  runState?: "running" | "done" | null;
  /** A page the server asks to be opened to let this connection in (Tailscale SSH's check). */
  authLink?: string | null;
}

/** Terminals opened together, shown as one tab with a list of them. */
export interface TabGroup {
  id: string;
  title: string;
}

/** A terminal someone else shares, watched from this app. */
export interface GuestTab {
  id: string;
  room: string;
  /** The shared terminal's title, as the host sees it. */
  title: string;
  hostName: string;
  /** This guest's number in the session; `0` until the host has answered. */
  me: number;
  /** Who types: `0` is the host, otherwise a guest's number. */
  control: number;
  people: { id: number; name: string }[];
  state: "joining" | "live" | "ended";
  /** Why it ended, as a message key. */
  ended: string | null;
  /** Asked for the keyboard and waits for the answer. */
  asked: boolean;
  /** Connected to the host directly rather than through the server. */
  direct: boolean;
}

export interface Suggestion {
  /**
   * `command`: a well-known command; `fix`: what a misspelt line was probably
   * meant to be; `container`: a container the terminal has shown;
   * `subcommand`: what can follow a tool's name; `ai`: a command the AI
   * offered for the line; `ask`: the row that asks the AI.
   */
  kind: "history" | "path" | "snippet" | "command" | "fix" | "container" | "subcommand" | "ai" | "ask";
  /** What is shown. */
  label: string;
  /** How many characters at the start of `label` are what has been typed. */
  match?: number;
  /** What a subcommand takes, as usage lines write it. */
  args?: string;
  detail?: string;
  /** Text that completes the current input when sent as typed. */
  insert: string;
  /** Replace the whole line instead of appending (snippets found by name). */
  replace?: boolean;
  /** The AI says the command deletes, stops or changes something. */
  danger?: boolean;
}

export interface SuggestState {
  items: Suggestion[];
  /** A word about the AI under the rows: its allowance used up, say. */
  note?: string;
  /** Selected row; -1 while nothing is selected. */
  index: number;
  /** Cursor cell the list is anchored to. */
  col: number;
  row: number;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  detail?: string;
}

/** What the hosts screen has open in its side panel. */
export type HostPanel =
  | { mode: "new"; groupId: Id | null }
  /** `tabId`: the tab that could not connect and is waiting for the fix. */
  | { mode: "edit"; hostId: Id; tabId?: string }
  | null;

/** Which form a host panel is: the new-host form, or the editor of one host. */
export function hostPanelKey(panel: NonNullable<HostPanel>): string {
  return panel.mode === "edit" ? `edit:${panel.hostId}` : "new";
}

/**
 * What has been typed into the host panel so far. It lives here, not in the
 * panel, so that looking at another section or a terminal and coming back
 * does not lose it. Closing the panel discards it.
 */
export interface HostDraft {
  key: string;
  label: string;
  address: string;
  port: string;
  groupId: Id | null;
  tags: string[];
  authKind: "inline" | "identity";
  username: string;
  password: SecretInput;
  keyId: Id | null;
  identityId: Id | null;
  startupId: Id | null;
  agentForwarding: boolean;
}

interface UiStore {
  view: View;
  /** `"home"`, `"new"` (the new-tab page) or a tab id. */
  active: string;
  tabs: Tab[];
  /** For each group of terminals, the one last looked at in it. */
  groupFocus: Record<string, string>;
  /** The new-tab page is open, after the terminal tabs. */
  newTab: boolean;
  /** Shared terminals of other people, after the terminal tabs. */
  guests: GuestTab[];
  toasts: Toast[];
  hostPanel: HostPanel;
  hostDraft: HostDraft | null;
  setView: (view: View) => void;
  goHome: (view?: View) => void;
  activate: (id: string) => void;
  cycle: (step: number) => void;
  openNewTab: () => void;
  /** Closes the new-tab page; if it was showing, the nearest tab shows instead. */
  closeNewTab: () => void;
  addGuest: (guest: GuestTab) => void;
  patchGuest: (id: string, patch: Partial<GuestTab>) => void;
  removeGuest: (id: string) => void;
  addTab: (tab: Tab) => void;
  patchTab: (id: string, patch: Partial<Tab>) => void;
  removeTab: (id: string) => void;
  setHostPanel: (panel: HostPanel) => void;
  setHostDraft: (draft: HostDraft) => void;
  toast: (kind: Toast["kind"], text: string, detail?: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUi = create<UiStore>((set, get) => ({
  view: "hosts",
  active: "home",
  groupFocus: {},
  tabs: [],
  newTab: false,
  guests: [],
  toasts: [],
  hostPanel: null,
  hostDraft: null,
  setView: (view) => set({ view }),
  goHome: (view) => set((s) => ({ active: "home", view: view ?? s.view })),
  activate: (id) =>
    set((s) => {
      const group = s.tabs.find((t) => t.id === id)?.group;
      return { active: id, groupFocus: group ? { ...s.groupFocus, [group.id]: id } : s.groupFocus };
    }),
  cycle: (step) => {
    const order = [
      "home",
      ...get().tabs.map((t) => t.id),
      ...get().guests.map((g) => g.id),
      ...(get().newTab ? ["new"] : []),
    ];
    const index = order.indexOf(get().active);
    set({ active: order[(index + step + order.length) % order.length] });
  },
  openNewTab: () => set({ newTab: true, active: "new" }),
  closeNewTab: () =>
    set((s) => ({
      newTab: false,
      active: s.active === "new" ? (s.tabs[s.tabs.length - 1]?.id ?? "home") : s.active,
    })),
  addGuest: (guest) => set((s) => ({ guests: [...s.guests, guest], active: guest.id })),
  patchGuest: (id, patch) =>
    set((s) => ({ guests: s.guests.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
  removeGuest: (id) =>
    set((s) => {
      const guests = s.guests.filter((g) => g.id !== id);
      const fallback = guests[guests.length - 1]?.id ?? s.tabs[s.tabs.length - 1]?.id ?? "home";
      return { guests, active: s.active === id ? fallback : s.active };
    }),
  addTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], active: tab.id })),
  patchTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  removeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Closing the active tab lands on another terminal of its group, else
      // on its neighbour, or home.
      const group = s.tabs[index].group;
      const sibling = group ? tabs.find((t) => t.group?.id === group.id) : undefined;
      const active =
        s.active !== id
          ? s.active
          : (sibling?.id ?? (tabs[index] ?? tabs[index - 1])?.id ?? (s.newTab ? "new" : "home"));
      return { tabs, active };
    }),
  // Closing the panel, or turning it to another host, drops the draft.
  setHostPanel: (hostPanel) =>
    set((s) => ({
      hostPanel,
      hostDraft: hostPanel && s.hostDraft?.key === hostPanelKey(hostPanel) ? s.hostDraft : null,
    })),
  setHostDraft: (hostDraft) => set({ hostDraft }),
  toast: (kind, text, detail) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, detail }] }));
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 2600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
