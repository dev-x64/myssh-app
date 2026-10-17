import { AlertTriangle, Check, Cloud, CloudOff, ExternalLink, Laptop, RefreshCw, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { reportError } from "../../lib/actions";
import { api, type CloudDevice, type ConflictNote } from "../../lib/api";
import { syncNow, useCloud } from "../../lib/cloud";
import { formatAgo, formatDate, useT, type MessageKey, type T } from "../../lib/i18n";
import { loadPlan, usePlan } from "../../lib/plan";
import { useSettings } from "../../lib/settings";
import { useUi, useVault } from "../../lib/store";
import { Confirm, cx } from "../ui";
import { SignInForm } from "./SignInForm";
import { openEmailDialog } from "./ChangeEmail";
import { GetProButton, ProBadge } from "./Pro";

/** A device's system as people write it. */
function platformName(platform: string): string {
  return ({ macos: "macOS", windows: "Windows", linux: "Linux", ios: "iOS", android: "Android" } as Record<string, string>)[platform] ?? platform;
}
import { openAccountPage, signOutOfCloud, useSyncStatus } from "./status";

function describeConflict(note: ConflictNote, t: T): string {
  if (note.item === "settings") return t("cloud.conflict.settings");
  return t(`cloud.conflict.${note.resolution}` as MessageKey, {
    name: note.name,
    suffix: t("cloud.copy_suffix"),
  });
}

function Devices() {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const toast = useUi((s) => s.toast);
  const lastSync = useVault((s) => s.snapshot.cloud?.last_sync_at);
  const [devices, setDevices] = useState<CloudDevice[] | null>(null);
  const [revoking, setRevoking] = useState<CloudDevice | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await api.cloudDevices());
    } catch {
      setDevices(null);
      await useVault.getState().refresh();
    }
  }, []);

  // The list is refreshed with every sync.
  useEffect(() => {
    void load();
  }, [load, lastSync]);

  return (
    <>
      <div className="section-title">{t("cloud.devices")}</div>
      {devices === null ? (
        <p className="dim">{t("cloud.devices.unavailable")}</p>
      ) : (
        <div className="list">
          {devices.map((device) => (
            <div key={device.id} className="item">
              <span className={cx("card-icon", device.current && "accent")}>
                <Laptop size={18} />
              </span>
              <div className="item-main">
                <div className="item-title">
                  <span className="name">{device.name}</span>
                  {device.current && <span className="chip accent">{t("cloud.devices.this")}</span>}
                </div>
                <div className="item-sub">
                  {platformName(device.platform)}
                  {" · "}
                  {t("cloud.devices.added", { date: formatDate(device.created_at * 1000, locale) })}
                  {" · "}
                  {t("cloud.devices.seen", { date: formatAgo(device.last_seen_at * 1000, locale) })}
                </div>
              </div>
              {!device.current && (
                <div className="item-actions">
                  <button className="btn small danger" onClick={() => setRevoking(device)}>
                    <ShieldOff size={13} />
                    {t("cloud.devices.revoke")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {revoking && (
        <Confirm
          danger
          title={t("cloud.devices.revoke.title", { name: revoking.name })}
          text={t("cloud.devices.revoke.text")}
          confirmLabel={t("cloud.devices.revoke")}
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            const device = revoking;
            setRevoking(null);
            try {
              await api.cloudRevokeDevice(device.id);
              toast("success", t("cloud.devices.revoked"));
            } catch (e) {
              reportError(e);
            }
            await load();
          }}
        />
      )}
    </>
  );
}

/**
 * Free or Pro, and the way to the account's pages in the browser, where
 * the subscription is taken, renewed and cancelled.
 */
function Plan() {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const email = useVault((s) => s.snapshot.cloud?.email ?? "");
  const lastSync = useVault((s) => s.snapshot.cloud?.last_sync_at);
  const plan = usePlan((s) => s.plan);
  const offered = useCloud((s) => s.state === "error" && s.error?.code === "pro_required");
  const [opening, setOpening] = useState(false);

  // Asked again on opening the screen and with every sync; coming back
  // from the browser is seen to by the plan itself.
  useEffect(() => {
    void loadPlan(true);
  }, []);
  useEffect(() => {
    void loadPlan();
  }, [lastSync]);

  const date = plan?.ends_at ? formatDate(plan.ends_at * 1000, locale) : "";
  const open = async () => {
    setOpening(true);
    await openAccountPage();
    setOpening(false);
  };

  return (
    <>
      <div className="section-title">{t("cloud.account")}</div>
      <div className="table">
        <div className="setting">
          <div className="setting-text">
            <div className="name selectable">{email}</div>
            <div className="hint">{t("account.email.hint")}</div>
          </div>
          <div className="control">
            <button className="btn" onClick={openEmailDialog}>
              {t("account.email.change")}
            </button>
          </div>
        </div>
        <div className="setting">
          <div className="setting-text">
            <div className="name">
              {plan ? (plan.plan === "pro" ? <ProBadge /> : "Free") : t("cloud.plan.open")}
              {plan?.plan === "pro" && plan.period && (
                <span className="chip" style={{ marginLeft: 8 }}>
                  {t(`cloud.plan.${plan.period}` as MessageKey)}
                </span>
              )}
            </div>
            <div className="hint">
              {plan ? t(`cloud.plan.${plan.state}` as MessageKey, { date }) : t("cloud.plan.open.hint")}
            </div>
          </div>
          <div className="control">
            {plan?.plan === "free" ? (
              // Offered once on this screen: in the card above, when sync waits for it.
              !offered && <GetProButton />
            ) : (
              <button className="btn" disabled={opening} title={t("cloud.plan.open.hint")} onClick={() => void open()}>
                {t("cloud.plan.open")}
                <ExternalLink size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function CloudView() {
  const t = useT();
  const account = useVault((s) => s.snapshot.cloud);
  const available = useVault((s) => s.status?.cloud_available ?? false);
  const sync = useCloud();
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(false);
    await signOutOfCloud();
  };

  const status = useSyncStatus(true);
  const onFree = sync.state === "error" && sync.error?.code === "pro_required";

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("cloud.title")}</h1>
      </div>
      <div className="page-body scroll">
        <div className="settings">
          {!available ? (
            <p className="lead">{t("cloud.unavailable")}</p>
          ) : !account ? (
            <>
              <p className="lead">{t("cloud.intro")}</p>
              <SignInForm />
              <p className="dim" style={{ marginTop: 16 }}>
                {t("cloud.local_ok")}
              </p>
            </>
          ) : account.revoked ? (
            <div className="cloud-card bad">
              <span className="cloud-badge">
                <CloudOff size={20} />
              </span>
              <div className="cloud-main">
                <div className="cloud-title">{t("cloud.revoked.title")}</div>
                <div className="cloud-sub">{t("cloud.revoked.text")}</div>
                <div className="cloud-sub mono">{account.email}</div>
              </div>
              <button className="btn primary" onClick={() => void signOut()}>
                {t("cloud.revoked.again")}
              </button>
            </div>
          ) : (
            <>
              <div className={cx("cloud-card", onFree ? "free" : status?.tone)}>
                <span className="cloud-badge">
                  {onFree ? (
                    <CloudOff size={20} />
                  ) : status?.tone === "busy" ? (
                    <RefreshCw size={20} className="spin" />
                  ) : status?.tone === "ok" ? (
                    <Check size={20} />
                  ) : status?.tone === "bad" ? (
                    <AlertTriangle size={20} />
                  ) : (
                    <Cloud size={20} />
                  )}
                </span>
                <div className="cloud-main">
                  <div className="cloud-title">{status?.text}</div>
                  {status?.detail && <div className="cloud-sub selectable">{status.detail}</div>}
                  <div className="cloud-sub">{t("cloud.signed_in_as", { email: account.email })}</div>
                </div>
                {/* On Free nothing is wrong and there is nothing to sync: the way to Pro instead. */}
                {onFree ? (
                  <GetProButton />
                ) : (
                  <button className="btn" disabled={sync.state === "syncing"} onClick={() => void syncNow()}>
                    <RefreshCw size={14} />
                    {t("cloud.sync_now")}
                  </button>
                )}
                <button className="btn" onClick={() => setSigningOut(true)}>
                  {t("cloud.sign_out")}
                </button>
              </div>

              {sync.conflicts.length > 0 && (
                <>
                  <div className="section-title">
                    {t("cloud.conflicts")}
                    <span style={{ flex: 1 }} />
                    <button className="btn small ghost" onClick={sync.dismissConflicts}>
                      {t("cloud.conflicts.dismiss")}
                    </button>
                  </div>
                  <div className="table">
                    {sync.conflicts.map((note, index) => (
                      <div key={index} className="setting">
                        <span className="chip">{t(`cloud.item.${note.item}` as MessageKey)}</span>
                        <div className="setting-text">{describeConflict(note, t)}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <Plan />

              <Devices />

              <div className="section-title">{t("cloud.synced.title")}</div>
              <p className="lead">{t("cloud.synced.text")}</p>
            </>
          )}
        </div>
      </div>

      {signingOut && (
        <Confirm
          title={t("cloud.sign_out.title")}
          text={t("cloud.sign_out.text")}
          confirmLabel={t("cloud.sign_out")}
          onClose={() => setSigningOut(false)}
          onConfirm={() => void signOut()}
        />
      )}
    </div>
  );
}
