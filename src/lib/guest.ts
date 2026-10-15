// Watching a terminal someone else shares: the guest's end.
//
// An invitation names a room on the cloud server and carries, after "#",
// the key that seals the session. The guest joins the room and is sent the
// screen; from then on it sees what the host sees. It starts out through
// the server and moves to a direct channel as soon as the host offers one
// and it opens. Its keys go anywhere only while the host lets it type.

import { Terminal } from "@xterm/xterm";
import { create } from "zustand";
import { api, asApiError } from "./api";
import { errorText, translate, type MessageKey } from "./i18n";
import { terminalOptions } from "./sessions";
import { onSystemThemeChange, useSettings } from "./settings";
import {
  assembler,
  BYTES,
  describe,
  EVENT,
  eventBody,
  ICE_SERVERS,
  importKey,
  keyFromText,
  open,
  parseEvent,
  seal,
  sendOver,
  textBody,
} from "./sharewire";
import { useUi, useVault, type GuestTab } from "./store";

const ROOM = /^[A-Za-z0-9_-]{22}$/;
/** Why the server closed the connection. */
const CLOSE_REASON: Record<number, MessageKey> = {
  4000: "guest.ended.stopped",
  4001: "guest.ended.full",
  4004: "guest.ended.missing",
  4008: "guest.ended.slow",
};

const sessions = new Map<string, GuestSession>();
let seq = 1;

function say(kind: "info" | "error", key: MessageKey, vars?: Record<string, string>) {
  useUi.getState().toast(kind, translate(useSettings.getState().locale, key, vars));
}

/** The room and key of an invitation: the link itself, or what it opens the app with. */
export function parseInvite(text: string): { room: string; key: Uint8Array<ArrayBuffer> } | null {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/join\/|https?:\/\/[^/\s]+\/s\/)([A-Za-z0-9_-]+)\/?#([A-Za-z0-9_-]+)$/.exec(
    text.trim(),
  );
  if (!match || !ROOM.test(match[1])) return null;
  try {
    return { room: match[1], key: keyFromText(match[2]) };
  } catch {
    return null;
  }
}

export class GuestSession {
  readonly term: Terminal;
  private socket: WebSocket | null = null;
  private key: CryptoKey | null = null;
  /** Messages are opened, and sealed, one after another, in order. */
  private inbox: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  /** The host has moved this guest to the direct channel. */
  private direct = false;
  /** What came over the channel before the server delivered the word to switch. */
  private early: Uint8Array[] = [];
  /** The screen has arrived; output before it belongs to it already. */
  private ready = false;
  private element: HTMLElement | null = null;
  private size = { cols: 80, rows: 24 };
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly room: string,
    private readonly keyBytes: Uint8Array<ArrayBuffer>,
    private readonly name: string,
  ) {
    this.term = new Terminal({
      ...terminalOptions(useSettings.getState()),
      allowProposedApi: true,
      disableStdin: true,
      scrollback: 5000,
    });
    this.term.onData((data) => {
      const tab = this.tab();
      if (tab && tab.me !== 0 && tab.control === tab.me) this.send(BYTES, textBody(data));
    });
  }

  private tab(): GuestTab | undefined {
    return useUi.getState().guests.find((g) => g.id === this.id);
  }

  private patch(change: Partial<GuestTab>) {
    useUi.getState().patchGuest(this.id, change);
  }

  async connect() {
    try {
      this.key = await importKey(this.keyBytes);
      const { socket: address } = await api.shareJoin(this.room);
      if (this.disposed) return;
      const socket = new WebSocket(address);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      socket.addEventListener("open", () => this.send(EVENT, eventBody({ k: "hello", name: this.name })));
      socket.addEventListener("message", (message) => {
        if (typeof message.data === "string") return;
        const sealed = new Uint8Array(message.data as ArrayBuffer);
        this.inbox = this.inbox.then(() => this.handle(sealed, false)).catch(() => {});
      });
      socket.addEventListener("close", (closed) => {
        if (this.disposed) return;
        this.end(CLOSE_REASON[closed.code] ?? "guest.ended.lost");
      });
    } catch (e) {
      const failure = asApiError(e);
      this.end("guest.ended.lost");
      useUi.getState().toast("error", errorText(failure), failure.detail ?? undefined);
    }
  }

  private end(reason: MessageKey) {
    if (this.tab()?.state === "ended") return;
    this.dropDirect();
    this.term.options.disableStdin = true;
    this.patch({ state: "ended", ended: reason, control: 0, asked: false, direct: false });
  }

  /** Seals and sends, by the direct channel once the host has moved us to it. */
  private send(type: number, body: Uint8Array) {
    this.outbox = this.outbox
      .then(async () => {
        if (!this.key) return;
        const sealed = await seal(this.key, "guest", type, body);
        if (this.direct && this.channel?.readyState === "open") sendOver(this.channel, sealed);
        else if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(sealed);
      })
      .catch(() => {});
  }

  private async handle(sealed: Uint8Array, overChannel: boolean) {
    if (!this.key || this.disposed) return;
    // Until the server has delivered the word to switch, the channel waits.
    if (overChannel && !this.direct) {
      this.early.push(sealed);
      return;
    }
    const { type, body } = await open(this.key, "host", sealed);
    if (type === BYTES) {
      if (this.ready) this.term.write(body);
      return;
    }
    if (type !== EVENT) return;
    const event = parseEvent(body);
    const people = Array.isArray(event.people) ? (event.people as GuestTab["people"]) : [];
    const control = typeof event.control === "number" ? event.control : 0;
    switch (event.k) {
      case "init": {
        const me = typeof event.you === "number" ? event.you : 0;
        this.ready = true;
        this.size = { cols: Number(event.cols) || 80, rows: Number(event.rows) || 24 };
        this.term.reset();
        this.refit();
        const wasAsking = this.tab()?.asked ?? false;
        this.patch({
          state: "live",
          me,
          control,
          people,
          title: typeof event.title === "string" ? event.title : "",
          hostName: typeof event.host === "string" ? event.host : "",
          asked: control === me ? false : wasAsking,
        });
        this.term.options.disableStdin = control !== me;
        break;
      }
      case "size":
        this.size = { cols: Number(event.cols) || 80, rows: Number(event.rows) || 24 };
        this.refit();
        break;
      case "people": {
        const tab = this.tab();
        if (!tab) return;
        const mine = tab.me !== 0 && control === tab.me;
        this.patch({ people, control, asked: control !== tab.control ? false : tab.asked });
        this.term.options.disableStdin = !mine;
        if (mine && useUi.getState().active === this.id) this.term.focus();
        break;
      }
      case "denied":
        this.patch({ asked: false });
        say("info", "guest.denied");
        break;
      case "end":
        this.end("guest.ended.stopped");
        break;
      case "offer":
        if (typeof event.sdp === "string") void this.answer(event.sdp);
        break;
      case "switch": {
        // The last word through the server. Say so, by the same way, and
        // from here on speak and listen over the channel.
        this.send(EVENT, eventBody({ k: "switched" }));
        await this.outbox;
        this.direct = true;
        this.patch({ direct: true });
        const early = this.early;
        this.early = [];
        for (const message of early) await this.handle(message, true).catch(() => {});
        break;
      }
    }
  }

  /** Accepts the host's offer of a direct channel. */
  private async answer(sdp: string) {
    if (typeof RTCPeerConnection !== "function") return;
    this.dropDirect();
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peer = peer;
    peer.ondatachannel = ({ channel }) => {
      if (this.peer !== peer) return;
      channel.binaryType = "arraybuffer";
      this.channel = channel;
      const receive = assembler((sealed) => {
        this.inbox = this.inbox
          .then(() => (this.channel === channel ? this.handle(sealed, true) : undefined))
          .catch(() => {});
      });
      channel.onmessage = (message) => receive(message.data as ArrayBuffer);
      channel.onclose = () => {
        if (this.channel === channel) this.lostDirect();
      };
    };
    peer.onconnectionstatechange = () => {
      if (this.peer === peer && (peer.connectionState === "failed" || peer.connectionState === "closed")) {
        this.lostDirect();
      }
    };
    try {
      await peer.setRemoteDescription({ type: "offer", sdp });
      await peer.setLocalDescription(await peer.createAnswer());
      const local = await describe(peer);
      if (this.peer === peer) this.send(EVENT, eventBody({ k: "answer", sdp: local.sdp }));
    } catch {
      if (this.peer === peer) this.dropDirect();
    }
  }

  private dropDirect() {
    const { channel, peer } = this;
    this.channel = null;
    this.peer = null;
    this.direct = false;
    this.early = [];
    if (channel) channel.onclose = null;
    try {
      channel?.close();
      peer?.close();
    } catch {
      // Already gone.
    }
  }

  /** The direct channel failed: back to the server, and ask for the screen again. */
  private lostDirect() {
    const wasDirect = this.direct;
    this.dropDirect();
    if (!wasDirect || this.tab()?.state !== "live") return;
    this.patch({ direct: false });
    // What was on its way over the channel is lost; the host sends the
    // screen anew, and output before it is not taken.
    this.ready = false;
    this.send(EVENT, eventBody({ k: "relay" }));
  }

  askForKeyboard() {
    this.patch({ asked: true });
    this.send(EVENT, eventBody({ k: "request" }));
  }

  giveKeyboardBack() {
    this.send(EVENT, eventBody({ k: "release" }));
  }

  mount(element: HTMLElement) {
    if (this.element !== element) {
      this.element = element;
      this.term.open(element);
    }
    this.refit();
  }

  /**
   * The host's terminal has its own size in rows and columns. It is shown
   * whole: the font is made as large as fits, up to the size set here.
   */
  refit() {
    const element = this.element?.parentElement;
    if (!element) return;
    const settings = useSettings.getState();
    const options = terminalOptions(settings);
    const probe = document.createElement("canvas").getContext("2d");
    let ratio = 0.6;
    if (probe) {
      probe.font = `100px ${options.fontFamily}`;
      ratio = probe.measureText("M").width / 100 || 0.6;
    }
    const { cols, rows } = this.size;
    const fits = Math.min(
      (element.clientWidth - 16) / (cols * ratio),
      (element.clientHeight - 12) / (rows * options.lineHeight),
    );
    const fontSize = Math.max(6, Math.min(options.fontSize, Math.floor(fits * 10) / 10));
    Object.assign(this.term.options, { ...options, fontSize, scrollback: 5000 });
    if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
  }

  focus() {
    this.term.focus();
  }

  dispose() {
    this.disposed = true;
    this.dropDirect();
    this.socket?.close();
    this.term.dispose();
  }
}

export function getGuest(id: string): GuestSession | undefined {
  return sessions.get(id);
}

/** Joins a shared terminal from its invitation. Returns whether the invitation was understood. */
export function joinShare(invitation: string): boolean {
  const invite = parseInvite(invitation);
  if (!invite) {
    say("error", "guest.bad_link");
    return false;
  }
  const ui = useUi.getState();
  const already = ui.guests.find((g) => g.room === invite.room && g.state !== "ended");
  if (already) {
    ui.activate(already.id);
    return true;
  }
  const account = useVault.getState().snapshot.cloud?.email ?? "";
  const name = account.split("@")[0] || translate(useSettings.getState().locale, "guest.name");
  const id = `guest-${seq++}`;
  const session = new GuestSession(id, invite.room, invite.key, name);
  sessions.set(id, session);
  ui.addGuest({
    id,
    room: invite.room,
    title: "",
    hostName: "",
    me: 0,
    control: 0,
    people: [],
    state: "joining",
    ended: null,
    asked: false,
    direct: false,
  });
  void session.connect();
  return true;
}

/** An invitation that arrived while shared sessions are off, waiting for an answer. */
export const useInvite = create<{ pending: string | null }>(() => ({ pending: null }));

/** Takes an invitation the app was opened with: joins, or asks first if shared sessions are off. */
export function receiveInvite(invitation: string) {
  if (useSettings.getState().sharing) joinShare(invitation);
  else if (parseInvite(invitation)) useInvite.setState({ pending: invitation });
  else say("error", "guest.bad_link");
}

/** Leaves a shared terminal and closes its tab. */
export function leaveShare(id: string) {
  sessions.get(id)?.dispose();
  sessions.delete(id);
  useUi.getState().removeGuest(id);
}

/** Keeps guest terminals in step with settings and theme. */
export function startGuestSync() {
  const refit = () => {
    for (const session of sessions.values()) session.refit();
  };
  useSettings.subscribe(refit);
  onSystemThemeChange(refit);
}
