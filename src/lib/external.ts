// Remote files opened in other apps.
//
// The file is fetched into a working copy on this Mac and opened there.
// While its tab lives, the copy is watched: when the other app saves it,
// the user is asked whether the new content should go to the server, and
// nothing is sent without that answer. A file that has changed on the
// server in the meantime gets a second, sharper question.

import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  api,
  asApiError,
  type ApiError,
  type FileVersion,
  type LocalStamp,
  type TransferProgress,
} from "./api";
import { errorText, translate } from "./i18n";
import { getSession } from "./sessions";
import { useSettings } from "./settings";
import { useUi } from "./store";

const POLL_MS = 1500;
/** Transfer ids of these uploads, kept apart from the file manager's own. */
let transferSeq = 1_000_000;

export interface ExternalFile {
  id: number;
  tabId: string;
  /** Path on the server. */
  remote: string;
  name: string;
  /** The working copy and its folder. */
  local: string;
  dir: string;
  /** Name of the app it was opened in, if one was chosen. */
  app: string | null;
  /** The server's file as last fetched or sent. */
  version: FileVersion;
  /** The working copy as last fetched or sent. */
  stamp: LocalStamp;
  /**
   * `asking`: saved in the other app; the user decides whether it is sent.
   * `conflict`: the user said yes, but the server's file has changed too.
   */
  state: "watching" | "asking" | "sending" | "conflict";
}

interface ExternalStore {
  files: ExternalFile[];
}

export const useExternal = create<ExternalStore>(() => ({ files: [] }));

let seq = 1;
let timer: number | undefined;

function patch(id: number, change: Partial<ExternalFile>) {
  useExternal.setState((s) => ({
    files: s.files.map((file) => (file.id === id ? { ...file, ...change } : file)),
  }));
}

function say(kind: "success" | "error" | "info", key: Parameters<typeof translate>[1], name: string, detail?: string) {
  useUi.getState().toast(kind, translate(useSettings.getState().locale, key, { name }), detail);
}

function parentOf(path: string): string {
  const index = path.replace(/\/+$/, "").lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/** The app's name as the Finder shows it: its bundle without ".app". */
export function appName(path: string): string {
  return (path.replace(/\/+$/, "").split("/").pop() ?? path).replace(/\.app$/i, "");
}

/** Fetches a remote file and opens it in another app; from then on its saves go back. */
export async function openExternally(
  tabId: string,
  sid: number,
  remote: string,
  name: string,
  app: string | null,
): Promise<ApiError | null> {
  // Opened twice, a file would have two copies racing to be the one sent back.
  const already = useExternal.getState().files.find((f) => f.tabId === tabId && f.remote === remote);
  try {
    if (already) {
      await api.localOpen(already.local, app);
      return null;
    }
    const copy = await api.sftpOpenExternal(sid, remote, app);
    const file: ExternalFile = {
      id: seq++,
      tabId,
      remote,
      name,
      local: copy.local,
      dir: copy.dir,
      app: app ? appName(app) : null,
      version: copy.version,
      stamp: copy.stamp,
      state: "watching",
    };
    useExternal.setState((s) => ({ files: [...s.files, file] }));
    timer ??= window.setInterval(() => void poll(), POLL_MS);
    return null;
  } catch (e) {
    return asApiError(e);
  }
}

/** Stops watching a file and removes its working copy. */
export function stopWatching(id: number) {
  const file = useExternal.getState().files.find((f) => f.id === id);
  if (!file) return;
  useExternal.setState((s) => ({ files: s.files.filter((f) => f.id !== id) }));
  void api.externalDiscard(file.dir).catch(() => {});
  if (useExternal.getState().files.length === 0) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

/** A tab is closing: its files are no longer anyone's to send back. */
export function forgetTab(tabId: string) {
  for (const file of useExternal.getState().files) {
    if (file.tabId === tabId) stopWatching(file.id);
  }
}

const sameVersion = (a: FileVersion, b: FileVersion) => a.size === b.size && a.modified === b.modified;
const sameStamp = (a: LocalStamp, b: LocalStamp) => a.size === b.size && a.modified_ms === b.modified_ms;

/** Sends the working copy to the server. `force`: even if the server's file has changed. */
async function send(file: ExternalFile, stamp: LocalStamp, force: boolean) {
  const sid = getSession(file.tabId)?.liveSessionId ?? null;
  // Not connected just now: the change stays noticed and is sent later.
  if (sid === null) return;
  patch(file.id, { state: "sending" });
  try {
    if (!force) {
      let current: FileVersion | null = null;
      try {
        current = await api.sftpVersion(sid, file.remote);
      } catch (e) {
        // Gone from the server counts as changed there.
        if (asApiError(e).code !== "no_such_file") throw e;
      }
      if (!current || !sameVersion(current, file.version)) {
        patch(file.id, { state: "conflict" });
        // The question waits in the file's tab; say so wherever the user is.
        say("info", "external.conflict.title", file.name);
        return;
      }
    }
    await api.sftpUpload(
      sid,
      file.local,
      parentOf(file.remote),
      true,
      transferSeq++,
      new Channel<TransferProgress>(),
    );
    const version = await api.sftpVersion(sid, file.remote);
    patch(file.id, { state: "watching", version, stamp });
    say("success", "external.sent", file.name);
  } catch (e) {
    const failure = asApiError(e);
    // The copy counts as sent in this state, so the same failure is not
    // repeated every second; the next save tries again.
    patch(file.id, { state: "watching", stamp });
    say("error", "external.failed", file.name, failure.detail ?? errorText(failure));
  }
}

let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (const file of useExternal.getState().files) {
      if (file.state !== "watching") continue;
      let stamp: LocalStamp | null;
      try {
        stamp = await api.localStamp(file.local);
      } catch {
        continue;
      }
      // Editors that save by replacing the file leave a moment without it.
      if (!stamp) continue;
      if (!sameStamp(stamp, file.stamp)) {
        // Nothing goes to the server on its own: the tab asks.
        patch(file.id, { state: "asking" });
        say("info", "external.changed", file.name);
      }
    }
  } finally {
    polling = false;
  }
}

/** The user's answer to "send what was saved?". Declined, this save is let go. */
export async function answerChange(id: number, upload: boolean) {
  const file = useExternal.getState().files.find((f) => f.id === id);
  if (!file || file.state !== "asking") return;
  // What is sent, or let go, is the copy as it is at this moment.
  const stamp = (await api.localStamp(file.local).catch(() => null)) ?? file.stamp;
  if (!upload) {
    patch(file.id, { state: "watching", stamp });
    return;
  }
  if ((getSession(file.tabId)?.liveSessionId ?? null) === null) {
    // Asked again once there is a connection to send it over.
    patch(file.id, { state: "watching" });
    say("error", "external.offline", file.name);
    return;
  }
  await send({ ...file, state: "watching" }, stamp, false);
}

/** The user's answer to a conflict: send mine anyway, or leave the server's file. */
export async function resolveConflict(id: number, overwrite: boolean) {
  const file = useExternal.getState().files.find((f) => f.id === id);
  if (!file || file.state !== "conflict") return;
  const stamp = (await api.localStamp(file.local).catch(() => null)) ?? file.stamp;
  if (overwrite) {
    await send({ ...file, state: "watching" }, stamp, true);
  } else {
    // This save is let go; a later one is compared with the server again.
    patch(file.id, { state: "watching", stamp });
  }
}
