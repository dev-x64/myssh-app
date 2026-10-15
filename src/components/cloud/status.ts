// The one-line state of cloud sync, shared by the account menu and the
// cloud screen.

import { useEffect, useState } from "react";
import { reportError } from "../../lib/actions";
import { api } from "../../lib/api";
import { useCloud } from "../../lib/cloud";
import { errorText, formatAgo, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";
import { useVault } from "../../lib/store";

export interface SyncStatus {
  /** ok: in sync. busy: working. warn: waiting. bad: needs attention. */
  tone: "ok" | "busy" | "warn" | "bad";
  text: string;
  detail?: string;
}

/** `null` when not signed in. */
/** A change is normally sent within a few seconds; waiting longer than this is worth showing. */
const WAITING_MS = 6000;

/**
 * Whether something has been so for a while. What passes in a moment,
 * such as a change on its way to the cloud, is then not shown at all.
 */
function useLasting(on: boolean, ms: number): boolean {
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    if (!on) {
      setLasting(false);
      return;
    }
    const timer = window.setTimeout(() => setLasting(true), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return on && lasting;
}

/**
 * What sync is up to, in words. `live`: where it is shown large and looked
 * at, the time since the last sync is counted second by second.
 */
export function useSyncStatus(live = false): SyncStatus | null {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const account = useVault((s) => s.snapshot.cloud);
  const state = useCloud((s) => s.state);
  const error = useCloud((s) => s.error);
  const waiting = useLasting((account?.pending ?? 0) > 0, WAITING_MS);
  // Re-render so that "synced 2 minutes ago" keeps up with the clock.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), live ? 1000 : 20_000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (!account) return null;
  if (account.revoked) return { tone: "bad", text: t("cloud.revoked.title") };
  if (state === "syncing") return { tone: "busy", text: t("cloud.status.syncing") };
  if (state === "offline") return { tone: "warn", text: t("cloud.status.offline") };
  // An account on Free: nothing is wrong, the cloud is simply Pro's.
  if (state === "error" && error?.code === "pro_required") {
    return { tone: "warn", text: t("cloud.status.pro_required"), detail: t("cloud.status.pro_required.detail") };
  }
  if (state === "error" && error) {
    return {
      tone: "bad",
      text: `${t("cloud.status.error")}: ${errorText(error)}`,
      detail: error.detail ?? undefined,
    };
  }
  if (waiting) {
    return { tone: "warn", text: t("cloud.status.pending", { n: account.pending }) };
  }
  if (account.last_sync_at) {
    return {
      tone: "ok",
      text: t("cloud.status.synced"),
      detail: t("cloud.status.synced_at", { time: formatAgo(account.last_sync_at, locale, live) }),
    };
  }
  return { tone: "warn", text: t("cloud.status.never") };
}

/** Opens the account's pages on the server in the browser, signed in as this device. */
export async function openAccountPage(): Promise<void> {
  try {
    await api.cloudOpenAccount(useSettings.getState().locale);
  } catch (e) {
    reportError(e);
  }
}

/** Ends cloud access on this device. Local data stays. */
export async function signOutOfCloud(): Promise<void> {
  try {
    await api.cloudSignOut();
  } catch (e) {
    reportError(e);
  }
  useCloud.setState({ state: "idle", error: null, conflicts: [] });
  await useVault.getState().refresh();
}
