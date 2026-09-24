// Thin native shell: owns the window and (in release builds) the daemon sidecar.
// In dev, the daemon runs separately under `bun --watch` (see root `pnpm dev`).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct Daemon(Mutex<Option<CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Daemon(Mutex::new(None)))
        .setup(|app| {
            if !cfg!(debug_assertions) {
                let (_events, child) = app.shell().sidecar("apcode-daemon")?.spawn()?;
                *app.state::<Daemon>().0.lock().unwrap() = Some(child);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build APCode")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(child) = app.state::<Daemon>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
