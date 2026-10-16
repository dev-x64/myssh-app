import { Check, Layers, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { requestCloseTab } from "../../lib/sessions";
import { useUi, useVault, type Tab } from "../../lib/store";
import { OsIcon } from "../hosts/OsIcon";
import { cx } from "../ui";

/** Where a terminal of a group stands, as its row says it. */
function stateOf(tab: Tab): "connecting" | "closed" | "running" | "done" | "idle" {
  if (tab.status === "connecting") return "connecting";
  if (tab.status === "closed") return "closed";
  return tab.runState ?? "idle";
}

/**
 * The terminals a snippet was run in on several hosts, at the side of the
 * one tab they share: each with how it is getting on, a click to see it,
 * a cross to close it. A tick goes up as each one finishes.
 */
export function RunGroupList({ tabs, active }: { tabs: Tab[]; active: string }) {
  const t = useT();
  const hosts = useVault((s) => s.snapshot.hosts);
  const activate = useUi((s) => s.activate);
  const done = tabs.filter((tab) => tab.runState === "done").length;
  return (
    <aside className="run-group">
      <div className="run-group-head">
        <Layers size={14} />
        <span className="run-group-title" title={tabs[0]?.group?.title}>
          {tabs[0]?.group?.title}
        </span>
        <span className={cx("run-group-count", done === tabs.length && "all")}>
          {done}/{tabs.length}
        </span>
      </div>
      <div className="run-group-list scroll">
        {tabs.map((tab) => {
          const state = stateOf(tab);
          const host = hosts.find((h) => h.id === tab.hostId);
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              className={cx("run-group-item", state, tab.id === active && "active")}
              onClick={() => activate(tab.id)}
              onKeyDown={(e) => e.key === "Enter" && activate(tab.id)}
            >
              <span className="run-group-icon">
                <OsIcon os={host?.os ?? null} />
              </span>
              <span className="run-group-text">
                <b>{tab.title}</b>
                <small>{t(`rungroup.${state}`)}</small>
              </span>
              <span className="run-group-state" aria-hidden>
                {state === "done" ? (
                  <span className="run-tick">
                    <Check size={12} strokeWidth={3} />
                  </span>
                ) : state === "running" || state === "connecting" ? (
                  <span className="spinner" />
                ) : (
                  <span className={cx("dot", tab.status)} />
                )}
              </span>
              <button
                type="button"
                className="run-group-close"
                title={t("tab.close")}
                onClick={(e) => {
                  e.stopPropagation();
                  requestCloseTab(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
