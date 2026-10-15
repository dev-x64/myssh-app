//! Development-only bridge for driving the real app from a test script.
//!
//! Compiled into debug builds only, and inert unless `MYSSH_E2E_DIR` points
//! at a directory. While active, a script dropped there as `in.js` is run in
//! the window and its result is written next to it as `out.json`.

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Listener, Manager};

const RESULT_EVENT: &str = "e2e-result";

pub fn start(app: &AppHandle) {
    let Some(dir) = std::env::var_os("MYSSH_E2E_DIR").map(PathBuf::from) else {
        return;
    };
    log::warn!("e2e bridge active in {}", dir.display());

    let out = dir.join("out.json");
    app.listen(RESULT_EVENT, move |event| {
        let tmp = out.with_extension("tmp");
        if std::fs::write(&tmp, event.payload()).is_ok() {
            let _ = std::fs::rename(&tmp, &out);
        }
    });

    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let input = dir.join("in.js");
        let Ok(script) = std::fs::read_to_string(&input) else {
            continue;
        };
        let _ = std::fs::remove_file(&input);
        let Some(window) = app.get_webview_window("main") else {
            continue;
        };
        let wrapped = format!(
            "(async () => {{
                let result;
                try {{
                    result = {{ ok: true, value: await (async () => {{ {script} }})() }};
                }} catch (e) {{
                    result = {{ ok: false, error: String(e), stack: String((e && e.stack) || '') }};
                }}
                if (result.value === undefined) result.value = null;
                window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                    event: '{RESULT_EVENT}',
                    payload: result,
                }});
            }})()"
        );
        let _ = window.eval(&wrapped);
    });
}
