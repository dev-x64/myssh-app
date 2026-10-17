import {
  Check,
  Cloud,
  Copy,
  FileKey2,
  KeyRound,
  Pencil,
  Plus,
  ServerCog,
  Laptop,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useMemo, useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type IdentityView, type KeyView, type Snapshot } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { KeySyncDialog } from "./KeySyncDialog";
import { useUi, useVault } from "../../lib/store";
import { Confirm, Empty } from "../ui";
import { IdentityDialog } from "./IdentityDialog";
import { InstallKeyDialog } from "./InstallKeyDialog";
import { Tip } from "../Tip";
import { GenerateKeyDialog, ImportKeyDialog, RenameKeyDialog } from "./KeyDialogs";

type Dialog =
  | { kind: "generate" }
  | { kind: "import" }
  | { kind: "rename"; key: KeyView }
  | { kind: "install"; key: KeyView }
  | { kind: "sync"; key: KeyView }
  | { kind: "delete-key"; key: KeyView }
  | { kind: "identity"; identity: IdentityView | null }
  | { kind: "delete-identity"; identity: IdentityView }
  | null;

/** How many hosts end up using each key, directly or through an identity. */
function keyUsage(snapshot: Snapshot): Map<string, number> {
  const usage = new Map<string, number>();
  for (const host of snapshot.hosts) {
    const keyId =
      host.auth.kind === "inline"
        ? host.auth.key_id
        : (snapshot.identities.find(
            (i) => host.auth.kind === "identity" && i.id === host.auth.identity_id,
          )?.key_id ?? null);
    if (keyId) usage.set(keyId, (usage.get(keyId) ?? 0) + 1);
  }
  return usage;
}

export function KeychainView() {
  const t = useT();
  const snapshot = useVault((s) => s.snapshot);
  const signedIn = snapshot.cloud !== null && !snapshot.cloud.revoked;
  const toast = useUi((s) => s.toast);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const usage = useMemo(() => keyUsage(snapshot), [snapshot]);
  const identityUsage = (identity: IdentityView) =>
    snapshot.hosts.filter((h) => h.auth.kind === "identity" && h.auth.identity_id === identity.id).length;
  /** Hosts and identities that reference the key and so block its deletion. */
  const keyReferences = (key: KeyView) =>
    snapshot.hosts.filter((h) => h.auth.kind === "inline" && h.auth.key_id === key.id).length +
    snapshot.identities.filter((i) => i.key_id === key.id).length;

  const setSync = async (key: KeyView) => {
    setDialog(null);
    await mutate(() => api.keySetSync(key.id, !key.sync));
  };

  const copyPublic = async (key: KeyView) => {
    try {
      await writeText(`${key.public_key} ${key.label}`.trim());
      setCopied(key.id);
      window.setTimeout(() => setCopied((current) => (current === key.id ? null : current)), 1600);
    } catch (e) {
      toast("error", String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("keychain.title")}</h1>
        <div className="grow" />
        <button className="btn" onClick={() => setDialog({ kind: "import" })}>
          <Upload size={15} />
          {t("keychain.import")}
        </button>
        <button className="btn primary" onClick={() => setDialog({ kind: "generate" })}>
          <Plus size={15} />
          {t("keychain.generate")}
        </button>
      </div>

      <div className="page-body scroll">
        <Tip id="keychain" title={t("tip.keychain.title")}>
          {t("tip.keychain.text")}
        </Tip>
        <div className="section-title">
          {t("keychain.keys")}
          <span className="dim">{snapshot.keys.length}</span>
        </div>
        {snapshot.keys.length === 0 ? (
          <Empty icon={<KeyRound size={24} />} text={t("keychain.keys.empty")} />
        ) : (
          <div className="list">
            {snapshot.keys.map((key) => {
              const used = usage.get(key.id) ?? 0;
              return (
                <div key={key.id} className="item">
                  <span className="card-icon accent">
                    <FileKey2 size={18} />
                  </span>
                  <div className="item-main">
                    <div className="item-title">
                      <span className="name">{key.label || key.algorithm}</span>
                      <span className="chip">{key.algorithm}</span>
                      {/* Where the key lives, and the switch for it. */}
                      <button
                        className={key.sync ? "chip ok" : "chip"}
                        title={[
                          t(key.sync ? (signedIn ? "key.sync.cloud.hint" : "key.sync.waiting.hint") : "key.sync.local.hint"),
                          t(key.sync ? "key.sync.disable.click" : "key.sync.enable.click"),
                        ].join(". ")}
                        onClick={() => setDialog({ kind: "sync", key })}
                      >
                        {key.sync ? <Cloud size={11} /> : <Laptop size={11} />}
                        {t(key.sync ? (signedIn ? "key.sync.cloud" : "key.sync.waiting") : "key.sync.local")}
                      </button>
                      {key.encrypted && (
                        <span
                          className="chip"
                          title={key.has_passphrase ? t("key.protected.saved") : t("key.protected.ask")}
                        >
                          {t("key.protected")}
                        </span>
                      )}
                    </div>
                    <div className="item-sub mono selectable">{key.fingerprint}</div>
                    <div className="item-sub">
                      {t(key.origin === "generated" ? "key.origin.generated" : "key.origin.imported")}
                      {" · "}
                      {used > 0 ? t("key.used_by", { n: used }) : t("key.unused")}
                    </div>
                  </div>
                  <div className="item-actions">
                    <button className="btn small" onClick={() => void copyPublic(key)}>
                      {copied === key.id ? <Check size={13} /> : <Copy size={13} />}
                      {copied === key.id ? t("common.copied") : t("key.copy_public")}
                    </button>
                    <button
                      className="btn small"
                      disabled={snapshot.hosts.length === 0}
                      onClick={() => setDialog({ kind: "install", key })}
                    >
                      <ServerCog size={13} />
                      {t("install.action")}
                    </button>
                    <button
                      className="btn small icon ghost"
                      title={t("common.rename")}
                      onClick={() => setDialog({ kind: "rename", key })}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="btn small icon ghost"
                      title={t("common.delete")}
                      onClick={() => setDialog({ kind: "delete-key", key })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="section-title" style={{ marginTop: 26 }}>
          {t("keychain.identities")}
          <span className="dim">{snapshot.identities.length}</span>
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={() => setDialog({ kind: "identity", identity: null })}>
            <Plus size={13} />
            {t("keychain.new_identity")}
          </button>
        </div>
        {snapshot.identities.length === 0 ? (
          <Empty icon={<UserRound size={24} />} text={t("keychain.identities.empty")} />
        ) : (
          <div className="list">
            {snapshot.identities.map((identity) => {
              const key = snapshot.keys.find((k) => k.id === identity.key_id);
              const secrets = [
                identity.has_password && t("identity.auth.password"),
                key && `${t("identity.auth.key")}: ${key.label || key.algorithm}`,
              ].filter(Boolean);
              return (
                <div key={identity.id} className="item">
                  <span className="card-icon">
                    <UserRound size={18} />
                  </span>
                  <div className="item-main">
                    <div className="item-title">
                      <span className="name">{identity.label || identity.username}</span>
                    </div>
                    <div className="item-sub">
                      {identity.username}
                      {" · "}
                      {secrets.length ? secrets.join(" + ") : t("identity.auth.none")}
                      {" · "}
                      {t("hosts.count", { n: identityUsage(identity) })}
                    </div>
                  </div>
                  <div className="item-actions">
                    <button
                      className="btn small icon ghost"
                      title={t("common.edit")}
                      onClick={() => setDialog({ kind: "identity", identity })}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="btn small icon ghost"
                      title={t("common.delete")}
                      onClick={() => setDialog({ kind: "delete-identity", identity })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="dim" style={{ marginTop: 22 }}>
          {t("keychain.local_note")}
        </p>
      </div>

      {dialog?.kind === "generate" && <GenerateKeyDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "import" && <ImportKeyDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "rename" && <RenameKeyDialog keyView={dialog.key} onClose={() => setDialog(null)} />}
      {dialog?.kind === "install" && (
        <InstallKeyDialog keyView={dialog.key} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "sync" &&
        (dialog.key.sync ? (
          <Confirm
            danger
            title={t("key.sync.disable.title", { name: dialog.key.label || dialog.key.algorithm })}
            text={t("key.sync.disable.text")}
            confirmLabel={t("key.sync.disable")}
            onClose={() => setDialog(null)}
            onConfirm={() => setSync(dialog.key)}
          />
        ) : (
          <KeySyncDialog
            keyView={dialog.key}
            signedIn={snapshot.cloud !== null}
            onClose={() => setDialog(null)}
            onConfirm={() => setSync(dialog.key)}
          />
        ))}
      {dialog?.kind === "identity" && (
        <IdentityDialog identity={dialog.identity} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete-key" &&
        (keyReferences(dialog.key) > 0 ? (
          <Confirm
            title={t("key.delete.title")}
            text={`${t("error.in_use")}: ${t("key.used_by", { n: usage.get(dialog.key.id) ?? keyReferences(dialog.key) })}.`}
            confirmLabel={t("common.close")}
            onClose={() => setDialog(null)}
            onConfirm={() => setDialog(null)}
          />
        ) : (
          <Confirm
            danger
            title={t("key.delete.title")}
            text={t("key.delete.text", { name: dialog.key.label || dialog.key.fingerprint })}
            confirmLabel={t("common.delete")}
            onClose={() => setDialog(null)}
            onConfirm={async () => {
              const key = dialog.key;
              setDialog(null);
              await mutate(() => api.keyDelete(key.id), t("key.deleted"));
            }}
          />
        ))}
      {dialog?.kind === "delete-identity" &&
        (identityUsage(dialog.identity) > 0 ? (
          <Confirm
            title={t("identity.delete.title")}
            text={`${t("error.in_use")}: ${t("hosts.count", { n: identityUsage(dialog.identity) })}.`}
            confirmLabel={t("common.close")}
            onClose={() => setDialog(null)}
            onConfirm={() => setDialog(null)}
          />
        ) : (
          <Confirm
            danger
            title={t("identity.delete.title")}
            text={t("identity.delete.text", { name: dialog.identity.label || dialog.identity.username })}
            confirmLabel={t("common.delete")}
            onClose={() => setDialog(null)}
            onConfirm={async () => {
              const identity = dialog.identity;
              setDialog(null);
              await mutate(() => api.identityDelete(identity.id), t("identity.deleted"));
            }}
          />
        ))}
    </div>
  );
}
