import { UserRound } from "lucide-react";
import { useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type Id, type IdentityView, type SecretInput } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useVault } from "../../lib/store";
import { SecretField } from "../hosts/HostPanel";
import { Field, Modal } from "../ui";

export function IdentityDialog(props: {
  identity: IdentityView | null;
  onClose: () => void;
  /**
   * Saving a password asked for in the terminal: the account is filled in,
   * the password is what is typed first, and there is no key to pick.
   */
  forPrompt?: { username: string; onSaved: (identity: IdentityView) => void };
}) {
  const t = useT();
  const keys = useVault((s) => s.snapshot.keys);
  const identity = props.identity;
  const forPrompt = props.forPrompt;
  const [label, setLabel] = useState(identity?.label ?? "");
  const [username, setUsername] = useState(identity?.username ?? forPrompt?.username ?? "");
  const [password, setPassword] = useState<SecretInput>(
    identity?.has_password ? { action: "keep" } : { action: "set", value: "" },
  );
  const [keyId, setKeyId] = useState<Id | null>(identity?.key_id ?? null);
  const [busy, setBusy] = useState(false);

  const missing = !username.trim() || (!!forPrompt && !(password.action === "set" && password.value));

  const submit = async () => {
    if (busy || missing) return;
    setBusy(true);
    const effectivePassword: SecretInput =
      identity?.has_password && password.action === "set" && password.value === ""
        ? { action: "keep" }
        : password;
    const saved = await mutate(
      () =>
        api.identitySave({
          id: identity?.id ?? null,
          label,
          username,
          password: effectivePassword,
          key_id: keyId,
        }),
      t("identity.saved"),
    );
    setBusy(false);
    if (saved) {
      props.onClose();
      forPrompt?.onSaved(saved);
    }
  };

  return (
    <Modal
      title={identity ? t("identity.edit") : forPrompt ? t("term.password.add_title") : t("identity.new")}
      icon={<UserRound size={17} />}
      onClose={props.onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || missing}>
            {forPrompt ? t("term.password.add_save") : t("common.save")}
          </button>
        </>
      }
    >
      <Field label={t("host.username")}>
        <input
          className="input"
          data-autofocus={!forPrompt || undefined}
          value={username}
          placeholder="deploy"
          onChange={(e) => setUsername(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
      <Field label={t("identity.label")} optional>
        <input
          className="input"
          value={label}
          placeholder={username.trim()}
          onChange={(e) => setLabel(e.target.value)}
          spellCheck={false}
        />
      </Field>
      {forPrompt && <p className="muted">{t("term.password.add_text")}</p>}
      <Field label={t("host.password")} optional={!forPrompt}>
        <SecretField
          autoFocus={!!forPrompt}
          saved={!!identity?.has_password}
          value={password}
          onChange={setPassword}
          reveal={identity ? () => api.identityPassword(identity.id) : undefined}
        />
      </Field>
      {!forPrompt && (
        <Field label={t("host.key")} optional>
          <select className="select" value={keyId ?? ""} onChange={(e) => setKeyId(e.target.value || null)}>
            <option value="">{t("host.no_key")}</option>
            {keys.map((key) => (
              <option key={key.id} value={key.id}>
                {key.label || key.fingerprint} · {key.algorithm}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  );
}
