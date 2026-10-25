// The preview's own panel, in the bottom left corner: which state the
// window pretends to be in. Plain DOM beside the app's React root, so that
// it changes nothing in the app itself. Each choice reloads the page.

import { CHOICES, saveScenario, type Scenario } from "./scenario";

const LABELS: { [K in keyof Scenario]?: [string, Record<string, string>] } = {
  account: ["Аккаунт", { none: "вышел", free: "Free", pro: "Pro", revoked: "отключён" }],
  cloud: ["Облако в сборке", { true: "есть", false: "нет" }],
  empty: ["Хранилище", { false: "с данными", true: "пустое" }],
  update: ["Обновление", { none: "нет", available: "есть" }],
  offline: ["Сервер", { false: "доступен", true: "офлайн" }],
  vaultError: ["Хранилище не открылось", { false: "нет", true: "да" }],
  os: ["Система", { mac: "macOS", windows: "Windows", linux: "Linux", android: "Android" }],
  ai: ["AI-подсказки", { on: "отвечают", limited: "лимит", off: "выключены" }],
  forwards: ["Переброска портов", { ok: "работает", busy: "порт занят", refused: "нет ответа" }],
  found: ["Хосты для импорта", { true: "найдены", false: "нет" }],
};

const CSS = `
.preview-panel{position:fixed;right:10px;bottom:10px;display:flex;flex-direction:column;align-items:flex-end;z-index:100000;font:12px/1.35 -apple-system,system-ui,sans-serif;color:#e6e9ee}
.preview-panel>button.preview-toggle{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;background:#7c3aed;color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.preview-body{margin-bottom:8px;width:370px;padding:10px 12px;border-radius:10px;background:rgba(18,20,26,.97);border:1px solid #3a3f4b;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.preview-body h4{margin:0 0 6px;font-size:12px;color:#a78bfa}
.preview-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0}
.preview-row>span{color:#9aa3b2;flex:none}
.preview-seg{display:flex;gap:2px;background:#232833;border-radius:6px;padding:2px}
.preview-seg button{all:unset;cursor:pointer;padding:2px 7px;border-radius:4px;color:#c5cad3;white-space:nowrap}
.preview-seg button.on{background:#7c3aed;color:#fff}
.preview-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.preview-actions button{all:unset;cursor:pointer;padding:3px 8px;border-radius:5px;background:#232833;color:#c5cad3}
.preview-actions button:hover,.preview-seg button:hover:not(.on){background:#2f3542}
.preview-note{margin-top:8px;color:#6b7280;font-size:11px}
`;

function reloadWith(scenario: Scenario) {
  saveScenario(scenario);
  // The address may hold choices of its own; the panel's win from now on.
  location.search = "";
}

export function mountPanel(scenario: Scenario) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement("div");
  root.className = "preview-panel";
  let open = false;
  try {
    open = localStorage.getItem("myssh.preview.open") === "1";
  } catch {
    // Closed, then.
  }

  const render = () => {
    root.replaceChildren();
    if (open) {
      const body = document.createElement("div");
      body.className = "preview-body";
      body.innerHTML = "<h4>Предпросмотр интерфейса</h4>";
      for (const key of Object.keys(LABELS) as (keyof Scenario)[]) {
        const [label, names] = LABELS[key]!;
        const row = document.createElement("div");
        row.className = "preview-row";
        const name = document.createElement("span");
        name.textContent = label;
        const seg = document.createElement("div");
        seg.className = "preview-seg";
        for (const choice of CHOICES[key]) {
          const button = document.createElement("button");
          button.textContent = names[String(choice)];
          if (scenario[key] === choice) button.className = "on";
          button.onclick = () => reloadWith({ ...scenario, [key]: choice });
          seg.append(button);
        }
        row.append(name, seg);
        body.append(row);
      }
      const actions = document.createElement("div");
      actions.className = "preview-actions";
      const action = (text: string, run: () => void) => {
        const button = document.createElement("button");
        button.textContent = text;
        button.onclick = run;
        actions.append(button);
      };
      action("Стартовая настройка", () => {
        const stored = JSON.parse(localStorage.getItem("myssh.settings") ?? '{"state":{}}');
        stored.state = { ...stored.state, welcomed: false, setupDone: false };
        localStorage.setItem("myssh.settings", JSON.stringify(stored));
        reloadWith(scenario);
      });
      action("Сбросить настройки", () => {
        localStorage.removeItem("myssh.settings");
        reloadWith(scenario);
      });
      action("Спрятать панель", () => reloadWith({ ...scenario, panel: false }));
      body.append(actions);
      const note = document.createElement("div");
      note.className = "preview-note";
      note.textContent = "Данные выдуманы и живут до перезагрузки. Язык и тема — в настройках самого приложения. Вернуть панель: ?panel=true";
      body.append(note);
      root.append(body);
    }
    const toggle = document.createElement("button");
    toggle.className = "preview-toggle";
    toggle.textContent = open ? "Скрыть" : "Предпросмотр";
    toggle.onclick = () => {
      open = !open;
      try {
        localStorage.setItem("myssh.preview.open", open ? "1" : "0");
      } catch {
        // Not remembered.
      }
      render();
    };
    root.append(toggle);
  };

  render();
  document.body.append(root);
}
