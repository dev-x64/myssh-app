import { Cpu, HardDrive, MemoryStick, type LucideIcon } from "lucide-react";
import { useT, formatSize } from "../../lib/i18n";
import { useHostStats } from "../../lib/hostStats";
import { useSettings } from "../../lib/settings";
import type { Id } from "../../lib/api";
import { cx } from "../ui";

function share(used: number, total: number): number {
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * One column of the tile's foot: an icon and the share, and under them a
 * bar the width of the column; amber, then red, as it fills.
 */
function Gauge({ icon: Icon, value, title }: { icon: LucideIcon; value: number; title: string }) {
  const tone = value >= 92 ? "bad" : value >= 80 ? "warn" : "";
  return (
    <span className={cx("load-gauge", tone)} title={title}>
      <span className="load-top">
        <Icon size={10} className="load-icon" />
        <span className="load-value">{Math.round(value)}%</span>
      </span>
      <span className="load-bar">
        <i style={{ width: `${Math.max(2, value)}%` }} />
      </span>
    </span>
  );
}

/**
 * While the first look is under way: the three columns as they will be,
 * with a dash for each share and a light passing along the bars, so that
 * nothing moves when the numbers come.
 */
function Reading({ title }: { title: string }) {
  return (
    <div className="host-load reading" title={title} aria-busy>
      {[Cpu, MemoryStick, HardDrive].map((Icon, index) => (
        <span key={index} className="load-gauge">
          <span className="load-top">
            <Icon size={10} className="load-icon" />
            <span className="load-value">—</span>
          </span>
          <span className="load-bar">
            <i />
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Advanced mode at the foot of a host's tile: processor, memory and disk
 * in three even columns, so that they line up from tile to tile; the
 * details on hover. A word instead when there is nothing to show.
 */
export function HostLoad({ hostId }: { hostId: Id }) {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const load = useHostStats((s) => s.loads[hostId]);
  if (!load) return <Reading title={t("load.reading")} />;
  if (load.problem === "sign_in") {
    return (
      <div className="host-load dim" title={t("load.sign_in.hint")}>
        {t("load.sign_in")}
      </div>
    );
  }
  if (load.problem === "offline") return <div className="host-load dim">{t("load.offline")}</div>;
  if (load.problem === "silent" || !load.stats) return <div className="host-load dim">{t("load.silent")}</div>;
  const s = load.stats;
  return (
    <div className="host-load">
      {s.cpu_percent != null && (
        <Gauge
          icon={Cpu}
          value={s.cpu_percent}
          title={`CPU · ${s.cores ? t("load.cpu.title", { n: s.cores }) : t("stats.cpu.hint")}`}
        />
      )}
      {s.mem_total != null && s.mem_available != null && s.mem_total > 0 && (
        <Gauge
          icon={MemoryStick}
          value={share(s.mem_total - s.mem_available, s.mem_total)}
          title={`RAM · ${formatSize(s.mem_total - s.mem_available, locale)} / ${formatSize(s.mem_total, locale)}`}
        />
      )}
      {s.disk_total != null && s.disk_free != null && s.disk_total > 0 && (
        <Gauge
          icon={HardDrive}
          value={share(s.disk_total - s.disk_free, s.disk_total)}
          title={t("stats.disk", { free: formatSize(s.disk_free, locale), total: formatSize(s.disk_total, locale) })}
        />
      )}
    </div>
  );
}

/**
 * On the host's icon, in advanced mode: whether the server answered the
 * last look (green), did not (red), or could not be looked at (grey).
 */
export function OnlineDot({ hostId }: { hostId: Id }) {
  const t = useT();
  const load = useHostStats((s) => s.loads[hostId]);
  if (!load) return null;
  const state = load.problem === "offline" ? "down" : load.problem === "sign_in" ? "unknown" : "up";
  return <i className={cx("online-dot", state)} title={t(`load.${state}` as "load.up")} />;
}
