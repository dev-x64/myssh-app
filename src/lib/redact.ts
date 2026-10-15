// Takes passwords, tokens and keys out of text before it leaves the device
// for AI suggestions: what is on the command line and the lines the
// terminal shows around it. What is taken out becomes `[REDACTED]`, so the
// model still sees that something stood there.
//
// It errs on the side of taking out too much: a long run of random-looking
// characters goes too, whether it was a secret or a checksum.

const R = "[REDACTED]";
/** A value: quoted, or up to the next space or separator. */
const VALUE = `(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"',;]+)`;
/** Not a value already taken out, nor the kind of an authorization that follows. */
const NOT_DONE = "(?!\\[REDACTED\\]|(?:Bearer|Basic|Token)\\s)";

function hide(value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return `${quote}${R}${quote}`;
}

/** Names of things whose value is a secret. */
const SECRET_NAME =
  "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth(?:orization)?|credentials?|session[_-]?id|cookie)";

const RULES: [RegExp, string | ((...groups: string[]) => string)][] = [
  // A whole private key, wherever it is printed.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, R],
  // user:password@ in an address.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_, before) => `${before}${R}@`],
  // Authorization headers and bearer tokens.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_, kind) => `${kind} ${R}`],
  // NAME=value, NAME: value, "name": "value", for secret names, in env, flags and configs.
  [
    new RegExp(`(["']?[\\w.-]*${SECRET_NAME}[\\w.-]*["']?\\s*[:=]\\s*)${NOT_DONE}(${VALUE})`, "gi"),
    (_, before, value) => `${before}${hide(value)}`,
  ],
  // --password value, --token=value, and their kin.
  [
    new RegExp(`(--?[\\w-]*${SECRET_NAME}[\\w-]*)(=|\\s+)${NOT_DONE}(${VALUE})`, "gi"),
    (_, flag, gap, value) => `${flag}${gap}${hide(value)}`,
  ],
  // sshpass -p secret
  [/\b(sshpass\s+(?:-\w+\s+)*-p)\s*\S+/g, (_, before) => `${before} ${R}`],
  // mysql -psecret (a value glued to -p) for the MySQL tools.
  [/\b(mysql\w*|mariadb\w*)\b([^|;&\n]*?\s)-p(?!\s)\S+/gi, (_, tool, between) => `${tool}${between}-p${R}`],
  // Tokens with well-known shapes.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|AQ\.[\w.-]{20,}|ya29\.[\w-]{20,}|npm_[A-Za-z0-9]{30,})\b/g,
    R,
  ],
  // JSON web tokens.
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}\b/g, R],
];

/** A long run of the characters keys and tokens are written in. */
const RANDOM = /[A-Za-z0-9+/_=-]{32,}/g;

const kind = (c: string) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /[0-9]/.test(c) ? 2 : 3);

/**
 * Whether a run looks random rather than made of words: in keys, hashes
 * and tokens letters, capitals and digits keep changing places, in paths
 * and names they come in stretches.
 */
function looksRandom(run: string): boolean {
  if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) return false;
  let changes = 0;
  for (let i = 1; i < run.length; i++) if (kind(run[i]) !== kind(run[i - 1])) changes += 1;
  return changes / run.length >= 0.3;
}

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as never);
  }
  return out.replace(RANDOM, (run) => (looksRandom(run) ? R : run));
}
