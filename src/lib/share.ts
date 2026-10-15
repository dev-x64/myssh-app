// Sharing a terminal with people invited by link: the host's end.
//
// The app is the host of a room on the cloud server. Guests join the same
// room from their own MySSH. Everything either side says is sealed with a
// key that is made here, travels in the link after "#", and never reaches
// the server.
//
// Messages start out relayed by the server. As soon as the two computers
// manage to reach each other, each guest is moved to a direct channel,
// which is faster; if that channel fails, the guest is moved back and
// sent the screen again.
//
// One person types at a time: the host by default, a guest only after the
// host says yes, and the host can take the keyboard back at any moment.

import { SerializeAddon } from "@xterm/addon-serialize";
import { create } from "zustand";
import { api, asApiError, type ApiError } from "./api";
import { translate, type MessageKey } from "./i18n";
import { getSession } from "./sessions";
import { useSettings } from "./settings";
import {
  assembler,
  base64url,
  bodyText,
  BYTES,
  describe,
  EVENT,
  eventBody,
  ICE_SERVERS,
  importKey,
  open,
  parseEvent,
  seal,
  sendOver,
} from "./sharewire";
import { useUi } from "./store";

/** Output is gathered for this long, so a burst travels as one message. */
const BATCH_MS = 12;
/** No message is larger than this; bigger things go as several. */
const MESSAGE_BYTES = 192 * 1024;
/** Past this much waiting to be sent, output is skipped and the screen resent later. */
const BEHIND_BYTES = 2 * 1024 * 1024;
const CAUGHT_UP_BYTES = 128 * 1024;
const SCROLLBACK_SHARED = 2000;
/** A direct channel that has not opened in this time is given up. */
const DIRECT_TIMEOUT_MS = 15_000;

export interface ShareGuest {
  id: number;
  /** Empty until the guest has introduced itself. */
  name: string;
  /** Asked for the keyboard and waits for the answer. */
  asking: boolean;
  /** Reached directly rather than through the server. */
  direct: boolean;
}

export interface Share {
  tabId: string;
  /** The link to send; `null` while the room is being set up. */
  link: string | null;
  hostName: string;
  guests: ShareGuest[];
  /** Who types: `0` is the host, otherwise a guest's id. */
  control: number;
}

/** How one guest is reached. */
interface Link {
  /** Sent the screen; output before that is not this guest's yet. */
  ready: boolean;
  peer: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  /** What is for this guest goes over the direct channel. */
  direct: boolean;
  /**
   * What the guest sent over the channel before saying, through the
   * server, that it has switched: kept until then, so that nothing
   * overtakes what is still on its way through the server.
   */
  held: Uint8Array[] | null;
  timer: number | undefined;
}

interface Wire {
  socket: WebSocket;
  key: CryptoKey;
  serializer: SerializeAddon;
  /** Sends and received messages are handled one after another, in order. */
  out: Promise<void>;
  inbox: Promise<void>;
  pending: Uint8Array[];
  timer: number | undefined;
  watchdog: number;
  behind: boolean;
  links: Map<number, Link>;
  closing: boolean;
}

export const useShare = create<{ shares: Record<string, Share> }>(() => ({ shares: {} }));
const wires = new Map<string, Wire>();

function without(shares: Record<string, Share>, tabId: string): Record<string, Share> {
  return Object.fromEntries(Object.entries(shares).filter(([id]) => id !== tabId));
}

function patch(tabId: string, change: (share: Share) => Share) {
  useShare.setState((s) => {
    const share = s.shares[tabId];
    return share ? { shares: { ...s.shares, [tabId]: change(share) } } : s;
  });
}

function patchGuest(tabId: string, id: number, change: Partial<ShareGuest>) {
  patch(tabId, (s) => ({ ...s, guests: s.guests.map((g) => (g.id === id ? { ...g, ...change } : g)) }));
}

function say(kind: "info" | "success" | "error", key: MessageKey, vars?: Record<string, string | number>) {
  useUi.getState().toast(kind, translate(useSettings.getState().locale, key, vars));
}

/** Hands a sealed message to one guest, by whichever way it is reached. */
function deliver(wire: Wire, id: number, sealed: Uint8Array) {
  const link = wire.links.get(id);
  if (!link) return;
  if (link.direct && link.channel?.readyState === "open") {
    sendOver(link.channel, sealed);
    return;
  }
  if (wire.socket.readyState !== WebSocket.OPEN) return;
  const frame = new Uint8Array(4 + sealed.length);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(sealed, 4);
  wire.socket.send(frame);
}

/** Queues a message for one guest (`to`), or for all of them (`0`). */
function send(tabId: string, to: number, type: number, body: Uint8Array, then?: (wire: Wire) => void) {
  const wire = wires.get(tabId);
  if (!wire) return;
  wire.out = wire.out
    .then(async () => {
      const sealed = await seal(wire.key, "host", type, body);
      for (const id of to === 0 ? [...wire.links.keys()] : [to]) deliver(wire, id, sealed);
      then?.(wire);
    })
    .catch(() => {});
}

const sendEvent = (tabId: string, to: number, event: object, then?: (wire: Wire) => void) =>
  send(tabId, to, EVENT, eventBody(event), then);

/** Sends bytes as one message or, when there are many, as several. */
function sendBytes(tabId: string, to: number, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += MESSAGE_BYTES) {
    send(tabId, to, BYTES, bytes.subarray(offset, offset + MESSAGE_BYTES));
  }
}

function people(share: Share) {
  return {
    people: share.guests.filter((g) => g.name).map(({ id, name }) => ({ id, name })),
    control: share.control,
  };
}

function announce(tabId: string) {
  const share = useShare.getState().shares[tabId];
  if (share) sendEvent(tabId, 0, { k: "people", ...people(share) });
}

/**
 * Sends the whole screen to one guest, or to all. It is taken once the
 * terminal has drawn everything received so far, so what follows it on
 * the wire continues exactly where it ends.
 */
function sendScreen(tabId: string, to: number) {
  const wire = wires.get(tabId);
  const session = getSession(tabId);
  if (!wire || !session) return;
  session.term.write("", () => {
    const share = useShare.getState().shares[tabId];
    if (!share || !wires.has(tabId)) return;
    // Output already drawn goes out first: it is part of the screen below,
    // and must not arrive after it a second time.
    window.clearTimeout(wire.timer);
    flush(tabId);
    const screen = new TextEncoder().encode(wire.serializer.serialize({ scrollback: SCROLLBACK_SHARED }));
    for (const guest of to === 0 ? share.guests : share.guests.filter((g) => g.id === to)) {
      const link = wire.links.get(guest.id);
      if (!guest.name || !link) continue;
      sendEvent(tabId, guest.id, {
        k: "init",
        you: guest.id,
        host: share.hostName,
        title: session.tab()?.title ?? "",
        cols: session.term.cols,
        rows: session.term.rows,
        ...people(share),
      });
      // The screen follows as ordinary output, which the guest now takes.
      sendBytes(tabId, guest.id, screen);
      link.ready = true;
    }
  });
}

/** How much is waiting to be sent, on the slowest way out. */
function backlog(wire: Wire): number {
  let most = wire.socket.bufferedAmount;
  for (const link of wire.links.values()) {
    if (link.direct && link.channel) most = Math.max(most, link.channel.bufferedAmount);
  }
  return most;
}

function flush(tabId: string) {
  const wire = wires.get(tabId);
  if (!wire) return;
  wire.timer = undefined;
  const chunks = wire.pending;
  wire.pending = [];
  if (chunks.length === 0 || wire.behind) return;
  if (![...wire.links.values()].some((link) => link.ready)) return;
  if (backlog(wire) > BEHIND_BYTES) {
    // Someone cannot keep up. Skip ahead: the screen is sent again once
    // what is already on its way has gone.
    wire.behind = true;
    return;
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  sendBytes(tabId, 0, merged);
}

/** Terminal output, in the order the terminal drew it. Called by the session. */
export function shareOutput(tabId: string, data: Uint8Array) {
  const wire = wires.get(tabId);
  if (!wire || wire.behind) return;
  wire.pending.push(data);
  wire.timer ??= window.setTimeout(() => flush(tabId), BATCH_MS);
}

export function shareResize(tabId: string, cols: number, rows: number) {
  if (wires.has(tabId)) sendEvent(tabId, 0, { k: "size", cols, rows });
}

/** Whether the host's own keys go to the shell: not while a guest has the keyboard. */
export function hostMayType(tabId: string): boolean {
  const share = useShare.getState().shares[tabId];
  return !share || share.control === 0;
}

// ------------------------------------------------------- direct channels ---

function dropDirect(link: Link) {
  window.clearTimeout(link.timer);
  link.timer = undefined;
  link.direct = false;
  link.held = null;
  const { channel, peer } = link;
  link.channel = null;
  link.peer = null;
  if (channel) channel.onclose = null;
  try {
    channel?.close();
    peer?.close();
  } catch {
    // Already gone.
  }
}

/** Back to the server for one guest, with the screen sent again over it. */
function fallBack(tabId: string, id: number) {
  const link = wires.get(tabId)?.links.get(id);
  if (!link) return;
  const wasDirect = link.direct;
  dropDirect(link);
  patchGuest(tabId, id, { direct: false });
  if (wasDirect) sendScreen(tabId, id);
}

/** Offers a guest a direct channel. Until it opens, nothing changes. */
function offerDirect(tabId: string, id: number) {
  const wire = wires.get(tabId);
  const link = wire?.links.get(id);
  if (!wire || !link || link.peer || typeof RTCPeerConnection !== "function") return;
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = peer.createDataChannel("myssh", { ordered: true });
  channel.binaryType = "arraybuffer";
  link.peer = peer;
  link.channel = channel;
  link.timer = window.setTimeout(() => {
    if (!link.direct && link.peer === peer) dropDirect(link);
  }, DIRECT_TIMEOUT_MS);

  const receive = assembler((sealed) => {
    wire.inbox = wire.inbox
      .then(async () => {
        if (link.channel !== channel) return;
        // Not yet told, through the server, that the guest has switched.
        if (link.held) link.held.push(sealed);
        else await handle(tabId, id, sealed);
      })
      .catch(() => {});
  });
  channel.onmessage = (message) => receive(message.data as ArrayBuffer);
  channel.onopen = () => {
    if (link.channel !== channel) return;
    window.clearTimeout(link.timer);
    link.held = [];
    // The last thing this guest gets through the server; all that follows
    // goes over the channel, in the same order.
    sendEvent(tabId, id, { k: "switch" }, () => {
      if (link.channel === channel) link.direct = true;
    });
    patchGuest(tabId, id, { direct: true });
  };
  channel.onclose = () => {
    if (link.channel === channel) fallBack(tabId, id);
  };
  peer.onconnectionstatechange = () => {
    if (link.peer === peer && (peer.connectionState === "failed" || peer.connectionState === "closed")) {
      fallBack(tabId, id);
    }
  };

  void (async () => {
    try {
      await peer.setLocalDescription(await peer.createOffer());
      const offer = await describe(peer);
      if (link.peer === peer) sendEvent(tabId, id, { k: "offer", sdp: offer.sdp });
    } catch {
      if (link.peer === peer) dropDirect(link);
    }
  })();
}

// ------------------------------------------------------ what guests say ---

function onRelay(tabId: string, message: { t?: string; id?: number }) {
  const wire = wires.get(tabId);
  const id = message.id;
  if (!wire || typeof id !== "number") return;
  if (message.t === "join") {
    wire.links.set(id, { ready: false, peer: null, channel: null, direct: false, held: null, timer: undefined });
    patch(tabId, (s) => ({
      ...s,
      guests: [...s.guests, { id, name: "", asking: false, direct: false }],
    }));
  } else if (message.t === "leave") {
    const left = useShare.getState().shares[tabId]?.guests.find((g) => g.id === id);
    const link = wire.links.get(id);
    if (link) dropDirect(link);
    wire.links.delete(id);
    patch(tabId, (s) => ({
      ...s,
      guests: s.guests.filter((g) => g.id !== id),
      // The keyboard does not leave with a guest.
      control: s.control === id ? 0 : s.control,
    }));
    if (left?.name) say("info", "share.left", { name: left.name });
    announce(tabId);
  }
}

/** Opens and acts on one message from a guest, whichever way it came. */
async function handle(tabId: string, from: number, sealed: Uint8Array) {
  const wire = wires.get(tabId);
  if (!wire) return;
  const { type, body } = await open(wire.key, "guest", sealed);
  const share = useShare.getState().shares[tabId];
  const guest = share?.guests.find((g) => g.id === from);
  const link = wire.links.get(from);
  if (!share || !guest || !link) return;
  if (type === BYTES) {
    // Keys count only from the one who holds the keyboard.
    if (share.control === from) getSession(tabId)?.type(bodyText(body));
    return;
  }
  if (type !== EVENT) return;
  const event = parseEvent(body);
  switch (event.k) {
    case "hello": {
      if (guest.name) return;
      const name = (typeof event.name === "string" ? event.name : "").trim().slice(0, 40) || `#${from}`;
      patchGuest(tabId, from, { name });
      say("info", "share.joined", { name });
      sendScreen(tabId, from);
      announce(tabId);
      offerDirect(tabId, from);
      break;
    }
    case "answer":
      if (link.peer && typeof event.sdp === "string") {
        await link.peer.setRemoteDescription({ type: "answer", sdp: event.sdp }).catch(() => dropDirect(link));
      }
      break;
    case "switched": {
      // From here on the guest speaks over the channel; first, what it
      // said there while this was on its way.
      const held = link.held ?? [];
      link.held = null;
      for (const earlier of held) await handle(tabId, from, earlier).catch(() => {});
      break;
    }
    case "relay":
      // The guest lost the channel before this end noticed.
      fallBack(tabId, from);
      break;
    case "request":
      if (!guest.name || share.control === from) return;
      patchGuest(tabId, from, { asking: true });
      break;
    case "release":
      if (share.control !== from) return;
      patch(tabId, (s) => ({ ...s, control: 0 }));
      announce(tabId);
      break;
  }
}

/** Starts sharing a tab's terminal. The link is ready when this resolves without an error. */
export async function startShare(tabId: string): Promise<ApiError | null> {
  const session = getSession(tabId);
  if (!session || wires.has(tabId) || useShare.getState().shares[tabId]) return null;
  useShare.setState((s) => ({
    shares: { ...s.shares, [tabId]: { tabId, link: null, hostName: "", guests: [], control: 0 } },
  }));
  const forget = () => useShare.setState((s) => ({ shares: without(s.shares, tabId) }));
  try {
    const invite = await api.shareOpen();
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importKey(raw);
    const socket = new WebSocket(invite.socket);
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("close", () => reject(new Error("the connection was refused")), { once: true });
    });
    const serializer = new SerializeAddon();
    session.term.loadAddon(serializer);
    const wire: Wire = {
      socket,
      key,
      serializer,
      out: Promise.resolve(),
      inbox: Promise.resolve(),
      pending: [],
      timer: undefined,
      behind: false,
      links: new Map(),
      closing: false,
      watchdog: window.setInterval(() => {
        // Caught up after falling behind: everyone gets the screen as it is now.
        if (wire.behind && backlog(wire) < CAUGHT_UP_BYTES) {
          wire.behind = false;
          sendScreen(tabId, 0);
        }
      }, 250),
    };
    wires.set(tabId, wire);
    socket.addEventListener("message", (message) => {
      if (typeof message.data === "string") {
        try {
          onRelay(tabId, JSON.parse(message.data));
        } catch {
          // Not something the relay says; ignored.
        }
        return;
      }
      const data = new Uint8Array(message.data as ArrayBuffer);
      if (data.length < 4) return;
      const from = new DataView(data.buffer).getUint32(0);
      wire.inbox = wire.inbox
        .then(() => handle(tabId, from, data.subarray(4)))
        // A message that does not open is not from someone with the link.
        .catch(() => {});
    });
    socket.addEventListener("close", () => {
      if (wire.closing) return;
      cleanUp(tabId);
      say("error", "share.lost");
    });
    patch(tabId, (s) => ({ ...s, link: `${invite.link}#${base64url(raw)}`, hostName: invite.host }));
    return null;
  } catch (e) {
    forget();
    return asApiError(e);
  }
}

function cleanUp(tabId: string) {
  const wire = wires.get(tabId);
  if (wire) {
    window.clearTimeout(wire.timer);
    window.clearInterval(wire.watchdog);
    for (const link of wire.links.values()) dropDirect(link);
    wire.serializer.dispose();
    wires.delete(tabId);
  }
  useShare.setState((s) => ({ shares: without(s.shares, tabId) }));
}

/** Stops sharing: guests are told, and the room is gone. */
export function stopShare(tabId: string) {
  const wire = wires.get(tabId);
  if (!wire) {
    cleanUp(tabId);
    return;
  }
  wire.closing = true;
  const { socket } = wire;
  // Everyone is told by the way they are reached; then the ways are closed.
  sendEvent(tabId, 0, { k: "end" });
  const told = wire.out;
  wires.delete(tabId);
  window.clearTimeout(wire.timer);
  window.clearInterval(wire.watchdog);
  useShare.setState((s) => ({ shares: without(s.shares, tabId) }));
  void told.then(() => {
    window.setTimeout(() => {
      for (const link of wire.links.values()) dropDirect(link);
      wire.serializer.dispose();
      socket.close();
    }, 150);
  });
}

/** Lets a guest type. From then on the host's own keys are held back. */
export function grantControl(tabId: string, guestId: number) {
  patch(tabId, (s) => ({
    ...s,
    control: s.guests.some((g) => g.id === guestId) ? guestId : s.control,
    guests: s.guests.map((g) => (g.id === guestId ? { ...g, asking: false } : g)),
  }));
  announce(tabId);
}

export function denyControl(tabId: string, guestId: number) {
  patchGuest(tabId, guestId, { asking: false });
  sendEvent(tabId, guestId, { k: "denied" });
}

/** The host takes the keyboard back. */
export function takeControl(tabId: string) {
  patch(tabId, (s) => ({ ...s, control: 0 }));
  announce(tabId);
}

/** For tests: makes a guest's direct channel fail, as a network change would. */
export function breakDirect(tabId: string, guestId: number) {
  wires.get(tabId)?.links.get(guestId)?.channel?.close();
}
