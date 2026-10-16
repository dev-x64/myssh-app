// Typed bridge to the Rust core. Secrets only ever travel towards the core.

import { Channel, invoke } from "@tauri-apps/api/core";

export type Id = string;

export interface ApiError {
  code: string;
  /** English description, for logs and as a last resort. */
  message: string;
  /** The underlying cause from the system or SSH library, if any. */
  detail: string | null;
}

export function asApiError(e: unknown): ApiError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    return e as ApiError;
  }
  const text = typeof e === "string" ? e : String(e);
  return { code: "unknown", message: text, detail: text };
}

export type HostAuthView =
  | { kind: "inline"; username: string; has_password: boolean; key_id: Id | null }
  | { kind: "identity"; identity_id: Id };

export interface HostOs {
  /** `ubuntu`, `debian`, `alpine`, `macos`… */
  id: string;
  /** What it is derived from, when it says so. */
  family: string | null;
  /** Human name with version. */
  name: string;
}

/** How busy a server is, as it said; what it did not say is null. */
export interface ServerStats {
  /** How busy the processor was over a second, all cores together, 0–100. */
  cpu_percent: number | null;
  cores: number | null;
  mem_total: number | null;
  mem_available: number | null;
  disk_total: number | null;
  disk_free: number | null;
  uptime_secs: number | null;
  load1: number | null;
}

/** What is on a command line and around it, secrets taken out, for AI suggestions. */
export interface AiAsk {
  line: string;
  os: string;
  shell: string;
  cwd: string;
  user: string;
  context: string;
  locale: string;
}

export interface AiSuggestion {
  command: string;
  explanation: string;
  danger: boolean;
}

export interface AiAnswer {
  suggestions: AiSuggestion[];
  /** Unix seconds: the plan's allowance is used up until then. */
  limited_until?: number | null;
  plan?: "free" | "pro" | null;
}

export interface HostView {
  id: Id;
  label: string;
  address: string;
  port: number;
  group_id: Id | null;
  tags: string[];
  auth: HostAuthView;
  startup_snippet_id: Id | null;
  /** The server's operating system, as last seen on connecting. */
  os: HostOs | null;
  /** Shown before the others in its list. */
  pinned: boolean;
  created_at: number;
  updated_at: number;
}

/** The other SSH clients hosts can be imported from. */
export type ImportKind = "open_ssh" | "moba_xterm" | "putty" | "win_scp" | "file_zilla";

/** A host found in another app. */
export interface FoundHost {
  label: string;
  address: string;
  port: number;
  username: string;
  /** The folders it sits in there, outermost first. */
  folder: string[];
  key_file: string | null;
  password: string | null;
}

export interface ImportCandidate extends FoundHost {
  /** A host with the same address, port and user is saved already. */
  exists: boolean;
  key_name: string | null;
  /** The key file is on this computer and can be read. */
  key_found: boolean;
}

export interface ImportSource {
  kind: ImportKind;
  /** A file, or the Windows registry. */
  location: string;
  hosts: ImportCandidate[];
}

export interface ImportReport {
  hosts: number;
  groups: number;
  keys: number;
  /** Key files that could not be taken. */
  keys_skipped: string[];
}

/** On Linux, run as an AppImage: whether the app can be, and is, in the applications menu. */
export interface MenuEntryStatus {
  available: boolean;
  installed: boolean;
}

export interface Group {
  id: Id;
  name: string;
  parent_id: Id | null;
  created_at: number;
  updated_at: number;
}

export interface IdentityView {
  id: Id;
  label: string;
  username: string;
  has_password: boolean;
  key_id: Id | null;
  created_at: number;
  updated_at: number;
}

export interface KeyView {
  id: Id;
  label: string;
  algorithm: string;
  public_key: string;
  fingerprint: string;
  encrypted: boolean;
  has_passphrase: boolean;
  origin: "generated" | "imported";
  /** The user allowed this key into the cloud; otherwise it is device-only. */
  sync: boolean;
  created_at: number;
  updated_at: number;
}

export interface Snippet {
  id: Id;
  name: string;
  description: string;
  script: string;
  /** Free-form group name; empty means ungrouped. */
  package: string;
  /** The hosts it is run on together, when remembered. */
  targets?: Id[];
  created_at: number;
  updated_at: number;
}

export interface SnippetInput {
  id: Id | null;
  name: string;
  description: string;
  script: string;
  package: string;
}

export interface Snapshot {
  hosts: HostView[];
  groups: Group[];
  identities: IdentityView[];
  keys: KeyView[];
  snippets: Snippet[];
  /** Preferences that sync between devices; `null` until first saved. */
  settings: Record<string, unknown> | null;
  cloud: CloudView | null;
}

/** Cloud sign-in state of this device. */
export interface CloudView {
  server: string;
  email: string;
  device_id: string;
  last_sync_at: number | null;
  /** The server no longer accepts this device. */
  revoked: boolean;
  /** Local changes not yet sent. */
  pending: number;
}

/** Result of asking the cloud server whether it is there. */
export interface CloudCheck {
  host: string;
  online: boolean;
  /** New accounts can be created. */
  registration_open: boolean;
  error: ApiError | null;
}

/** What the cloud account is on. */
export interface CloudPlan {
  plan: "free" | "pro";
  /** `ending`: cancelled, runs to its end. `gift`: given until a date. */
  state: "free" | "active" | "ending" | "past_due" | "gift";
  period: "month" | "year" | null;
  /** Seconds since the Unix epoch. */
  ends_at: number | null;
  /** AI suggestions are on for this account, as the server's owner has them. */
  ai: boolean;
  /** What is left of the account's AI asks, while they are on for it. */
  ai_allowance?: AiAllowance | null;
}

export interface AiAllowance {
  left: number;
  limit: number;
  window_hours: number;
  /** When the next ask comes back, Unix seconds; null when none is used. */
  back_at: number | null;
}

export interface CloudDevice {
  id: string;
  name: string;
  platform: string;
  /** Seconds since the Unix epoch. */
  created_at: number;
  last_seen_at: number;
  current: boolean;
}

export type Resolution = "kept_both" | "kept_edited" | "restored" | "replaced";

/** A decision sync took where two devices had changed the same item. */
export interface ConflictNote {
  resolution: Resolution;
  item: "host" | "group" | "identity" | "key" | "snippet" | "settings";
  name: string;
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  conflicts: ConflictNote[];
  pending: number;
}

/** How a form treats a stored secret it cannot read back. */
export type SecretInput =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "set"; value: string };

export type HostAuthInput =
  | { kind: "inline"; username: string; password: SecretInput; key_id: Id | null }
  | { kind: "identity"; identity_id: Id };

export interface HostInput {
  id: Id | null;
  label: string;
  address: string;
  port: number | null;
  group_id: Id | null;
  tags: string[];
  auth: HostAuthInput;
  startup_snippet_id: Id | null;
}

export interface GroupInput {
  id: Id | null;
  name: string;
  parent_id: Id | null;
}

export interface IdentityInput {
  id: Id | null;
  label: string;
  username: string;
  password: SecretInput;
  key_id: Id | null;
}

export type KeyKind = "ed25519" | "ecdsa_p256" | "ecdsa_p384" | "rsa4096";

export interface KnownHost {
  host: string;
  port: number;
  algorithm: string;
  public_key: string;
  fingerprint: string;
  added_at: number;
}

export interface AppStatus {
  version: string;
  data_dir: string;
  debug: boolean;
  vault_error: ApiError | null;
  /** This build has a cloud server to talk to. */
  cloud_available: boolean;
  /** This build updates itself, rather than being updated by a store. */
  updates: boolean;
}

/** Where to connect as the host of a shared terminal, and the link for guests. */
export interface ShareInvite {
  socket: string;
  link: string;
  host: string;
}

export type DiskEncryption = "on" | "off" | "unknown";

/** Who else holds the credentials a host keeps for itself. */
export interface SharedCredentials {
  /** Other hosts that keep the very same ones, each for itself. */
  hosts: Id[];
  /** An identity that already holds them. */
  identity: Id | null;
}

/** A newer version of the app that can be installed. */
export interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
  date: string | null;
  /** The way back from a version that was withdrawn, not a newer one. */
  rollback: boolean;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

/** A command run often enough to be worth keeping as a snippet. */
export interface FrequentCommand {
  command: string;
  count: number;
  hosts: number;
  last_used: number;
}

export type Stage =
  | "connecting"
  | "handshake"
  | "authenticating"
  | "opening_shell"
  | "installing_key"
  | "verifying_key";
export type CloseReason = "exited" | "user" | "failed" | "lost";

export interface KnownKeyInfo {
  algorithm: string;
  fingerprint: string;
  added_at: number;
}

export type Prompt =
  | {
      kind: "host_key";
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
      known: KnownKeyInfo[];
    }
  | { kind: "username" }
  | { kind: "password"; username: string; attempt: number }
  | { kind: "key_passphrase"; key_label: string; attempt: number }
  | {
      kind: "keyboard_interactive";
      name: string;
      instructions: string;
      prompts: { prompt: string; echo: boolean }[];
    };

export type PromptReply =
  | { kind: "cancel" }
  | { kind: "accept" }
  | { kind: "text"; value: string; remember: boolean }
  | { kind: "answers"; values: string[] };

export type SessionEvent =
  | { type: "stage"; stage: Stage }
  | { type: "prompt"; id: number; prompt: Prompt }
  | { type: "banner"; text: string }
  | { type: "connected" }
  | { type: "key_installed"; already_present: boolean }
  | { type: "key_verified" }
  | { type: "log"; entry: LogEntry }
  | { type: "closed"; reason: CloseReason; exit_status: number | null; error: ApiError | null };

/** One step of a connection attempt, as the core reports it. */
export type LogEntry =
  | { code: "connecting"; host: string; port: number }
  | { code: "reached"; address: string }
  | { code: "host_key"; algorithm: string; fingerprint: string; status: "trusted" | "new" | "changed" }
  | { code: "host_key_accepted" }
  | { code: "auth_offered"; methods: string[] }
  | { code: "auth_not_required" }
  | { code: "auth_unavailable"; method: string }
  | { code: "auth_trying"; method: string; detail: string | null; saved: boolean }
  | { code: "auth_accepted"; method: string }
  | { code: "auth_rejected"; method: string; partial: boolean; remaining: string[] }
  | { code: "waiting"; what: "host_key" | "username" | "password" | "passphrase" | "answers" }
  | { code: "shell_opening" }
  | { code: "shell_ready" };

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  /** A directory, or a symlink leading to one. */
  is_dir: boolean;
  size: number;
  /** Seconds since the Unix epoch. */
  modified: number | null;
  permissions: number | null;
  /** For a symlink: where it points. */
  target: string | null;
}

/** What a remote file looked like when it was read. */
/** What a local file looks like at one moment. */
export interface LocalStamp {
  size: number;
  modified_ms: number;
}

/** The working copy of a remote file opened in another app. */
export interface ExternalCopy {
  local: string;
  dir: string;
  version: FileVersion;
  stamp: LocalStamp;
}

export interface FileVersion {
  size: number;
  modified: number | null;
}

export interface TextFile {
  content: string;
  crlf: boolean;
  version: FileVersion;
}

export interface TransferProgress {
  done: number;
  total: number;
}

export interface TransferSummary {
  files: number;
  bytes: number;
  /** Links and special files inside a folder that were not copied. */
  skipped: number;
}

export const api = {
  appStatus: () => invoke<AppStatus>("app_status"),
  /** Tries again to open a vault that could not be opened. */
  vaultRetry: () => invoke<AppStatus>("vault_retry"),
  /** Starts an empty vault in place of an unreadable one; the old files go to the Trash. */
  vaultReplace: () => invoke<void>("vault_replace"),
  diskEncryption: () => invoke<DiskEncryption>("disk_encryption"),
  /** `null`: this is the latest version, or this build does not update itself. */
  updateCheck: () => invoke<UpdateInfo | null>("update_check"),
  /** Downloads and installs the newest version; the app keeps running until restarted. */
  updateInstall: (onProgress: (progress: UpdateProgress) => void) => {
    const progress = new Channel<UpdateProgress>();
    progress.onmessage = onProgress;
    return invoke<void>("update_install", { progress });
  },
  updateRestart: () => invoke<void>("update_restart"),
  snapshot: () => invoke<Snapshot>("vault_snapshot"),

  hostSave: (input: HostInput) => invoke<HostView>("host_save", { input }),
  /** Who else holds the credentials a host keeps for itself. */
  hostSharedCredentials: (id: Id) => invoke<SharedCredentials>("host_shared_credentials", { id }),
  /** Gathers the credentials a host shares with others into one identity. */
  hostGatherCredentials: (id: Id, label: string) =>
    invoke<IdentityView>("host_gather_credentials", { id, label }),
  /** A saved password, for the user who asked to see it. */
  hostPassword: (id: Id) => invoke<string | null>("host_password", { id }),
  identityPassword: (id: Id) => invoke<string | null>("identity_password", { id }),
  hostDelete: (id: Id) => invoke<void>("host_delete", { id }),
  hostDuplicate: (id: Id, suffix: string) => invoke<HostView>("host_duplicate", { id, suffix }),
  hostMove: (id: Id, groupId: Id | null) => invoke<HostView>("host_move", { id, groupId }),
  hostPin: (id: Id, pinned: boolean) => invoke<HostView>("host_pin", { id, pinned }),
  groupSave: (input: GroupInput) => invoke<Group>("group_save", { input }),
  groupDelete: (id: Id) => invoke<void>("group_delete", { id }),

  snippetSave: (input: SnippetInput) => invoke<Snippet>("snippet_save", { input }),
  /** Remembers the hosts a snippet is run on together; an empty list forgets them. */
  snippetTargets: (id: Id, targets: Id[]) => invoke<Snippet>("snippet_targets", { id, targets }),
  snippetDelete: (id: Id) => invoke<void>("snippet_delete", { id }),

  identitySave: (input: IdentityInput) => invoke<IdentityView>("identity_save", { input }),
  identityDelete: (id: Id) => invoke<void>("identity_delete", { id }),
  keyGenerate: (kind: KeyKind, label: string) => invoke<KeyView>("key_generate", { kind, label }),
  keyImport: (text: string, passphrase: string | null, savePassphrase: boolean, label: string) =>
    invoke<KeyView>("key_import", { text, passphrase, savePassphrase, label }),
  keyRename: (id: Id, label: string) => invoke<KeyView>("key_rename", { id, label }),
  keyDelete: (id: Id) => invoke<void>("key_delete", { id }),
  /** Starts installing a key on a host; progress arrives as session events. */
  keyInstallScript: (keyId: Id) => invoke<string>("key_install_script", { keyId }),
  keyInstall: (keyId: Id, hostId: Id, events: Channel<SessionEvent>) =>
    invoke<number>("key_install", { keyId, hostId, events }),
  hostAssignKey: (hostId: Id, keyId: Id) => invoke<boolean>("host_assign_key", { hostId, keyId }),

  /** Other SSH clients' hosts found on this computer. */
  importScan: () => invoke<ImportSource[]>("import_scan"),
  /** The hosts in a file chosen by hand: an export, an ini file, an ssh config. */
  importFile: (path: string) => invoke<ImportSource>("import_file", { path }),
  importApply: (hosts: FoundHost[]) => invoke<ImportReport>("import_apply", { hosts }),
  menuEntryStatus: () => invoke<MenuEntryStatus>("menu_entry_status"),
  menuEntryInstall: () => invoke<void>("menu_entry_install"),

  historyRecord: (hostId: Id, command: string) => invoke<void>("history_record", { hostId, command }),
  historySuggest: (hostId: Id, typed: string, limit: number) =>
    invoke<{ command: string; this_host: boolean }[]>("history_suggest", { hostId, typed, limit }),
  historyFrequent: (limit: number) => invoke<FrequentCommand[]>("history_frequent", { limit }),
  historyClear: (hostId: Id | null) => invoke<void>("history_clear", { hostId }),

  cloudCheck: () => invoke<CloudCheck>("cloud_check"),
  cloudSignUp: (email: string, password: string) => invoke<void>("cloud_sign_up", { email, password }),
  cloudSignIn: (email: string, password: string) => invoke<void>("cloud_sign_in", { email, password }),
  cloudSignOut: () => invoke<void>("cloud_sign_out"),
  /** Deletes the account and all the server keeps for it; local data stays. */
  cloudDeleteAccount: (password: string) => invoke<void>("cloud_delete_account", { password }),
  /** Changes the e-mail the account signs in with; returns it as stored. */
  cloudChangeEmail: (password: string, email: string) => invoke<string>("cloud_change_email", { password, email }),
  cloudSync: (copySuffix: string) => invoke<SyncReport>("cloud_sync", { copySuffix }),
  cloudDevices: () => invoke<CloudDevice[]>("cloud_devices"),
  /** `null` from a server that knows no plans. */
  cloudPlan: () => invoke<CloudPlan | null>("cloud_plan"),
  /** Opens the account's pages (profile, subscription) in the browser, signed in. */
  cloudOpenAccount: (language: string) => invoke<void>("cloud_open_account", { language }),
  /** Reserves a room for sharing a terminal with people invited by link. */
  shareOpen: () => invoke<ShareInvite>("share_open"),
  aiSuggest: (ask: AiAsk) => invoke<AiAnswer>("ai_suggest", { ask }),
  /** Where to connect to join the shared terminal of an invitation. */
  shareJoin: (room: string) => invoke<{ socket: string }>("share_join", { room }),
  /** Links the app was opened with since the last call. */
  linksTake: () => invoke<string[]>("links_take"),
  cloudRevokeDevice: (deviceId: string) => invoke<void>("cloud_revoke_device", { deviceId }),
  keySetSync: (id: Id, sync: boolean) => invoke<KeyView>("key_set_sync", { id, sync }),
  settingsSave: (settings: Record<string, unknown>) => invoke<void>("settings_save", { settings }),

  knownHosts: () => invoke<KnownHost[]>("known_hosts_list"),
  knownHostForget: (host: string, port: number) =>
    invoke<boolean>("known_host_forget", { host, port }),

  /** A terminal on this computer; it answers on the channels as a session does. */
  localTerminal: (cols: number, rows: number, events: Channel<SessionEvent>, output: Channel<ArrayBuffer>) =>
    invoke<number>("local_terminal", { cols, rows, events, output }),
  sessionOpen: (
    hostId: Id,
    cols: number,
    rows: number,
    runStartup: boolean,
    events: Channel<SessionEvent>,
    output: Channel<ArrayBuffer>,
  ) => invoke<number>("session_open", { hostId, cols, rows, runStartup, events, output }),
  sessionCwd: (id: number) => invoke<string | null>("session_cwd", { id }),
  sessionShell: (id: number) => invoke<string | null>("session_shell", { id }),
  sessionStats: (id: number) => invoke<ServerStats>("session_stats", { id }),
  /** A quiet look at a host for its tile: connects with what is saved, asks nothing. */
  hostStats: (hostId: Id) => invoke<ServerStats>("host_stats", { hostId }),
  sessionWrite: (id: number, data: string) => invoke<void>("session_write", { id, data }),
  sessionResize: (id: number, cols: number, rows: number) =>
    invoke<void>("session_resize", { id, cols, rows }),
  sessionReply: (id: number, promptId: number, reply: PromptReply) =>
    invoke<void>("session_reply", { id, promptId, reply }),
  sessionAck: (id: number, bytes: number) => invoke<void>("session_ack", { id, bytes }),
  sessionClose: (id: number) => invoke<void>("session_close", { id }),
  sessionCloseAll: () => invoke<void>("session_close_all"),

  // Remote files; `id` is the terminal session whose connection is used.
  sftpHome: (id: number) => invoke<string>("sftp_home", { id }),
  sftpResolve: (id: number, path: string) => invoke<string>("sftp_resolve", { id, path }),
  sftpList: (id: number, path: string) => invoke<FileEntry[]>("sftp_list", { id, path }),
  sftpMkdir: (id: number, dir: string, name: string) => invoke<string>("sftp_mkdir", { id, dir, name }),
  sftpRename: (id: number, path: string, name: string) =>
    invoke<string>("sftp_rename", { id, path, name }),
  sftpRemove: (id: number, path: string) => invoke<void>("sftp_remove", { id, path }),
  /** Sets the permission bits, as `chmod` does. */
  sftpChmod: (id: number, path: string, mode: number) => invoke<void>("sftp_chmod", { id, path, mode }),
  sftpVersion: (id: number, path: string) => invoke<FileVersion>("sftp_version", { id, path }),
  /** Fetches a remote file into a working copy and opens it in another app. */
  sftpOpenExternal: (id: number, path: string, app: string | null) =>
    invoke<ExternalCopy>("sftp_open_external", { id, path, app }),
  externalDiscard: (dir: string) => invoke<void>("external_discard", { dir }),
  localChmod: (path: string, mode: number) => invoke<void>("local_chmod", { path, mode }),
  /** `null` once the file is gone. */
  localStamp: (path: string) => invoke<LocalStamp | null>("local_stamp", { path }),
  /** Opens a local file in the app the system uses for it, or in the one given. */
  localOpen: (path: string, app: string | null) => invoke<void>("local_open", { path, app }),
  /** Opens a web address in the default browser. */
  openLink: (url: string) => invoke<void>("open_link", { url }),
  openNetworkPrivacy: () => invoke<void>("open_network_privacy"),
  sftpReadText: (id: number, path: string) => invoke<TextFile>("sftp_read_text", { id, path }),
  sftpWriteText: (
    id: number,
    path: string,
    content: string,
    crlf: boolean,
    expected: FileVersion | null,
  ) => invoke<FileVersion>("sftp_write_text", { id, path, content, crlf, expected }),
  sftpDownload: (
    id: number,
    remote: string,
    localDir: string,
    overwrite: boolean,
    transfer: number,
    progress: Channel<TransferProgress>,
    /** A folder goes as one tar stream, where the server has tar. */
    archive = false,
  ) =>
    invoke<TransferSummary>("sftp_download", { id, remote, localDir, overwrite, transfer, progress, archive }),
  sftpUpload: (
    id: number,
    local: string,
    remoteDir: string,
    overwrite: boolean,
    transfer: number,
    progress: Channel<TransferProgress>,
    /** A folder goes as one tar stream, where the server has tar. */
    archive = false,
  ) => invoke<TransferSummary>("sftp_upload", { id, local, remoteDir, overwrite, transfer, progress, archive }),
  transferCancel: (transfer: number) => invoke<void>("transfer_cancel", { transfer }),
  localWriteText: (path: string, content: string) => invoke<void>("local_write_text", { path, content }),

  // Files on this computer.
  localHome: () => invoke<string>("local_home"),
  localResolve: (path: string) => invoke<string>("local_resolve", { path }),
  localList: (path: string) => invoke<FileEntry[]>("local_list", { path }),
  localMkdir: (dir: string, name: string) => invoke<string>("local_mkdir", { dir, name }),
  localRename: (path: string, name: string) => invoke<string>("local_rename", { path, name }),
  localTrash: (paths: string[]) => invoke<void>("local_trash", { paths }),
};
