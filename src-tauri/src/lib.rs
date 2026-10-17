//! Desktop shell: wires the UI to `myssh-core`.

mod cloud;
mod commands;
mod files;
mod import;
#[cfg(debug_assertions)]
mod e2e;
mod links;
mod local;
mod menu_entry;
mod menu;
mod state;
mod update;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(links::Pending::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = state::AppState::open(data_dir);
            cloud::allow_test_server();
            cloud::follow_configured_server(&state);
            app.manage(state);
            menu::install(app.handle(), "en")?;
            menu::forward_events(app.handle());
            menu_entry::refresh();
            // On Windows the app draws its own title bar, with the tabs in it,
            // so the system's frame goes; its shadow and rounded corners stay.
            #[cfg(target_os = "windows")]
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                let _ = window.set_decorations(false);
                let _ = window.set_shadow(true);
            }
            {
                // Invitations: the app was opened with one, or is handed one later.
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        links::arrived(&handle, url.to_string());
                    }
                }
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        links::arrived(&handle, url.to_string());
                    }
                });
            }
            #[cfg(debug_assertions)]
            e2e::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            update::update_check,
            update::update_install,
            update::update_restart,
            commands::vault_retry,
            commands::vault_replace,
            commands::disk_encryption,
            commands::menu_set_locale,
            commands::vault_snapshot,
            commands::host_save,
            commands::host_delete,
            commands::host_duplicate,
            commands::host_move,
            commands::host_pin,
            commands::host_set_forwards,
            commands::group_save,
            commands::group_delete,
            commands::snippet_save,
            commands::snippet_targets,
            commands::snippet_delete,
            commands::identity_save,
            commands::identity_delete,
            commands::host_shared_credentials,
            commands::host_gather_credentials,
            commands::host_password,
            commands::identity_password,
            commands::key_generate,
            commands::key_import,
            commands::key_rename,
            commands::key_delete,
            commands::key_install,
            commands::key_install_script,
            commands::script_check,
            import::import_scan,
            import::import_file,
            import::import_apply,
            import::tailscale_peers,
            menu_entry::menu_entry_status,
            menu_entry::menu_entry_install,
            commands::host_assign_key,
            commands::history_record,
            commands::history_suggest,
            commands::history_frequent,
            commands::history_clear,
            commands::known_hosts_list,
            commands::known_host_forget,
            commands::session_open,
            commands::session_write,
            commands::session_resize,
            commands::session_reply,
            commands::session_ack,
            commands::session_cwd,
            commands::session_shell,
            commands::session_stats,
            commands::host_stats,
            local::local_terminal,
            commands::session_close,
            commands::session_close_all,
            commands::forward_start,
            commands::forward_stop,
            commands::forward_status,
            cloud::cloud_check,
            cloud::cloud_sign_up,
            cloud::cloud_sign_in,
            cloud::cloud_sign_out,
            cloud::cloud_delete_account,
            cloud::cloud_change_email,
            cloud::cloud_sync,
            cloud::cloud_devices,
            cloud::cloud_plan,
            cloud::cloud_open_account,
            cloud::share_open,
            cloud::ai_suggest,
            cloud::share_join,
            links::links_take,
            cloud::cloud_revoke_device,
            cloud::key_set_sync,
            cloud::settings_save,
            files::sftp_home,
            files::sftp_resolve,
            files::sftp_list,
            files::sftp_mkdir,
            files::sftp_rename,
            files::sftp_remove,
            files::sftp_read_text,
            files::sftp_write_text,
            files::sftp_download,
            files::sftp_upload,
            files::sftp_chmod,
            files::sftp_version,
            files::sftp_open_external,
            files::external_discard,
            files::local_chmod,
            files::local_stamp,
            files::local_open,
            files::open_link,
            files::open_network_privacy,
            files::transfer_cancel,
            files::local_write_text,
            files::local_home,
            files::local_resolve,
            files::local_list,
            files::local_mkdir,
            files::local_rename,
            files::local_trash,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start MySSH")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                update::on_exit();
            }
        });
}
