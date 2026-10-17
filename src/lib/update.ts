// Updates of the app: looking for a newer version, and installing it when
// the user says so. The app is never restarted on its own.
//
// An update can be put off, but not for ever: once it has been put off
// twice, or has been on offer for a few days, it is installed quietly for
// the next launch, so that nobody stays long on an old version.
//
// Installing puts the new version in place of this one on disk; the app
// that is running goes on as it was until it is started again. So an
// update can be taken now, with a restart, or left for the next launch.
// A restart ends the connections, and the tabs open again once the app is
// back.
//
// What is found is usually newer. In an emergency it is older: the version
// in use was withdrawn, and the way back is offered. That is not left for
// the user to come across: the dialog opens by itself, once.

import { create } from "zustand";
import { api, asApiError, type ApiError, type UpdateInfo } from "./api";
import { tabsToReopen } from "./sessions";

/** The first look, shortly after start, and how often after that. */
const FIRST_CHECK_MS = 1_000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

/** Put off this many times, an update is installed for the next launch. */
export const PUT_OFF_TIMES = 2;
/** On offer this long, it is installed even if nobody looked at it. */
const PUT_OFF_MS = 3 * 24 * 60 * 60 * 1000;

/** How long the version on offer has been waiting for the user. */
interface PutOff {
  version: string;
  /** How many times the dialog was closed without installing it. */
  times: number;
  /** When it was first found, Unix milliseconds. */
  since: number;
}

const PUT_OFF_KEY = "myssh.update.put_off";

function readPutOff(): PutOff | null {
  try {
    const stored = JSON.parse(localStorage.getItem(PUT_OFF_KEY) ?? "null") as PutOff | null;
    return stored && typeof stored.version === "string" ? stored : null;
  } catch {
    return null;
  }
}

/** The record for this version, started afresh when another one is found. */
function putOffFor(version: string): PutOff {
  const stored = readPutOff();
  if (stored?.version === version) return stored;
  const fresh = { version, times: 0, since: Date.now() };
  localStorage.setItem(PUT_OFF_KEY, JSON.stringify(fresh));
  return fresh;
}

interface UpdateStore {
  /** The newer version found, if any. */
  available: UpdateInfo | null;
  /**
   * `ready`: in place, and taking over whenever the app is next started;
   * `restarting`: in place, and the app is on its way out.
   */
  phase: "idle" | "checking" | "downloading" | "ready" | "restarting";
  /** Downloaded part, 0 to 1; `null` while the size is not known. */
  progress: number | null;
  error: ApiError | null;
  /** When the last look succeeded, Unix milliseconds. */
  checkedAt: number | null;
  /** The dialog with what is new and the button to install. */
  dialog: boolean;
  setDialog: (open: boolean) => void;
  /** How many times the version on offer was put off. */
  putOff: number;
  /** The dialog was closed without installing. Enough of that, and it installs. */
  postpone: () => void;
  /** Looks for a newer version. `quiet`: a failure is not worth showing. */
  check: (quiet: boolean) => Promise<UpdateInfo | null>;
  /** Installs the version found. `restart`: and starts the app again as it, now. */
  install: (restart: boolean) => Promise<boolean>;
  /** Starts the app again, as the version already installed. */
  restart: () => Promise<void>;
}

export const useUpdate = create<UpdateStore>((set, get) => ({
  available: null,
  phase: "idle",
  progress: null,
  error: null,
  checkedAt: null,
  dialog: false,
  setDialog: (dialog) => set({ dialog, ...(dialog ? {} : { error: null }) }),
  putOff: 0,
  postpone: () => {
    const { available, phase } = get();
    if (!available || phase !== "idle") return;
    const record = putOffFor(available.version);
    record.times += 1;
    localStorage.setItem(PUT_OFF_KEY, JSON.stringify(record));
    set({ putOff: record.times });
    if (record.times >= PUT_OFF_TIMES) void get().install(false);
  },
  check: async (quiet) => {
    if (get().phase !== "idle") return get().available;
    set({ phase: "checking", ...(quiet ? {} : { error: null }) });
    try {
      const available = await api.updateCheck();
      const before = get().available;
      const news = available?.rollback && !(before?.rollback && before.version === available.version);
      const record = available ? putOffFor(available.version) : null;
      set({
        available,
        phase: "idle",
        checkedAt: Date.now(),
        error: null,
        putOff: record?.times ?? 0,
        ...(news ? { dialog: true } : {}),
      });
      // Waited long enough: it goes in for the next launch, without a word.
      const overdue = record && (record.times >= PUT_OFF_TIMES || Date.now() - record.since >= PUT_OFF_MS);
      if (overdue && !get().dialog) void get().install(false);
      return available;
    } catch (e) {
      set({ phase: "idle", ...(quiet ? {} : { error: asApiError(e) }) });
      return null;
    }
  },
  install: async (restart) => {
    if (get().phase !== "idle" || !get().available) return false;
    set({ phase: "downloading", progress: null, error: null });
    try {
      await api.updateInstall(({ downloaded, total }) =>
        set({ progress: total ? Math.min(1, downloaded / total) : null }),
      );
    } catch (e) {
      set({ phase: "idle", progress: null, error: asApiError(e) });
      return false;
    }
    set({ phase: "ready", progress: 1 });
    if (restart) await get().restart();
    return true;
  },
  restart: async () => {
    if (get().phase !== "ready") return;
    set({ phase: "restarting", error: null });
    try {
      await api.updateRestart(tabsToReopen());
    } catch (e) {
      set({ phase: "ready", error: asApiError(e) });
    }
  },
}));

/**
 * Looks for updates now and then, for as long as the app runs. Quietly:
 * finding one only puts a small button in the title bar.
 */
export function startUpdates() {
  let lookedAt = Date.now();
  const look = () => {
    lookedAt = Date.now();
    void useUpdate.getState().check(true);
  };
  window.setTimeout(look, FIRST_CHECK_MS);
  window.setInterval(look, CHECK_EVERY_MS);
  // A window out of sight has its timers slowed down; it catches up when it is looked at again.
  window.addEventListener("focus", () => {
    if (Date.now() - lookedAt >= CHECK_EVERY_MS) look();
  });
}
