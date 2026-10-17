// The state of things the preview pretends: signed in or not, Free or Pro,
// an update waiting, Windows or the Mac. Kept in the browser between
// reloads; the page's address can set any of it (?account=pro&os=windows),
// which is how a picture of one state is taken without clicking.

export interface Scenario {
  /** none: signed out. revoked: this device was signed out from another. */
  account: "none" | "free" | "pro" | "revoked";
  /** The build has a cloud server. */
  cloud: boolean;
  /** No hosts, keys or snippets yet. */
  empty: boolean;
  update: "none" | "available" | "rollback";
  /** The vault cannot be opened. */
  vaultError: boolean;
  /** The cloud server cannot be reached. */
  offline: boolean;
  os: "mac" | "windows" | "linux";
  /** The preview's own panel is shown. */
  panel: boolean;
  /** AI suggestions: answering, used up, or switched off on the server. */
  ai: "on" | "limited" | "off";
  /** Forwarded ports: they work, the port here is taken, or nothing answers on the server's side. */
  forwards: "ok" | "busy" | "refused";
  /** Other apps on this computer hold hosts to import (the setup offers them), or none. */
  found: boolean;
}

const KEY = "myssh.preview";

const DEFAULTS: Scenario = {
  account: "pro",
  cloud: true,
  empty: false,
  update: "none",
  vaultError: false,
  offline: false,
  os: "mac",
  panel: true,
  ai: "on",
  forwards: "ok",
  found: true,
};

export const CHOICES: { [K in keyof Scenario]: Scenario[K][] } = {
  account: ["none", "free", "pro", "revoked"],
  cloud: [true, false],
  empty: [false, true],
  update: ["none", "available", "rollback"],
  vaultError: [false, true],
  offline: [false, true],
  os: ["mac", "windows", "linux"],
  panel: [true, false],
  ai: ["on", "limited", "off"],
  forwards: ["ok", "busy", "refused"],
  found: [true, false],
};

function parse<K extends keyof Scenario>(key: K, text: string): Scenario[K] | undefined {
  return CHOICES[key].find((choice) => String(choice) === text);
}

export function loadScenario(): Scenario {
  let stored: Partial<Scenario> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    // A broken entry is as good as none.
  }
  const scenario = { ...DEFAULTS, ...stored };
  const params = new URLSearchParams(location.search);
  for (const key of Object.keys(DEFAULTS) as (keyof Scenario)[]) {
    const value = params.get(key);
    const parsed = value === null ? undefined : parse(key, value);
    if (parsed !== undefined) (scenario as Record<string, unknown>)[key] = parsed;
  }
  return scenario;
}

export function saveScenario(scenario: Scenario) {
  try {
    localStorage.setItem(KEY, JSON.stringify(scenario));
  } catch {
    // Storage refused: the choice lasts until the reload.
  }
}
