import { Check, Keyboard, Link2, Settings, Users, X } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState } from "react";
import { reportError } from "../../lib/actions";
import { useT } from "../../lib/i18n";
import { loadPlan, usePlan } from "../../lib/plan";
import { useSettings } from "../../lib/settings";
import {
  denyControl,
  grantControl,
  startShare,
  stopShare,
  takeControl,
  useShare,
  type Share,
} from "../../lib/share";
import { useUi, useVault, type Tab } from "../../lib/store";
import { cx } from "../ui";
import { GetProButton, ProBadge } from "../cloud/Pro";
import { personTone } from "./CursorBadge";
import { ShareDemo } from "./HelpDemos";

/** The guests who have introduced themselves; the ones still joining have no name yet. */
const present = (share: Share | undefined) => share?.guests.filter((guest) => guest.name) ?? [];

/**
 * The button in the title bar that shares the active terminal, and its
 * panel: the link, who is there, and who has the keyboard. The button is
 * there even while sharing is off in Settings, or the account has no Pro:
 * the panel then says what it takes.
 */
export function ShareButton({ tab }: { tab: Tab }) {
  const t = useT();
  const share = useShare((s) => s.shares[tab.id]);
  const signedIn = useVault((s) => s.snapshot.cloud !== null && !s.snapshot.cloud.revoked);
  const account = useVault((s) => s.snapshot.cloud?.email ?? "");
  const toast = useUi((s) => s.toast);
  const enabled = useSettings((s) => s.sharing);
  const [open, setOpen] = useState(false);
  // Whether the account has Pro, asked again as the panel opens; unknown
  // (offline, an older server) lets the server decide when inviting.
  const plan = usePlan((s) => s.plan);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const guests = present(share);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && signedIn && !share) void loadPlan();
  }, [open, signedIn, share]);
  const free = plan?.plan === "free";
  const pro = plan?.plan === "pro";

  const start = async () => {
    setBusy(true);
    const failure = await startShare(tab.id);
    setBusy(false);
    if (failure) reportError(failure);
  };
  // The button itself says the link is on the clipboard, for a moment.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (!share?.link) return;
    try {
      await writeText(share.link);
      setCopied(true);
    } catch (e) {
      reportError(e);
    }
  };
  const signIn = () => {
    setOpen(false);
    useSettings.getState().set({ welcomed: false });
    useUi.getState().goHome();
  };
  const toSettings = () => {
    setOpen(false);
    useUi.getState().goHome("settings");
    // The page is drawn on the next render; the section is then brought into view.
    window.setTimeout(() => document.getElementById("settings-sharing")?.scrollIntoView({ block: "start" }), 60);
  };

  return (
    <div className="share" ref={root}>
      <button
        className={cx("btn ghost icon small", (open || share) && "on")}
        title={share ? t("share.guests", { n: guests.length }) : t("share.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Users size={15} />
        {guests.length > 0 && <span className="share-count">{guests.length}</span>}
      </button>

      {open && (
        <div className="share-panel" role="dialog" aria-label={t("share.title")}>
          <div className="share-head">
            <Users size={15} />
            <span className="grow">{t("share.title")}</span>
            {!share && !pro && <ProBadge />}
            {share?.link && (
              <>
                <button className={cx("btn small", copied && "done")} onClick={() => void copy()}>
                  {copied ? <Check size={13} /> : <Link2 size={13} />}
                  {t(copied ? "share.copied" : "share.copy")}
                </button>
                <button
                  className="btn small danger"
                  onClick={() => {
                    stopShare(tab.id);
                    toast("info", t("share.stopped"));
                  }}
                >
                  {t("share.stop")}
                </button>
              </>
            )}
          </div>

          {!share ? (
            <div className="share-body">
              <ShareDemo />
              <p>{t("share.intro")}</p>
              {!signedIn ? (
                <>
                  <p className="note">{t("share.sign_in")}</p>
                  <button className="btn primary" onClick={signIn}>
                    {t("cloud.sign_in")}
                  </button>
                </>
              ) : free ? (
                <>
                  <p className="note">{t("share.pro")}</p>
                  <GetProButton onOpen={() => setOpen(false)} />
                </>
              ) : !enabled ? (
                <>
                  <p className="note">{t("share.disabled")}</p>
                  <button className="btn primary" onClick={toSettings}>
                    <Settings size={14} />
                    {t("share.open_settings")}
                  </button>
                </>
              ) : tab.status !== "connected" ? (
                <p className="note">{t("share.offline")}</p>
              ) : (
                <>
                  <p className="note warn">{t("share.warn")}</p>
                  <p className="dim">{t("share.e2e")}</p>
                  <button className="btn primary" disabled={busy} onClick={() => void start()}>
                    <Link2 size={14} />
                    {t(busy ? "share.starting" : "share.start")}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="share-body">
              <div className="share-label">{t("share.people")}</div>
              <div className="share-person">
                <span className="avatar">{(account || "?").slice(0, 1).toUpperCase()}</span>
                <span className="share-name">{account}</span>
                <span className="chip">{t("share.you")}</span>
                {share.control === 0 ? (
                  <span className="chip accent" title={t("share.at_keyboard")}>
                    <Keyboard size={12} />
                  </span>
                ) : (
                  <button className="btn small" onClick={() => takeControl(tab.id)}>
                    {t("share.take")}
                  </button>
                )}
              </div>
              {share.guests.map((guest) => (
                <div key={guest.id} className="share-person">
                  <span className="avatar guest" style={{ background: personTone(guest.id), color: "#0b0d10" }}>
                    {(guest.name || "…").slice(0, 1).toUpperCase()}
                  </span>
                  <span className={cx("share-name", !guest.name && "dim")}>
                    {guest.name || t("share.joining")}
                  </span>
                  {guest.name && <span className="chip">{t(guest.direct ? "share.direct" : "share.relayed")}</span>}
                  {share.control === guest.id && (
                    <span className="chip accent" title={t("share.at_keyboard")}>
                      <Keyboard size={12} />
                    </span>
                  )}
                  {guest.asking && (
                    <>
                      <button
                        className="btn small primary"
                        title={t("share.asks.hint")}
                        onClick={() => grantControl(tab.id, guest.id)}
                      >
                        <Check size={13} />
                        {t("share.allow")}
                      </button>
                      <button
                        className="btn small icon"
                        title={t("share.deny")}
                        onClick={() => denyControl(tab.id, guest.id)}
                      >
                        <X size={13} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {share.guests.length === 0 && <p className="dim">{t(share.link ? "share.nobody" : "share.starting")}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A strip over the terminal for the two moments that need the host's eye:
 * a guest asks for the keyboard, or a guest has it.
 */
export function ShareBar({ tab }: { tab: Tab }) {
  const t = useT();
  const share = useShare((s) => s.shares[tab.id]);
  if (!share) return null;
  const asking = share.guests.find((guest) => guest.asking);
  const typing = share.guests.find((guest) => guest.id === share.control);
  if (!asking && !typing) return null;
  return (
    <div className={cx("share-bar", asking && "asking")} role="status">
      <Keyboard size={14} />
      {asking ? (
        <>
          <div className="text">
            <div className="title">{t("share.asks", { name: asking.name })}</div>
            <div className="detail">{t("share.asks.hint")}</div>
          </div>
          <button className="btn small" onClick={() => denyControl(tab.id, asking.id)}>
            {t("share.deny")}
          </button>
          <button className="btn small primary" onClick={() => grantControl(tab.id, asking.id)}>
            {t("share.allow")}
          </button>
        </>
      ) : (
        typing && (
          <>
            <div className="text">
              <div className="title">{t("share.guest_types", { name: typing.name })}</div>
            </div>
            <button className="btn small primary" onClick={() => takeControl(tab.id)}>
              {t("share.take")}
            </button>
          </>
        )
      )}
    </div>
  );
}

/** A mark on the tab of a shared terminal. */
export function ShareMark({ tabId }: { tabId: string }) {
  const t = useT();
  const share = useShare((s) => s.shares[tabId]);
  if (!share) return null;
  return (
    <span className="share-mark" title={t("share.guests", { n: present(share).length })}>
      <Users size={12} />
    </span>
  );
}
