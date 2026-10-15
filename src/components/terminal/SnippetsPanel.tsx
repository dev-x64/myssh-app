import { CornerDownLeft, Search, TextCursorInput, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { getSession } from "../../lib/sessions";
import { useUi, useVault, type Tab } from "../../lib/store";
import { groupSnippets, matchesSnippet } from "../snippets/SnippetsView";

/** Snippets beside a terminal: insert into the command line, or run. */
export function SnippetsPanel({ tab }: { tab: Tab }) {
  const t = useT();
  const snippets = useVault((s) => s.snapshot.snippets);
  const patchTab = useUi((s) => s.patchTab);
  const session = getSession(tab.id);
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () => groupSnippets(snippets.filter((s) => matchesSnippet(s, query))),
    [snippets, query],
  );
  const online = tab.status === "connected";

  const close = () => {
    patchTab(tab.id, { side: null });
    session?.focus();
  };

  return (
    <aside className="side">
      <div className="side-head">
        <h2>{t("snippets.title")}</h2>
        <button className="btn ghost icon small" title={t("common.close")} onClick={close}>
          <X size={15} />
        </button>
      </div>
      {snippets.length > 0 && (
        <div className="side-search">
          <div className="search" style={{ maxWidth: "none" }}>
            <Search size={14} />
            <input
              className="input"
              autoFocus
              value={query}
              placeholder={t("snippets.search")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : close())}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
        </div>
      )}
      <div className="side-body scroll">
        {snippets.length === 0 ? (
          <div className="side-note">{t("snippets.panel.empty")}</div>
        ) : groups.length === 0 ? (
          <div className="side-note">{t("snippets.no_results", { query: query.trim() })}</div>
        ) : (
          <>
            {!online && <div className="side-note">{t("snippets.panel.offline")}</div>}
            {groups.map(([name, items]) => (
              <div key={name}>
                <div className="section-title">{name || t("snippets.ungrouped")}</div>
                {items.map((snippet) => (
                  <div key={snippet.id} className="snip">
                    <div className="snip-name">{snippet.name}</div>
                    {snippet.description && <div className="snip-desc">{snippet.description}</div>}
                    <pre className="snip-code">{snippet.script.trimEnd()}</pre>
                    <div className="snip-actions">
                      <button
                        className="btn small"
                        disabled={!online}
                        title={t("snippets.insert.hint")}
                        onClick={() => session?.insert(snippet.script)}
                      >
                        <TextCursorInput size={13} />
                        {t("snippets.insert")}
                      </button>
                      <button
                        className="btn small primary"
                        disabled={!online}
                        title={t("snippets.run.hint")}
                        onClick={() => session?.run(snippet.script)}
                      >
                        <CornerDownLeft size={13} />
                        {t("snippets.run")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
