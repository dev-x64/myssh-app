import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Check, FileWarning, RotateCw, Save, X } from "lucide-react";
import { basicSetup, EditorView } from "codemirror";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, asApiError, type ApiError, type FileVersion } from "../../lib/api";
import { errorText, useT } from "../../lib/i18n";
import { appTheme, editorPhrases } from "./editorLook";
import { closeTab, getSession, requestCloseEditor } from "../../lib/sessions";
import { fontStack, isDark, useSettings } from "../../lib/settings";
import { useUi, type Tab } from "../../lib/store";
import { Modal } from "../ui";

type Phase =
  | { kind: "loading" }
  | { kind: "load-error"; error: ApiError }
  | { kind: "ready" };

/** What the line under the editor says: where the cursor is, what is selected, how much there is. */
interface Stats {
  line: number;
  column: number;
  /** Characters selected, over every cursor. */
  selected: number;
  /** Lines the selection touches; `0` with nothing selected. */
  selectedLines: number;
  lines: number;
  characters: number;
}

function statsOf(state: EditorState): Stats {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  let selected = 0;
  let selectedLines = 0;
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    selected += range.to - range.from;
    selectedLines += state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1;
  }
  return {
    line: line.number,
    column: head - line.from + 1,
    selected,
    selectedLines,
    lines: state.doc.lines,
    characters: state.doc.length,
  };
}

/** Text editor for one remote file, saved back over the session's connection. */
export function FileEditor({ tab }: { tab: Tab }) {
  const t = useT();
  const patchTab = useUi((s) => s.patchTab);
  const toast = useUi((s) => s.toast);
  const dark = useSettings((s) => isDark(s.theme));
  const fontFamily = useSettings((s) => fontStack(s.fontFamily));
  const fontSize = useSettings((s) => s.fontSize);
  const session = getSession(tab.id);
  const sid = tab.status === "connected" ? (session?.liveSessionId ?? null) : null;
  const file = tab.editor!;

  const holder = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const themeSlot = useRef(new Compartment());
  /** The server-side state the editor content is based on. */
  const base = useRef<{ version: FileVersion; crlf: boolean; saved: string } | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  /** Content as loaded from the server; a new object per load. */
  const [doc, setDoc] = useState<{ content: string } | null>(null);
  const [crlf, setCrlf] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  /** What the file was taken to be written in, by its name. */
  const [language, setLanguage] = useState<string | null>(null);

  const markDirty = useCallback(
    (dirty: boolean) => {
      if (useUi.getState().tabs.find((candidate) => candidate.id === tab.id)?.editorDirty !== dirty) {
        patchTab(tab.id, { editorDirty: dirty });
      }
    },
    [tab.id, patchTab],
  );

  const mount = useCallback(
    (content: string) => {
      view.current?.destroy();
      if (!holder.current) return;
      const language = new Compartment();
      const editor = new EditorView({
        parent: holder.current,
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            keymap.of([
              indentWithTab,
              {
                key: "Mod-s",
                run: () => {
                  saveRef.current();
                  return true;
                },
              },
            ]),
            language.of([]),
            themeSlot.current.of(isDark(useSettings.getState().theme) ? oneDark : []),
            appTheme,
            EditorState.phrases.of(editorPhrases(useSettings.getState().locale)),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) markDirty(update.state.doc.toString() !== base.current?.saved);
              if (update.docChanged || update.selectionSet) setStats(statsOf(update.state));
            }),
          ],
        }),
      });
      view.current = editor;
      setStats(statsOf(editor.state));
      editor.focus();
      const description = LanguageDescription.matchFilename(languages, file.name);
      setLanguage(description?.name ?? null);
      void description
        ?.load()
        .then((support) => {
          if (view.current === editor) editor.dispatch({ effects: language.reconfigure(support) });
        })
        .catch(() => {});
    },
    [file.name, markDirty],
  );

  const load = useCallback(async () => {
    if (sid === null) return;
    setPhase({ kind: "loading" });
    setFailure(null);
    setConflict(false);
    try {
      const text = await api.sftpReadText(sid, file.path);
      base.current = { version: text.version, crlf: text.crlf, saved: text.content };
      setCrlf(text.crlf);
      setDoc({ content: text.content });
      setPhase({ kind: "ready" });
      markDirty(false);
    } catch (e) {
      setPhase({ kind: "load-error", error: asApiError(e) });
    }
  }, [sid, file.path, markDirty, mount]);

  // The editor is created once its holder exists, i.e. after the "ready"
  // phase has rendered. (Not on an animation frame: those do not run while
  // the window is hidden.)
  useEffect(() => {
    if (doc && phase.kind === "ready") mount(doc.content);
  }, [doc, phase.kind, mount]);

  // Load once. A reconnection must not reload over the user's edits.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || sid === null) return;
    loaded.current = true;
    void load();
  }, [sid, load]);

  useEffect(() => () => view.current?.destroy(), []);

  useEffect(() => {
    view.current?.dispatch({ effects: themeSlot.current.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  const save = useCallback(
    async (force = false) => {
      const editor = view.current;
      const current = base.current;
      if (!editor || !current || saving) return;
      if (sid === null) {
        setFailure({ code: "session_closed", message: "not connected", detail: null });
        return;
      }
      const content = editor.state.doc.toString();
      setSaving(true);
      setFailure(null);
      try {
        const version = await api.sftpWriteText(
          sid,
          file.path,
          content,
          current.crlf,
          force ? null : current.version,
        );
        base.current = { version, crlf: current.crlf, saved: content };
        setSavedAt(Date.now());
        setConflict(false);
        // The user may have typed while the save was in flight.
        markDirty(editor.state.doc.toString() !== content);
      } catch (e) {
        const error = asApiError(e);
        if (error.code === "conflict") setConflict(true);
        else setFailure(error);
      } finally {
        setSaving(false);
      }
    },
    [sid, file.path, saving, markDirty],
  );
  saveRef.current = () => void save();

  const saveCopy = async () => {
    const editor = view.current;
    if (!editor) return;
    const local = await saveDialog({ defaultPath: file.name });
    if (!local) return;
    try {
      const content = editor.state.doc.toString();
      await api.localWriteText(local, crlf ? content.replace(/\n/g, "\r\n") : content);
      toast("success", t("editor.copy_saved"));
    } catch (e) {
      const error = asApiError(e);
      toast("error", errorText(error), error.detail ?? undefined);
    }
  };

  const discard = () => {
    const closingTab = tab.editorClosing === "tab";
    patchTab(tab.id, { editor: null, editorDirty: false, editorClosing: null });
    if (closingTab) closeTab(tab.id);
    else session?.focus();
  };

  const status = saving
    ? t("editor.saving")
    : tab.editorDirty
      ? t("editor.unsaved")
      : savedAt
        ? t("editor.saved")
        : "";

  return (
    <div className="editor" style={{ fontFamily, fontSize }}>
      <div className="editor-head">
        <div className="editor-title">
          <span className="name">{file.name}</span>
          <span className="path mono selectable">{file.path}</span>
        </div>
        {crlf && <span className="chip">{t("editor.crlf")}</span>}
        <span className={`editor-status${tab.editorDirty && !saving ? " dirty" : ""}`}>
          {!saving && !tab.editorDirty && savedAt ? <Check size={13} /> : null}
          {status}
        </span>
        <button
          className="btn small primary"
          disabled={phase.kind !== "ready" || saving || !tab.editorDirty || sid === null}
          onClick={() => void save()}
        >
          <Save size={13} />
          {t("editor.save")}
        </button>
        <button className="btn ghost icon small" title={t("common.close")} onClick={() => requestCloseEditor(tab.id)}>
          <X size={15} />
        </button>
      </div>

      {sid === null && phase.kind === "ready" && (
        <div className="editor-banner warn">
          <AlertTriangle size={14} />
          <span>{t("editor.offline")}</span>
          <button className="btn small" onClick={() => void saveCopy()}>
            {t("editor.save_copy")}
          </button>
        </div>
      )}
      {failure && sid !== null && (
        <div className="editor-banner error">
          <AlertTriangle size={14} />
          <span className="selectable">
            {t("editor.save_failed")} {errorText(failure)}
            {failure.detail ? ` — ${failure.detail}` : ""}
          </span>
          <button className="btn small" onClick={() => void saveCopy()}>
            {t("editor.save_copy")}
          </button>
          <button className="btn small" onClick={() => void save()}>
            {t("common.retry")}
          </button>
        </div>
      )}

      <div className="editor-body">
        {phase.kind === "loading" && (
          <div className="editor-note">
            <span className="spinner" />
            {sid === null ? t("files.offline") : t("editor.loading")}
          </div>
        )}
        {phase.kind === "load-error" && (
          <div className="editor-note">
            <FileWarning size={22} />
            <div>{errorText(phase.error)}</div>
            {phase.error.detail && <div className="dim selectable">{phase.error.detail}</div>}
            <div className="row">
              <button className="btn small" onClick={() => void load()}>
                <RotateCw size={13} />
                {t("common.retry")}
              </button>
              <button className="btn small" onClick={discard}>
                {t("common.close")}
              </button>
            </div>
          </div>
        )}
        {phase.kind === "ready" && <div className="editor-cm" ref={holder} />}
      </div>

      {phase.kind === "ready" && stats && (
        <div className="editor-foot">
          <span>{t("editor.stat.position", { line: stats.line, column: stats.column })}</span>
          {stats.selected > 0 && (
            <span className="selected">
              {t("editor.stat.selected", { n: stats.selected })}
              {stats.selectedLines > 1 ? ` ${t("editor.stat.selected_lines", { n: stats.selectedLines })}` : ""}
            </span>
          )}
          <span className="grow" />
          <span>{t("editor.stat.lines", { n: stats.lines })}</span>
          <span>{t("editor.stat.characters", { n: stats.characters })}</span>
          <span>{crlf ? "CRLF" : "LF"}</span>
          {language && <span>{language}</span>}
        </div>
      )}

      {conflict && (
        <Modal
          scope="tab"
          danger
          wide
          title={t("editor.conflict.title")}
          icon={<AlertTriangle size={17} />}
          onClose={() => setConflict(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => void saveCopy()}>
                {t("editor.save_copy")}
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={() => void load()}>
                {t("editor.conflict.reload")}
              </button>
              <button type="button" className="btn danger" onClick={() => void save(true)}>
                {t("editor.conflict.overwrite")}
              </button>
              <button type="button" className="btn primary" data-autofocus onClick={() => setConflict(false)}>
                {t("common.cancel")}
              </button>
            </>
          }
        >
          <p>{t("editor.conflict.text", { name: file.name })}</p>
        </Modal>
      )}

      {tab.editorClosing && (
        <Modal
          scope="tab"
          danger
          title={t("editor.discard.title")}
          icon={<AlertTriangle size={17} />}
          onClose={() => patchTab(tab.id, { editorClosing: null })}
          footer={
            <>
              <button type="button" className="btn danger" onClick={discard}>
                {t("editor.discard.action")}
              </button>
              <button
                type="button"
                className="btn primary"
                data-autofocus
                onClick={() => patchTab(tab.id, { editorClosing: null })}
              >
                {t("common.cancel")}
              </button>
            </>
          }
        >
          <p>{t("editor.discard.text", { name: file.name })}</p>
        </Modal>
      )}
    </div>
  );
}
