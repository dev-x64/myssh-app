// Advanced mode on the hosts' tiles: how busy each server is, looked at
// quietly about once a minute while its tile is in sight.
//
// A host with an open terminal is read over that connection. Any other is
// connected to with what it has saved, and the connection is kept for the
// next look, so a server is not signed in to every minute; it is closed a
// little after its tile goes out of sight. Nothing is ever asked of anyone
// (see `ssh::StatsProbes`). A host that would need
// someone to sign in is not tried again until it is changed or the app is
// started anew: repeated failed sign-ins could get this computer banned by
// the server (fail2ban and its kind).
//
// What was last read is kept on this computer and shown at once when the
// app starts, so the tiles do not stand empty while the servers are looked
// at again; the numbers then move to what is read now.

import { create } from "zustand";
import { api, type HostView, type Id, type ServerStats } from "./api";
import { getSession } from "./sessions";
import { useUi, useVault } from "./store";

const EVERY_MS = 60_000;
/** A server that did not answer is looked at again after this long. */
const OFFLINE_RETRY_MS = 5 * 60_000;
/** At most this many looks at a time. */
const AT_ONCE = 4;
/** Where the last readings are kept between runs. */
const KEPT_KEY = "myssh.hostLoads";
/** Readings older than this are not shown at start: they would mislead more than help. */
const KEPT_FOR_MS = 24 * 60 * 60_000;
/** What means "someone would have to sign in", not "the server is away". */
const NEEDS_SIGN_IN = new Set(["cancelled", "host_key_rejected", "auth_failed", "key_encrypted", "key"]);

export interface HostLoad {
  /** When this was read, milliseconds. */
  at: number;
  stats?: ServerStats;
  problem?: "sign_in" | "offline" | "silent";
  /** The host as it was when it needed signing in: a change to it tries again. */
  version?: number;
  /** Kept from an earlier run of the app: shown, but looked at again first thing. */
  kept?: boolean;
}

/** The readings kept from the last run, recent enough to show. */
function keptLoads(): Record<Id, HostLoad> {
  try {
    const stored = JSON.parse(localStorage.getItem(KEPT_KEY) ?? "{}") as Record<Id, HostLoad>;
    const now = Date.now();
    const loads: Record<Id, HostLoad> = {};
    for (const [id, load] of Object.entries(stored)) {
      if (load && typeof load.at === "number" && now - load.at < KEPT_FOR_MS) loads[id] = { ...load, kept: true };
    }
    return loads;
  } catch {
    return {};
  }
}

let keepTimer: number | undefined;

/** Keeps the readings for the next run, a moment after the last change. */
function keep() {
  window.clearTimeout(keepTimer);
  keepTimer = window.setTimeout(() => {
    try {
      const loads = Object.fromEntries(
        Object.entries(useHostStats.getState().loads).map(([id, { kept: _kept, ...load }]) => [id, load]),
      );
      localStorage.setItem(KEPT_KEY, JSON.stringify(loads));
    } catch {
      // Not kept: the tiles start empty next time, as they would anyway.
    }
  }, 1000);
}

export const useHostStats = create<{ loads: Record<Id, HostLoad> }>(() => ({ loads: keptLoads() }));

function set(hostId: Id, load: HostLoad) {
  useHostStats.setState((s) => ({ loads: { ...s.loads, [hostId]: load } }));
  keep();
}

/** A terminal of this host that is connected, if there is one. */
function liveSession(hostId: Id): number | null {
  for (const tab of useUi.getState().tabs) {
    if (tab.hostId !== hostId || tab.status !== "connected") continue;
    const id = getSession(tab.id)?.liveSessionId ?? null;
    if (id !== null) return id;
  }
  return null;
}

/** Whether the host has something saved to sign in with; without it there is nobody to ask. */
function canSignInAlone(host: HostView): boolean {
  return host.auth.kind === "identity" || host.auth.has_password || host.auth.key_id !== null;
}

function due(host: HostView, now: number): boolean {
  const load = useHostStats.getState().loads[host.id];
  if (!load || load.kept) return true;
  if (load.problem === "sign_in") return load.version !== host.updated_at;
  if (load.problem === "offline") return now - load.at >= OFFLINE_RETRY_MS;
  return now - load.at >= EVERY_MS - 1000;
}

async function look(host: HostView) {
  const at = Date.now();
  if (!canSignInAlone(host) && liveSession(host.id) === null) {
    set(host.id, { at, problem: "sign_in", version: host.updated_at });
    return;
  }
  try {
    const live = liveSession(host.id);
    const stats = live !== null ? await api.sessionStats(live) : await api.hostStats(host.id);
    const said = stats.mem_total != null || stats.disk_total != null || stats.uptime_secs != null;
    set(host.id, said ? { at, stats } : { at, problem: "silent" });
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "";
    set(host.id, NEEDS_SIGN_IN.has(code) ? { at, problem: "sign_in", version: host.updated_at } : { at, problem: "offline" });
  }
}

/**
 * Looks at these hosts now and about once a minute after, until the
 * returned function is called. Called by the hosts' list for the tiles it
 * shows. While the window is out of sight nothing is looked at; the hosts
 * due are looked at as soon as it is back.
 */
export function watchHosts(hostIds: Id[]): () => void {
  let stopped = false;
  let running = false;
  /** A round was due while the window was out of sight. */
  let waiting = false;
  let timer: number | undefined;
  const round = async () => {
    if (stopped || running) return;
    if (document.hidden) {
      waiting = true;
      return;
    }
    running = true;
    const now = Date.now();
    const hosts = useVault.getState().snapshot.hosts.filter((h) => hostIds.includes(h.id) && due(h, now));
    let next = 0;
    const worker = async () => {
      while (!stopped && next < hosts.length) await look(hosts[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, hosts.length) }, worker));
    running = false;
    if (!stopped) timer = window.setTimeout(() => void round(), EVERY_MS);
  };
  const onVisible = () => {
    if (document.hidden || !waiting) return;
    waiting = false;
    void round();
  };
  document.addEventListener("visibilitychange", onVisible);
  void round();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
