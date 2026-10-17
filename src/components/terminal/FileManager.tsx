import { Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import {
  AppWindow,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerLeftUp,
  Download,
  File as FileIcon,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderSymlink,
  House,
  Laptop,
  LocateFixed,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Server,
  SquarePen,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { api, asApiError, type ApiError, type FileEntry, type TransferProgress, type TransferSummary } from "../../lib/api";
import { appName, openExternally, stopWatching, useExternal } from "../../lib/external";
import { errorText, formatDateTime, formatSize, useT } from "../../lib/i18n";
import { LINUX, MAC, WINDOWS } from "../../lib/platform";
import { getSession } from "../../lib/sessions";
import {
  FILE_COLUMN_WIDTH,
  FILE_COLUMNS,
  useSettings,
  type FileColumn,
  type FileSort,
} from "../../lib/settings";
import { useUi, type Tab } from "../../lib/store";
import { Tip } from "../Tip";
import { FilesDemo } from "./HelpDemos";
import { Confirm, ContextMenu, cx, Field, Modal, type MenuEntry } from "../ui";

/** Matches the editor limit enforced by the core. */
const EDIT_LIMIT = 2 * 1024 * 1024;
const DRAG_TYPE = "application/x-myssh-files";
const COLUMN_DRAG = "application/x-myssh-column";
/** The name column never gets narrower than this. */
const NAME_MIN = 110;
/** Columns are shown only while the name keeps at least this much. */
const NAME_COMFORT = 160;

type Side = "local" | "remote";

/** One side of the manager: this computer, or the session's server. */
interface Source {
  side: Side;
  home: () => Promise<string>;
  resolve: (path: string) => Promise<string>;
  list: (path: string) => Promise<FileEntry[]>;
  mkdir: (dir: string, name: string) => Promise<string>;
  rename: (path: string, name: string) => Promise<string>;
  remove: (entries: FileEntry[]) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
}

const localSource: Source = {
  side: "local",
  home: api.localHome,
  resolve: api.localResolve,
  list: api.localList,
  mkdir: api.localMkdir,
  rename: api.localRename,
  remove: (entries) => api.localTrash(entries.map((entry) => entry.path)),
  chmod: api.localChmod,
};

function remoteSource(sid: number): Source {
  return {
    side: "remote",
    home: () => api.sftpHome(sid),
    resolve: (path) => api.sftpResolve(sid, path),
    list: (path) => api.sftpList(sid, path),
    mkdir: (dir, name) => api.sftpMkdir(sid, dir, name),
    rename: (path, name) => api.sftpRename(sid, path, name),
    remove: async (entries) => {
      for (const entry of entries) await api.sftpRemove(sid, entry.path);
    },
    chmod: (path, mode) => api.sftpChmod(sid, path, mode),
  };
}

/** A folder on a Windows disk: "C:\Users\me". Remote folders never look like this. */
const ON_DRIVE = /^[A-Za-z]:[\\/]/;

/** Whether there is nothing above a folder: "/", or the top of a Windows disk. */
function isTop(path: string): boolean {
  return path === "/" || /^[A-Za-z]:[\\/]?$/.test(path);
}

function parentOf(path: string): string {
  if (ON_DRIVE.test(path)) {
    const trimmed = path.replace(/[\\/]+$/, "");
    const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
    return index <= 2 ? `${trimmed.slice(0, 2)}\\` : trimmed.slice(0, index);
  }
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function describe(error: ApiError): string {
  const text = errorText(error);
  return error.detail ? `${text}: ${error.detail}` : text;
}

/** The cursor is on the ".." row rather than on an entry. */
const PARENT = "\u0000..";

/** Where an entry stands whatever the order: folders, then files, then links. */
const groupOf = (entry: FileEntry) => (entry.kind === "symlink" ? 2 : entry.is_dir ? 0 : 1);

/**
 * Folders first, then files, then links, each group ordered by the chosen
 * column; names break ties.
 */
function sortEntries(entries: FileEntry[], sort: FileSort): FileEntry[] {
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const byKey = (a: FileEntry, b: FileEntry) =>
    sort.key === "size"
      ? a.size - b.size
      : sort.key === "modified"
        ? (a.modified ?? 0) - (b.modified ?? 0)
        : byName(a, b);
  return [...entries].sort(
    (a, b) => groupOf(a) - groupOf(b) || (sort.desc ? byKey(b, a) : byKey(a, b)) || byName(a, b),
  );
}

/** `rwxr-xr-x`, with the set-id and sticky bits where `ls` shows them. */
function modeText(mode: number): string {
  const part = (bits: number, special: boolean, on: string, off: string) =>
    (bits & 4 ? "r" : "-") +
    (bits & 2 ? "w" : "-") +
    (special ? (bits & 1 ? on : off) : bits & 1 ? "x" : "-");
  return (
    part(mode >> 6, (mode & 0o4000) !== 0, "s", "S") +
    part(mode >> 3, (mode & 0o2000) !== 0, "s", "S") +
    part(mode, (mode & 0o1000) !== 0, "t", "T")
  );
}

interface PaneState {
  dir: string | null;
  draft: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  selected: Set<string>;
  /** The row keyboard actions apply to. */
  cursor: string | null;
  /** Where a Shift-click range starts. */
  anchor: string | null;
}

const EMPTY_PANE: PaneState = {
  dir: null,
  draft: "",
  entries: [],
  loading: false,
  error: null,
  selected: new Set(),
  cursor: null,
  anchor: null,
};

function usePane(source: Source | null, onDir: (dir: string) => void, sort: FileSort) {
  const [state, setState] = useState<PaneState>(EMPTY_PANE);
  const sortRef = useRef(sort);
  sortRef.current = sort;
  // A change of order rearranges what is shown; nothing is read again.
  useEffect(() => {
    setState((s) => ({ ...s, entries: sortEntries(s.entries, { key: sort.key, desc: sort.desc }) }));
  }, [sort.key, sort.desc]);
  /** Guards against a slow listing overwriting a newer one. */
  const ticket = useRef(0);
  const onDirRef = useRef(onDir);
  onDirRef.current = onDir;

  const show = useCallback(
    async (target: string, focus?: string): Promise<boolean> => {
      if (!source) return false;
      const mine = ++ticket.current;
      setState((s) => ({ ...s, loading: true }));
      try {
        const dir = await source.resolve(target);
        const entries = sortEntries(await source.list(dir), sortRef.current);
        if (mine !== ticket.current) return true;
        setState((s) => {
          const keep = (path: string | null | undefined) =>
            path && entries.some((entry) => entry.path === path) ? path : null;
          return {
            dir,
            draft: dir,
            entries,
            loading: false,
            error: null,
            selected: new Set(),
            cursor: keep(focus) ?? keep(s.cursor) ?? entries[0]?.path ?? (isTop(dir) ? null : PARENT),
            anchor: null,
          };
        });
        onDirRef.current(dir);
        return true;
      } catch (e) {
        if (mine === ticket.current) {
          setState((s) => ({ ...s, loading: false, error: describe(asApiError(e)) }));
        }
        return false;
      }
    },
    [source],
  );

  return { state, setState, show };
}

type Pane = ReturnType<typeof usePane>;

/** What an action applies to: the selection, or else the row under the cursor. */
function targetsOf(state: PaneState): FileEntry[] {
  if (state.selected.size > 0) return state.entries.filter((entry) => state.selected.has(entry.path));
  const current = state.entries.find((entry) => entry.path === state.cursor);
  return current ? [current] : [];
}

interface Transfer {
  id: number;
  name: string;
  upload: boolean;
  done: number;
  total: number;
  /** In the queue, not started yet. */
  waiting: boolean;
}

/** One item to copy, queued until there is room for it. */
interface Job {
  id: number;
  sid: number;
  entry: FileEntry;
  upload: boolean;
  destination: string;
  to: Side;
}

/**
 * How many files are copied at once, as the core does inside a folder. A
 * folder takes all of the room by itself, since it already runs that many
 * of its own files; single files share it.
 */
const COPIES_AT_ONCE = 3;
const roomFor = (job: Job) => (job.entry.is_dir ? COPIES_AT_ONCE : 1);

type ConflictAnswer = "replace" | "all" | "skip" | "skip_all" | "cancel";

type Dialog =
  | { kind: "rename"; side: Side; entry: FileEntry }
  | { kind: "folder"; side: Side }
  | { kind: "delete"; side: Side; entries: FileEntry[] }
  | { kind: "conflict"; name: string; more: boolean; answer: (answer: ConflictAnswer) => void }
  | { kind: "permissions"; side: Side; entries: FileEntry[] }
  | { kind: "open_with"; side: Side; entry: FileEntry }
  | { kind: "external" }
  | null;

let transferSeq = 1;

function NameDialog(props: {
  title: string;
  label: string;
  initial: string;
  action: string;
  onSubmit: (name: string) => Promise<ApiError | null>;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = name.trim() !== "" && !name.includes("/");

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const failure = await props.onSubmit(name.trim());
    setBusy(false);
    if (failure) setError(describe(failure));
    else props.onClose();
  };

  return (
    <Modal
      scope="tab"
      title={props.title}
      icon={<Pencil size={17} />}
      onClose={props.onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!valid || busy}>
            {props.action}
          </button>
        </>
      }
    >
      <Field label={props.label} error={error}>
        <input
          className="input"
          data-autofocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onFocus={(e) => {
            // Select the name without its extension, as Finder does.
            const dot = e.target.value.lastIndexOf(".");
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
    </Modal>
  );
}

const WHO = ["perm.owner", "perm.group", "perm.others"] as const;
const WHAT = ["perm.read", "perm.write", "perm.execute"] as const;

/** Permission bits as checkboxes and as a number, each following the other. */
function PermissionsDialog(props: {
  entries: FileEntry[];
  onApply: (mode: number) => Promise<ApiError | null>;
  onClose: () => void;
}) {
  const t = useT();
  const first = props.entries[0];
  const [mode, setMode] = useState((first.permissions ?? 0o644) & 0o7777);
  const [octal, setOctal] = useState(() => mode.toString(8).padStart(3, "0"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const octalValid = /^[0-7]{3,4}$/.test(octal);

  const toggle = (bit: number) => {
    const next = mode ^ bit;
    setMode(next);
    setOctal(next.toString(8).padStart(3, "0"));
    setError(null);
  };
  const submit = async () => {
    if (!octalValid || busy) return;
    setBusy(true);
    const failure = await props.onApply(mode);
    setBusy(false);
    if (failure) setError(describe(failure));
    else props.onClose();
  };

  return (
    <Modal
      scope="tab"
      title={
        props.entries.length === 1
          ? t("perm.title", { name: first.name })
          : t("perm.title.many", { n: props.entries.length })
      }
      icon={<LockKeyhole size={17} />}
      onClose={props.onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!octalValid || busy}>
            {t("perm.apply")}
          </button>
        </>
      }
    >
      <div className="perm-grid" role="group">
        <span />
        {WHAT.map((what) => (
          <span key={what} className="perm-head">
            {t(what)}
          </span>
        ))}
        {WHO.map((who, row) => (
          <Fragment key={who}>
            <span className="perm-who">{t(who)}</span>
            {WHAT.map((what, column) => {
              const bit = 1 << ((2 - row) * 3 + (2 - column));
              return (
                <label key={what} className="perm-box" title={`${t(who)}: ${t(what)}`}>
                  <input type="checkbox" checked={(mode & bit) !== 0} onChange={() => toggle(bit)} />
                </label>
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="perm-line">
        <Field label={t("perm.octal")} error={octalValid ? error : t("perm.octal.invalid")}>
          <input
            className="input mono"
            data-autofocus
            value={octal}
            inputMode="numeric"
            maxLength={4}
            onChange={(e) => {
              const text = e.target.value.replace(/[^0-7]/g, "");
              setOctal(text);
              setError(null);
              if (/^[0-7]{3,4}$/.test(text)) setMode(parseInt(text, 8));
            }}
          />
        </Field>
        <span className="perm-text mono">{modeText(mode)}</span>
      </div>
      {props.entries.some((entry) => entry.is_dir) && <p className="dim">{t("perm.note.dir")}</p>}
    </Modal>
  );
}

/** Which app to open a file in: one used before, or one picked now. */
function OpenWithDialog(props: {
  entry: FileEntry;
  remote: boolean;
  onOpen: (app: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const recent = useSettings((s) => s.openWithApps);
  const choose = async () => {
    // An application is a bundle in /Applications on a Mac, a program anywhere on
    // Windows, and on Linux any program, most of them in /usr/bin.
    const picked = await pickFile(
      WINDOWS
        ? { filters: [{ name: "Programs", extensions: ["exe"] }] }
        : LINUX
          ? { defaultPath: "/usr/bin" }
          : { defaultPath: "/Applications", filters: [{ name: "Applications", extensions: ["app"] }] },
    ).catch(() => null);
    if (typeof picked !== "string") return;
    const settings = useSettings.getState();
    settings.set({ openWithApps: [picked, ...settings.openWithApps.filter((app) => app !== picked)].slice(0, 6) });
    props.onOpen(picked);
  };
  return (
    <Modal
      scope="tab"
      title={t("openwith.title", { name: props.entry.name })}
      icon={<AppWindow size={17} />}
      onClose={props.onClose}
      footer={
        <button type="button" className="btn" onClick={props.onClose}>
          {t("common.cancel")}
        </button>
      }
    >
      <div className="app-list">
        <button type="button" className="app-row" data-autofocus onClick={() => props.onOpen(null)}>
          <AppWindow size={15} />
          {t("openwith.default")}
        </button>
        {recent.map((app) => (
          <button key={app} type="button" className="app-row" title={app} onClick={() => props.onOpen(app)}>
            <AppWindow size={15} />
            {appName(app)}
          </button>
        ))}
        <button type="button" className="app-row choose" onClick={() => void choose()}>
          <FolderPlus size={15} />
          {t("openwith.choose")}
        </button>
      </div>
      {props.remote && <p className="note">{t("openwith.remote_note")}</p>}
    </Modal>
  );
}

function entryIcon(entry: FileEntry) {
  if (entry.kind === "symlink") {
    return entry.is_dir ? <FolderSymlink size={15} /> : <FileSymlink size={15} />;
  }
  return entry.is_dir ? <Folder size={15} /> : <FileIcon size={15} />;
}

function PaneView(props: {
  side: Side;
  title: string;
  pane: Pane;
  active: boolean;
  available: boolean;
  unavailableText: string;
  onActivate: () => void;
  onOpen: (entry: FileEntry) => void;
  onMenu: (e: MouseEvent, entry: FileEntry | null) => void;
  onDropFrom: (from: Side) => void;
  sort: FileSort;
  onSort: (sort: FileSort) => void;
  extra?: React.ReactNode;
}) {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const parentRow = useSettings((s) => s.filesParentRow);
  const { state, setState, show } = props.pane;
  const canGoUp = props.available && state.dir !== null && !isTop(state.dir);
  const goUp = () => state.dir && void show(parentOf(state.dir), state.dir);
  // The columns after the name, in this pane's own order and widths.
  const layout = useSettings((s) => s.fileColumns[props.side]);
  const order = layout?.order ?? [...FILE_COLUMNS];
  const widths = layout?.widths ?? {};
  const saveLayout = (change: Partial<{ order: FileColumn[]; widths: Partial<Record<FileColumn, number>> }>) => {
    const settings = useSettings.getState();
    settings.set({
      fileColumns: { ...settings.fileColumns, [props.side]: { order, widths, ...change } },
    });
  };
  const paneRef = useRef<HTMLElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    const element = paneRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setPaneWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const known = [...order.filter((c) => FILE_COLUMNS.includes(c)), ...FILE_COLUMNS.filter((c) => !order.includes(c))];
  const widthOf = (column: FileColumn) => widths[column] ?? FILE_COLUMN_WIDTH[column];
  // As many columns as leave the name comfortable, in the user's order: in
  // a pane too narrow for all of them, the last ones give way.
  const columns: FileColumn[] = [];
  let room = (paneWidth || 10_000) - 28 - 20 - 8 - NAME_COMFORT;
  for (const column of known) {
    room -= widthOf(column) + 8;
    if (room < 0) break;
    columns.push(column);
  }
  const grid = `20px minmax(${NAME_MIN}px, 1fr) ${columns.map((c) => `${widthOf(c)}px`).join(" ")}`;
  const [movingOver, setMovingOver] = useState<FileColumn | null>(null);

  /**
   * Dragging the line between two columns moves it with the pointer: the
   * column on its left grows by what the one on its right gives up. Left
   * of the first column is the name, which takes whatever room there is.
   */
  const resize = (column: FileColumn, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const index = columns.indexOf(column);
    const before = index > 0 ? columns[index - 1] : null;
    const start = { own: widthOf(column), before: before ? widthOf(before) : 0 };
    const MIN = 48;
    const MAX = 480;
    // The name gives room to the first column only down to what keeps it readable.
    const nameCell = paneRef.current?.querySelector<HTMLElement>(".fm-cols > :first-child");
    const nameSpare = Math.max(0, (nameCell?.offsetWidth ?? NAME_MIN + 28) - 28 - NAME_MIN);
    const move = (moved: globalThis.MouseEvent) => {
      let shift = Math.round(moved.clientX - startX);
      // Neither column goes below what still shows something, or grows absurd.
      shift = Math.min(shift, start.own - MIN);
      shift = Math.max(shift, start.own - MAX);
      if (before) {
        shift = Math.max(shift, MIN - start.before);
        shift = Math.min(shift, MAX - start.before);
      } else {
        shift = Math.max(shift, -nameSpare);
      }
      const settings = useSettings.getState();
      const current = settings.fileColumns[props.side] ?? { order, widths: {} };
      settings.set({
        fileColumns: {
          ...settings.fileColumns,
          [props.side]: {
            ...current,
            widths: {
              ...current.widths,
              [column]: start.own - shift,
              ...(before ? { [before]: start.before + shift } : {}),
            },
          },
        },
      });
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };
  /** Dropping one heading on another moves it there: past it when dragged rightwards, before it otherwise. */
  const moveColumn = (moved: FileColumn, onto: FileColumn) => {
    if (moved === onto) return;
    const rightwards = known.indexOf(moved) < known.indexOf(onto);
    const next = known.filter((c) => c !== moved);
    next.splice(next.indexOf(onto) + (rightwards ? 1 : 0), 0, moved);
    saveLayout({ order: next });
  };

  // The same column again turns the order round; another column starts
  // from what one usually wants first: A to Z, largest, newest.
  const sortButton = (key: FileSort["key"], label: string) => (
    <button
      type="button"
      className={cx("fm-col", props.sort.key === key && "sorted")}
      onClick={() =>
        props.onSort(
          props.sort.key === key ? { key, desc: !props.sort.desc } : { key, desc: key !== "name" },
        )
      }
    >
      <span>{label}</span>
      {props.sort.key === key && (props.sort.desc ? <ChevronDown size={12} /> : <ChevronUp size={12} />)}
    </button>
  );
  const columnLabel: Record<FileColumn, string> = {
    size: t("files.size"),
    modified: t("files.modified"),
    type: t("files.type"),
    perms: t("files.perms"),
  };
  const typeText = (entry: FileEntry): string => {
    if (entry.kind === "symlink") return `→ ${entry.target ?? "?"}`;
    if (entry.is_dir) return t("files.type.dir");
    if (entry.kind === "other") return t("files.type.other");
    const dot = entry.name.lastIndexOf(".");
    const extension = dot > 0 && dot < entry.name.length - 1 ? entry.name.slice(dot + 1) : "";
    return extension && extension.length <= 8 ? t("files.type.ext", { ext: extension.toUpperCase() }) : t("files.type.file");
  };
  const cell = (column: FileColumn, entry: FileEntry) => {
    switch (column) {
      case "size":
        return <span key={column} className="file-size">{entry.is_dir ? "" : formatSize(entry.size, locale)}</span>;
      case "modified":
        return (
          <span key={column} className="file-date">
            {entry.modified ? formatDateTime(entry.modified, locale) : ""}
          </span>
        );
      case "type":
        return (
          <span key={column} className="file-type" title={entry.kind === "symlink" ? (entry.target ?? undefined) : undefined}>
            {typeText(entry)}
          </span>
        );
      case "perms":
        return (
          <span key={column} className="file-perms">
            {entry.permissions === null ? "" : modeText(entry.permissions)}
          </span>
        );
    }
  };
  const [dropping, setDropping] = useState(false);
  const cursorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.cursor]);

  const click = (e: MouseEvent, entry: FileEntry) => {
    e.stopPropagation();
    props.onActivate();
    setState((s) => {
      if (e.shiftKey && s.anchor) {
        const from = s.entries.findIndex((item) => item.path === s.anchor);
        const to = s.entries.findIndex((item) => item.path === entry.path);
        const [low, high] = from < to ? [from, to] : [to, from];
        return {
          ...s,
          cursor: entry.path,
          selected: new Set(s.entries.slice(low, high + 1).map((item) => item.path)),
        };
      }
      if (e.metaKey || e.ctrlKey) {
        const selected = new Set(s.selected);
        if (selected.has(entry.path)) selected.delete(entry.path);
        else selected.add(entry.path);
        return { ...s, cursor: entry.path, anchor: entry.path, selected };
      }
      return { ...s, cursor: entry.path, anchor: entry.path, selected: new Set() };
    });
  };

  return (
    <section
      ref={paneRef}
      style={{ "--fm-grid": grid } as React.CSSProperties}
      className={cx("fm-pane", props.active && "active", dropping && "dropping")}
      onMouseDown={props.onActivate}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const from = e.dataTransfer.getData(DRAG_TYPE) as Side;
        if (from && from !== props.side) {
          e.preventDefault();
          props.onDropFrom(from);
        }
      }}
    >
      <header className="fm-head">
        <span className="fm-where">
          {props.side === "local" ? <Laptop size={14} /> : <Server size={14} />}
          <span>{props.title}</span>
        </span>
        {props.extra}
        <button
          className="btn ghost icon small"
          title={t("files.home")}
          disabled={!props.available}
          onClick={() => void show("~").then((ok) => ok || show("."))}
        >
          <House size={14} />
        </button>
        <button
          className="btn ghost icon small"
          title={t("files.refresh")}
          disabled={!props.available || !state.dir}
          onClick={() => state.dir && void show(state.dir)}
        >
          <RefreshCw size={14} className={cx(state.loading && "spin")} />
        </button>
      </header>

      <form
        className="path-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (state.draft.trim()) void show(state.draft.trim());
        }}
      >
        <button
          type="button"
          className="btn ghost icon small"
          title={t("files.up")}
          disabled={!canGoUp}
          onClick={goUp}
        >
          <ArrowUp size={15} />
        </button>
        <input
          className="input mono"
          value={state.draft}
          disabled={!props.available}
          aria-label={t("files.path")}
          onChange={(e) => setState((s) => ({ ...s, draft: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setState((s) => ({ ...s, draft: s.dir ?? "" }));
              e.currentTarget.blur();
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </form>

      {state.error && <div className="files-error selectable">{state.error}</div>}

      <div className="fm-cols">
        {sortButton("name", t("files.name"))}
        {columns.map((column) => (
          <div
            key={column}
            className={cx("fm-col-cell", column, movingOver === column && "over")}
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.setData(COLUMN_DRAG, column);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(COLUMN_DRAG)) return;
              e.preventDefault();
              e.stopPropagation();
              setMovingOver(column);
            }}
            onDragLeave={() => setMovingOver(null)}
            onDrop={(e) => {
              const moved = e.dataTransfer.getData(COLUMN_DRAG) as FileColumn;
              setMovingOver(null);
              if (!moved) return;
              e.preventDefault();
              e.stopPropagation();
              moveColumn(moved, column);
            }}
          >
            <span className="fm-col-grip" onMouseDown={(e) => resize(column, e)} />
            {column === "size" || column === "modified" ? (
              sortButton(column, columnLabel[column])
            ) : (
              <span className="fm-col">{columnLabel[column]}</span>
            )}
          </div>
        ))}
      </div>

      <div
        className="fm-list scroll"
        onClick={() => setState((s) => ({ ...s, selected: new Set() }))}
        onContextMenu={(e) => props.onMenu(e, null)}
      >
        {!props.available ? (
          <div className="side-note">{props.unavailableText}</div>
        ) : state.dir === null ? (
          <div className="side-note">{state.error ? "" : t("files.loading")}</div>
        ) : (
          <>
            {parentRow && canGoUp && (
              <div
                ref={state.cursor === PARENT ? cursorRef : undefined}
                role="row"
                className={cx("file-row dir parent", state.cursor === PARENT && "cursor")}
                title={t("files.up")}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onActivate();
                  setState((s) => ({ ...s, cursor: PARENT, anchor: null, selected: new Set() }));
                }}
                onDoubleClick={goUp}
                onContextMenu={(e) => {
                  e.stopPropagation();
                  props.onMenu(e, null);
                }}
              >
                <span className="file-icon">
                  <CornerLeftUp size={15} />
                </span>
                <span className="file-name">..</span>
              </div>
            )}
            {state.entries.length === 0 && <div className="side-note">{t("files.empty")}</div>}
            {state.entries.map((entry) => (
            <div
              key={entry.path}
              ref={state.cursor === entry.path ? cursorRef : undefined}
              role="row"
              aria-selected={state.selected.has(entry.path)}
              className={cx(
                "file-row",
                entry.is_dir && "dir",
                state.selected.has(entry.path) && "selected",
                state.cursor === entry.path && "cursor",
              )}
              draggable
              onDragStart={(e) => {
                // Dragging a row outside the selection drags just that row.
                if (!state.selected.has(entry.path)) {
                  setState((s) => ({ ...s, cursor: entry.path, anchor: entry.path, selected: new Set() }));
                }
                e.dataTransfer.setData(DRAG_TYPE, props.side);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={(e) => click(e, entry)}
              onDoubleClick={() => props.onOpen(entry)}
              onContextMenu={(e) => {
                e.stopPropagation();
                props.onMenu(e, entry);
              }}
            >
              <span className="file-icon">{entryIcon(entry)}</span>
              <span className="file-name">{entry.name}</span>
              {columns.map((column) => cell(column, entry))}
            </div>
            ))}
          </>
        )}
      </div>

      <footer className="fm-foot">
        {state.selected.size > 0
          ? t("files.selected", { n: state.selected.size })
          : t("files.items", { n: state.entries.length })}
      </footer>
    </section>
  );
}

/**
 * Two-pane file manager over the terminal: this computer on the left, the
 * session's server on the right, on the terminal's own connection.
 */
export function FileManager({ tab }: { tab: Tab }) {
  const t = useT();
  const patchTab = useUi((s) => s.patchTab);
  const toast = useUi((s) => s.toast);
  const session = getSession(tab.id);
  const sid = tab.status === "connected" ? (session?.liveSessionId ?? null) : null;
  const remote = useMemo(() => (sid === null ? null : remoteSource(sid)), [sid]);

  const sortLocal = useSettings((s) => s.fileSortLocal);
  const sortRemote = useSettings((s) => s.fileSortRemote);
  const parentRow = useSettings((s) => s.filesParentRow);
  const local = usePane(localSource, (dir) => useSettings.getState().set({ localDir: dir }), sortLocal);
  const server = usePane(remote, (dir) => patchTab(tab.id, { filesDir: dir }), sortRemote);
  const external = useExternal((s) => s.files).filter((file) => file.tabId === tab.id);
  const panes: Record<Side, Pane> = { local, remote: server };

  const [active, setActive] = useState<Side>("remote");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const root = useRef<HTMLDivElement>(null);
  // The copy queue. Kept in refs: jobs outlive the render they started in.
  const waiting = useRef<Job[]>([]);
  const running = useRef(new Map<number, number>());
  /** An answer given "for all", which holds until the queue is empty. */
  const forAll = useRef<"replace" | "skip" | null>(null);
  /** Questions about existing items, one at a time. */
  const asking = useRef<Promise<unknown>>(Promise.resolve());
  const tally = useRef({ uploaded: 0, downloaded: 0, skipped: 0 });

  const other = (side: Side): Side => (side === "local" ? "remote" : "local");
  const sourceOf = (side: Side) => (side === "local" ? localSource : remote);

  // This computer: where we were last time, else home.
  useEffect(() => {
    void (async () => {
      const last = useSettings.getState().localDir;
      if (last && (await local.show(last))) return;
      await local.show("~");
    })();
    // Runs once: the local side does not depend on the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The server: the terminal's directory if wanted and known, else the last
  // directory shown here, else home. After a reconnection: stay put.
  const opened = useRef(false);
  const lastRemote = useRef(tab.filesDir);
  lastRemote.current = server.state.dir ?? tab.filesDir;
  const showRemote = server.show;
  useEffect(() => {
    if (!remote || !session) return;
    let cancelled = false;
    void (async () => {
      const candidates: (string | null)[] = [];
      if (!opened.current && useSettings.getState().filesFollowTerminal) {
        candidates.push(await session.workingDirectory());
      }
      opened.current = true;
      candidates.push(lastRemote.current);
      for (const candidate of candidates) {
        if (cancelled) return;
        if (candidate && (await showRemote(candidate))) return;
      }
      if (!cancelled) await showRemote(".");
    })();
    return () => {
      cancelled = true;
    };
  }, [remote, session, showRemote]);

  useEffect(() => {
    if (!dialog && !menu) root.current?.focus();
  }, [dialog, menu]);

  const refresh = (side: Side) => {
    const dir = panes[side].state.dir;
    if (dir) void panes[side].show(dir);
  };

  const toTerminalDir = async () => {
    const cwd = await session?.workingDirectory();
    if (cwd) void server.show(cwd);
    else toast("info", t("files.to_terminal.unknown"));
  };

  const askConflict = (name: string, more: boolean) =>
    new Promise<ConflictAnswer>((resolve) => {
      setDialog({
        kind: "conflict",
        name,
        more,
        answer: (answer) => {
          setDialog(null);
          resolve(answer);
        },
      });
    });

  /** Whether anything besides the job asking is queued or under way. */
  const othersPending = () => waiting.current.length + running.current.size > 1;

  /** Asks about an existing item; questions wait for each other. */
  const askInTurn = (name: string) => {
    const turn = asking.current.then((): Promise<ConflictAnswer> | ConflictAnswer =>
      forAll.current === "replace"
        ? "replace"
        : forAll.current === "skip"
          ? "skip"
          : askConflict(name, othersPending()),
    );
    asking.current = turn.catch(() => {});
    return turn;
  };

  const drop = (id: number) => setTransfers((list) => list.filter((item) => item.id !== id));

  /** Takes the queued jobs off the queue, unstarted. */
  const dropWaiting = () => {
    const dropped = new Set(waiting.current.map((job) => job.id));
    waiting.current = [];
    setTransfers((list) => list.filter((item) => !dropped.has(item.id)));
  };

  const runJob = async (job: Job) => {
    const attempt = async (overwrite: boolean) => {
      const progress = new Channel<TransferProgress>();
      progress.onmessage = (p) =>
        setTransfers((list) => list.map((item) => (item.id === job.id ? { ...item, ...p } : item)));
      // Read at the moment of copying, so a change in settings applies at once.
      const archive = useSettings.getState().filesArchive && job.entry.is_dir;
      return job.upload
        ? await api.sftpUpload(job.sid, job.entry.path, job.destination, overwrite, job.id, progress, archive)
        : await api.sftpDownload(job.sid, job.entry.path, job.destination, overwrite, job.id, progress, archive);
    };
    const done = (summary: TransferSummary) => {
      tally.current[job.upload ? "uploaded" : "downloaded"] += 1;
      tally.current.skipped += summary.skipped;
    };
    const failed = (e: unknown) => {
      const failure = asApiError(e);
      if (failure.code !== "cancelled") {
        toast("error", `${job.entry.name}: ${errorText(failure)}`, failure.detail ?? undefined);
      }
    };
    try {
      done(await attempt(forAll.current === "replace"));
    } catch (e) {
      if (asApiError(e).code !== "already_exists") return failed(e);
      const answer = await askInTurn(job.entry.name);
      if (answer === "all") forAll.current = "replace";
      if (answer === "skip_all") forAll.current = "skip";
      if (answer === "cancel") dropWaiting();
      if (answer !== "replace" && answer !== "all") return;
      try {
        done(await attempt(true));
      } catch (retry) {
        failed(retry);
      }
    } finally {
      drop(job.id);
      refresh(job.to);
    }
  };

  /** Starts queued jobs while there is room, in the order they came. */
  const pump = () => {
    while (waiting.current.length > 0) {
      const job = waiting.current[0];
      const used = [...running.current.values()].reduce((sum, room) => sum + room, 0);
      if (running.current.size > 0 && used + roomFor(job) > COPIES_AT_ONCE) break;
      waiting.current.shift();
      running.current.set(job.id, roomFor(job));
      setTransfers((list) => list.map((item) => (item.id === job.id ? { ...item, waiting: false } : item)));
      void runJob(job).finally(() => {
        running.current.delete(job.id);
        pump();
        if (waiting.current.length === 0 && running.current.size === 0) finished();
      });
    }
  };

  /** The queue has emptied: say what was copied, and forget answers given for all. */
  const finished = () => {
    const { uploaded, downloaded, skipped } = tally.current;
    const note = skipped > 0 ? t("files.skipped", { n: skipped }) : undefined;
    if (uploaded > 0) toast("success", t("files.uploaded", { n: uploaded }), note);
    if (downloaded > 0) toast("success", t("files.downloaded", { n: downloaded }), uploaded > 0 ? undefined : note);
    tally.current = { uploaded: 0, downloaded: 0, skipped: 0 };
    forAll.current = null;
  };

  /**
   * Copies entries from one side to the directory shown on the other. They
   * join the queue: a copy started while another runs waits its turn.
   */
  const copy = (from: Side, entries: FileEntry[]) => {
    const to = other(from);
    const destination = panes[to].state.dir;
    if (sid === null || !destination || entries.length === 0) return;
    const upload = from === "local";
    const jobs = entries.map((entry) => ({ id: transferSeq++, sid, entry, upload, destination, to }));
    waiting.current.push(...jobs);
    setTransfers((list) => [
      ...list,
      ...jobs.map((job) => ({ id: job.id, name: job.entry.name, upload, done: 0, total: 0, waiting: true })),
    ]);
    pump();
  };

  /** Stops a copy: one under way is cancelled, one in the queue just leaves it. */
  const cancelTransfer = (id: number) => {
    const queued = waiting.current.findIndex((job) => job.id === id);
    if (queued >= 0) {
      waiting.current.splice(queued, 1);
      drop(id);
    } else {
      void api.transferCancel(id);
    }
  };

  const edit = (entry: FileEntry) => {
    if (entry.size > EDIT_LIMIT) {
      toast("info", t("files.too_large_to_edit"));
      return;
    }
    patchTab(tab.id, { editor: { path: entry.path, name: entry.name }, editorDirty: false });
  };

  const fail = (name: string, failure: ApiError) =>
    toast("error", `${name}: ${errorText(failure)}`, failure.detail ?? undefined);

  /** Opens a file in another app: a local one as it is, a remote one through a working copy. */
  const openIn = async (side: Side, entry: FileEntry, app: string | null) => {
    if (side === "local") {
      await api.localOpen(entry.path, app).catch((e) => fail(entry.name, asApiError(e)));
      return;
    }
    if (sid === null) return;
    const failure = await openExternally(tab.id, sid, entry.path, entry.name, app);
    if (failure) fail(entry.name, failure);
    else toast("info", t("openwith.opened", { name: entry.name }));
  };

  const open = (side: Side, entry: FileEntry) => {
    if (entry.is_dir) void panes[side].show(entry.path);
    else if (entry.kind === "other") return;
    else if (side === "remote") edit(entry);
    else void openIn("local", entry, null);
  };

  const attempt = async (side: Side, action: () => Promise<unknown>): Promise<ApiError | null> => {
    try {
      await action();
      refresh(side);
      return null;
    } catch (e) {
      return asApiError(e);
    }
  };

  const close = () => {
    patchTab(tab.id, { files: false });
    session?.focus();
  };

  const actOn = (side: Side) => {
    const state = panes[side].state;
    const targets = targetsOf(state);
    const single = targets.length === 1 ? targets[0] : null;
    const usable = side === "local" || sid !== null;
    return {
      canCopy: usable && sid !== null && targets.length > 0 && panes[other(side)].state.dir !== null,
      canRename: usable && single !== null,
      canEdit: side === "remote" && sid !== null && single !== null && !single.is_dir,
      canFolder: usable && state.dir !== null,
      canDelete: usable && targets.length > 0,
      copy: () => void copy(side, targets),
      rename: () => single && setDialog({ kind: "rename", side, entry: single }),
      edit: () => single && edit(single),
      folder: () => setDialog({ kind: "folder", side }),
      remove: () => targets.length > 0 && setDialog({ kind: "delete", side, entries: targets }),
    };
  };
  const act = actOn(active);

  const showMenu = (side: Side, e: MouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    setActive(side);
    const pane = panes[side];
    // A right-click outside the selection acts on the clicked row alone.
    let targets = entry ? [entry] : [];
    if (entry && pane.state.selected.has(entry.path)) targets = targetsOf(pane.state);
    else if (entry) pane.setState((s) => ({ ...s, cursor: entry.path, anchor: entry.path, selected: new Set() }));
    const usable = side === "local" || sid !== null;
    const items: MenuEntry[] = [];
    if (entry) {
      if (entry.is_dir && targets.length === 1) {
        items.push({ label: t("files.open"), icon: <Folder size={14} />, onSelect: () => open(side, entry) });
      } else if (targets.length === 1 && entry.kind !== "other") {
        items.push(
          side === "remote"
            ? { label: t("files.edit"), icon: <SquarePen size={14} />, onSelect: () => edit(entry) }
            : { label: t("files.open"), icon: <FileIcon size={14} />, onSelect: () => open(side, entry) },
        );
        if (usable) {
          items.push({
            label: t("files.open_with"),
            icon: <AppWindow size={14} />,
            onSelect: () => setDialog({ kind: "open_with", side, entry }),
          });
        }
      }
      if (sid !== null && panes[other(side)].state.dir) {
        items.push({
          label: t(side === "local" ? "files.copy_to_server" : "files.copy_to_mac"),
          icon: side === "local" ? <Upload size={14} /> : <Download size={14} />,
          onSelect: () => void copy(side, targets),
        });
      }
      if (targets.length === 1) {
        items.push({
          label: t("files.copy_path"),
          icon: <Copy size={14} />,
          onSelect: () => void writeText(entry.path).catch(() => {}),
        });
        items.push({
          label: t("common.rename"),
          icon: <Pencil size={14} />,
          separatorBefore: true,
          onSelect: () => setDialog({ kind: "rename", side, entry }),
        });
      }
      if (usable) {
        items.push({
          label: t("files.permissions"),
          icon: <LockKeyhole size={14} />,
          separatorBefore: targets.length !== 1,
          onSelect: () => setDialog({ kind: "permissions", side, entries: targets }),
        });
      }
      items.push({
        label: t(side === "local" ? "files.trash" : "common.delete"),
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => setDialog({ kind: "delete", side, entries: targets }),
      });
    }
    if (usable && pane.state.dir) {
      items.push({
        label: t("files.new_folder"),
        icon: <FolderPlus size={14} />,
        separatorBefore: items.length > 0,
        onSelect: () => setDialog({ kind: "folder", side }),
      });
      items.push({
        label: t("files.refresh"),
        icon: <RefreshCw size={14} />,
        onSelect: () => refresh(side),
      });
    }
    if (items.length > 0) setMenu({ x: e.clientX, y: e.clientY, entries: items });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (dialog || menu) return;
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (typing) return;
    const pane = panes[active];
    const { entries, cursor } = pane.state;
    const index = entries.findIndex((entry) => entry.path === cursor);
    const hasParent = parentRow && pane.state.dir !== null && !isTop(pane.state.dir);
    const goUp = () => {
      if (pane.state.dir && !isTop(pane.state.dir)) void pane.show(parentOf(pane.state.dir), pane.state.dir);
    };
    const move = (to: number, select: boolean) => {
      // Above the first entry is the ".." row, when it is shown.
      if (to < 0 && hasParent) {
        pane.setState((s) => ({ ...s, cursor: PARENT, anchor: null }));
        return;
      }
      const next = entries[Math.max(0, Math.min(entries.length - 1, to))];
      if (!next) return;
      pane.setState((s) => {
        const selected = new Set(s.selected);
        if (select && cursor) {
          if (selected.has(cursor)) selected.delete(cursor);
          else selected.add(cursor);
        }
        return { ...s, cursor: next.path, anchor: next.path, selected };
      });
    };
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "Tab":
        handled();
        setActive(other(active));
        break;
      case "ArrowDown":
        handled();
        move(index + 1, e.shiftKey);
        break;
      case "ArrowUp":
        handled();
        move(index - 1, e.shiftKey);
        break;
      case "Home":
        handled();
        move(hasParent ? -1 : 0, false);
        break;
      case "End":
        handled();
        move(entries.length - 1, false);
        break;
      case " ":
        // Space marks the row and moves on, as in orthodox file managers.
        handled();
        move(index + 1, true);
        break;
      case "Enter": {
        handled();
        const current = entries[index];
        if (cursor === PARENT) goUp();
        else if (current) open(active, current);
        break;
      }
      case "Backspace":
        handled();
        if (MAC ? e.metaKey : e.ctrlKey) act.remove();
        else goUp();
        break;
      case "a":
        if (MAC ? e.metaKey : e.ctrlKey) {
          handled();
          pane.setState((s) => ({ ...s, selected: new Set(s.entries.map((entry) => entry.path)) }));
        }
        break;
      case "F2":
        handled();
        if (act.canRename) act.rename();
        break;
      case "F4":
        handled();
        if (act.canEdit) act.edit();
        break;
      case "F5":
        handled();
        if (act.canCopy) act.copy();
        break;
      case "F7":
        handled();
        if (act.canFolder) act.folder();
        break;
      case "F8":
      case "Delete":
        handled();
        if (act.canDelete) act.remove();
        break;
      case "Escape":
        handled();
        if (pane.state.selected.size > 0) pane.setState((s) => ({ ...s, selected: new Set() }));
        else close();
        break;
    }
  };

  const deleting = dialog?.kind === "delete" ? dialog : null;

  return (
    <div className="fm" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
      <Tip id="files" title={t("tip.files.title")} className="tip-bar" art={<FilesDemo />}>
        {t("tip.files.text")}
      </Tip>
      <div className="fm-panes">
        <PaneView
          side="local"
          title={t("files.this_mac")}
          pane={local}
          active={active === "local"}
          available
          unavailableText=""
          onActivate={() => setActive("local")}
          onOpen={(entry) => open("local", entry)}
          onMenu={(e, entry) => showMenu("local", e, entry)}
          onDropFrom={(from) => void copy(from, targetsOf(panes[from].state))}
          sort={sortLocal}
          onSort={(fileSortLocal) => useSettings.getState().set({ fileSortLocal })}
        />
        <PaneView
          side="remote"
          title={tab.title}
          pane={server}
          active={active === "remote"}
          available={sid !== null}
          unavailableText={t("files.offline")}
          onActivate={() => setActive("remote")}
          onOpen={(entry) => open("remote", entry)}
          onMenu={(e, entry) => showMenu("remote", e, entry)}
          onDropFrom={(from) => void copy(from, targetsOf(panes[from].state))}
          sort={sortRemote}
          onSort={(fileSortRemote) => useSettings.getState().set({ fileSortRemote })}
          extra={
            <button
              className="btn ghost icon small"
              title={t("files.to_terminal")}
              disabled={sid === null}
              onClick={() => void toTerminalDir()}
            >
              <LocateFixed size={14} />
            </button>
          }
        />
      </div>

      {transfers.length > 0 && (
        <div className="transfers">
          {transfers.map((transfer) => (
            <Progress key={transfer.id} transfer={transfer} onCancel={() => cancelTransfer(transfer.id)} />
          ))}
        </div>
      )}

      <div className="fm-bar">
        <button className="fm-key" disabled={!act.canRename} onClick={act.rename}>
          <kbd>F2</kbd>
          {t("common.rename")}
        </button>
        <button className="fm-key" disabled={!act.canEdit} onClick={act.edit}>
          <kbd>F4</kbd>
          {t("files.edit")}
        </button>
        <button className="fm-key" disabled={!act.canCopy} onClick={act.copy}>
          <kbd>F5</kbd>
          {t(active === "local" ? "files.copy_to_server" : "files.copy_to_mac")}
        </button>
        <button className="fm-key" disabled={!act.canFolder} onClick={act.folder}>
          <kbd>F7</kbd>
          {t("files.new_folder")}
        </button>
        <button className="fm-key" disabled={!act.canDelete} onClick={act.remove}>
          <kbd>F8</kbd>
          {t(active === "local" ? "files.trash" : "common.delete")}
        </button>
        <span className="grow" />
        {external.length > 0 && (
          <button className="fm-key external" onClick={() => setDialog({ kind: "external" })}>
            <AppWindow size={13} />
            {t("external.chip", { n: external.length })}
          </button>
        )}
        <button className="fm-key" onClick={close}>
          <kbd>Esc</kbd>
          {t("files.back_to_terminal")}
        </button>
      </div>

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}

      {dialog?.kind === "rename" && (
        <NameDialog
          title={t("files.rename.title")}
          label={t("files.rename.label")}
          initial={dialog.entry.name}
          action={t("common.rename")}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            const source = sourceOf(dialog.side);
            return source
              ? attempt(dialog.side, () => source.rename(dialog.entry.path, name))
              : Promise.resolve(null);
          }}
        />
      )}
      {dialog?.kind === "folder" && (
        <NameDialog
          title={t("files.folder.title")}
          label={t("files.folder.label")}
          initial=""
          action={t("common.create")}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            const source = sourceOf(dialog.side);
            const dir = panes[dialog.side].state.dir;
            return source && dir
              ? attempt(dialog.side, () => source.mkdir(dir, name))
              : Promise.resolve(null);
          }}
        />
      )}
      {deleting && (
        <Confirm
          danger
          scope="tab"
          title={
            deleting.entries.length === 1
              ? t("files.delete.title", { name: deleting.entries[0].name })
              : t("files.delete.many", { n: deleting.entries.length })
          }
          text={t(
            deleting.side === "local"
              ? "files.delete.local"
              : deleting.entries.length === 1 && deleting.entries[0].kind === "symlink"
                ? "files.delete.link"
                : deleting.entries.some((entry) => entry.kind === "dir")
                  ? "files.delete.dir"
                  : "files.delete.file",
          )}
          confirmLabel={t(deleting.side === "local" ? "files.trash" : "common.delete")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            setDialog(null);
            const source = sourceOf(deleting.side);
            if (!source) return;
            const failure = await attempt(deleting.side, () => source.remove(deleting.entries));
            if (failure) {
              toast("error", errorText(failure), failure.detail ?? undefined);
              refresh(deleting.side);
            } else {
              toast("success", t(deleting.side === "local" ? "files.trashed" : "files.deleted"));
            }
          }}
        />
      )}
      {dialog?.kind === "permissions" && (
        <PermissionsDialog
          entries={dialog.entries}
          onClose={() => setDialog(null)}
          onApply={async (mode) => {
            const source = sourceOf(dialog.side);
            if (!source) return null;
            const failure = await attempt(dialog.side, async () => {
              for (const entry of dialog.entries) await source.chmod(entry.path, mode);
            });
            if (failure) refresh(dialog.side);
            else toast("success", t("perm.changed"));
            return failure;
          }}
        />
      )}
      {dialog?.kind === "open_with" && (
        <OpenWithDialog
          entry={dialog.entry}
          remote={dialog.side === "remote"}
          onClose={() => setDialog(null)}
          onOpen={(app) => {
            const { side, entry } = dialog;
            setDialog(null);
            void openIn(side, entry, app);
          }}
        />
      )}
      {dialog?.kind === "external" && (
        <Modal
          scope="tab"
          wide
          title={t("external.title")}
          icon={<AppWindow size={17} />}
          onClose={() => setDialog(null)}
          footer={
            <button type="button" className="btn" data-autofocus onClick={() => setDialog(null)}>
              {t("common.close")}
            </button>
          }
        >
          <p>{t("external.text")}</p>
          <div className="external-list">
            {external.map((file) => (
              <div key={file.id} className="external-row">
                <div className="external-main">
                  <div className="external-name">{file.name}</div>
                  <div className="external-path selectable">
                    {file.app ? `${file.app} · ` : ""}
                    {file.remote}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    stopWatching(file.id);
                    if (external.length === 1) setDialog(null);
                  }}
                >
                  {t("external.stop")}
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {dialog?.kind === "conflict" && (
        <Modal
          scope="tab"
          danger
          wide
          title={t("files.overwrite.title", { name: dialog.name })}
          icon={<Copy size={17} />}
          onClose={() => dialog.answer("cancel")}
          footer={
            <>
              <button type="button" className="btn" onClick={() => dialog.answer("cancel")}>
                {t("common.cancel")}
              </button>
              <span style={{ flex: 1 }} />
              {dialog.more && (
                <button type="button" className="btn" onClick={() => dialog.answer("skip_all")}>
                  {t("files.overwrite.skip_all")}
                </button>
              )}
              {dialog.more && (
                <button type="button" className="btn danger" onClick={() => dialog.answer("all")}>
                  {t("files.overwrite.all")}
                </button>
              )}
              <button type="button" className="btn danger" onClick={() => dialog.answer("replace")}>
                {t("files.overwrite.action")}
              </button>
              <button type="button" className="btn primary" data-autofocus onClick={() => dialog.answer("skip")}>
                {t("files.overwrite.skip")}
              </button>
            </>
          }
        >
          <p>{t("files.overwrite.text")}</p>
        </Modal>
      )}
    </div>
  );
}

function Progress({ transfer, onCancel }: { transfer: Transfer; onCancel: () => void }) {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  return (
    <div className="transfer">
      {transfer.upload ? <Upload size={13} /> : <Download size={13} />}
      <div className="transfer-main">
        <div className="transfer-name">{transfer.name}</div>
        <div className="bar">
          <span style={{ width: `${transfer.total ? (transfer.done / transfer.total) * 100 : 0}%` }} />
        </div>
      </div>
      <span className="transfer-size">
        {transfer.waiting
          ? t("files.transfer.waiting")
          : `${formatSize(transfer.done, locale)}${transfer.total ? ` / ${formatSize(transfer.total, locale)}` : ""}`}
      </span>
      <button className="btn ghost icon small" title={t("files.transfer.cancel")} onClick={onCancel}>
        <X size={13} />
      </button>
    </div>
  );
}
