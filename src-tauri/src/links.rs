//! Links that open the app: invitations to shared terminals.
//!
//! The system hands over a `myssh://` address, sometimes before the window
//! is ready to act on it. Addresses wait here until the window takes them.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

/// Told to the window when an address has arrived; it then takes them all.
const ARRIVED: &str = "link-arrived";

#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

pub fn arrived(app: &AppHandle, url: String) {
    if let Some(pending) = app.try_state::<Pending>() {
        pending.0.lock().unwrap().push(url);
    }
    let _ = app.emit(ARRIVED, ());
    // Whoever followed the link expects to see the app.
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The addresses that have arrived since the last call.
#[tauri::command]
pub fn links_take(pending: State<'_, Pending>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}
