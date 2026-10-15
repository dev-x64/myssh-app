import {
  AlertTriangle,
  Cloud,
  CloudOff,
  CreditCard,
  LogIn,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCloud } from "../../lib/cloud";
import type { AiAllowance } from "../../lib/api";
import { formatClock, formatDate, useT, type MessageKey } from "../../lib/i18n";
import { loadPlan, usePlan } from "../../lib/plan";
import { useSettings } from "../../lib/settings";
import { useUi, useVault } from "../../lib/store";
import { Confirm, cx } from "../ui";
import { GetProButton, ProBadge } from "./Pro";
import { openAccountPage, signOutOfCloud, useSyncStatus } from "./status";

/**
 * The one control in the top right corner for the cloud: whether this
 * device syncs and how that is going, who is signed in and whether on Pro
 * (a ring round the avatar), and, in its menu, sync now, devices, the way
 * to Pro and sign out. Signed out, it says so and leads to sign-in.
 */
export function AccountMenu() {
  const t = useT();
  const account = useVault((s) => s.snapshot.cloud);
  const available = useVault((s) => s.status?.cloud_available ?? false);
  const status = useSyncStatus();
  const welcomed = useSettings((s) => s.welcomed);
  const locale = useSettings((s) => s.locale);
  const plan = usePlan((s) => s.plan);
  const syncError = useCloud((s) => (s.state === "error" ? s.error?.code : undefined));
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void loadPlan();
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

  if (!available) return null;

  if (!account) {
    // The first-launch screen is the sign-in form itself.
    if (!welcomed) return null;
    return (
      <button
        className="account-pill off"
        title={t("sync.off.hint")}
        onClick={() => {
          // Back to the first-launch screen, which holds the sign-in form.
          useSettings.getState().set({ welcomed: false });
          useUi.getState().goHome();
        }}
      >
        <CloudOff size={13} />
        <span className="pill-label">{t("sync.off")}</span>
        <span className="pill-action">
          <LogIn size={13} />
          {t("cloud.sign_in")}
        </span>
      </button>
    );
  }

  const pro = plan?.plan === "pro";
  const free = plan?.plan === "free";
  // On Free, sync not going is no trouble to show in yellow: the pill
  // stays grey with the no-sync icon, and the menu offers Pro.
  const onFree = free && syncError === "pro_required";
  const tone = onFree ? "free" : (status?.tone ?? "warn");
  const label = onFree
    ? t("cloud.status.pro_required")
    : tone === "ok"
      ? t("sync.on")
      : tone === "busy"
        ? t("sync.busy")
        : tone === "bad"
          ? t("sync.stopped")
          : t("sync.waiting");
  const initial = account.email.slice(0, 1).toUpperCase();
  const date = plan?.ends_at ? formatDate(plan.ends_at * 1000, locale) : "";

  const openCloud = () => {
    setOpen(false);
    useUi.getState().goHome("cloud");
  };

  return (
    <div className="account" ref={root}>
      <button
        className={cx("account-pill", tone, open && "open")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={[account.email, pro ? "Pro" : free ? "Free" : "", status?.text, status?.detail]
          .filter(Boolean)
          .join(" · ")}
        onClick={() => setOpen(!open)}
      >
        {onFree ? (
          <CloudOff size={13} />
        ) : tone === "busy" ? (
          <RefreshCw size={13} className="spin" />
        ) : tone === "bad" ? (
          <AlertTriangle size={13} />
        ) : (
          <Cloud size={13} />
        )}
        {!onFree && <span className="pill-label">{label}</span>}
        <span className={cx("avatar", pro && "pro")}>{initial}</span>
      </button>

      {open && (
        <div className="account-menu" role="menu">
          <div className="account-head">
            <span className={cx("avatar large", pro && "pro")}>{initial}</span>
            <div className="account-who">
              <div className="account-email selectable">{account.email}</div>
              {plan && (
                <div className="account-plan">
                  {pro ? <ProBadge /> : <span className="chip">Free</span>}
                  {plan.state !== "free" && (
                    <span className={cx(plan.state === "past_due" && "warn")}>
                      {t(`cloud.plan.${plan.state}` as MessageKey, { date })}
                    </span>
                  )}
                </div>
              )}
              <div className={cx("account-status", status?.tone)}>{status?.text}</div>
              {status?.detail && !onFree && <div className="account-detail selectable">{status.detail}</div>}
              {plan?.ai && plan.ai_allowance && <AiAllowanceLine allowance={plan.ai_allowance} />}
            </div>
          </div>
          {free && !account.revoked && (
            <div className="account-pro">
              <div className="account-pro-text">{t("cloud.plan.free")}</div>
              <GetProButton small onOpen={() => setOpen(false)} />
            </div>
          )}
          <div className="menu-items">
            {/* Sync runs by itself; only a device that was signed out has something to do here. */}
            {account.revoked && (
              <button role="menuitem" onClick={openCloud}>
                <CloudOff size={14} />
                {t("cloud.revoked.again")}
              </button>
            )}
            <button role="menuitem" onClick={openCloud}>
              <MonitorSmartphone size={14} />
              {t("account.devices")}
            </button>
            {!account.revoked && !free && (
              <button
                role="menuitem"
                title={t("cloud.plan.open.hint")}
                onClick={() => {
                  setOpen(false);
                  void openAccountPage();
                }}
              >
                <CreditCard size={14} />
                {t("cloud.plan.open")}
              </button>
            )}
            <hr />
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setConfirming(true);
              }}
            >
              <LogOut size={14} />
              {t("cloud.sign_out")}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <Confirm
          title={t("cloud.sign_out.title")}
          text={t("cloud.sign_out.text")}
          confirmLabel={t("cloud.sign_out")}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void signOutOfCloud();
          }}
        />
      )}
    </div>
  );
}

/** How many AI asks are left in the window; used up, when they come back. */
function AiAllowanceLine({ allowance }: { allowance: AiAllowance }) {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const back = allowance.back_at ? formatClock(allowance.back_at * 1000, locale) : "";
  const text =
    allowance.left > 0
      ? t("cloud.ai.left", { left: allowance.left, limit: allowance.limit, hours: allowance.window_hours })
      : t("cloud.ai.none", { time: back });
  const used = allowance.limit > 0 ? Math.min(1, (allowance.limit - allowance.left) / allowance.limit) : 1;
  return (
    <>
      <div className={cx("account-detail account-ai", allowance.left === 0 && "out")}>
        <WandSparkles size={11} />
        {text}
      </div>
      <div
        className="account-ai-meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={allowance.limit}
        aria-valuenow={allowance.limit - allowance.left}
      >
        <i style={{ width: `${Math.max(used > 0 ? 3 : 0, used * 100)}%` }} />
      </div>
    </>
  );
}
