// What the two ends of a shared session have in common: how a message is
// sealed, and how it is carried over a direct channel.
//
// A message is one byte saying what it is, then its body, sealed with
// AES-256-GCM under the key from the link: twelve random bytes of nonce,
// then the ciphertext. Which side sealed it is bound in, so a message
// cannot be turned round and sent back.

/** Terminal bytes: output from the host, keystrokes from a guest. */
export const BYTES = 1;
/** A JSON object. */
export const EVENT = 2;

export type Side = "host" | "guest";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BOUND: Record<Side, Uint8Array<ArrayBuffer>> = {
  host: encoder.encode("myssh-share/v1/host"),
  guest: encoder.encode("myssh-share/v1/guest"),
};

/**
 * Finds participants' public addresses so that they can connect directly.
 * It is told their IP addresses and nothing about the session.
 */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
/** How long addresses are gathered before the offer or answer is sent as it is. */
const GATHER_MS = 2500;
/** How long this Mac is given to name one address of its own. */
const PROBE_MS = 5000;
/** A direct channel carries messages in pieces no larger than this. */
const PIECE = 16 * 1024;

/**
 * Whether this Mac lets the app make a direct connection. It asks for the
 * app's own addresses and nothing more: no server is contacted. macOS gives
 * none until the app is allowed onto the local network, and asking is what
 * makes it put the question.
 */
export async function directAllowed(): Promise<boolean> {
  if (typeof RTCPeerConnection !== "function") return false;
  const peer = new RTCPeerConnection();
  try {
    const found = new Promise<boolean>((resolve) => {
      peer.onicecandidate = (e) => e.candidate && resolve(true);
      window.setTimeout(() => resolve(false), PROBE_MS);
    });
    peer.createDataChannel("probe");
    await peer.setLocalDescription(await peer.createOffer());
    return await found;
  } catch {
    return false;
  } finally {
    peer.close();
  }
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The 32 bytes of key written after "#" in a link. */
export function keyFromText(text: string): Uint8Array<ArrayBuffer> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("the link is damaged");
  }
  if (raw.length !== 32) throw new Error("the link is damaged");
  return raw;
}

export function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seals a message. `from`: the side doing the sealing. */
export async function seal(
  key: CryptoKey,
  from: Side,
  type: number,
  body: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(1 + body.length);
  plain[0] = type;
  plain.set(body, 1);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: BOUND[from] },
    key,
    plain,
  );
  const out = new Uint8Array(12 + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), 12);
  return out;
}

/** Opens a message sealed by `from`. Throws if it is not genuine. */
export async function open(
  key: CryptoKey,
  from: Side,
  data: Uint8Array,
): Promise<{ type: number; body: Uint8Array }> {
  if (data.length < 12 + 16 + 1) throw new Error("the message is too short");
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.slice(0, 12), additionalData: BOUND[from] },
      key,
      data.slice(12),
    ),
  );
  return { type: plain[0], body: plain.subarray(1) };
}

export const eventBody = (event: object): Uint8Array => encoder.encode(JSON.stringify(event));
export const parseEvent = (body: Uint8Array): Record<string, unknown> => JSON.parse(decoder.decode(body));
export const textBody = (text: string): Uint8Array => encoder.encode(text);
export const bodyText = (body: Uint8Array): string => decoder.decode(body);

/**
 * A description of this end's connection with the addresses found so far.
 * Waiting for the addresses first means it can be sent in one message.
 */
export async function describe(peer: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  if (peer.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, GATHER_MS);
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer.iceGatheringState === "complete") {
          window.clearTimeout(timer);
          resolve();
        }
      });
    });
  }
  const local = peer.localDescription;
  if (!local) throw new Error("no local description");
  return { type: local.type, sdp: local.sdp };
}

/** Sends one sealed message over a direct channel, in pieces. */
export function sendOver(channel: RTCDataChannel, sealed: Uint8Array) {
  for (let offset = 0; offset < sealed.length || offset === 0; offset += PIECE) {
    const part = sealed.subarray(offset, offset + PIECE);
    const piece = new Uint8Array(1 + part.length);
    // The first byte says whether more pieces of this message follow.
    piece[0] = offset + PIECE < sealed.length ? 1 : 0;
    piece.set(part, 1);
    channel.send(piece);
  }
}

/** Puts the pieces of messages arriving on a direct channel back together. */
export function assembler(onMessage: (sealed: Uint8Array) => void): (piece: ArrayBuffer) => void {
  let parts: Uint8Array[] = [];
  return (piece) => {
    const data = new Uint8Array(piece);
    if (data.length === 0) return;
    parts.push(data.subarray(1));
    if (data[0] === 1) return;
    const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      whole.set(part, offset);
      offset += part.length;
    }
    parts = [];
    onMessage(whole);
  };
}
