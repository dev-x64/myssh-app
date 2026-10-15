import { AlertTriangle, CloudUpload, KeyRound, Lock, ShieldCheck, Undo2 } from "lucide-react";
import type { KeyView } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { cx, Modal } from "../ui";

/**
 * Asks before a private key is allowed into the cloud, saying plainly how
 * it is protected there and what the remaining risk is.
 */
export function KeySyncDialog(props: {
  keyView: KeyView;
  signedIn: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const key = props.keyView;
  const passphrase = !key.encrypted
    ? ({ text: t("key.sync.fact.no_passphrase"), warn: true } as const)
    : key.has_passphrase
      ? ({ text: t("key.sync.fact.passphrase_saved"), warn: true } as const)
      : ({ text: t("key.sync.fact.passphrase_kept"), warn: false } as const);
  const facts = [
    { icon: Lock, text: t("key.sync.fact.encrypted"), warn: false },
    { icon: KeyRound, text: t("key.sync.fact.password"), warn: false },
    { icon: passphrase.warn ? AlertTriangle : ShieldCheck, ...passphrase },
    { icon: Undo2, text: t("key.sync.fact.undo"), warn: false },
  ];
  return (
    <Modal
      title={t("key.sync.enable.title", { name: key.label || key.algorithm })}
      icon={<CloudUpload size={17} />}
      onClose={props.onClose}
      onSubmit={props.onConfirm}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose} data-autofocus>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary">
            {t("key.sync.enable")}
          </button>
        </>
      }
    >
      <p>{t("key.sync.enable.text")}</p>
      <div className="facts">
        {facts.map(({ icon: Icon, text, warn }) => (
          <div key={text} className={cx("fact", warn && "warn")}>
            <Icon size={15} />
            <span>{text}</span>
          </div>
        ))}
      </div>
      <p className="note">{t("key.sync.fact.safer")}</p>
      {!props.signedIn && <p className="dim">{t("key.sync.enable.signed_out")}</p>}
    </Modal>
  );
}
