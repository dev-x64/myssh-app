// How the file editor looks beyond its colours: the editor's own panels
// (find and replace, go to line) drawn like the rest of the app, and their
// wording in the app's language.

import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Locale } from "../../lib/i18n";

const field = {
  height: "28px",
  margin: "3px 6px 3px 0",
  padding: "0 9px",
  border: "1px solid var(--line-strong)",
  borderRadius: "var(--radius)",
  fontFamily: "var(--font-ui)",
  fontSize: "12.5px",
  verticalAlign: "middle",
};

const base = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg-1)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-1)",
    color: "var(--text-3)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--bg-2)" },
  "&.cm-focused": { outline: "none" },
});

// The panels are the app's own furniture, so they are drawn the app's way
// whatever colour scheme the text is shown in.
const panels = EditorView.theme({
  ".cm-panels": {
    backgroundColor: "var(--bg-0)",
    color: "var(--text)",
    fontFamily: "var(--font-ui)",
    fontSize: "12.5px",
  },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  // Find and replace: two rows of a field and its buttons, the close button in the corner.
  ".cm-panel.cm-search, .cm-panel.cm-gotoLine": { position: "relative", padding: "7px 40px 7px 10px" },
  ".cm-panel .cm-textfield": {
    ...field,
    width: "230px",
    backgroundColor: "var(--bg-1)",
    color: "var(--text)",
    outline: "none",
  },
  ".cm-panel .cm-textfield:focus": { borderColor: "var(--accent)" },
  ".cm-panel .cm-textfield::placeholder": { color: "var(--text-3)" },
  ".cm-panel .cm-button": {
    ...field,
    borderColor: "var(--line)",
    backgroundColor: "var(--bg-2)",
    backgroundImage: "none",
    color: "var(--text-2)",
    fontWeight: "500",
    cursor: "pointer",
  },
  ".cm-panel .cm-button:hover": { borderColor: "var(--line-strong)", color: "var(--text)" },
  ".cm-panel .cm-button:active": { backgroundColor: "var(--bg-1)", backgroundImage: "none" },
  ".cm-panel.cm-search label, .cm-panel.cm-gotoLine label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    margin: "3px 12px 3px 2px",
    color: "var(--text-2)",
    fontSize: "12px",
    verticalAlign: "middle",
    cursor: "pointer",
  },
  ".cm-panel.cm-search input[type=checkbox]": { margin: "0", accentColor: "var(--accent)", cursor: "pointer" },
  '.cm-panel.cm-search button[name="close"]': {
    position: "absolute",
    top: "9px",
    right: "9px",
    width: "26px",
    height: "26px",
    padding: "0",
    border: "none",
    borderRadius: "var(--radius)",
    backgroundColor: "transparent",
    color: "var(--text-3)",
    fontSize: "17px",
    lineHeight: "1",
    cursor: "pointer",
  },
  '.cm-panel.cm-search button[name="close"]:hover': { backgroundColor: "var(--bg-2)", color: "var(--text)" },
});

export const appTheme = [base, Prec.highest(panels)];

/** The wording of the editor's panels; what is left out stays as the editor has it. */
export function editorPhrases(locale: Locale): Record<string, string> {
  return locale === "ru"
    ? {
        Find: "Найти",
        Replace: "Заменить на",
        next: "Далее",
        previous: "Назад",
        all: "Все",
        "match case": "С учётом регистра",
        regexp: "Регулярное выражение",
        "by word": "Слово целиком",
        replace: "Заменить",
        "replace all": "Заменить все",
        close: "Закрыть",
        "Go to line": "Перейти к строке",
        go: "Перейти",
        "current match": "текущее совпадение",
        "on line": "в строке",
        "replaced $ matches": "заменено совпадений: $",
        "replaced match on line $": "заменено совпадение в строке $",
      }
    : {
        Replace: "Replace with",
        next: "Next",
        previous: "Previous",
        all: "All",
        "match case": "Match case",
        regexp: "Regular expression",
        "by word": "Whole word",
        replace: "Replace",
        "replace all": "Replace all",
        go: "Go",
      };
}
