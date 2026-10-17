// Ports forwarded through terminal sessions (`ssh -L`).
//
// A host keeps its forwards; a tab opens them on its session's connection:
// the host's automatic ones with the first connection, the others when
// asked. What a tab has open is opened again after a reconnection, and a
// forward changed or removed meanwhile (here or on another device) is
// reopened as it now is, or closed.

import { create } from "zustand";
import { api, asApiError, type ApiError, type ForwardStatus, type Id, type PortForward } from "./api";
import { useVault } from "./store";

export interface OpenForward {
  state: "opening" | "open" | "failed";
  status: ForwardStatus | null;
  error: ApiError | null;
  /** Where it led when opened, to notice a change. */
  spec: string;
}

export interface TabForwards {
  /** What the tab wants open, connected or not. */
  wanted: Id[];
  /** What is open, or being opened, on the current connection. */
  open: Record<Id, OpenForward>;
}

export const useForwards = create<{ tabs: Record<string, TabForwards> }>(() => ({ tabs: {} }));

/** Each tab's connected session and its host. */
const live = new Map<string, { session: number; hostId: Id }>();
/** Tabs whose host's automatic forwards were already asked for. */
const seeded = new Set<string>();

const specOf = (f: PortForward) => `${f.local_port}>${f.remote_host}:${f.remote_port}`;

function hostForwards(hostId: Id): PortForward[] {
  return useVault.getState().snapshot.hosts.find((h) => h.id === hostId)?.forwards ?? [];
}

function update(tabId: string, change: (tab: TabForwards) => TabForwards) {
  useForwards.setState((s) => ({
    tabs: { ...s.tabs, [tabId]: change(s.tabs[tabId] ?? { wanted: [], open: {} }) },
  }));
}

function setOpen(tabId: string, id: Id, value: OpenForward | null) {
  update(tabId, (tab) => {
    const open = { ...tab.open };
    if (value) open[id] = value;
    else delete open[id];
    return { ...tab, open };
  });
}

function want(tabId: string, id: Id, wanted: boolean) {
  update(tabId, (tab) => ({
    ...tab,
    wanted: wanted ? [...tab.wanted.filter((w) => w !== id), id] : tab.wanted.filter((w) => w !== id),
  }));
}

/** Opens a forward on the tab's connection, or once it is connected. */
export async function openForward(tabId: string, forward: PortForward) {
  want(tabId, forward.id, true);
  const connection = live.get(tabId);
  if (!connection) return;
  const spec = specOf(forward);
  setOpen(tabId, forward.id, { state: "opening", status: null, error: null, spec });
  try {
    const status = await api.forwardStart(connection.session, forward.id, {
      local_port: forward.local_port,
      remote_host: forward.remote_host,
      remote_port: forward.remote_port,
    });
    if (live.get(tabId)?.session !== connection.session) return;
    setOpen(tabId, forward.id, { state: "open", status, error: null, spec });
  } catch (e) {
    if (live.get(tabId)?.session !== connection.session) return;
    setOpen(tabId, forward.id, { state: "failed", status: null, error: asApiError(e), spec });
  }
}

/** Closes a forward and stops asking for it. */
export function closeForward(tabId: string, id: Id) {
  want(tabId, id, false);
  const connection = live.get(tabId);
  if (connection) void api.forwardStop(connection.session, id).catch(() => {});
  setOpen(tabId, id, null);
}

/** A tab's session is connected: its forwards open on the new connection. */
export function forwardsConnected(tabId: string, session: number, hostId: Id) {
  live.set(tabId, { session, hostId });
  const forwards = hostForwards(hostId);
  if (!seeded.has(tabId)) {
    seeded.add(tabId);
    for (const f of forwards) if (f.auto) want(tabId, f.id, true);
  }
  const wanted = new Set(useForwards.getState().tabs[tabId]?.wanted ?? []);
  update(tabId, (tab) => ({ ...tab, open: {} }));
  for (const f of forwards) if (wanted.has(f.id)) void openForward(tabId, f);
}

/** A tab's session ended: its ports closed with it, and wait for the next one. */
export function forwardsClosed(tabId: string) {
  live.delete(tabId);
  update(tabId, (tab) => ({ ...tab, open: {} }));
}

/** The tab is gone. */
export function forgetForwards(tabId: string) {
  live.delete(tabId);
  seeded.delete(tabId);
  useForwards.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs[tabId];
    return { tabs };
  });
}

/** Asks how the tab's open forwards are doing: connections carried, failures. */
export async function refreshForwards(tabId: string) {
  const connection = live.get(tabId);
  if (!connection) return;
  let statuses: Record<Id, ForwardStatus>;
  try {
    statuses = await api.forwardStatus(connection.session);
  } catch {
    return;
  }
  if (live.get(tabId)?.session !== connection.session) return;
  update(tabId, (tab) => {
    const open = { ...tab.open };
    for (const [id, status] of Object.entries(statuses)) {
      if (open[id]?.state === "open") open[id] = { ...open[id], status };
    }
    return { ...tab, open };
  });
}

// A host's forwards changed: what is open follows.
useVault.subscribe((state, before) => {
  if (state.snapshot.hosts === before.snapshot.hosts) return;
  for (const [tabId, { hostId }] of live) {
    const forwards = hostForwards(hostId);
    const tab = useForwards.getState().tabs[tabId];
    if (!tab) continue;
    for (const id of tab.wanted) {
      const forward = forwards.find((f) => f.id === id);
      if (!forward) closeForward(tabId, id);
      else if (tab.open[id] && tab.open[id].spec !== specOf(forward)) void openForward(tabId, forward);
    }
  }
});
