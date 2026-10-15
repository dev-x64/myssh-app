// Device-local preferences.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Locale } from "./i18n";
import { WINDOWS } from "./platform";

export type AppTheme = "dark" | "light" | "system";
export type CursorStyle = "block" | "bar" | "underline";

/** The fonts offered for the terminal: the one that comes with the app, then those the system has. */
export const FONT_CHOICES: { id: string; stack: string }[] = [
  { id: "JetBrains Mono", stack: '"JetBrains Mono", "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace' },
  ...(WINDOWS
    ? [
        { id: "Cascadia Mono", stack: '"Cascadia Mono", Consolas, monospace' },
        { id: "Consolas", stack: 'Consolas, "Courier New", monospace' },
      ]
    : [
        { id: "SF Mono", stack: '"SF Mono", SFMono-Regular, Menlo, monospace' },
        { id: "Menlo", stack: "Menlo, Monaco, monospace" },
        { id: "Monaco", stack: "Monaco, Menlo, monospace" },
      ]),
  { id: "Courier New", stack: '"Courier New", Courier, monospace' },
];

export const FONT_SIZE = { min: 9, max: 28, default: 13 };

/** The colour that marks what is active or chosen. */
export const ACCENTS = ["orange", "blue", "violet", "green", "teal", "pink", "amber", "graphite"] as const;
export type Accent = (typeof ACCENTS)[number];
/** Each one's colour; its lighter, softer and darker forms are worked out in the stylesheet. */
export const ACCENT_COLOR: Record<Accent, string> = {
  orange: "#ff7a45",
  blue: "#4c8dff",
  violet: "#8b7cf6",
  green: "#3ecf8e",
  teal: "#22c3c3",
  pink: "#f472b6",
  amber: "#f5b83d",
  graphite: "#a7b0c0",
};

/**
 * The terminal cursor's colour: the colour scheme's own, one of the accent
 * colours, or the colour of the text (light on a dark scheme, dark on a light one).
 */
export const CURSOR_COLORS = ["scheme", ...ACCENTS, "text"] as const;
export type CursorColor = (typeof CURSOR_COLORS)[number];

export function cursorColorOf(choice: CursorColor, scheme: { cursor?: string; foreground?: string }): string {
  const own = scheme.cursor ?? scheme.foreground ?? "#ffffff";
  if (choice === "scheme") return own;
  if (choice === "text") return scheme.foreground ?? own;
  return ACCENT_COLOR[choice] ?? own;
}

/** The columns of a file list beside the name, which always comes first. */
export const FILE_COLUMNS = ["size", "modified", "type", "perms"] as const;
export type FileColumn = (typeof FILE_COLUMNS)[number];
export const FILE_COLUMN_WIDTH: Record<FileColumn, number> = { size: 76, modified: 132, type: 110, perms: 80 };

export interface FileColumnLayout {
  /** Left to right, after the name. */
  order: FileColumn[];
  /** Widths in pixels, where changed from the usual. */
  widths: Partial<Record<FileColumn, number>>;
}

/** How a pane of the file manager is ordered; folders always come first. */
export interface FileSort {
  key: "name" | "size" | "modified";
  desc: boolean;
}

export interface Settings {
  locale: Locale;
  theme: AppTheme;
  accent: Accent;
  termTheme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  cursorColor: CursorColor;
  scrollback: number;
  copyOnSelect: boolean;
  autoReconnect: boolean;
  /** Open the files panel in the terminal's current directory. */
  filesFollowTerminal: boolean;
  /** Local directory last shown in the file manager. */
  localDir: string | null;
  /** Show ".." as the first row of a file list, to go up a level. */
  filesParentRow: boolean;
  /** Folders go as one tar stream rather than file by file, where the server has tar. */
  filesArchive: boolean;
  fileSortLocal: FileSort;
  fileSortRemote: FileSort;
  /** Apps recently chosen in "Open with", newest first. */
  openWithApps: string[];
  /** The columns of each pane of the file manager; the two are set up apart. */
  fileColumns: Record<"local" | "remote", FileColumnLayout>;
  /** Suggest commands while typing, and remember commands for that. */
  suggestions: boolean;
  /** With Pro: ask the AI as well, after a pause in typing. */
  aiSuggestions: boolean;
  /** Colour IP addresses in terminal output. */
  highlightIp: boolean;
  /** Colour words that say something failed, warns or succeeded. */
  highlightStatus: boolean;
  /** Web addresses in the terminal: coloured, and opened with a Cmd-click. */
  terminalLinks: boolean;
  /** Shared sessions: inviting people into a terminal, and joining by invitation. */
  sharing: boolean;
  /** The sign-in screen shown on first launch has been answered. */
  welcomed: boolean;
  /** The setup shown on first launch (look, terminal, account) has been gone through. */
  setupDone: boolean;
  /** Advanced mode: each server's load, memory, disk and uptime, where the two below say. */
  serverStats: boolean;
  /** Advanced mode on the hosts' tiles. */
  statsTiles: boolean;
  /** Advanced mode under the terminal. */
  statsBar: boolean;
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  bumpFontSize: (delta: number) => void;
}

function systemLocale(): Locale {
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      locale: systemLocale(),
      theme: "dark",
      accent: "orange",
      termTheme: "auto",
      fontFamily: "JetBrains Mono",
      fontSize: FONT_SIZE.default,
      lineHeight: 1.2,
      cursorStyle: "block",
      cursorBlink: true,
      cursorColor: "scheme",
      scrollback: 10000,
      copyOnSelect: false,
      autoReconnect: true,
      filesFollowTerminal: true,
      localDir: null,
      filesParentRow: true,
      filesArchive: false,
      fileSortLocal: { key: "name", desc: false },
      fileSortRemote: { key: "name", desc: false },
      openWithApps: [],
      fileColumns: {
        local: { order: [...FILE_COLUMNS], widths: {} },
        remote: { order: [...FILE_COLUMNS], widths: {} },
      },
      suggestions: true,
      aiSuggestions: true,
      highlightIp: true,
      highlightStatus: true,
      terminalLinks: true,
      sharing: false,
      welcomed: false,
      setupDone: false,
      serverStats: false,
      statsTiles: true,
      statsBar: true,
      set: (patch) => set(patch),
      bumpFontSize: (delta) =>
        set((s) => ({
          fontSize:
            delta === 0
              ? FONT_SIZE.default
              : Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, s.fontSize + delta)),
        })),
    }),
    {
      name: "myssh.settings",
      version: 2,
      // Settings kept from before the first-launch setup existed belong to
      // someone who is past their first launch.
      migrate: (persisted, version) =>
        (version < 2 ? { ...(persisted as object), setupDone: true } : persisted) as SettingsStore,
    },
  ),
);

export function fontStack(id: string): string {
  return (FONT_CHOICES.find((f) => f.id === id) ?? FONT_CHOICES[0]).stack;
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function isDark(theme: AppTheme): boolean {
  return theme === "system" ? darkQuery.matches : theme === "dark";
}

/** Subscribes to the effective dark/light state, including system changes. */
export function onSystemThemeChange(listener: () => void): () => void {
  darkQuery.addEventListener("change", listener);
  return () => darkQuery.removeEventListener("change", listener);
}
