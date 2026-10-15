import { distance } from "./typos";

/**
 * Mail services people mostly sign up with, the most used first: a typed
 * domain close to one of them is likely a slip of the finger.
 */
const DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "aol.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "zoho.com",
  "fastmail.com",
  "tutanota.com",
  "tuta.io",
  "hey.com",
  "yandex.ru",
  "yandex.com",
  "ya.ru",
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "internet.ru",
  "rambler.ru",
  "ukr.net",
  "yahoo.co.uk",
  "hotmail.co.uk",
  "qq.com",
  "163.com",
];
const KNOWN = new Set(DOMAINS);
/** Services with a single ending: any other ending after their name is a slip. */
const ONE_ENDING = new Set(["gmail", "googlemail", "icloud"]);
/**
 * Endings in real use. One of them is left as typed: "name@web.dev" is
 * somebody's own domain, not a slip for web.de.
 */
const REAL_ENDINGS = new Set(
  "com net org info biz io dev app co me ai tech eu us uk ca de fr it es nl ch at pl cz ru ua by kz".split(" "),
);

const split = (domain: string): [string, string] => {
  const dot = domain.lastIndexOf(".");
  return dot < 0 ? [domain, ""] : [domain.slice(0, dot), domain.slice(dot + 1)];
};

/**
 * The address the typed one was probably meant to be ("name@gmail.con" →
 * "name@gmail.com", "name@gmial.com" → "name@gmail.com"), or null when it
 * looks right or is too far from any service known here to guess.
 */
export function emailTypo(typed: string): string | null {
  const email = typed.trim();
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (domain === "" || KNOWN.has(domain)) return null;
  const [name, ending] = split(domain);

  let best: string | null = null;
  let bestScore = 3;
  for (const known of DOMAINS) {
    const [knownName, knownEnding] = split(known);
    let score: number;
    if (ending === "") {
      // No ending at all: "name@gmail", or the dot left out, "name@gmailcom".
      score = name === knownName ? 1 : distance(name, known) <= 1 ? 1 : 3;
    } else {
      // The name: short ones leave no room, "acme" is not a slip for "me".
      const room = knownName.length <= 4 ? 0 : knownName.length <= 6 ? 1 : 2;
      const nameOff = distance(name, knownName);
      if (nameOff > room) continue;
      let endingOff = 0;
      if (ending !== knownEnding) {
        const close = distance(ending, knownEnding) <= 1 || knownEnding.startsWith(ending);
        if (!close || (REAL_ENDINGS.has(ending) && !ONE_ENDING.has(knownName))) continue;
        endingOff = 1;
      }
      score = nameOff + endingOff;
    }
    if (score > 0 && score < bestScore) {
      best = known;
      bestScore = score;
    }
  }
  return best ? `${local}@${best}` : null;
}
