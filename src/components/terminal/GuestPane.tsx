import { Keyboard, LogOut, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getGuest, joinShare, leaveShare, useInvite } from "../../lib/guest";
import { useT, type MessageKey } from "../../lib/i18n";
import { isDark, useSettings } from "../../lib/settings";
import { type GuestTab } from "../../lib/store";
import { resolveTermTheme } from "../../lib/themes";
import { cx, Field, Modal } from "../ui";
import { CursorBadge, personTone } from "./CursorBadge";

/**
 * A terminal someone else shares. It shows what its host sees; the keys
 * of this computer reach it only while the host lets this guest type.
 */
export function GuestPane({ guest, active }: { guest: GuestTab; active: boolean }) {
  const t = useT();
  const session = getGuest(guest.id);
  const screen = useRef<HTMLDivElement>(null);
  const background = useSettings((s) => resolveTermTheme(s.termTheme, isDark(s.theme)).colors.background);
  const mine = guest.me !== 0 && guest.control === guest.me;

  useEffect(() => {
    const element = screen.current;
    if (!session || !element) return;
    let cancelled = false;
    const settings = useSettings.getState();
    void document.fonts
      .load(`${settings.fontSize}px "${settings.fontFamily}"`)
      .catch(() => {})
      .then(() => {
        if (!cancelled) session.mount(element);
      });
    const observer = new ResizeObserver(() => session.refit());
    if (element.parentElement) observer.observe(element.parentElement);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [session]);

  useEffect(() => {
    if (active && session && guest.state === "live") {
      session.refit();
      if (mine) session.focus();
    }
  }, [active, session, guest.state, mine]);

  if (!session) return null;
  const typist =
    guest.control === 0
      ? guest.hostName
      : (guest.people.find((person) => person.id === guest.control)?.name ?? "");

  return (
    <div className={cx("term-pane guest-pane", !active && "hidden")} style={{ background }} aria-hidden={!active}>
      <div className="guest-bar">
        <Users size={15} />
        <div className="text">
          <div className="title">{guest.title || t("guest.tab")}</div>
          {guest.state === "live" && (
            <div className="detail">
              {t("guest.host", { name: guest.hostName })} · {t("guest.people", { n: guest.people.length + 1 })}
              {" · "}
              <span title={t(guest.direct ? "guest.direct.hint" : "guest.relayed.hint")}>
                {t(guest.direct ? "guest.direct" : "guest.relayed")}
              </span>
            </div>
          )}
        </div>
        {guest.state === "live" && (
          <>
            <span className={cx("guest-who", mine && "me")}>
              <Keyboard size={13} />
              {mine ? t("guest.you_type") : t("guest.typing", { name: typist })}
            </span>
            {mine ? (
              <button className="btn small" onClick={() => session.giveKeyboardBack()}>
                {t("guest.release")}
              </button>
            ) : (
              <button className="btn small primary" disabled={guest.asked} onClick={() => session.askForKeyboard()}>
                {t(guest.asked ? "guest.requested" : "guest.request")}
              </button>
            )}
          </>
        )}
        <button className="btn small" onClick={() => leaveShare(guest.id)}>
          <LogOut size={13} />
          {t("guest.leave")}
        </button>
      </div>

      <div className="guest-stage">
        <div className="guest-screen" ref={screen} onContextMenu={(e) => e.preventDefault()} />
        {guest.state === "live" && (
          <CursorBadge term={session.term} name={typist} tone={personTone(guest.control)} />
        )}
      </div>

      {guest.state === "joining" && (
        <div className="guest-veil">
          <div className="guest-note">
            <span className="spinner" />
            {t("guest.joining")}
          </div>
        </div>
      )}
      {guest.state === "ended" && (
        <div className="guest-veil">
          <div className="guest-card">
            <h2>{t("guest.ended.title")}</h2>
            <p>{t((guest.ended ?? "guest.ended.lost") as MessageKey)}</p>
            <button className="btn" onClick={() => leaveShare(guest.id)}>
              {t("common.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** An invitation arrived while shared sessions are off: turn them on for it, or leave it. */
export function SharingOffDialog() {
  const t = useT();
  const pending = useInvite((s) => s.pending);
  if (!pending) return null;
  const close = () => useInvite.setState({ pending: null });
  return (
    <Modal
      title={t("sharing.off.title")}
      icon={<Users size={17} />}
      onClose={close}
      onSubmit={() => {
        useSettings.getState().set({ sharing: true });
        close();
        joinShare(pending);
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" data-autofocus>
            {t("sharing.off.enable")}
          </button>
        </>
      }
    >
      <p>{t("sharing.off.text")}</p>
    </Modal>
  );
}

/** Asks for an invitation link, for when it did not open the app by itself. */
export function JoinDialog(props: { onClose: () => void }) {
  const t = useT();
  const [link, setLink] = useState("");
  return (
    <Modal
      title={t("join.title")}
      icon={<Users size={17} />}
      onClose={props.onClose}
      onSubmit={() => {
        if (link.trim() && joinShare(link)) props.onClose();
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!link.trim()}>
            {t("join.action")}
          </button>
        </>
      }
    >
      <Field label={t("join.label")} hint={t("join.hint")}>
        <input
          className="input mono"
          data-autofocus
          value={link}
          placeholder="https://…/s/…#…"
          onChange={(e) => setLink(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
    </Modal>
  );
}
