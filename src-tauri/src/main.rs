// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// @illusion: suppress console window on Windows, delegate to lib::run
fn main() {
    tauri_app_lib::run()
}
