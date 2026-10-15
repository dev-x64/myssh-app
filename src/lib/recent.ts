// The hosts connected to most recently, for the new-tab page.
//
// Kept on this device only and outside the vault: it is not something to
// sync, and recording a connection must not touch the hosts themselves.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Id } from "./api";

export const RECENT_LIMIT = 10;

export interface RecentHost {
  hostId: Id;
  /** When the last session with it began, Unix milliseconds. */
  at: number;
}

interface RecentStore {
  entries: RecentHost[];
  /** A session with the host has just begun. */
  note: (hostId: Id) => void;
}

export const useRecent = create<RecentStore>()(
  persist(
    (set) => ({
      entries: [],
      note: (hostId) =>
        set((s) => ({
          entries: [{ hostId, at: Date.now() }, ...s.entries.filter((e) => e.hostId !== hostId)].slice(
            0,
            RECENT_LIMIT,
          ),
        })),
    }),
    { name: "myssh.recent" },
  ),
);
