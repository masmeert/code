// Thin native shell: owns the window and (in release builds) the daemon sidecar.
// In dev, the daemon runs separately under `bun --watch` (see root `pnpm dev`).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct Daemon(Mutex<Option<CommandChild>>);

/// Secret the daemon requires on every connection, so other local processes can't drive it.
/// Only set in release builds, where we spawn the daemon; in dev it runs on its own.
struct DaemonToken(Option<String>);

#[tauri::command]
fn daemon_token(token: tauri::State<DaemonToken>) -> Option<String> {
    token.0.clone()
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("no OS randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let token = (!cfg!(debug_assertions)).then(new_token);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Daemon(Mutex::new(None)))
        .manage(DaemonToken(token.clone()))
        .invoke_handler(tauri::generate_handler![daemon_token])
        .setup(move |app| {
            if let Some(token) = token {
                let (_events, child) = app.shell().sidecar("apcode-daemon")?.env("APCODE_TOKEN", token).spawn()?;
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
