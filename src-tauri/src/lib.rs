use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// @illusion: build Tauri app with window, system tray, and close-to-tray behavior
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // @illusion: create main window and system tray with Show/Quit menu
        .setup(|app| {
            // Build the main window programmatically for full control over sizing.
            let _win =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("VoiceCall")
                    .inner_size(460.0, 620.0)
                    .min_inner_size(360.0, 500.0)
                    .resizable(true)
                    .build()?;

            // System tray  left-click or "Show" to restore; "Quit" to exit.
            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("VoiceCall")
                .icon(app.default_window_icon().unwrap().clone())
                // @illusion: handle Show/Quit tray menu actions
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                // @illusion: show window on left-click tray icon
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        // @illusion: minimize to tray on close instead of quitting
        .on_window_event(|window, event| {
            // Minimise to tray instead of quitting on close.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
