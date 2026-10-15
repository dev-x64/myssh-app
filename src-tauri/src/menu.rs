//! Application menu.
//!
//! The menu owns the standard shortcuts (so that, for instance, Cmd+W closes
//! a tab rather than the window) and forwards them to the UI as `menu` events.
//!
//! It is the Mac's menu bar. Windows has none: there the window carries its
//! own buttons and the UI listens for the shortcuts, which take Shift as
//! well so as to keep clear of the keys a shell uses.

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

struct Labels {
    about: &'static str,
    settings: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    quit: &'static str,
    shell: &'static str,
    check_updates: &'static str,
    new_tab: &'static str,
    hosts: &'static str,
    new_host: &'static str,
    close_tab: &'static str,
    next_tab: &'static str,
    prev_tab: &'static str,
    edit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    find: &'static str,
    snippets: &'static str,
    files: &'static str,
    view: &'static str,
    bigger: &'static str,
    smaller: &'static str,
    reset_size: &'static str,
    clear: &'static str,
    fullscreen: &'static str,
    window: &'static str,
    minimize: &'static str,
    zoom: &'static str,
}

const EN: Labels = Labels {
    about: "About MySSH",
    settings: "Settings…",
    hide: "Hide MySSH",
    hide_others: "Hide Others",
    show_all: "Show All",
    quit: "Quit MySSH",
    shell: "Shell",
    check_updates: "Check for Updates…",
    new_tab: "New Tab",
    hosts: "Hosts",
    new_host: "New Host…",
    close_tab: "Close Tab",
    next_tab: "Next Tab",
    prev_tab: "Previous Tab",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    find: "Find…",
    snippets: "Snippets",
    files: "Files",
    view: "View",
    bigger: "Bigger Text",
    smaller: "Smaller Text",
    reset_size: "Default Text Size",
    clear: "Clear Terminal",
    fullscreen: "Toggle Full Screen",
    window: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
};

const RU: Labels = Labels {
    about: "О программе MySSH",
    settings: "Настройки…",
    hide: "Скрыть MySSH",
    hide_others: "Скрыть остальные",
    show_all: "Показать все",
    quit: "Завершить MySSH",
    shell: "Сессия",
    check_updates: "Проверить обновления…",
    new_tab: "Новая вкладка",
    hosts: "Хосты",
    new_host: "Новый хост…",
    close_tab: "Закрыть вкладку",
    next_tab: "Следующая вкладка",
    prev_tab: "Предыдущая вкладка",
    edit: "Правка",
    undo: "Отменить",
    redo: "Повторить",
    cut: "Вырезать",
    copy: "Скопировать",
    paste: "Вставить",
    select_all: "Выбрать все",
    find: "Найти…",
    snippets: "Сниппеты",
    files: "Файлы",
    view: "Вид",
    bigger: "Увеличить шрифт",
    smaller: "Уменьшить шрифт",
    reset_size: "Размер шрифта по умолчанию",
    clear: "Очистить терминал",
    fullscreen: "Полноэкранный режим",
    window: "Окно",
    minimize: "Свернуть",
    zoom: "Изменить масштаб",
};

pub fn install<R: Runtime>(app: &AppHandle<R>, locale: &str) -> tauri::Result<()> {
    // A menu bar is the Mac's. Elsewhere it would be a strip across the
    // window; the window does without it there, and takes the shortcuts itself.
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let l = if locale == "ru" { &RU } else { &EN };
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, text, true, accelerator)
    };
    let separator = || PredefinedMenuItem::separator(app);

    let about = PredefinedMenuItem::about(app, Some(l.about), Some(AboutMetadata::default()))?;
    let check_updates = item("check_updates", l.check_updates, None)?;
    let breaks = [separator()?, separator()?, separator()?];
    let settings = item("settings", l.settings, Some("CmdOrCtrl+,"))?;
    let hide = PredefinedMenuItem::hide(app, Some(l.hide))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some(l.hide_others))?;
    let show_all = PredefinedMenuItem::show_all(app, Some(l.show_all))?;
    let quit = PredefinedMenuItem::quit(app, Some(l.quit))?;
    let mut entries: Vec<&dyn IsMenuItem<R>> = vec![&about];
    // A build that does not update itself has no updates of its own to look for.
    if crate::update::enabled() {
        entries.push(&check_updates);
    }
    entries.extend([
        &breaks[0] as &dyn IsMenuItem<R>,
        &settings,
        &breaks[1],
        &hide,
        &hide_others,
        &show_all,
        &breaks[2],
        &quit,
    ]);
    let app_menu = Submenu::with_items(app, "MySSH", true, &entries)?;
    let shell_menu = Submenu::with_items(
        app,
        l.shell,
        true,
        &[
            &item("new_tab", l.new_tab, Some("CmdOrCtrl+T"))?,
            &item("hosts", l.hosts, Some("CmdOrCtrl+Shift+H"))?,
            &item("new_host", l.new_host, Some("CmdOrCtrl+N"))?,
            &separator()?,
            &item("close_tab", l.close_tab, Some("CmdOrCtrl+W"))?,
            &item("next_tab", l.next_tab, Some("CmdOrCtrl+Shift+]"))?,
            &item("prev_tab", l.prev_tab, Some("CmdOrCtrl+Shift+["))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        l.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(l.undo))?,
            &PredefinedMenuItem::redo(app, Some(l.redo))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some(l.cut))?,
            &PredefinedMenuItem::copy(app, Some(l.copy))?,
            &PredefinedMenuItem::paste(app, Some(l.paste))?,
            &PredefinedMenuItem::select_all(app, Some(l.select_all))?,
            &separator()?,
            &item("find", l.find, Some("CmdOrCtrl+F"))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        l.view,
        true,
        &[
            &item("font_bigger", l.bigger, Some("CmdOrCtrl+="))?,
            &item("font_smaller", l.smaller, Some("CmdOrCtrl+-"))?,
            &item("font_reset", l.reset_size, Some("CmdOrCtrl+0"))?,
            &separator()?,
            &item("files", l.files, Some("CmdOrCtrl+Shift+F"))?,
            &item("snippets", l.snippets, Some("CmdOrCtrl+Shift+S"))?,
            &item("clear", l.clear, Some("CmdOrCtrl+K"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, Some(l.fullscreen))?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        l.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(l.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(l.zoom))?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &shell_menu, &edit_menu, &view_menu, &window_menu],
    )?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn forward_events<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().0.as_str());
    });
}
