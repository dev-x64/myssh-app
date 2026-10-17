// The network under the open sessions: gone, back, or perhaps changed (the
// computer woke up, a VPN came or went). A connection does not notice by
// itself for a while; the sessions are told, so that they check theirs at
// once and reconnect as soon as there is a network to reconnect over.

import { create } from "zustand";

export type NetworkChange = "offline" | "online" | "wake";

export const useNetwork = create<{ online: boolean }>(() => ({ online: navigator.onLine }));

const listeners = new Set<(change: NetworkChange) => void>();

export function onNetworkChange(listener: (change: NetworkChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tell(change: NetworkChange) {
  for (const listener of listeners) listener(change);
}

window.addEventListener("offline", () => {
  useNetwork.setState({ online: false });
  tell("offline");
});
window.addEventListener("online", () => {
  useNetwork.setState({ online: true });
  tell("online");
});

// A timer that comes back much later than it was set for means the computer
// was asleep: its network may well be another one now.
const TICK_MS = 5000;
const SLEPT_MS = 20000;
let last = Date.now();
window.setInterval(() => {
  const now = Date.now();
  if (now - last > SLEPT_MS) tell("wake");
  last = now;
}, TICK_MS);
