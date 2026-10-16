// What stands in for the Rust core in the interface preview: every command
// the window sends is answered here, from made-up data kept in memory, as
// the chosen scenario has it. Changes (a host saved, a key renamed) last
// until the page is reloaded.

import type { Channel } from "@tauri-apps/api/core";
import type {
  ApiError,
  AppStatus,
  CloudView,
  GroupInput,
  HostInput,
  HostView,
  IdentityInput,
  KeyKind,
  KeyView,
  SessionEvent,
  Snapshot,
  SnippetInput,
  TransferProgress,
  UpdateInfo,
  UpdateProgress,
} from "../lib/api";
import * as data from "./data";
import type { Scenario } from "./scenario";
import { saveScenario } from "./scenario";
import * as shell from "./shell";

type Args = Record<string, unknown>;

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => Math.floor(Date.now() / 1000);
const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

function fail(code: string, message: string, detail: string | null = null): never {
  throw { code, message, detail } satisfies ApiError;
}

export function createHandler(scenario: Scenario) {
  const cloudOf = (): CloudView | null =>
    scenario.account === "none"
      ? null
      : {
          server: "https://cloud.myssh.app",
          email: data.EMAIL,
          device_id: "d-this",
          last_sync_at: scenario.account === "pro" ? Date.now() - 40_000 : null,
          revoked: scenario.account === "revoked",
          pending: 0,
        };
  const vault: Snapshot = data.snapshot(cloudOf(), scenario.empty);

  const status = (): AppStatus => ({
    version: "0.1.0",
    data_dir: "~/Library/Application Support/app.myssh.desktop",
    debug: false,
    vault_error: scenario.vaultError
      ? { code: "vault_decrypt", message: "the vault cannot be decrypted", detail: "aead::Error" }
      : null,
    cloud_available: scenario.cloud,
    updates: true,
  });

  const update = (): UpdateInfo | null =>
    scenario.update === "none"
      ? null
      : {
          version: scenario.update === "rollback" ? "0.0.9" : "0.1.1",
          current: "0.1.0",
          notes: "Faster file transfers.\nThe account menu shows whether you are on Pro.",
          date: new Date().toISOString(),
          rollback: scenario.update === "rollback",
        };

  const hostById = (id: unknown): HostView => {
    const host = vault.hosts.find((h) => h.id === id);
    if (!host) fail("not_found", "no such host");
    return host;
  };

  function saveHost(input: HostInput): HostView {
    const existing = input.id ? vault.hosts.find((h) => h.id === input.id) : undefined;
    const auth: HostView["auth"] =
      input.auth.kind === "identity"
        ? input.auth
        : {
            kind: "inline",
            username: input.auth.username,
            key_id: input.auth.key_id,
            has_password:
              input.auth.password.action === "set" ||
              (input.auth.password.action === "keep" && existing?.auth.kind === "inline" && existing.auth.has_password),
          };
    const host: HostView = {
      id: existing?.id ?? newId("h"),
      label: input.label,
      address: input.address,
      port: input.port ?? 22,
      group_id: input.group_id,
      tags: input.tags,
      auth,
      startup_snippet_id: input.startup_snippet_id,
      os: existing?.os ?? null,
      pinned: existing?.pinned ?? false,
      created_at: existing?.created_at ?? stamp(),
      updated_at: stamp(),
    };
    vault.hosts = existing ? vault.hosts.map((h) => (h.id === host.id ? host : h)) : [...vault.hosts, host];
    return host;
  }

  function generateKey(kind: KeyKind, label: string): KeyView {
    const algorithm = { ed25519: "ssh-ed25519", ecdsa_p256: "ecdsa-sha2-nistp256", ecdsa_p384: "ecdsa-sha2-nistp384", rsa4096: "ssh-rsa" }[kind];
    const key: KeyView = {
      id: newId("k"),
      label,
      algorithm,
      public_key: `${algorithm} AAAAPreview${Math.random().toString(36).slice(2)}`,
      fingerprint: `SHA256:${btoa(Math.random().toString()).slice(0, 43)}`,
      encrypted: false,
      has_passphrase: false,
      origin: "generated",
      sync: false,
      created_at: stamp(),
      updated_at: stamp(),
    };
    vault.keys = [...vault.keys, key];
    return key;
  }

  async function transfer(progress: Channel<TransferProgress>, total = 48_211_337) {
    for (let done = 0; done <= total; done += total / 20) {
      progress.onmessage({ done: Math.min(done, total), total });
      await later(60);
    }
    return { files: 1, bytes: total, skipped: 0 };
  }

  const commands: Record<string, (args: Args) => unknown> = {
    app_status: status,
    vault_retry: status,
    vault_replace: () => {
      scenario.vaultError = false;
      saveScenario(scenario);
    },
    vault_snapshot: () => {
      if (scenario.vaultError) fail("vault_decrypt", "the vault cannot be decrypted");
      return structuredClone(vault);
    },
    disk_encryption: () => "on",
    links_take: () => [],

    update_check: update,
    update_install: async ({ progress }) => {
      const channel = progress as Channel<UpdateProgress>;
      const total = 8_039_345;
      for (let downloaded = 0; downloaded <= total; downloaded += total / 25) {
        channel.onmessage({ downloaded: Math.min(downloaded, total), total });
        await later(80);
      }
    },
    update_restart: () => location.reload(),

    host_save: ({ input }) => saveHost(input as HostInput),
    host_delete: ({ id }) => void (vault.hosts = vault.hosts.filter((h) => h.id !== id)),
    host_duplicate: ({ id, suffix }) => {
      const copy = { ...structuredClone(hostById(id)), id: newId("h"), created_at: stamp() };
      copy.label = `${copy.label} ${suffix}`;
      vault.hosts = [...vault.hosts, copy];
      return copy;
    },
    host_move: ({ id, groupId }) => {
      const host = hostById(id);
      host.group_id = (groupId as string | null) ?? null;
      return host;
    },
    host_pin: ({ id, pinned }) => {
      const host = hostById(id);
      host.pinned = Boolean(pinned);
      return host;
    },
    host_password: () => "preview-password",
    identity_password: () => "preview-password",
    host_shared_credentials: () => ({ hosts: [], identity: null }),
    host_gather_credentials: ({ id, label }) => {
      const host = hostById(id);
      const identity = {
        id: newId("i"),
        label: String(label),
        username: host.auth.kind === "inline" ? host.auth.username : "root",
        has_password: false,
        key_id: host.auth.kind === "inline" ? host.auth.key_id : null,
        created_at: stamp(),
        updated_at: stamp(),
      };
      vault.identities = [...vault.identities, identity];
      host.auth = { kind: "identity", identity_id: identity.id };
      return identity;
    },
    host_assign_key: ({ hostId, keyId }) => {
      const host = hostById(hostId);
      if (host.auth.kind === "inline") host.auth.key_id = keyId as string;
      return true;
    },

    group_save: ({ input }) => {
      const value = input as GroupInput;
      const group = { id: value.id ?? newId("g"), name: value.name, parent_id: value.parent_id, created_at: stamp(), updated_at: stamp() };
      vault.groups = value.id ? vault.groups.map((g) => (g.id === value.id ? group : g)) : [...vault.groups, group];
      return group;
    },
    group_delete: ({ id }) => {
      vault.groups = vault.groups.filter((g) => g.id !== id);
      vault.hosts.forEach((h) => h.group_id === id && (h.group_id = null));
    },
    snippet_save: ({ input }) => {
      const value = input as SnippetInput;
      const snippet = { ...value, id: value.id ?? newId("s"), created_at: stamp(), updated_at: stamp() };
      vault.snippets = value.id ? vault.snippets.map((s) => (s.id === value.id ? snippet : s)) : [...vault.snippets, snippet];
      return snippet;
    },
    snippet_delete: ({ id }) => void (vault.snippets = vault.snippets.filter((s) => s.id !== id)),
    snippet_targets: ({ id, targets }) => {
      vault.snippets = vault.snippets.map((s) => (s.id === id ? { ...s, targets: targets as string[], updated_at: stamp() } : s));
      return vault.snippets.find((s) => s.id === id);
    },
    identity_save: ({ input }) => {
      const value = input as IdentityInput;
      const old = vault.identities.find((i) => i.id === value.id);
      const identity = {
        id: value.id ?? newId("i"),
        label: value.label,
        username: value.username,
        key_id: value.key_id,
        has_password: value.password.action === "set" || (value.password.action === "keep" && Boolean(old?.has_password)),
        created_at: old?.created_at ?? stamp(),
        updated_at: stamp(),
      };
      vault.identities = old ? vault.identities.map((i) => (i.id === identity.id ? identity : i)) : [...vault.identities, identity];
      return identity;
    },
    identity_delete: ({ id }) => void (vault.identities = vault.identities.filter((i) => i.id !== id)),

    key_generate: ({ kind, label }) => generateKey(kind as KeyKind, String(label)),
    key_import: ({ label }) => ({ ...generateKey("ed25519", String(label) || "imported"), origin: "imported" }),
    key_rename: ({ id, label }) => {
      const key = vault.keys.find((k) => k.id === id)!;
      key.label = String(label);
      return key;
    },
    key_delete: ({ id }) => void (vault.keys = vault.keys.filter((k) => k.id !== id)),
    key_set_sync: ({ id, sync }) => {
      const key = vault.keys.find((k) => k.id === id)!;
      key.sync = Boolean(sync);
      return key;
    },
    // As on a Mac: no applications menu to be put in. ?os=linux plays an AppImage.
    menu_entry_status: () => ({ available: new URLSearchParams(location.search).get("os") === "linux", installed: false }),
    menu_entry_install: () => undefined,
    // Other SSH clients, as if found on this computer.
    import_scan: () => [
      {
        kind: "open_ssh",
        location: "/Users/me/.ssh/config",
        hosts: [
          { label: "web-1", address: "10.0.0.5", port: 22, username: "deploy", folder: [], key_file: "/Users/me/.ssh/deploy_ed25519", password: null, exists: true, key_name: "deploy_ed25519", key_found: true },
          { label: "orb", address: "127.0.0.1", port: 32222, username: "me", folder: [], key_file: "/Users/me/.ssh/id_ed25519", password: null, exists: false, key_name: "id_ed25519", key_found: true },
          { label: "bastion", address: "bastion.example.com", port: 22, username: "ops", folder: [], key_file: "/Users/me/.ssh/ops_rsa", password: null, exists: false, key_name: "ops_rsa", key_found: false },
        ],
      },
      {
        kind: "file_zilla",
        location: "/Users/me/.config/filezilla/sitemanager.xml",
        hosts: [
          { label: "Shop", address: "sftp.shop.example", port: 2222, username: "shop", folder: ["Clients"], key_file: null, password: "x", exists: false, key_name: null, key_found: false },
          { label: "Media", address: "media.example", port: 22, username: "upload", folder: ["Clients"], key_file: null, password: "x", exists: false, key_name: null, key_found: false },
        ],
      },
    ],
    import_file: ({ path }) => ({
      kind: "moba_xterm",
      location: String(path),
      hosts: [
        { label: "prod-api", address: "api.acme.com", port: 22, username: "root", folder: ["Acme", "Prod"], key_file: null, password: null, exists: false, key_name: null, key_found: false },
        { label: "prod-db", address: "db.acme.com", port: 22, username: "root", folder: ["Acme", "Prod"], key_file: null, password: null, exists: false, key_name: null, key_found: false },
        { label: "staging", address: "stage.acme.com", port: 2200, username: "deploy", folder: ["Acme"], key_file: null, password: null, exists: false, key_name: null, key_found: false },
      ],
    }),
    import_apply: ({ hosts }) => {
      const list = hosts as { label: string; address: string; port: number; username: string }[];
      for (const host of list) {
        vault.hosts.push({
          ...vault.hosts[0],
          id: crypto.randomUUID(),
          label: host.label,
          address: host.address,
          port: host.port,
          group_id: null,
          tags: [],
          pinned: false,
          os: null,
          auth: { kind: "inline", username: host.username, has_password: false, key_id: null },
        });
      }
      return { hosts: list.length, groups: 0, keys: 1, keys_skipped: [] };
    },
    // The script as the app builds it (crates/core/src/ssh/install.rs), for a made-up key.
    key_install_script: () =>
      [
        "umask 077",
        'dir="${HOME:?}/.ssh"',
        'file="$dir/authorized_keys"',
        "settle() {",
        '  chmod go-w "$dir" "$file" 2>/dev/null',
        '  if command -v restorecon >/dev/null 2>&1; then restorecon "$dir" "$file" >/dev/null 2>&1; fi',
        "  return 0",
        "}",
        'if [ ! -d "$dir" ]; then',
        '  mkdir -p "$dir" && chmod 700 "$dir" || { echo "cannot create $dir" >&2; exit 2; }',
        "fi",
        'if [ -f "$file" ]; then',
        "  awk -v key='AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKey' '",
        "    /^[[:space:]]*#/ { next }",
        "    { for (i = 2; i <= NF; i++) if ($i == key && $(i - 1) ~ /^(ssh-|ecdsa-|sk-)/) found = 1 }",
        "    END { exit !found }' \"$file\" 2>/dev/null",
        "  case $? in",
        "    0) settle; echo MYSSH_KEY_PRESENT; exit 0 ;;",
        "    1) ;;",
        '    *) echo "cannot read $file" >&2; exit 3 ;;',
        "  esac",
        "fi",
        'if [ -s "$file" ] && [ "$(tail -c 1 "$file" | wc -l)" -eq 0 ]; then',
        "  printf '\\n' >> \"$file\" || { echo \"cannot write $file\" >&2; exit 3; }",
        "fi",
        "printf '%s\\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKey myssh-laptop' >> \"$file\" || { echo \"cannot write $file\" >&2; exit 3; }",
        "settle",
        "echo MYSSH_KEY_ADDED",
      ].join("\n"),
    key_install: ({ events }) => {
      const channel = events as Channel<SessionEvent>;
      void later(600).then(() => {
        channel.onmessage({ type: "key_installed", already_present: false });
        channel.onmessage({ type: "key_verified" });
        channel.onmessage({ type: "closed", reason: "exited", exit_status: 0, error: null });
      });
      return 900;
    },
    known_hosts_list: () => data.knownHosts,
    known_host_forget: () => true,
    settings_save: ({ settings }) => void (vault.settings = settings as Record<string, unknown>),

    ai_suggest: async ({ ask }) => {
      const { line } = ask as { line: string };
      await later(700);
      if (scenario.ai === "off") return fail("cloud", "cloud error: AI suggestions are not available");
      const plan = scenario.account === "pro" ? "pro" : "free";
      if (scenario.ai === "limited") return { suggestions: [], limited_until: Math.floor(Date.now() / 1000) + 3 * 3600, plan };
      return { suggestions: data.aiAnswer(line), plan };
    },

    // bash -n in miniature: an unclosed quote or a block left open.
    script_check: ({ script }) => {
      const text = String(script);
      if ((text.match(/"/g) ?? []).length % 2) return { checked: true, error: "unexpected EOF while looking for matching `\"'", line: 1 };
      const opened = (text.match(/\b(if|do)\b/g) ?? []).length;
      const closed = (text.match(/\b(fi|done)\b/g) ?? []).length;
      if (opened > closed) return { checked: true, error: "syntax error: unexpected end of file", line: text.split("\n").length + 1 };
      return { checked: true, error: null, line: null };
    },
    history_record: () => undefined,
    history_suggest: ({ typed, limit }) =>
      data.history
        .filter((c) => c.startsWith(String(typed)) && c !== typed)
        .slice(0, Number(limit))
        .map((command, i) => ({ command, this_host: i % 2 === 0 })),
    history_frequent: ({ limit }) => data.frequent.slice(0, Number(limit)),
    history_clear: () => undefined,

    cloud_check: () => ({ host: "cloud.myssh.app", online: true, registration_open: true, error: null }),
    cloud_sign_in: async () => {
      await later(500);
      scenario.account = "free";
      saveScenario(scenario);
      vault.cloud = cloudOf();
    },
    cloud_sign_up: async () => {
      await later(500);
      scenario.account = "free";
      saveScenario(scenario);
      vault.cloud = cloudOf();
    },
    cloud_sign_out: () => {
      scenario.account = "none";
      saveScenario(scenario);
      vault.cloud = null;
    },
    cloud_delete_account: () => {
      scenario.account = "none";
      saveScenario(scenario);
      vault.cloud = null;
    },
    cloud_change_email: ({ email }) => {
      if (vault.cloud) vault.cloud.email = String(email);
      return email;
    },
    cloud_sync: async () => {
      await later(300);
      if (scenario.offline) fail("offline", "the cloud server cannot be reached");
      if (scenario.account === "free") fail("pro_required", "sync and shared sessions come with MySSH Pro");
      if (scenario.account === "revoked") fail("device_revoked", "this device was signed out");
      if (vault.cloud) {
        vault.cloud.last_sync_at = Date.now();
        vault.cloud.pending = 0;
      }
      return { pulled: 0, pushed: 0, conflicts: [], pending: 0 };
    },
    cloud_devices: () => data.devices,
    cloud_plan: () =>
      scenario.account === "free" || scenario.account === "pro"
        ? {
            ...data.plans[scenario.account],
            ai: scenario.ai !== "off",
            ai_allowance:
              scenario.ai === "off"
                ? null
                : {
                    left: scenario.ai === "limited" ? 0 : scenario.account === "pro" ? 287 : 14,
                    limit: scenario.account === "pro" ? 300 : 20,
                    window_hours: 5,
                    back_at: Math.floor(Date.now() / 1000) + (scenario.ai === "limited" ? 3 : 2) * 3600,
                  },
          }
        : null,
    cloud_open_account: () => console.info("[preview] the account's subscription page would open in the browser"),
    cloud_revoke_device: () => undefined,
    share_open: () => ({ socket: "ws://127.0.0.1:9/preview", link: "https://cloud.myssh.app/s/preview-room", host: "cloud.myssh.app" }),
    share_join: () => ({ socket: "ws://127.0.0.1:9/preview" }),

    // The local terminal: the pretend shell, as if on this Mac.
    local_terminal: ({ events, output }) =>
      shell.open(
        { ...vault.hosts[0], label: "MacBook", auth: { kind: "inline", username: "you", has_password: false, key_id: null }, os: { id: "macos", family: null, name: "macOS" } },
        events as Channel<SessionEvent>,
        output as Channel<ArrayBuffer>,
        true,
      ),
    session_open: ({ hostId, events, output }) =>
      shell.open(hostById(hostId), events as Channel<SessionEvent>, output as Channel<ArrayBuffer>),
    session_write: ({ id, data: text }) => shell.input(Number(id), String(text)),
    session_reply: ({ id, reply }) => shell.reply(Number(id), reply as never),
    session_cwd: ({ id }) => shell.cwd(Number(id)),
    session_shell: () => "bash",
    // A server ticking over, about 15% busy.
    session_stats: async () => {
      await later(300);
      return data.stats(0);
    },
    // The hosts' tiles: each its own load; one needs signing in, one is away.
    host_stats: async ({ hostId }) => {
      await later(400 + Math.random() * 600);
      const index = vault.hosts.findIndex((h) => h.id === hostId);
      if (index === 2) fail("cancelled", "cancelled");
      if (index === 4) fail("timeout", "connection timed out");
      return data.stats(index);
    },
    session_resize: () => undefined,
    session_ack: () => undefined,
    session_close: ({ id }) => shell.close(Number(id)),
    session_close_all: () => shell.closeAll(),

    sftp_home: () => "/root",
    sftp_resolve: ({ path }) => path,
    sftp_list: async ({ path }) => {
      await later(120);
      return data.listing(String(path));
    },
    sftp_mkdir: ({ dir, name }) => `${dir}/${name}`,
    sftp_rename: ({ path, name }) => `${String(path).replace(/[^/]+$/, "")}${name}`,
    sftp_remove: () => undefined,
    sftp_chmod: () => undefined,
    sftp_version: () => ({ size: 1843, modified: stamp() }),
    sftp_read_text: ({ path }) => ({
      content: data.textFiles[String(path).split("/").pop() ?? ""] ?? "",
      crlf: false,
      version: { size: 1843, modified: stamp() },
    }),
    sftp_write_text: ({ content }) => ({ size: String(content).length, modified: stamp() }),
    sftp_open_external: () => fail("unsupported", "opening in another app is not part of the preview"),
    sftp_download: ({ progress }) => transfer(progress as Channel<TransferProgress>),
    sftp_upload: ({ progress }) => transfer(progress as Channel<TransferProgress>),
    transfer_cancel: () => undefined,
    external_discard: () => undefined,

    local_home: () => "/Users/you",
    local_resolve: ({ path }) => path,
    local_list: ({ path }) => data.listing(String(path)),
    local_mkdir: ({ dir, name }) => `${dir}/${name}`,
    local_rename: ({ path, name }) => `${String(path).replace(/[^/]+$/, "")}${name}`,
    local_trash: () => undefined,
    local_chmod: () => undefined,
    local_stamp: () => null,
    local_open: () => undefined,
    local_write_text: () => undefined,
    open_link: ({ url }) => void window.open(String(url), "_blank"),
    open_network_privacy: () => undefined,

    // Plugins the window uses directly.
    "plugin:clipboard-manager|write_text": ({ text }) => navigator.clipboard?.writeText(String(text)).catch(() => {}),
    "plugin:clipboard-manager|read_text": async () => (await navigator.clipboard?.readText().catch(() => "")) ?? "",
    "plugin:dialog|open": () => null,
    "plugin:dialog|save": () => null,
    "plugin:window|is_maximized": () => false,
    "plugin:window|is_fullscreen": () => false,
  };

  return async (cmd: string, payload?: unknown) => {
    const args = (payload ?? {}) as Args;
    const command = commands[cmd];
    if (command) return command(args);
    // Everything else the window asks of the system (minimise, close…) does nothing here.
    if (!cmd.startsWith("plugin:")) console.warn(`[preview] no stand-in for "${cmd}"`, args);
    return null;
  };
}
