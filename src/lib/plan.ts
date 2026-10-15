// What the cloud account is on, Free or Pro, known in one place for the
// whole window: the avatar, the account menu, the cloud screen and the
// features that come with Pro all read it from here.

import { create } from "zustand";
import { api, type CloudPlan } from "./api";
import { syncNow, useCloud } from "./cloud";
import { useVault } from "./store";

interface PlanStore {
  /** `null`: signed out, or not known yet (offline, an older server). */
  plan: CloudPlan | null;
}

export const usePlan = create<PlanStore>(() => ({ plan: null }));

/** Whether the account has Pro; `null` while that is not known. */
export function usePro(): boolean | null {
  return usePlan((s) => (s.plan ? s.plan.plan === "pro" : null));
}

/** An answer this fresh is not asked for again, unless forced. */
const FRESH_MS = 30_000;
let loadedAt = 0;
let loading: Promise<void> | null = null;

function signedIn(): boolean {
  const account = useVault.getState().snapshot.cloud;
  return account !== null && !account.revoked;
}

/** Asks the server what the account is on. What was known stays when it cannot be asked. */
export function loadPlan(force = false): Promise<void> {
  if (!signedIn()) return Promise.resolve();
  if (loading) return loading;
  if (!force && Date.now() - loadedAt < FRESH_MS) return Promise.resolve();
  loading = (async () => {
    try {
      const plan = await api.cloudPlan();
      loadedAt = Date.now();
      usePlan.setState({ plan });
      // Pro has just been taken: sync, stopped for want of it, goes on at once.
      const { state, error } = useCloud.getState();
      if (plan?.plan === "pro" && state === "error" && error?.code === "pro_required") void syncNow();
      // The answer also brings the account's e-mail, changed perhaps on another device.
      await useVault.getState().refresh();
    } catch {
      // Offline or an older server.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Keeps the plan known while the app runs. */
export function startPlan() {
  useVault.subscribe((state, previous) => {
    const now = state.snapshot.cloud;
    if (!now || now.revoked) {
      loadedAt = 0;
      if (usePlan.getState().plan) usePlan.setState({ plan: null });
      return;
    }
    const before = previous.snapshot.cloud;
    if (!before || before.revoked || before.email !== now.email) void loadPlan(true);
  });
  // What sync runs into says when the plan has changed: refused for want of
  // Pro while Pro was thought to be there, or going through on Free.
  useCloud.subscribe((state, previous) => {
    const plan = usePlan.getState().plan?.plan;
    const refused = state.state === "error" && state.error?.code === "pro_required";
    const wasRefused = previous.state === "error" && previous.error?.code === "pro_required";
    if ((refused && plan !== "free") || (wasRefused && !refused && state.state === "idle" && plan === "free")) {
      void loadPlan(true);
    }
  });
  // Back from the browser, where Pro may just have been taken or cancelled.
  window.addEventListener("focus", () => void loadPlan());
  void loadPlan(true);
}
