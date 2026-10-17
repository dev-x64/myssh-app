// The saved passwords, offered wherever a shell asks for one: sudo, su,
// ssh onwards, mysql -p, git over https, a key's passphrase, passwd… One is
// typed only when chosen. Whether it was taken is read from what the server
// says next, and remembered per host and account, so that the one that
// works comes first and the one that did not is offered to be updated.

import type { Terminal } from "@xterm/xterm";
import { api, type Id } from "./api";
import { translate } from "./i18n";
import { useSettings } from "./settings";
import { useUi, useVault, type Tab } from "./store";

/** A line that asks for a password and waits on it. */
const PASSWORD_PROMPT =
  /(?:\b(?:password|passphrase|pass phrase|passcode|pin)\b|passwort|kennwort|contraseña|mot de passe|пароль|парольн)[^\n]{0,80}?:\s*$/i;
/** The account a prompt asks the password of, when it says: `[sudo] password for admin:`. */
const PROMPT_USER = /password for ([a-z_][\w.-]*)\s*:\s*$/i;
/** `su`, `su -`, `su - admin` on the line above: the password of that account (root unless named). */
const SU_COMMAND = /(?:^|[\s;&|])su(?:\s+-l?|\s+--login)?(?:\s+([a-z_][\w.-]*))?\s*$/i;
/** `passwd admin` on the line above: the new password is admin's. */
const PASSWD_COMMAND = /(?:^|[\s;&|])passwd\s+(?:-\S+\s+)*([a-z_][\w.-]*)\s*$/i;
/** What servers say when a password was not taken. */
const REFUSED =
  /sorry, try again|authentication (?:failure|failed)|authentication token manipulation error|incorrect (?:password|passphrase)|wrong (?:password|passphrase)|bad passphrase|permission denied|access denied|login incorrect|passwords? do(?:es)? not match|no password supplied|неверн\S* пароль|пароли не совпадают|ошибка аутентификации|сбой при проверке подлинности|в доступе отказано/i;

/** How long the server may stay quiet before what it said about a password is taken as all it says. */
const SETTLE_MS = 2500;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** A saved password that can be typed at a prompt. */
export interface PasswordChoice {
  /** `host:<id>` or `identity:<id>`. */
  key: string;
  /** The host's name, or the identity's. */
  label: string;
  username: string;
  /** The host's own (or its identity's): the one it signs in with. */
  own: boolean;
  fetch: () => Promise<string | null>;
}

/** A row of the list under a prompt. */
export type PasswordRow = { kind: "saved"; choice: PasswordChoice; mark: "worked" | "failed" | null } | { kind: "add" };

export type PasswordOffer = NonNullable<Tab["passwordOffer"]>;

/** Where a password typed at a prompt is kept: a host, an identity, or a new identity. */
export type SaveTarget = { kind: "host"; id: Id } | { kind: "identity"; id: Id } | { kind: "new"; username: string };

/** What the last password chosen for this account on this host did. */
function memoryKey(hostId: Id, user: string | null): string {
  return `${hostId}|${user ?? ""}`;
}

function remember(hostId: Id, user: string | null, key: string, worked: boolean) {
  const s = useSettings.getState();
  const at = memoryKey(hostId, user);
  const was = s.passwordsUsed[at] ?? {};
  const failed = (was.failed ?? []).filter((k) => k !== key);
  const now = worked
    ? { worked: key, failed }
    : { worked: was.worked === key ? undefined : was.worked, failed: [...failed, key] };
  s.set({ passwordsUsed: { ...s.passwordsUsed, [at]: now } });
}

/** A password was changed: wherever it was refused, it may well be taken now. */
function forgetRefusals(key: string) {
  const s = useSettings.getState();
  const used = Object.fromEntries(
    Object.entries(s.passwordsUsed).map(([at, was]) => [at, { ...was, failed: was.failed?.filter((k) => k !== key) }]),
  );
  s.set({ passwordsUsed: used });
}

/** Every saved password there is: this host's own, then every identity that keeps one. */
export function passwordChoices(hostId: Id): PasswordChoice[] {
  const snapshot = useVault.getState().snapshot;
  const host = snapshot.hosts.find((h) => h.id === hostId);
  const ownIdentity = host?.auth.kind === "identity" ? host.auth.identity_id : null;
  const choices: PasswordChoice[] = [];
  if (host?.auth.kind === "inline" && host.auth.has_password) {
    const id = host.id;
    choices.push({
      key: `host:${id}`,
      label: host.label,
      username: host.auth.username,
      own: true,
      fetch: () => api.hostPassword(id),
    });
  }
  for (const identity of snapshot.identities) {
    if (!identity.has_password) continue;
    const id = identity.id;
    choices.push({
      key: `identity:${id}`,
      label: identity.label || identity.username,
      username: identity.username,
      own: id === ownIdentity,
      fetch: () => api.identityPassword(id),
    });
  }
  return choices;
}

/**
 * The list under a prompt, best guess first: the one that worked here
 * last time, then the account the prompt names, then the host's own. A
 * prompt for a new password starts with making one up; adding one ends it.
 */
export function passwordRows(hostId: Id, offer: PasswordOffer): PasswordRow[] {
  const memory = useSettings.getState().passwordsUsed[memoryKey(hostId, offer.user)];
  const saved = passwordChoices(hostId).map((choice): PasswordRow & { kind: "saved" } => ({
    kind: "saved",
    choice,
    mark:
      choice.key === offer.failed || memory?.failed?.includes(choice.key)
        ? "failed"
        : memory?.worked === choice.key
          ? "worked"
          : null,
  }));
  const rank = (row: { choice: PasswordChoice; mark: string | null }) =>
    row.mark === "worked" ? 0 : offer.user && row.choice.username === offer.user ? 1 : row.choice.own ? 2 : 3;
  saved.sort((a, b) => rank(a) - rank(b));
  return [...saved, { kind: "add" }];
}

/** The account a password asked for here belongs to: the one the prompt names, or the host's. */
export function promptAccount(hostId: Id, user: string | null): string {
  if (user) return user;
  const snapshot = useVault.getState().snapshot;
  const host = snapshot.hosts.find((h) => h.id === hostId);
  if (host?.auth.kind === "inline") return host.auth.username;
  const identityId = host?.auth.kind === "identity" ? host.auth.identity_id : null;
  return snapshot.identities.find((i) => i.id === identityId)?.username ?? "";
}

export function targetOf(key: string): SaveTarget {
  const [kind, id] = key.split(":");
  return kind === "host" ? { kind: "host", id } : { kind: "identity", id };
}

export function keyOf(target: SaveTarget): string | null {
  return target.kind === "new" ? null : `${target.kind}:${target.id}`;
}

/** What the helper needs from the session it serves. */
export interface PasswordHost {
  readonly term: Terminal;
  readonly hostId: Id;
  tab(): Tab | undefined;
  patch(patch: Partial<Tab>): void;
  /** Sends text exactly as if it had been typed. */
  type(text: string): void;
  focus(): void;
  /** Forgets the line being typed, so that nothing typed here is suggested or remembered. */
  forgetLine(): void;
}

/** A password just typed, and what the server has said since. */
interface Watch {
  /** The saved one typed: `host:…` or `identity:…`. */
  key: string;
  user: string | null;
  /** The prompt it answered, as it read. */
  prompt: string;
  said: string;
}

export class PasswordHelper {
  /** The prompt put away with Escape: it does not come back. */
  private dismissed: string | null = null;
  private watch: Watch | null = null;
  private settleTimer: number | undefined;
  private readonly decoder = new TextDecoder();

  constructor(private readonly host: PasswordHost) {}

  private get offer(): PasswordOffer | null {
    return this.host.tab()?.passwordOffer ?? null;
  }

  /** Call with every piece of output once it is on the screen. */
  onOutput(data: Uint8Array) {
    if (this.watch) {
      const text = this.decoder.decode(data, { stream: true });
      this.watch.said = (this.watch.said + text.replace(ANSI, "")).slice(-2000);
      window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS);
    }
    this.look();
  }

  /** The person types: the list is not wanted, and the password typed before was taken. */
  onInput() {
    if (this.offer) this.host.patch({ passwordOffer: null });
    if (this.watch && !this.asking()) this.settle();
  }

  /** The prompt the cursor is right after, if it asks for a password. */
  private asking(): { line: string; at: string } | null {
    const tab = this.host.tab();
    const buffer = this.host.term.buffer.active;
    if (!tab || tab.status !== "connected" || buffer.type !== "normal") return null;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
    if (!PASSWORD_PROMPT.test(line) || buffer.cursorX < line.trimEnd().length) return null;
    return { line: line.trimEnd(), at: `${buffer.baseY + buffer.cursorY}:${buffer.cursorX}` };
  }

  /** Whose password the prompt wants, from the prompt or the command above it. */
  private user(line: string): string | null {
    const buffer = this.host.term.buffer.active;
    const above = buffer.getLine(buffer.baseY + buffer.cursorY - 1)?.translateToString(true) ?? "";
    const su = SU_COMMAND.exec(above);
    return PROMPT_USER.exec(line)?.[1] ?? PASSWD_COMMAND.exec(above)?.[1] ?? (su ? (su[1] ?? "root") : null);
  }

  private look() {
    const prompt = this.asking();
    const now = this.offer;
    if (!prompt) {
      if (now) this.host.patch({ passwordOffer: null });
      return;
    }
    const buffer = this.host.term.buffer.active;
    if (now?.row === buffer.cursorY && now.col === buffer.cursorX) return;
    if (prompt.at === this.dismissed) return;
    // The same prompt again, or a refusal before it: the one typed was not taken.
    let failed: string | null = null;
    const watch = this.watch;
    if (watch && (REFUSED.test(watch.said) || watch.prompt === prompt.line)) {
      this.watch = null;
      window.clearTimeout(this.settleTimer);
      remember(this.host.hostId, watch.user, watch.key, false);
      failed = watch.key;
    }
    const user = this.user(prompt.line);
    this.host.patch({
      passwordOffer: {
        row: buffer.cursorY,
        col: buffer.cursorX,
        index: -1,
        user,
        failed,
        prompt: prompt.line,
      },
    });
  }

  /** The server has had its say about the password typed. */
  private settle() {
    window.clearTimeout(this.settleTimer);
    const watch = this.watch;
    if (!watch || this.asking()) return;
    this.watch = null;
    const refused = REFUSED.test(watch.said);
    remember(this.host.hostId, watch.user, watch.key, !refused);
    if (refused) useUi.getState().toast("error", translate(useSettings.getState().locale, "term.password.refused"));
  }

  /** The arrows choose, Enter types the chosen one, Escape puts the list away. */
  handleKey(event: KeyboardEvent): boolean {
    const offer = this.offer;
    if (!offer || event.type !== "keydown" || event.metaKey || event.ctrlKey || event.altKey) return true;
    const rows = passwordRows(this.host.hostId, offer).length;
    const consume = () => {
      event.preventDefault();
      return false;
    };
    switch (event.key) {
      case "ArrowDown":
        this.host.patch({ passwordOffer: { ...offer, index: Math.min(offer.index + 1, rows - 1) } });
        return consume();
      case "ArrowUp":
        this.host.patch({ passwordOffer: { ...offer, index: Math.max(offer.index - 1, -1) } });
        return consume();
      case "Enter":
        if (offer.index < 0) return true;
        this.choose(offer.index);
        return consume();
      case "Escape":
        this.dismiss();
        return consume();
      default:
        return true;
    }
  }

  dismiss() {
    const buffer = this.host.term.buffer.active;
    this.dismissed = `${buffer.baseY + buffer.cursorY}:${buffer.cursorX}`;
    this.host.patch({ passwordOffer: null });
  }

  /** A row was chosen: a saved one typed (or updated, if it failed), or one added. */
  choose(index: number) {
    const offer = this.offer;
    if (!offer) return;
    const row = passwordRows(this.host.hostId, offer)[index];
    if (!row) return;
    const account = promptAccount(this.host.hostId, offer.user);
    if (row.kind === "saved" && row.mark === "failed") {
      this.host.patch({ passwordSave: { reason: "update", target: targetOf(row.choice.key) } });
    } else if (row.kind === "saved") {
      const key = row.choice.key;
      void row.choice.fetch().then(
        (password) => password && this.send(password, { key, user: offer.user, prompt: offer.prompt, said: "" }),
        () => {},
      );
    } else {
      this.host.patch({ passwordSave: { reason: "add", target: { kind: "new", username: account } } });
    }
  }

  /** A password was just saved from the list: typed at the prompt if it is still waiting. */
  saved(target: SaveTarget, password: string) {
    const offer = this.offer;
    const key = keyOf(target);
    if (key) forgetRefusals(key);
    if (offer?.failed === key) this.host.patch({ passwordOffer: { ...offer, failed: null } });
    if (!offer || !key) return;
    this.send(password, { key, user: offer.user, prompt: offer.prompt, said: "" });
  }

  /** Types a password and Enter at the prompt, kept out of suggestions and history. */
  private send(password: string, watch: Watch) {
    if (this.host.tab()?.status !== "connected") return;
    this.host.patch({ passwordOffer: null });
    this.watch = watch;
    this.host.forgetLine();
    this.host.type(`${password}\r`);
    this.host.focus();
  }
}
