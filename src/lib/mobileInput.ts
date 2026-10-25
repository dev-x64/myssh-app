// Typing into a terminal from a phone's keyboard. Such a keyboard composes
// a word before it gives it (to suggest and correct it), and the terminal
// would send nothing until the word is done: no letter shows as it is
// typed, and Ctrl from the bar above the keyboard misses the letter it was
// meant for. Here every change to the word goes out as it happens: a
// letter added is sent, one taken back is a Backspace, and a word the
// keyboard corrects is rubbed out as far as it differs and typed anew.

import type { Terminal } from "@xterm/xterm";

/** Backspace, as a terminal sends it. */
const DEL = "\x7f";

/**
 * What the (unseen) input field holds between keys. A keyboard sends a
 * Backspace only when there is something before the cursor to delete, so
 * there always is; what it deletes of this is a Backspace for the shell.
 */
const SPARE = "________";

/** What to send to turn `before` into `after`, both typed at the cursor. */
function change(before: string, after: string): string {
  const was = [...before];
  const now = [...after];
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same++;
  return DEL.repeat(was.length - same) + now.slice(same).join("");
}

/**
 * Takes the terminal's keyboard input from the keyboard's composing over
 * from the terminal. `send` gets what is to go to the shell, as typed.
 */
export function attachMobileInput(term: Terminal, send: (data: string) => void): () => void {
  const element = term.element;
  const input = term.textarea;
  if (!element || !input) return () => {};

  // Nothing to complete, correct or capitalise: it is a command line.
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "none");

  /** The word being composed, as far as it has been sent. */
  let composing: string | null = null;

  const refill = () => {
    if (composing !== null) return;
    if (input.value !== SPARE) input.value = SPARE;
    input.setSelectionRange(SPARE.length, SPARE.length);
  };
  refill();

  const typeEach = (data: string) => {
    // One character at a time, so that Ctrl or Alt from the bar takes the first.
    for (const char of data) send(char);
  };

  // Heard on the way down, before the terminal's own textarea hears them:
  // the terminal never learns of the composing, and does not send the word again.
  const onCompositionStart = (e: CompositionEvent) => {
    if (e.target !== input) return;
    e.stopPropagation();
    composing = "";
  };
  const onCompositionUpdate = (e: CompositionEvent) => {
    if (e.target !== input) return;
    e.stopPropagation();
  };
  const onCompositionEnd = (e: CompositionEvent) => {
    if (e.target !== input) return;
    e.stopPropagation();
    if (composing !== null && e.data !== composing) typeEach(change(composing, e.data ?? ""));
    composing = null;
    window.setTimeout(refill, 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // "Being composed": what it is comes with the input event.
    if (e.target === input && (e.keyCode === 229 || e.key === "Unidentified")) e.stopPropagation();
  };
  // Whatever emptied the field meanwhile (the terminal does, now and then), it is filled again.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.target === input) refill();
  };

  const onInput = (e: Event) => {
    if (e.target !== input) return;
    const event = e as InputEvent;
    e.stopPropagation();
    switch (event.inputType) {
      case "insertCompositionText": {
        const now = event.data ?? "";
        typeEach(change(composing ?? "", now));
        composing = now;
        break;
      }
      case "insertText":
      case "insertReplacementText":
        if (event.data) typeEach(event.data);
        refill();
        break;
      case "insertLineBreak":
      case "insertParagraph":
        send("\r");
        refill();
        break;
      case "deleteContentBackward":
      case "deleteWordBackward":
        // Outside a word: as many Backspaces as the keyboard took of the spare text.
        if (composing === null) {
          send(DEL.repeat(Math.max(1, SPARE.length - input.value.length)));
          refill();
        }
        break;
    }
  };

  element.addEventListener("compositionstart", onCompositionStart, true);
  element.addEventListener("compositionupdate", onCompositionUpdate, true);
  element.addEventListener("compositionend", onCompositionEnd, true);
  element.addEventListener("keydown", onKeyDown, true);
  element.addEventListener("keyup", onKeyUp, true);
  element.addEventListener("input", onInput, true);
  input.addEventListener("focus", refill);
  return () => {
    element.removeEventListener("compositionstart", onCompositionStart, true);
    element.removeEventListener("compositionupdate", onCompositionUpdate, true);
    element.removeEventListener("compositionend", onCompositionEnd, true);
    element.removeEventListener("keydown", onKeyDown, true);
    element.removeEventListener("keyup", onKeyUp, true);
    element.removeEventListener("input", onInput, true);
    input.removeEventListener("focus", refill);
  };
}
