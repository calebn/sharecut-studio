//! The iOS app: the Tauri shell around an embedded CPython that serves the Studio on loopback.
//!
//! Compiled only for `target_os = "ios"` with the `app` feature. The lifecycle decisions are the
//! pure reducer in `crate::lifecycle`; this module wires them to the interpreter, the WebView
//! and the app's foreground events.

mod driver;
mod python;
mod webview;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use driver::Driver;

use crate::engine::{engine_navigation_allowed, ios_engine_environment, DEBUG_ONLY_VARIABLES};
use crate::lifecycle::{Event, RETRY_SCHEME};

/// Interpreter variables and the boot token go in before any thread exists, because setting the
/// environment is not safe once threads run.
fn set_engine_environment() -> String {
    let token = crate::random_boot_token().expect("the system random source answers");
    let bundle = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        .expect("the app executable sits in its bundle");
    for name in DEBUG_ONLY_VARIABLES {
        std::env::remove_var(name);
    }
    for (name, value) in ios_engine_environment(&bundle, &token, cfg!(debug_assertions)) {
        std::env::set_var(name, value);
    }
    token
}

#[tauri::mobile_entry_point]
pub fn run() {
    let boot_token = set_engine_environment();
    let (events, inbox) = mpsc::channel::<Event>();
    let engine_port = Arc::new(Mutex::new(None::<u16>));
    let nav_port = engine_port.clone();
    let retry = events.clone();
    let resumed = events.clone();
    let navigation = tauri::plugin::Builder::<tauri::Wry, ()>::new("engine-nav")
        .on_navigation(move |_webview, url| {
            if url.scheme() == RETRY_SCHEME {
                let _ = retry.send(Event::RetryRequested);
                return false;
            }
            engine_navigation_allowed(url.as_str(), nav_port.lock().ok().and_then(|port| *port))
        })
        .build();
    tauri::Builder::default()
        .plugin(navigation)
        .on_window_event(move |_window, event| {
            if matches!(event, tauri::WindowEvent::Resumed) {
                let _ = resumed.send(Event::Resumed);
            }
        })
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                webview::lay_out_over_the_whole_screen(&window);
            }
            Driver {
                app: app.handle().clone(),
                events,
                boot_token,
                engine_port,
            }
            .spawn(inbox);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ShareCut");
}
