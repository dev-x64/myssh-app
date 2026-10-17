import { CornerDownLeft, KeyRound, Plus, Server, UserRound } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type Id } from "../../lib/api";
import { useT, type MessageKey } from "../../lib/i18n";
import { passwordRows, type PasswordRow, type SaveTarget } from "../../lib/passwords";
import { getSession } from "../../lib/sessions";
import { useUi, useVault, type Tab } from "../../lib/store";
import { cx, Field, Modal, PasswordInput } from "../ui";

/**
 * The shell asks for a password (sudo, su, ssh onwards, mysql, git, a key's
 * passphrase…): the saved ones are listed under the prompt, the one most
 * likely to be taken first; the one pointed at or chosen shows above the
 * list whose it is. One is typed only when chosen, with a click or the
 * arrows and Enter; typing on puts the list away, and so does Escape.
 */
export function PasswordOffer({ tab }: { tab: Tab }) {
  const t = useT();
  const session = getSession(tab.id);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<React.CSSProperties>({ visibility: "hidden" });
  const offer = tab.passwordOffer;
  // Read again when the vault changes: a password saved elsewhere shows up here.
  useVault((s) => s.snapshot);
  const rows = offer ? passwordRows(tab.hostId, offer) : [];
  const [hovered, setHovered] = useState(-1);

  useLayoutEffect(() => {
    const list = ref.current;
    const wrap = list?.parentElement;
    const screen = wrap?.querySelector<HTMLElement>(".xterm-screen");
    if (!list || !wrap || !screen || !session || !offer) return;
    const origin = wrap.getBoundingClientRect();
    const area = screen.getBoundingClientRect();
    const cellWidth = area.width / session.term.cols;
    const cellHeight = area.height / session.term.rows;
    const left = Math.max(
      6,
      Math.min(area.left - origin.left + offer.col * cellWidth, origin.width - list.offsetWidth - 6),
    );
    const below = area.top - origin.top + (offer.row + 1) * cellHeight + 2;
    if (below + list.offsetHeight > origin.height - 4) {
      setPlace({ left, bottom: origin.height - (area.top - origin.top + offer.row * cellHeight - 2) });
    } else {
      setPlace({ left, top: below });
    }
  }, [session, offer, rows.length]);

  if (!session || !offer) return null;
  const failedRow = rows.find((row) => row.kind === "saved" && row.choice.key === offer.failed);
  const focused = hovered >= 0 ? hovered : offer.index;
  const shown = rows[focused];
  return (
    <div
      ref={ref}
      className="suggest password-offer"
      style={place}
      role="listbox"
      aria-label={t("term.password.title")}
    >
      {failedRow?.kind === "saved" && (
        <div className="password-refused">{t("term.password.failed_now", { name: failedRow.choice.label })}</div>
      )}
      {shown?.kind === "saved" && (
        <div className="password-card">
          <span>{t("host.username")}:</span>
          <b>{shown.choice.username}</b>
          <span>{t("host.password")}:</span>
          <b className="password-mask">••••••••••••</b>
        </div>
      )}
      <div className="suggest-list" onMouseLeave={() => setHovered(-1)}>
        {rows.map((row, index) => (
          <div
            key={row.kind === "saved" ? row.choice.key : row.kind}
            role="option"
            aria-selected={index === offer.index}
            className={cx(
              "suggest-item",
              `password-${row.kind}`,
              row.kind === "saved" && row.mark,
              index === focused && "active",
            )}
            onMouseEnter={() => setHovered(index)}
            // Keep the terminal focused: act on press, not on click.
            onMouseDown={(e) => {
              e.preventDefault();
              session.passwords.choose(index);
            }}
          >
            <PasswordLine row={row} user={offer.user} chosen={index === focused} />
          </div>
        ))}
      </div>
      <div className="suggest-hint">{t(rows.length > 1 ? "term.password.hint" : "term.password.hint_none")}</div>
    </div>
  );
}

function PasswordLine({ row, user, chosen }: { row: PasswordRow; user: string | null; chosen: boolean }) {
  const t = useT();
  const enter = chosen && <CornerDownLeft size={13} className="password-enter" />;
  if (row.kind === "add") {
    return (
      <div className="suggest-line">
        <Plus size={13} className="suggest-icon" />
        <span className="suggest-text">{user ? t("term.password.add_for", { user }) : t("term.password.add")}</span>
        {enter}
      </div>
    );
  }
  const { choice, mark } = row;
  const Icon = choice.key.startsWith("host:") ? Server : UserRound;
  return (
    <div className="suggest-line">
      <Icon size={13} className="suggest-icon" />
      <span className="suggest-text">{choice.label}</span>
      <span className="suggest-detail">
        {choice.label === choice.username ? "" : choice.username}
        {mark === "worked" ? (
          <em className="worked">{t("term.password.worked")}</em>
        ) : mark === "failed" ? (
          <em className="failed">{t("term.password.failed")}</em>
        ) : (
          choice.own && <em>{t("term.password.this_host")}</em>
        )}
      </span>
      {enter}
    </div>
  );
}

const SAVE_TEXT: Record<NonNullable<Tab["passwordSave"]>["reason"], [MessageKey, MessageKey, MessageKey]> = {
  add: ["term.password.add_title", "term.password.add_text", "term.password.save_type"],
  update: ["term.password.update_title", "term.password.update_text", "term.password.save_type"],
};

/**
 * Keeping a password met in the terminal: one added from the list, or one
 * refused and changed since.
 * Kept where that account's password already is (the host, an identity),
 * or as a new identity; typed at the prompt if it is still waiting.
 */
export function PasswordSave({ tab }: { tab: Tab }) {
  const t = useT();
  const session = getSession(tab.id);
  const snapshot = useVault((s) => s.snapshot);
  const saving = tab.passwordSave;
  const [target, setTarget] = useState<SaveTarget | null>(saving?.target ?? null);
  const [username, setUsername] = useState(saving?.target.kind === "new" ? saving.target.username : "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  if (!session || !saving || !target) return null;

  const host = snapshot.hosts.find((h) => h.id === tab.hostId);
  const [title, text, submitLabel] = SAVE_TEXT[saving.reason];
  const close = () => {
    useUi.getState().patchTab(tab.id, { passwordSave: null });
    session.focus();
  };
  const missing = !password || (target.kind === "new" && !username.trim());

  // Where it can go: this host (signing in with a password of its own), any identity, a new one.
  const places: { value: string; label: string }[] = [];
  if (host?.auth.kind === "inline") {
    places.push({
      value: `host:${host.id}`,
      label: t("term.password.to_host", { host: host.label, user: host.auth.username }),
    });
  }
  for (const identity of snapshot.identities) {
    places.push({
      value: `identity:${identity.id}`,
      label: t("term.password.to_identity", { name: identity.label || identity.username, user: identity.username }),
    });
  }
  places.push({ value: "new", label: t("term.password.to_new") });
  const value = target.kind === "new" ? "new" : `${target.kind}:${target.id}`;
  const pick = (picked: string) => {
    if (picked === "new") return setTarget({ kind: "new", username });
    const [kind, id] = picked.split(":") as ["host" | "identity", Id];
    setTarget({ kind, id });
  };

  const submit = async () => {
    if (busy || missing) return;
    setBusy(true);
    const set = { action: "set" as const, value: password };
    const kept = await mutate(async (): Promise<SaveTarget | null> => {
      if (target.kind === "host") {
        const h = snapshot.hosts.find((x) => x.id === target.id);
        if (!h || h.auth.kind !== "inline") return null;
        await api.hostSave({
          id: h.id,
          label: h.label,
          address: h.address,
          port: h.port,
          group_id: h.group_id,
          tags: h.tags,
          auth: { kind: "inline", username: h.auth.username, password: set, key_id: h.auth.key_id },
          startup_snippet_id: h.startup_snippet_id,
        });
        return target;
      }
      const old = target.kind === "identity" ? snapshot.identities.find((i) => i.id === target.id) : null;
      const identity = await api.identitySave({
        id: old?.id ?? null,
        label: old?.label ?? "",
        username: old?.username ?? username.trim(),
        password: set,
        key_id: old?.key_id ?? null,
      });
      return { kind: "identity", id: identity.id };
    }, t("term.password.kept"));
    setBusy(false);
    if (!kept) return;
    useUi.getState().patchTab(tab.id, { passwordSave: null });
    session.passwords.saved(kept, password);
  };

  return (
    <Modal
      title={t(title)}
      icon={<KeyRound size={17} />}
      scope="tab"
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || missing}>
            {t(submitLabel)}
          </button>
        </>
      }
    >
      <p className="muted">{t(text)}</p>
      <Field label={t("host.password")}>
        <PasswordInput data-autofocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {saving.reason !== "update" && (
        <Field label={t("term.password.where")}>
          <select className="select" value={value} onChange={(e) => pick(e.target.value)}>
            {places.map((place) => (
              <option key={place.value} value={place.value}>
                {place.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {target.kind === "new" && (
        <Field label={t("host.username")}>
          <input
            className="input"
            value={username}
            placeholder="root"
            onChange={(e) => setUsername(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Field>
      )}
    </Modal>
  );
}
