import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { reportError } from "../../lib/actions";
import { api, type KnownHost } from "../../lib/api";
import { formatDate, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";
import { useUi } from "../../lib/store";
import { Confirm, Empty } from "../ui";

export function KnownHostsView() {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const toast = useUi((s) => s.toast);
  const [entries, setEntries] = useState<KnownHost[] | null>(null);
  const [forgetting, setForgetting] = useState<KnownHost | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.knownHosts();
      setEntries(list.sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port));
    } catch (e) {
      reportError(e);
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const target = (entry: KnownHost) => (entry.port === 22 ? entry.host : `${entry.host}:${entry.port}`);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("known.title")}</h1>
      </div>
      <div className="page-body scroll">
        <p className="lead">{t("known.text")}</p>
        {entries === null ? null : entries.length === 0 ? (
          <Empty icon={<ShieldCheck size={24} />} text={t("known.empty")} />
        ) : (
          <div className="table">
            <div className="table-row head">
              <span>{t("known.host")}</span>
              <span>{t("known.algorithm")}</span>
              <span>{t("known.fingerprint")}</span>
              <span>{t("known.added")}</span>
              <span />
            </div>
            {entries.map((entry) => (
              <div key={`${entry.host}:${entry.port}`} className="table-row">
                <span style={{ fontWeight: 600 }}>{target(entry)}</span>
                <span className="muted">{entry.algorithm}</span>
                <span className="mono selectable" title={entry.fingerprint}>
                  {entry.fingerprint}
                </span>
                <span className="muted">{formatDate(entry.added_at, locale)}</span>
                <span>
                  <button className="btn small" onClick={() => setForgetting(entry)}>
                    {t("known.forget")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {forgetting && (
        <Confirm
          danger
          title={t("known.forget.title")}
          text={t("known.forget.text", { host: target(forgetting) })}
          confirmLabel={t("known.forget")}
          onClose={() => setForgetting(null)}
          onConfirm={async () => {
            const entry = forgetting;
            setForgetting(null);
            try {
              await api.knownHostForget(entry.host, entry.port);
              toast("success", t("known.forgotten"));
            } catch (e) {
              reportError(e);
            }
            await load();
          }}
        />
      )}
    </div>
  );
}
