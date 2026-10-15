import {
  Cable,
  CloudUpload,
  Eye,
  Fingerprint,
  HardDrive,
  KeyRound,
  Lock,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, type DiskEncryption } from "../../lib/api";
import { useT, type MessageKey } from "../../lib/i18n";
import { cx } from "../ui";

const NOTES: { icon: typeof Lock; title: MessageKey; text: MessageKey; warn?: boolean }[] = [
  { icon: Lock, title: "sec.vault.title", text: "sec.vault.text" },
  { icon: ShieldAlert, title: "sec.limits.title", text: "sec.limits.text", warn: true },
  { icon: CloudUpload, title: "sec.cloud.title", text: "sec.cloud.text" },
  { icon: KeyRound, title: "sec.password.title", text: "sec.password.text" },
  { icon: Eye, title: "sec.server.title", text: "sec.server.text" },
  { icon: MonitorSmartphone, title: "sec.local.title", text: "sec.local.text" },
  { icon: Cable, title: "sec.net.title", text: "sec.net.text" },
  { icon: Fingerprint, title: "sec.hostkeys.title", text: "sec.hostkeys.text" },
  { icon: ShieldCheck, title: "sec.auto.title", text: "sec.auto.text" },
];

/**
 * The whole story of how data is protected, limits included, with the one
 * thing that depends on this Mac checked live: disk encryption.
 */
export function SecuritySection() {
  const t = useT();
  const [disk, setDisk] = useState<DiskEncryption | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .diskEncryption()
      .catch((): DiskEncryption => "unknown")
      .then((state) => alive && setDisk(state));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="section-title">{t("settings.security")}</div>
      <p className="section-hint">{t("sec.intro")}</p>
      <div className="table sec-list">
        {NOTES.slice(0, 2).map((note) => (
          <Note key={note.title} {...note} />
        ))}
        <div className={cx("sec-item", disk === "off" && "warn")}>
          <span className="security-icon">
            <HardDrive size={15} />
          </span>
          <div className="grow">
            <div className="security-name">
              {t("sec.disk.title")}
              {disk && (
                <span className={cx("chip", disk === "on" && "ok", disk === "off" && "danger")}>
                  {t(`sec.disk.chip.${disk}`)}
                </span>
              )}
            </div>
            <div className="security-text">{disk ? t(`sec.disk.${disk}`) : "…"}</div>
          </div>
        </div>
        {NOTES.slice(2).map((note) => (
          <Note key={note.title} {...note} />
        ))}
      </div>
    </>
  );
}

function Note(props: { icon: typeof Lock; title: MessageKey; text: MessageKey; warn?: boolean }) {
  const t = useT();
  const Icon = props.icon;
  return (
    <div className={cx("sec-item", props.warn && "warn")}>
      <span className="security-icon">
        <Icon size={15} />
      </span>
      <div>
        <div className="security-name">{t(props.title)}</div>
        <div className="security-text">{t(props.text)}</div>
      </div>
    </div>
  );
}
