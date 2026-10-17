import { KeyRound } from "lucide-react";
import type { HostView } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useVault } from "../../lib/store";

/**
 * On a host's tile, after its address, when it signs in with a key,
 * directly or through an identity: a key and the key's name, and in a
 * tooltip how it is chosen.
 */
export function KeyBadge({ host }: { host: HostView }) {
  const t = useT();
  const snapshot = useVault((s) => s.snapshot);
  const identity =
    host.auth.kind === "identity"
      ? snapshot.identities.find((i) => host.auth.kind === "identity" && i.id === host.auth.identity_id)
      : undefined;
  const keyId = host.auth.kind === "inline" ? host.auth.key_id : (identity?.key_id ?? null);
  const key = keyId ? snapshot.keys.find((k) => k.id === keyId) : undefined;
  if (!key) return null;
  const name = key.label || key.algorithm;
  const title = identity
    ? t("hosts.key.via", { key: name, identity: identity.label || identity.username })
    : t("hosts.key", { key: name });
  return (
    <span className="key-mark" title={title}>
      <KeyRound size={11} />
      {name}
    </span>
  );
}
