import { Eraser, Eye, EyeOff, Pencil, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { mutate } from "../../lib/actions";
import {
  api,
  type Group,
  type HostInput,
  type HostView,
  type Id,
  type SecretInput,
  type SharedCredentials,
} from "../../lib/api";
import { useT } from "../../lib/i18n";
import { getSession, openHost } from "../../lib/sessions";
import { hostPanelKey, useUi, useVault, type HostPanel as PanelState } from "../../lib/store";
import { Field, PasswordInput, Segmented, TagInput } from "../ui";
import { AgentForwarding } from "./AgentForwarding";

/** Groups as a flat list with their full path, for a select. */
export function groupOptions(groups: Group[]): { id: Id; path: string }[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const pathOf = (g: Group): string => {
    const parent = g.parent_id ? byId.get(g.parent_id) : undefined;
    return parent ? `${pathOf(parent)} / ${g.name}` : g.name;
  };
  return groups
    .map((g) => ({ id: g.id, path: pathOf(g) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** A saved password that was asked to be shown is hidden again by itself after this long. */
const REVEAL_MS = 30_000;

/**
 * Editor for a stored secret: shows that one is saved and lets the user
 * replace or remove it. The secret itself is not here. With `reveal` there
 * is an eye that fetches it to be looked at, for a while.
 */
export function SecretField(props: {
  saved: boolean;
  value: SecretInput;
  onChange: (value: SecretInput) => void;
  placeholder?: string;
  reveal?: () => Promise<string | null>;
  /** Takes the focus when its dialog opens. */
  autoFocus?: boolean;
}) {
  const t = useT();
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (shown === null) return;
    const timer = window.setTimeout(() => setShown(null), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  const toggle = async () => {
    if (shown !== null) return setShown(null);
    const secret = await props.reveal?.().catch(() => null);
    if (secret) setShown(secret);
  };
  if (props.saved && props.value.action === "keep") {
    return (
      <div className="saved-secret">
        <span
          className={shown === null ? "grow" : "grow shown mono selectable"}
          title={shown === null ? t("host.password.saved") : undefined}
        >
          {shown ?? "••••••••"}
        </span>
        {props.reveal && (
          <button
            type="button"
            className="btn ghost icon small"
            title={t(shown === null ? "password.show" : "password.hide")}
            aria-label={t(shown === null ? "password.show" : "password.hide")}
            onClick={() => void toggle()}
          >
            {shown === null ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon small"
          title={t("host.password.change")}
          aria-label={t("host.password.change")}
          onClick={() => props.onChange({ action: "set", value: "" })}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          className="btn ghost icon small"
          title={t("host.password.remove")}
          aria-label={t("host.password.remove")}
          onClick={() => props.onChange({ action: "clear" })}
        >
          <Eraser size={14} />
        </button>
      </div>
    );
  }
  return (
    <PasswordInput
      data-autofocus={props.autoFocus || undefined}
      placeholder={props.placeholder}
      value={props.value.action === "set" ? props.value.value : ""}
      onChange={(e) => props.onChange({ action: "set", value: e.target.value })}
    />
  );
}

/**
 * Says that other hosts keep the very credentials this one keeps, and
 * gathers them into one identity at a press, so that the password is
 * changed in one place from then on.
 */
function SharedHint(props: {
  host: HostView;
  shared: SharedCredentials;
  onGathered: (identityId: Id) => void;
}) {
  const t = useT();
  const snapshot = useVault((s) => s.snapshot);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const { host, shared } = props;
  const others = shared.hosts
    .map((id) => snapshot.hosts.find((h) => h.id === id))
    .filter((h): h is HostView => h !== undefined);
  const identity = snapshot.identities.find((i) => i.id === shared.identity);
  const username = host.auth.kind === "inline" ? host.auth.username : "";
  const names =
    others
      .slice(0, 3)
      .map((h) => h.label || h.address)
      .join(", ") + (others.length > 3 ? ` ${t("host.shared.more", { n: others.length - 3 })}` : "");

  const gather = async () => {
    if (busy) return;
    setBusy(true);
    const made = await mutate(
      () => api.hostGatherCredentials(host.id, label.trim() || username),
      t("host.shared.done", { n: others.length + 1 }),
    );
    setBusy(false);
    if (made) props.onGathered(made.id);
  };

  return (
    <div className="shared-hint">
      <Sparkles size={15} />
      <div className="grow">
        {identity && (
          <p>{t("host.shared.identity", { name: identity.label || identity.username })}</p>
        )}
        {others.length > 0 && <p>{t("host.shared.text", { n: others.length, names })}</p>}
        <p className="dim">{t(identity ? "host.shared.why.identity" : "host.shared.why")}</p>
        <div className="row">
          {!identity && (
            <input
              className="input"
              value={label}
              placeholder={t("host.shared.label", { name: username })}
              onChange={(e) => setLabel(e.target.value)}
              spellCheck={false}
            />
          )}
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void gather()}>
            {t(identity ? "host.shared.use" : "host.shared.action")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function HostPanel(props: {
  panel: NonNullable<PanelState>;
  onClose: () => void;
  onDelete: (host: HostView) => void;
  /** Told of the host once saved, before the panel closes. */
  onSaved?: (host: HostView) => void;
}) {
  const t = useT();
  const snapshot = useVault((s) => s.snapshot);
  const editing =
    props.panel.mode === "edit"
      ? snapshot.hosts.find((h) => props.panel.mode === "edit" && h.id === props.panel.hostId)
      : undefined;

  // Start from what was typed here before, if the panel was left open while
  // the user looked elsewhere; otherwise from the host being edited.
  const draftKey = hostPanelKey(props.panel);
  const [saved] = useState(() => {
    const draft = useUi.getState().hostDraft;
    return draft?.key === draftKey ? draft : null;
  });
  const [label, setLabel] = useState(saved?.label ?? editing?.label ?? "");
  const [address, setAddress] = useState(saved?.address ?? editing?.address ?? "");
  const [port, setPort] = useState(saved?.port ?? (editing ? String(editing.port) : "22"));
  const [groupId, setGroupId] = useState<Id | null>(
    saved
      ? saved.groupId
      : editing
        ? editing.group_id
        : props.panel.mode === "new"
          ? props.panel.groupId
          : null,
  );
  const [tags, setTags] = useState<string[]>(saved?.tags ?? editing?.tags ?? []);
  const [authKind, setAuthKind] = useState<"inline" | "identity">(
    saved?.authKind ?? editing?.auth.kind ?? "inline",
  );
  const [username, setUsername] = useState(
    saved?.username ?? (editing?.auth.kind === "inline" ? editing.auth.username : ""),
  );
  const [password, setPassword] = useState<SecretInput>(
    saved?.password ??
      (editing?.auth.kind === "inline" && editing.auth.has_password
        ? { action: "keep" }
        : { action: "set", value: "" }),
  );
  const [keyId, setKeyId] = useState<Id | null>(
    saved ? saved.keyId : editing?.auth.kind === "inline" ? editing.auth.key_id : null,
  );
  const [identityId, setIdentityId] = useState<Id | null>(
    saved
      ? saved.identityId
      : editing?.auth.kind === "identity"
        ? editing.auth.identity_id
        : (snapshot.identities[0]?.id ?? null),
  );
  const [startupId, setStartupId] = useState<Id | null>(
    saved ? saved.startupId : (editing?.startup_snippet_id ?? null),
  );
  const [agentForwarding, setAgentForwarding] = useState(saved?.agentForwarding ?? editing?.agent_forwarding ?? false);
  useEffect(() => {
    useUi.getState().setHostDraft({
      key: draftKey,
      label,
      address,
      port,
      groupId,
      tags,
      authKind,
      username,
      password,
      keyId,
      identityId,
      startupId,
      agentForwarding,
    });
  }, [draftKey, label, address, port, groupId, tags, authKind, username, password, keyId, identityId, startupId, agentForwarding]);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // Who else holds this host's own credentials; asked again whenever hosts change.
  const [shared, setShared] = useState<SharedCredentials | null>(null);
  const editingId = editing?.id ?? null;
  const ownCredentials = editing?.auth.kind === "inline";
  useEffect(() => {
    let alive = true;
    setShared(null);
    if (editingId !== null && ownCredentials) {
      void api
        .hostSharedCredentials(editingId)
        .then((found) => alive && setShared(found))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [editingId, ownCredentials, snapshot.hosts, snapshot.identities]);
  // The hint is about what is saved, so it goes once the form says something else.
  const untouched =
    editing?.auth.kind === "inline" &&
    authKind === "inline" &&
    username === editing.auth.username &&
    keyId === editing.auth.key_id &&
    (password.action === "keep" || (password.action === "set" && password.value === ""));

  const groups = useMemo(() => groupOptions(snapshot.groups), [snapshot.groups]);

  const portNumber = Number(port);
  const portValid = /^\d+$/.test(port.trim()) && portNumber >= 1 && portNumber <= 65535;
  const addressValid = address.trim() !== "" && !/\s/.test(address.trim());
  const identityValid = authKind !== "identity" || identityId !== null;
  const valid = portValid && addressValid && identityValid;
  const hadPassword = editing?.auth.kind === "inline" && editing.auth.has_password;

  const save = async (connect: boolean) => {
    setTouched(true);
    if (!valid || busy) return;
    // "Change" followed by an empty field means the user changed their mind;
    // only "Remove" deletes a saved password.
    const effectivePassword: SecretInput =
      hadPassword && password.action === "set" && password.value === "" ? { action: "keep" } : password;
    const input: HostInput = {
      id: editing?.id ?? null,
      label,
      address,
      port: portNumber,
      group_id: groupId,
      tags,
      auth:
        authKind === "identity"
          ? { kind: "identity", identity_id: identityId! }
          : { kind: "inline", username, password: effectivePassword, key_id: keyId },
      startup_snippet_id: startupId,
      agent_forwarding: agentForwarding,
    };
    setBusy(true);
    const saved = await mutate(() => api.hostSave(input), connect ? undefined : t("host.saved"));
    setBusy(false);
    if (!saved) return;
    // Opened from a tab that could not connect: that tab tries again.
    const waiting = props.panel.mode === "edit" ? props.panel.tabId : undefined;
    props.onSaved?.(saved);
    props.onClose();
    if (!connect) return;
    const ui = useUi.getState();
    const tab = ui.tabs.find((candidate) => candidate.id === waiting);
    const session = tab && getSession(tab.id);
    if (tab && session && tab.status === "closed") {
      ui.activate(tab.id);
      session.reconnect();
    } else {
      openHost(saved.id);
    }
  };

  // The host was deleted while its editor was open.
  if (props.panel.mode === "edit" && !editing) return null;

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div className="panel-head">
        <h2>{editing ? t("host.edit") : t("host.new")}</h2>
        {editing && (
          <button
            type="button"
            className="btn ghost danger icon small"
            title={t("common.delete")}
            aria-label={t("common.delete")}
            onClick={() => props.onDelete(editing)}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button type="button" className="btn ghost icon small" onClick={props.onClose} aria-label={t("common.close")}>
          <X size={15} />
        </button>
      </div>

      <div className="panel-body scroll">
        <div className="row">
          <div className="grow">
            <Field
              label={t("host.address")}
              hint={t("host.address.hint")}
              error={touched && !addressValid ? t("host.address.hint") : null}
            >
              <input
                className={`input${touched && !addressValid ? " invalid" : ""}`}
                autoFocus={!editing}
                value={address}
                placeholder="example.com"
                onChange={(e) => setAddress(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </Field>
          </div>
          <div style={{ width: 84 }}>
            <Field label={t("host.port")}>
              <input
                className={`input${touched && !portValid ? " invalid" : ""}`}
                value={port}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, "").slice(0, 5))}
              />
            </Field>
          </div>
        </div>

        <Field label={t("host.label")} hint={t("host.label.hint")} optional>
          <input
            className="input"
            value={label}
            placeholder={address.trim()}
            onChange={(e) => setLabel(e.target.value)}
            spellCheck={false}
          />
        </Field>

        <div className="group-box">
          <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <span className="field-label grow nowrap">{t("host.credentials")}</span>
            <Segmented
              value={authKind}
              onChange={setAuthKind}
              options={[
                { value: "inline", label: t("host.auth.inline") },
                { value: "identity", label: t("host.auth.identity") },
              ]}
            />
          </div>

          {authKind === "inline" ? (
            <>
              <Field label={t("host.username")} hint={t("host.username.hint")}>
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
              <Field label={t("host.password")} hint={hadPassword ? undefined : t("host.password.hint")}>
                <SecretField
                  saved={!!hadPassword}
                  value={password}
                  onChange={setPassword}
                  reveal={editing ? () => api.hostPassword(editing.id) : undefined}
                />
              </Field>
              <Field label={t("host.key")}>
                <select
                  className="select"
                  value={keyId ?? ""}
                  onChange={(e) => setKeyId(e.target.value || null)}
                >
                  <option value="">{t("host.no_key")}</option>
                  {snapshot.keys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.label || key.fingerprint} · {key.algorithm}
                    </option>
                  ))}
                </select>
              </Field>
              {editing && untouched && shared && (shared.hosts.length > 0 || shared.identity) && (
                <SharedHint
                  host={editing}
                  shared={shared}
                  onGathered={(id) => {
                    setAuthKind("identity");
                    setIdentityId(id);
                  }}
                />
              )}
            </>
          ) : snapshot.identities.length === 0 ? (
            <p className="muted">{t("host.identity.none")}</p>
          ) : (
            <Field label={t("host.identity")}>
              <select
                className="select"
                value={identityId ?? ""}
                onChange={(e) => setIdentityId(e.target.value || null)}
              >
                {snapshot.identities.map((identity) => (
                  <option key={identity.id} value={identity.id}>
                    {identity.label ? `${identity.label} · ${identity.username}` : identity.username}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <Field label={t("host.group")}>
          <select className="select" value={groupId ?? ""} onChange={(e) => setGroupId(e.target.value || null)}>
            <option value="">{t("host.no_group")}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.path}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("host.tags")} optional>
          <TagInput tags={tags} onChange={setTags} placeholder={t("host.tags.hint")} />
        </Field>

        {(snapshot.snippets.length > 0 || startupId) && (
          <Field label={t("host.startup")} hint={t("host.startup.hint")}>
            <select
              className="select"
              value={startupId ?? ""}
              onChange={(e) => setStartupId(e.target.value || null)}
            >
              <option value="">{t("host.startup.none")}</option>
              {snapshot.snippets.map((snippet) => (
                <option key={snippet.id} value={snippet.id}>
                  {snippet.package ? `${snippet.package} / ${snippet.name}` : snippet.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <AgentForwarding
          on={agentForwarding}
          onChange={setAgentForwarding}
          hostName={label.trim() || address.trim()}
          keys={snapshot.keys}
        />
      </div>

      <div className="panel-foot">
        <div className="grow" />
        <button type="submit" className="btn" disabled={busy}>
          {t("common.save")}
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save(true)}>
          {t("host.save_connect")}
        </button>
      </div>
    </form>
  );
}
