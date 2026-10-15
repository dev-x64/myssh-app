import { Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ServerStats } from "../../lib/api";
import { formatSize, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";
import { cx } from "../ui";

/** How often a server is asked how busy it is, while its terminal is in sight. */
const EVERY_MS = 5000;

/** What the bar shows. */
export interface StatsView {
  /** How busy the processor was over a second, 0–100. */
  cpu: number | null;
  cores: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskFree: number | null;
  diskTotal: number | null;
  uptime: number | null;
  load: number | null;
}

function view(now: ServerStats): StatsView {
  return {
    cpu: now.cpu_percent,
    cores: now.cores,
    memUsed: now.mem_total != null && now.mem_available != null ? now.mem_total - now.mem_available : null,
    memTotal: now.mem_total,
    diskFree: now.disk_free,
    diskTotal: now.disk_total,
    uptime: now.uptime_secs,
    load: now.load1,
  };
}

/**
 * Asks the session's server how busy it is every few seconds, while asked
 * to (the terminal is in sight and advanced mode is on). `null` until the
 * first answer; `"none"` when the server tells nothing useful.
 */
export function useServerStats(sessionId: number | null, watching: boolean): StatsView | null | "none" {
  const [shown, setShown] = useState<StatsView | null | "none">(null);
  const heard = useRef(false);
  useEffect(() => {
    if (sessionId === null || !watching) return;
    let stopped = false;
    let timer: number | undefined;
    const read = async () => {
      const now = await api.sessionStats(sessionId).catch(() => null);
      if (stopped) return;
      if (now && (now.mem_total != null || now.disk_total != null || now.uptime_secs != null)) {
        setShown(view(now));
        heard.current = true;
      } else if (!heard.current) {
        setShown("none");
      }
      timer = window.setTimeout(read, EVERY_MS);
    };
    void read();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, watching]);
  return shown;
}

/** Plain words for how long the server has been up: "41 d 3 h", "5 h 12 min". */
function uptimeText(seconds: number, ru: boolean): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const [dd, hh, mm] = ru ? ["д", "ч", "мин"] : ["d", "h", "min"];
  if (d > 0) return `${d} ${dd} ${h} ${hh}`;
  if (h > 0) return `${h} ${hh} ${m} ${mm}`;
  return `${m} ${mm}`;
}

/** A small gauge; it turns amber, then red, as the share grows. */
function Meter({ share }: { share: number }) {
  const tone = share >= 92 ? "bad" : share >= 80 ? "warn" : "";
  return (
    <span className={cx("stats-meter", tone)}>
      <i style={{ width: `${Math.max(2, Math.min(100, share))}%` }} />
    </span>
  );
}

/**
 * Advanced mode, under a terminal: the server's processor, memory, free
 * disk space, uptime and load, quietly. What the server does not tell is
 * left out.
 */
export function StatsLine({ stats }: { stats: StatsView | null | "none" }) {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const ru = locale === "ru";
  if (stats === null) return <div className="stats-bar dim">{t("stats.reading")}</div>;
  if (stats === "none") return <div className="stats-bar dim">{t("stats.none")}</div>;
  const parts = [];
  if (stats.cpu != null || stats.cores != null) {
    parts.push(
      <span key="cpu" className="stats-item" title={t("stats.cpu.hint")}>
        <Cpu size={12} />
        {t("stats.cpu")} {stats.cpu != null ? `${Math.round(stats.cpu)}%` : "…"}
        {stats.cpu != null && <Meter share={stats.cpu} />}
        {stats.cores != null && <span className="dim">{t("stats.cores", { n: stats.cores })}</span>}
      </span>,
    );
  }
  if (stats.memUsed != null && stats.memTotal) {
    const share = (stats.memUsed / stats.memTotal) * 100;
    parts.push(
      <span key="mem" className="stats-item">
        <MemoryStick size={12} />
        {t("stats.mem")} {formatSize(stats.memUsed, locale)} / {formatSize(stats.memTotal, locale)}
        <Meter share={share} />
      </span>,
    );
  }
  if (stats.diskFree != null && stats.diskTotal) {
    const share = ((stats.diskTotal - stats.diskFree) / stats.diskTotal) * 100;
    parts.push(
      <span key="disk" className="stats-item">
        <HardDrive size={12} />
        {t("stats.disk", { free: formatSize(stats.diskFree, locale), total: formatSize(stats.diskTotal, locale) })}
        <Meter share={share} />
      </span>,
    );
  }
  if (stats.uptime != null) {
    parts.push(
      <span key="up" className="stats-item">
        <Clock size={12} />
        {t("stats.uptime")} {uptimeText(stats.uptime, ru)}
        {stats.load != null && <span className="dim">· LA {stats.load.toFixed(2)}</span>}
      </span>,
    );
  }
  return <div className="stats-bar">{parts}</div>;
}
