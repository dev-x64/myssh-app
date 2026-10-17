// Made-up contents for the interface preview: a vault that looks lived in,
// devices, known hosts and files. Nothing here is real.

import type {
  CloudDevice,
  CloudPlan,
  FileEntry,
  FrequentCommand,
  Group,
  HostView,
  IdentityView,
  KeyView,
  KnownHost,
  Snapshot,
  Snippet,
} from "../lib/api";

const now = Math.floor(Date.now() / 1000);
const day = 86400;

const groups: Group[] = [
  { id: "g-prod", name: "Production", parent_id: null, created_at: now - 90 * day, updated_at: now - 9 * day },
  { id: "g-stage", name: "Staging", parent_id: null, created_at: now - 80 * day, updated_at: now - 20 * day },
  { id: "g-home", name: "Home lab", parent_id: null, created_at: now - 60 * day, updated_at: now - 3 * day },
];

const keys: KeyView[] = [
  {
    id: "k-main",
    label: "MacBook",
    algorithm: "ssh-ed25519",
    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewPreviewPreviewPreviewPreviewPrev1",
    fingerprint: "SHA256:3bR0f7Yp2kq9LwB8m1Zc4uXv6nT5sQe0aHjKdPiGo2E",
    encrypted: false,
    has_passphrase: false,
    origin: "generated",
    sync: true,
    created_at: now - 120 * day,
    updated_at: now - 120 * day,
  },
  {
    id: "k-deploy",
    label: "deploy (CI)",
    algorithm: "ecdsa-sha2-nistp256",
    public_key: "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYPreview2",
    fingerprint: "SHA256:Qm8vT1cN4xP0sLkE7rB2yH6uW9aZ3dF5gJiOtYeR1cU",
    encrypted: true,
    has_passphrase: true,
    origin: "imported",
    sync: false,
    created_at: now - 40 * day,
    updated_at: now - 12 * day,
  },
];

const identities: IdentityView[] = [
  {
    id: "i-ops",
    label: "ops",
    username: "ops",
    has_password: false,
    key_id: "k-main",
    created_at: now - 70 * day,
    updated_at: now - 7 * day,
  },
];

function host(
  id: string,
  label: string,
  address: string,
  group: string | null,
  os: HostView["os"],
  extra: Partial<HostView> = {},
): HostView {
  return {
    id,
    label,
    address,
    port: 22,
    group_id: group,
    tags: [],
    auth: { kind: "inline", username: "root", has_password: false, key_id: "k-main" },
    startup_snippet_id: null,
    os,
    pinned: false,
    forwards: [],
    agent_forwarding: false,
    created_at: now - 50 * day,
    updated_at: now - 2 * day,
    ...extra,
  };
}

const ubuntu = { id: "ubuntu", family: "debian", name: "Ubuntu 24.04.1 LTS" };
const debian = { id: "debian", family: null, name: "Debian GNU/Linux 12 (bookworm)" };
const alpine = { id: "alpine", family: null, name: "Alpine Linux v3.20" };
const rocky = { id: "rocky", family: "rhel", name: "Rocky Linux 9.4 (Blue Onyx)" };

const hosts: HostView[] = [
  host("h-web1", "web-1", "203.0.113.10", "g-prod", ubuntu, {
    pinned: true,
    tags: ["nginx", "eu"],
    forwards: [
      { id: "f-grafana", label: "Grafana", local_port: 3000, remote_host: "localhost", remote_port: 3000, auto: true },
      { id: "f-redis", label: "", local_port: 6379, remote_host: "10.0.0.7", remote_port: 6379, auto: false },
    ],
  }),
  host("h-web2", "web-2", "203.0.113.11", "g-prod", ubuntu, { tags: ["nginx", "eu"] }),
  host("h-db", "db-primary", "203.0.113.20", "g-prod", debian, {
    auth: { kind: "identity", identity_id: "i-ops" },
    tags: ["postgres"],
    forwards: [{ id: "f-pg", label: "Postgres", local_port: 5432, remote_host: "localhost", remote_port: 5432, auto: true }],
  }),
  host("h-stage", "staging", "stage.example.com", "g-stage", rocky, { port: 2222 }),
  host("h-pi", "raspberry", "192.168.1.40", "g-home", alpine, {
    auth: { kind: "inline", username: "pi", has_password: true, key_id: null },
  }),
  host("h-nas", "nas", "192.168.1.5", "g-home", null),
  host("h-vps", "vps.example.org", "vps.example.org", null, debian),
];

const snippets: Snippet[] = [
  {
    id: "s-disk",
    name: "Disk usage",
    description: "Biggest folders under the current one",
    script: "du -h --max-depth=1 | sort -rh | head -20",
    package: "Diagnostics",
    created_at: now - 30 * day,
    updated_at: now - 30 * day,
  },
  {
    id: "s-logs",
    name: "Follow nginx errors",
    description: "",
    script: "sudo tail -f /var/log/nginx/error.log",
    package: "Diagnostics",
    created_at: now - 20 * day,
    updated_at: now - 4 * day,
  },
  {
    id: "s-update",
    name: "Update packages",
    description: "apt update and upgrade",
    script: "sudo apt update && sudo apt -y upgrade",
    package: "",
    created_at: now - 10 * day,
    updated_at: now - 10 * day,
  },
];

export function snapshot(cloud: Snapshot["cloud"], empty: boolean): Snapshot {
  if (empty) return { hosts: [], groups: [], identities: [], keys: [], snippets: [], settings: null, cloud };
  return {
    hosts: structuredClone(hosts),
    groups: structuredClone(groups),
    identities: structuredClone(identities),
    keys: structuredClone(keys),
    snippets: structuredClone(snippets),
    settings: null,
    cloud,
  };
}

export const EMAIL = "you@example.com";

export const plans: Record<"free" | "pro", CloudPlan> = {
  free: { plan: "free", state: "free", period: null, ends_at: null, ai: true },
  pro: { plan: "pro", state: "active", period: "year", ends_at: now + 300 * day, ai: true },
};

export const devices: CloudDevice[] = [
  {
    id: "d-this",
    name: "MacBook Air",
    platform: "macos",
    created_at: now - 60 * day,
    last_seen_at: now - 30,
    current: true,
  },
  {
    id: "d-work",
    name: "WORKSTATION",
    platform: "windows",
    created_at: now - 20 * day,
    last_seen_at: now - 2 * 3600,
    current: false,
  },
];

export const knownHosts: KnownHost[] = hosts.slice(0, 5).map((h, i) => ({
  host: h.address,
  port: h.port,
  algorithm: "ssh-ed25519",
  public_key: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKnown${i}KnownKnownKnownKnownKnown`,
  fingerprint: `SHA256:Kn0wn${i}xP0sLkE7rB2yH6uW9aZ3dF5gJiOtYeR1cU`,
  added_at: now - (40 - i * 5) * day,
}));

export const frequent: FrequentCommand[] = [
  { command: "docker compose ps", count: 41, hosts: 3, last_used: now - 3600 },
  { command: "systemctl status nginx", count: 27, hosts: 2, last_used: now - 5 * 3600 },
  { command: "journalctl -u app -n 200 -f", count: 19, hosts: 1, last_used: now - day },
];

export const history = [
  "docker compose ps",
  "docker compose logs -f --tail=100",
  "systemctl status nginx",
  "sudo systemctl reload nginx",
  "df -h",
  "htop",
];

function entry(dir: string, name: string, kind: FileEntry["kind"], size: number, ageDays: number, mode: number): FileEntry {
  return {
    name,
    path: `${dir === "/" ? "" : dir}/${name}`,
    kind,
    is_dir: kind === "dir",
    size,
    modified: now - Math.round(ageDays * day),
    permissions: mode,
    target: null,
  };
}

/** A small file tree, the same for the server and for this computer. */
export function listing(dir: string): FileEntry[] {
  const depth = dir.split("/").filter(Boolean).length;
  if (depth > 4) return [];
  return [
    entry(dir, "app", "dir", 0, 2, 0o40755),
    entry(dir, "backups", "dir", 0, 14, 0o40750),
    entry(dir, "logs", "dir", 0, 0.1, 0o40755),
    entry(dir, ".env", "file", 412, 30, 0o100600),
    entry(dir, "docker-compose.yml", "file", 1843, 6, 0o100644),
    entry(dir, "README.md", "file", 5210, 45, 0o100644),
    entry(dir, "deploy.sh", "file", 977, 9, 0o100755),
    entry(dir, "dump-2026-10-01.sql.gz", "file", 48_211_337, 14, 0o100640),
  ];
}

export const textFiles: Record<string, string> = {
  "docker-compose.yml":
    'services:\n  app:\n    image: ghcr.io/example/app:latest\n    restart: unless-stopped\n    env_file: .env\n    ports:\n      - "127.0.0.1:8080:8080"\n',
  "deploy.sh": "#!/bin/sh\nset -e\ngit pull\ndocker compose pull\ndocker compose up -d\n",
  "README.md": "# app\n\nDeployed with `deploy.sh`.\n",
  ".env": "DATABASE_URL=postgres://app@db/app\nLOG_LEVEL=info\n",
};

/** What the pretend AI says about a line: a request in words, or a command begun. */
export function aiAnswer(line: string): { command: string; explanation: string; danger: boolean }[] {
  const ru = /[а-яё]/i.test(line);
  if (/больш|big|large/i.test(line)) {
    return [
      { command: "du -ah . | sort -rh | head -n 20", explanation: ru ? "20 самых больших файлов и папок здесь" : "The 20 biggest files and folders here", danger: false },
      { command: "find . -type f -size +100M -exec ls -lh {} +", explanation: ru ? "Файлы больше 100 МБ" : "Files over 100 MB", danger: false },
    ];
  }
  if (/nginx|перезапус|restart/i.test(line)) {
    return [
      { command: "sudo systemctl restart nginx", explanation: ru ? "Перезапустить nginx" : "Restart nginx", danger: true },
      { command: "sudo nginx -t && sudo systemctl reload nginx", explanation: ru ? "Проверить настройки и перечитать без остановки" : "Check the config, then reload without stopping", danger: false },
    ];
  }
  if (line.startsWith("docker")) {
    return [{ command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'", explanation: ru ? "Контейнеры: имя, состояние, порты" : "Containers: name, state, ports", danger: false }];
  }
  return [];
}

/** How busy the pretend servers are: each its own, with one nearly out of disk. */
export function stats(index: number) {
  const tick = Date.now() / 1000;
  const cpu = [12, 46, 3, 88, 21, 7, 64][index % 7] + 4 * Math.sin(tick / 9 + index);
  const memTotal = [8, 16, 4, 32, 8, 2, 16][index % 7] * 1024 ** 3;
  const memUsed = [0.31, 0.62, 0.18, 0.84, 0.4, 0.55, 0.93][index % 7];
  const diskTotal = [78, 160, 40, 480, 78, 20, 240][index % 7] * 1024 ** 3;
  const diskUsed = [0.6, 0.35, 0.95, 0.5, 0.2, 0.7, 0.41][index % 7];
  return {
    cpu_percent: Math.max(0, Math.min(100, cpu)),
    cores: [4, 8, 2, 16, 4, 1, 8][index % 7],
    mem_total: memTotal,
    mem_available: memTotal * (1 - memUsed),
    disk_total: diskTotal,
    disk_free: diskTotal * (1 - diskUsed),
    uptime_secs: [41, 3, 120, 0.2, 9, 300, 17][index % 7] * 86400,
    load1: 0.08,
  };
}
