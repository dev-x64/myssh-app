import { AlertTriangle, Check, Info, ShieldAlert, SquareTerminal, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type AiSuggestion, type Snippet } from "../../lib/api";
import { formatClock, useT } from "../../lib/i18n";
import { loadPlan, usePlan } from "../../lib/plan";
import { redact } from "../../lib/redact";
import { lintScript, syntaxText, type ScriptIssue } from "../../lib/scriptLint";
import { useSettings } from "../../lib/settings";
import { useVault } from "../../lib/store";
import { cx, Field, Modal } from "../ui";

/** How long typing has to pause before the script is looked over. */
const CHECK_AFTER_MS = 350;

/**
 * The script looked over as it is written: bash's verdict on its syntax,
 * then what `lintScript` notices, each with its fix where there is one.
 */
function ScriptCheck({ script, onFix }: { script: string; onFix: (script: string) => void }) {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const [issues, setIssues] = useState<ScriptIssue[] | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!script.trim()) {
      setIssues(null);
      return;
    }
    let gone = false;
    const timer = window.setTimeout(async () => {
      const found = lintScript(script, locale);
      const syntax = await api.scriptCheck(script).catch(() => null);
      if (gone) return;
      if (syntax?.error) {
        found.unshift({ level: "error", line: syntax.line, text: syntaxText(syntax.error, locale) });
      }
      setChecked(syntax?.checked ?? false);
      setIssues(found);
    }, CHECK_AFTER_MS);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [script, locale]);

  if (!issues) return null;
  if (issues.length === 0) {
    return (
      <div className="script-check ok">
        <Check size={13} />
        {checked ? t("lint.ok") : t("lint.ok.unchecked")}
      </div>
    );
  }
  return (
    <div className="script-check">
      {issues.map((issue, index) => (
        <div key={index} className={cx("script-issue", issue.level)}>
          {issue.level === "error" ? (
            <AlertTriangle size={13} />
          ) : issue.level === "warn" ? (
            <ShieldAlert size={13} />
          ) : (
            <Info size={13} />
          )}
          <span>
            {issue.line !== null && <b>{t("lint.line", { n: issue.line })}</b>}
            {issue.text}
          </span>
          {issue.fix !== undefined && (
            <button type="button" className="btn small" onClick={() => onFix(issue.fix!)}>
              {t("lint.fix")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function SnippetDialog(props: {
  snippet: Snippet | null;
  /** For a new snippet: the command to start from. */
  script?: string;
  onClose: () => void;
}) {
  const t = useT();
  const snippets = useVault((s) => s.snapshot.snippets);
  const [name, setName] = useState(props.snippet?.name ?? "");
  const [group, setGroup] = useState(props.snippet?.package ?? "");
  const [description, setDescription] = useState(props.snippet?.description ?? "");
  const [script, setScript] = useState(props.snippet?.script ?? props.script ?? "");
  const [busy, setBusy] = useState(false);
  const planAi = usePlan((s) => s.plan?.ai === true);
  const aiSetting = useSettings((s) => s.aiSuggestions);
  const aiOn = planAi && aiSetting;
  const locale = useSettings((s) => s.locale);
  const [ai, setAi] = useState<{ thinking: boolean; note: string | null; found: AiSuggestion[] }>({
    thinking: false,
    note: null,
    found: [],
  });

  // Commands for what the description says, by the AI: for a plain Linux
  // server with bash, as a snippet has no server of its own.
  const askAi = async () => {
    const asked = description.trim();
    if (!asked) {
      setAi({ thinking: false, note: t("snippet.ai.empty"), found: [] });
      return;
    }
    setAi({ thinking: true, note: null, found: [] });
    const answer = await api
      .aiSuggest({ line: redact(asked), os: "Linux", shell: "bash", cwd: "", user: "", context: "", locale })
      .catch(() => null);
    void loadPlan(true);
    if (!answer) {
      setAi({ thinking: false, note: t("suggest.ai_failed"), found: [] });
    } else if (answer.limited_until) {
      const time = formatClock(answer.limited_until * 1000, locale);
      setAi({ thinking: false, note: t(answer.plan === "free" ? "suggest.ai_limit_free" : "suggest.ai_limit", { time }), found: [] });
    } else if (answer.suggestions.length === 0) {
      setAi({ thinking: false, note: t("suggest.ai_nothing"), found: [] });
    } else {
      setAi({ thinking: false, note: null, found: answer.suggestions });
    }
  };
  const take = (command: string, add: boolean) => {
    setScript((before) => (add && before.trim() ? `${before.replace(/\s+$/, "")}\n${command}` : command));
    if (!name.trim()) setName(description.trim().slice(0, 60));
    setAi((was) => ({ ...was, found: [] }));
  };

  const groups = useMemo(
    () => [...new Set(snippets.map((s) => s.package).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [snippets],
  );
  const valid = name.trim() !== "" && script.trim() !== "";

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const saved = await mutate(
      () =>
        api.snippetSave({ id: props.snippet?.id ?? null, name, description, script, package: group }),
      t("snippet.saved"),
    );
    setBusy(false);
    if (saved) props.onClose();
  };

  return (
    <Modal
      wide
      title={props.snippet ? t("snippet.edit") : t("snippet.new")}
      icon={<SquareTerminal size={17} />}
      onClose={props.onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!valid || busy}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="row">
        <div className="grow">
          <Field label={t("snippet.name")}>
            <input
              className="input"
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
          </Field>
        </div>
        <div style={{ width: 170 }}>
          <Field label={t("snippet.package")} optional>
            <input
              className="input"
              list="snippet-groups"
              value={group}
              title={t("snippet.package.hint")}
              onChange={(e) => setGroup(e.target.value)}
              spellCheck={false}
            />
            <datalist id="snippet-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>
      </div>
      <Field label={t("snippet.description")} optional>
        <div className="with-action">
          <input
            className="input"
            value={description}
            placeholder={t("snippet.description.placeholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button
            type="button"
            className="btn ghost icon small"
            title={aiOn ? t("snippet.ai") : t("snippet.ai.off")}
            disabled={!aiOn || ai.thinking}
            onClick={() => void askAi()}
          >
            {ai.thinking ? <span className="spinner" /> : <WandSparkles size={15} />}
          </button>
        </div>
      </Field>
      {(ai.thinking || ai.note || ai.found.length > 0) && (
        <div className="snippet-ai">
          {ai.thinking && <p className="dim">{t("snippet.ai.thinking")}</p>}
          {ai.note && <p className="dim">{ai.note}</p>}
          {ai.found.map((found) => (
            <div key={found.command} className={cx("snippet-ai-item", found.danger && "danger")}>
              <div className="snippet-ai-text">
                <code>{found.command}</code>
                <span>{found.explanation}</span>
              </div>
              <button type="button" className="btn small primary" onClick={() => take(found.command, false)}>
                {t("snippet.ai.use")}
              </button>
              {script.trim() && (
                <button type="button" className="btn small" onClick={() => take(found.command, true)}>
                  {t("snippet.ai.add")}
                </button>
              )}
            </div>
          ))}
          {ai.found.length > 0 && <p className="snippet-ai-note">{t("snippet.ai.note")}</p>}
        </div>
      )}
      <Field label={t("snippet.script")} hint={t("snippet.script.hint")}>
        <textarea
          className="textarea"
          value={script}
          placeholder={"sudo systemctl restart nginx"}
          onChange={(e) => setScript(e.target.value)}
          // Enter adds a line here; the dialog is submitted with the button.
          onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
      <ScriptCheck script={script} onFix={setScript} />
    </Modal>
  );
}
