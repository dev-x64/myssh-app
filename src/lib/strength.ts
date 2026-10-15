// How hard a password would be to guess, in four steps, for the line under
// the field where a master password is chosen. An estimate, not a promise:
// it counts the kinds of characters and the length, and takes off for what
// makes a password shorter than it looks: runs, repeats, and the passwords
// everybody tries first.

/** 0: nothing typed; 1 weak, 2 fair, 3 good, 4 strong. */
export type Strength = 0 | 1 | 2 | 3 | 4;

const COMMON = new Set([
  "password", "passw0rd", "qwerty", "qwertyuiop", "letmein", "welcome", "admin", "administrator", "iloveyou",
  "monkey", "dragon", "football", "baseball", "sunshine", "princess", "master", "superman", "trustno1",
  "abc123", "changeme", "secret", "login", "root", "toor", "test", "пароль", "йцукен", "привет", "любовь",
]);
/** Keys that sit side by side, and the alphabet and digits in order. */
const RUNS = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm", "йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю"];

/** Whether three characters follow one another in some run, either way. */
function inRun(a: string, b: string, c: string): boolean {
  const three = a + b + c;
  const back = c + b + a;
  return RUNS.some((run) => run.includes(three) || run.includes(back));
}

/** The password's length with what adds nothing left out. */
function tellingLength(password: string): number {
  const chars = [...password.toLowerCase()];
  let length = 0;
  for (let i = 0; i < chars.length; i++) {
    const repeated = i >= 2 && chars[i] === chars[i - 1] && chars[i] === chars[i - 2];
    const running = i >= 2 && inRun(chars[i - 2], chars[i - 1], chars[i]);
    // The third and later characters of a repeat or a run are worth a fraction.
    length += repeated || running ? 0.25 : 1;
  }
  return length;
}

export function passwordStrength(password: string): Strength {
  if (password === "") return 0;
  const lowered = password.toLowerCase();
  // A well-worn password, with or without digits tacked on, is weak however long.
  if (COMMON.has(lowered.replace(/[\d\W_]+$/u, "")) || COMMON.has(lowered)) return 1;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^\p{L}\p{N}]/u.test(password)) pool += 33;
  if (/[^\x00-\x7f]/.test(password)) pool += 40;
  const bits = tellingLength(password) * Math.log2(Math.max(pool, 2));
  // Ten characters is the least the form takes; fewer is weak whatever they are.
  if ([...password].length < 10 || bits < 45) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}
