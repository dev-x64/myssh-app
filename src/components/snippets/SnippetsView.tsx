import { History, Pencil, Play, Plus, Search, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type FrequentCommand, type Snippet } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useVault } from "../../lib/store";
import { Confirm, cx, Empty } from "../ui";
import { RunPanel } from "./RunPanel";
import { Tip } from "../Tip";
import { SnippetDialog } from "./SnippetDialog";

export function matchesSnippet(snippet: Snippet, query: string): boolean {
  const haystack = [snippet.name, snippet.description, snippet.package, snippet.script]
    .join("\n")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Snippets bucketed by group name; ungrouped ones come first. */
export function groupSnippets(snippets: Snippet[]): [string, Snippet[]][] {
  const buckets = new Map<string, Snippet[]>();
  for (const snippet of snippets) {
    buckets.set(snippet.package, [...(buckets.get(snippet.package) ?? []), snippet]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([name, items]) => [name, items.sort((a, b) => a.name.localeCompare(b.name))]);
}

/** How many commands from history are offered at first, and at most. */
const HISTORY_SHOWN = 6;
const HISTORY_MAX = 40;

type Dialog =
  | { kind: "edit"; snippet: Snippet | null; script?: string }
  | { kind: "delete"; snippet: Snippet }
  | null;

export function SnippetsView() {
  const t = useT();
  const snippets = useVault((s) => s.snapshot.snippets);
  const hosts = useVault((s) => s.snapshot.hosts);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  /** The snippet whose hosts are being picked, to run it on them. */
  const [running, setRunning] = useState<Snippet | null>(null);

  const groups = useMemo(
    () => groupSnippets(snippets.filter((s) => matchesSnippet(s, query))),
    [snippets, query],
  );
  // Commands run often that are not snippets yet. Read again whenever the
  // snippets change, so a saved one leaves the list.
  const [frequent, setFrequent] = useState<FrequentCommand[]>([]);
  const [allHistory, setAllHistory] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .historyFrequent(HISTORY_MAX)
      .catch((): FrequentCommand[] => [])
      .then((found) => alive && setFrequent(found));
    return () => {
      alive = false;
    };
  }, [snippets]);
  const candidates = useMemo(() => {
    const saved = new Set(snippets.map((s) => s.script.trim()));
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return frequent.filter(
      (f) => !saved.has(f.command) && words.every((word) => f.command.toLowerCase().includes(word)),
    );
  }, [frequent, snippets, query]);
  const fromHistory = candidates.length > 0 && (
    <div className="from-history">
      <div className="section-title">
        <History size={13} />
        {t("snippets.history.title")}
      </div>
      <p className="section-hint">{t("snippets.history.hint")}</p>
      <div className="list">
        {(allHistory ? candidates : candidates.slice(0, HISTORY_SHOWN)).map((found) => (
          <div key={found.command} className="item history-item">
            <code className="grow selectable">{found.command}</code>
            <span className="chip">{t("snippets.history.count", { n: found.count })}</span>
            <button
              className="btn small"
              title={t("snippets.history.add")}
              onClick={() => setDialog({ kind: "edit", snippet: null, script: found.command })}
            >
              <Plus size={13} />
              {t("snippets.history.add")}
            </button>
          </div>
        ))}
      </div>
      {!allHistory && candidates.length > HISTORY_SHOWN && (
        <button className="btn ghost small" onClick={() => setAllHistory(true)}>
          {t("snippets.history.more")}
        </button>
      )}
    </div>
  );

  const startupUsers = (snippet: Snippet) =>
    hosts.filter((h) => h.startup_snippet_id === snippet.id).length;

  return (
    <>
    <div className="page">
      <div className="page-head">
        <div className="search">
          <Search size={15} />
          <input
            className="input"
            value={query}
            placeholder={t("snippets.search")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <div className="grow" />
        <button className="btn primary" onClick={() => setDialog({ kind: "edit", snippet: null })}>
          <Plus size={15} />
          {t("snippets.new")}
        </button>
      </div>

      <div className="page-body scroll">
        {snippets.length > 0 && (
          <Tip id="snippets" title={t("tip.snippets.title")}>
            {t("tip.snippets.text")}
          </Tip>
        )}
        {snippets.length === 0 ? (
          <Empty
            icon={<SquareTerminal size={24} />}
            title={t("snippets.empty.title")}
            text={t("snippets.empty.text")}
            action={
              <button className="btn primary" onClick={() => setDialog({ kind: "edit", snippet: null })}>
                <Plus size={15} />
                {t("snippets.new")}
              </button>
            }
          />
        ) : groups.length === 0 ? (
          !fromHistory && (
            <Empty icon={<SquareTerminal size={24} />} text={t("snippets.no_results", { query: query.trim() })} />
          )
        ) : (
          groups.map(([name, items]) => (
            <div key={name}>
              <div className="section-title">
                {name || t("snippets.ungrouped")}
                <span className="dim">{items.length}</span>
              </div>
              <div className="list">
                {items.map((snippet) => {
                  const lines = snippet.script.trimEnd().split("\n").length;
                  const users = startupUsers(snippet);
                  return (
                    <div key={snippet.id} className="item" style={{ alignItems: "flex-start" }}>
                      <span className="card-icon accent">
                        <SquareTerminal size={18} />
                      </span>
                      <div className="item-main">
                        <div className="item-title">
                          <span className="name">{snippet.name}</span>
                          {lines > 1 && <span className="chip">{t("snippets.lines", { n: lines })}</span>}
                          {users > 0 && (
                            <span className="chip accent">{t("snippets.startup_for", { n: users })}</span>
                          )}
                        </div>
                        {snippet.description && <div className="item-sub">{snippet.description}</div>}
                        <pre className="snip-code selectable">{snippet.script.trimEnd()}</pre>
                      </div>
                      <div className="item-actions">
                        <button
                          className={cx("btn small", running?.id === snippet.id && "on")}
                          title={t("run.hint")}
                          onClick={() => setRunning(running?.id === snippet.id ? null : snippet)}
                        >
                          <Play size={12} />
                          {t("run.open")}
                          {(snippet.targets?.length ?? 0) > 0 && <span className="dim">{snippet.targets!.length}</span>}
                        </button>
                        <button
                          className="btn small icon ghost"
                          title={t("common.edit")}
                          onClick={() => setDialog({ kind: "edit", snippet })}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="btn small icon ghost"
                          title={t("common.delete")}
                          onClick={() => setDialog({ kind: "delete", snippet })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
        {fromHistory}
      </div>

      {dialog?.kind === "edit" && (
        <SnippetDialog
          key={dialog.snippet?.id ?? "new"}
          snippet={dialog.snippet}
          script={dialog.script}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <Confirm
          danger
          title={t("snippet.delete.title")}
          text={t(startupUsers(dialog.snippet) > 0 ? "snippet.delete.startup" : "snippet.delete.text", {
            name: dialog.snippet.name,
          })}
          confirmLabel={t("common.delete")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const snippet = dialog.snippet;
            setDialog(null);
            await mutate(() => api.snippetDelete(snippet.id), t("snippet.deleted"));
          }}
        />
      )}
    </div>
    {running && (
      <RunPanel
        key={running.id}
        snippet={snippets.find((s) => s.id === running.id) ?? running}
        onClose={() => setRunning(null)}
      />
    )}
    </>
  );
}
