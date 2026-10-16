//! On Linux, MySSH comes as an AppImage: one file, run from wherever it
//! was saved, which no menu knows about. This puts it in the applications
//! menu when asked, the way the desktop expects: a `.desktop` file and an
//! icon in the user's own folders. The same entry makes `myssh://` links
//! (invitations to a shared terminal) open the app.
//!
//! Elsewhere, and on Linux when not run as an AppImage, there is nothing
//! to do and the window offers nothing.

use myssh_core::Result;
use serde::Serialize;

#[derive(Serialize)]
pub struct MenuEntry {
    /// Running as an AppImage on Linux: an entry can be made.
    available: bool,
    /// There is one, and it opens this very file.
    installed: bool,
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::PathBuf;

    use myssh_core::{Error, Result};

    /// Marks an entry as this app's own, so it is kept up to date and not
    /// mistaken for one somebody wrote by hand.
    const MARK: &str = "X-MySSH-AppImage=true";
    const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

    /// The AppImage this copy was started from.
    pub fn appimage() -> Option<PathBuf> {
        std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file())
    }

    fn data_home() -> Option<PathBuf> {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
    }

    fn desktop_file() -> Option<PathBuf> {
        Some(data_home()?.join("applications/myssh.desktop"))
    }

    fn entry_for(appimage: &std::path::Path) -> String {
        // The Exec key quotes the path, and escapes what quoting does not cover.
        let path = appimage.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`");
        format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=MySSH\n\
             GenericName=SSH Client\n\
             Comment=SSH client with hosts, a terminal, files and snippets\n\
             Exec=\"{path}\" %u\n\
             Icon=myssh\n\
             Terminal=false\n\
             Categories=Network;RemoteAccess;Development;\n\
             Keywords=ssh;sftp;terminal;server;\n\
             MimeType=x-scheme-handler/myssh;\n\
             StartupWMClass=myssh\n\
             {MARK}\n"
        )
    }

    /// The entry there is, if it is this app's own.
    fn current() -> Option<String> {
        std::fs::read_to_string(desktop_file()?).ok().filter(|text| text.contains(MARK))
    }

    pub fn installed() -> bool {
        match (appimage(), current()) {
            (Some(appimage), Some(text)) => text == entry_for(&appimage),
            _ => false,
        }
    }

    pub fn install() -> Result<()> {
        let appimage = appimage().ok_or_else(|| Error::Invalid("not running as an AppImage".into()))?;
        let data = data_home().ok_or_else(|| Error::Invalid("no home folder".into()))?;
        let icons = data.join("icons/hicolor/256x256/apps");
        std::fs::create_dir_all(&icons)?;
        std::fs::write(icons.join("myssh.png"), ICON)?;
        let file = desktop_file().ok_or_else(|| Error::Invalid("no home folder".into()))?;
        std::fs::create_dir_all(file.parent().unwrap())?;
        std::fs::write(&file, entry_for(&appimage))?;
        // Menus and links pick it up sooner with these; without them they do in time.
        let applications = data.join("applications");
        let _ = std::process::Command::new("update-desktop-database").arg(&applications).status();
        let _ = std::process::Command::new("xdg-mime")
            .args(["default", "myssh.desktop", "x-scheme-handler/myssh"])
            .status();
        Ok(())
    }

    /// An entry made earlier for an AppImage that has since been moved or
    /// renamed is pointed at this one, quietly.
    pub fn refresh() {
        if let (Some(appimage), Some(text)) = (appimage(), current()) {
            if text != entry_for(&appimage) {
                if let Some(file) = desktop_file() {
                    let _ = std::fs::write(file, entry_for(&appimage));
                }
            }
        }
    }
}

/// Whether the app can be put in the applications menu, and whether it is.
#[tauri::command]
pub fn menu_entry_status() -> MenuEntry {
    #[cfg(target_os = "linux")]
    return MenuEntry { available: linux::appimage().is_some(), installed: linux::installed() };
    #[cfg(not(target_os = "linux"))]
    MenuEntry { available: false, installed: false }
}

/// Puts the app in the applications menu, or brings its entry up to date.
#[tauri::command]
pub fn menu_entry_install() -> Result<()> {
    #[cfg(target_os = "linux")]
    return linux::install();
    #[cfg(not(target_os = "linux"))]
    Err(myssh_core::Error::Invalid("only an AppImage on Linux goes in a menu this way".into()))
}

/// At start: keeps an entry made earlier pointing at this AppImage.
pub fn refresh() {
    #[cfg(target_os = "linux")]
    linux::refresh();
}
