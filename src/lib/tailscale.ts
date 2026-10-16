// Machines of a tailnet among the saved hosts: which they are, and whether
// Tailscale on this computer sees them online. Asked of Tailscale about every
// half minute while the hosts are in sight, and only when some host looks
// like one of its machines.

import { create } from "zustand";
import { api, type HostView, type TailscalePeer } from "./api";

const EVERY_MS = 30_000;

export const useTailscale = create<{ peers: TailscalePeer[] }>(() => ({ peers: [] }));

/** 100.64.0.0/10, the addresses Tailscale hands out. */
function inTailnetRange(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** Whether a host is one of a tailnet's machines, by what it is called or where it is. */
export function looksTailscale(host: HostView): boolean {
  const address = host.address.toLowerCase();
  return host.tags.includes("tailscale") || address.endsWith(".ts.net") || inTailnetRange(address);
}

/** The tailnet machine a host is, if Tailscale knows it. */
export function peerOf(host: HostView, peers: TailscalePeer[]): TailscalePeer | null {
  const address = host.address.toLowerCase().replace(/\.$/, "");
  return (
    peers.find((peer) => peer.dns === address || peer.ips.includes(address) || (peer.name && peer.name === address)) ??
    null
  );
}

/** Asks Tailscale now and every half minute after, until told to stop. */
export function watchTailscale(hosts: HostView[]): () => void {
  if (!hosts.some(looksTailscale)) return () => {};
  let stopped = false;
  const ask = () =>
    void api
      .tailscalePeers()
      .then((peers) => !stopped && useTailscale.setState({ peers }))
      .catch(() => {});
  ask();
  const timer = window.setInterval(ask, EVERY_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}
