//! The iOS app: the Tauri shell around an embedded CPython that serves the Studio on loopback.
//!
//! Compiled only for `target_os = "ios"` with the `app` feature. The lifecycle decisions are the
//! pure reducer in `crate::lifecycle`; this module wires them to the interpreter, the WebView
//! and the app's foreground events.

mod driver;
mod python;
mod scope;
mod webview;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use tauri::webview::PageLoadEvent;
use tauri::Manager;
use url::Url;

use driver::Driver;

use crate::engine::{engine_navigation_allowed, ios_engine_environment, DEBUG_ONLY_VARIABLES};
use crate::lifecycle::{Event, RETRY_SCHEME};
use crate::open_bundle::{self, BundleSlot};

/// Interpreter variables and the boot token go in before any thread exists, because setting the
/// environment is not safe once threads run.
fn set_engine_environment(inbox_dir: &std::path::Path) -> String {
    let token = crate::random_boot_token().expect("the system random source answers");
    let bundle = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        .expect("the app executable sits in its bundle");
    for name in DEBUG_ONLY_VARIABLES {
        std::env::remove_var(name);
    }
    for (name, value) in ios_engine_environment(&bundle, &token, inbox_dir, cfg!(debug_assertions))
    {
        std::env::set_var(name, value);
    }
    token
}

#[tauri::mobile_entry_point]
pub fn run() {
    let inbox_dir = open_bundle::inbox_dir(&std::env::temp_dir());
    open_bundle::sweep_inbox(
        &inbox_dir,
        open_bundle::INBOX_MAX_AGE,
        std::time::SystemTime::now(),
    );
    let boot_token = set_engine_environment(&inbox_dir);
    let (events, inbox) = mpsc::channel::<Event>();
    let engine_port = Arc::new(Mutex::new(None::<u16>));
    let nav_port = engine_port.clone();
    let load_port = engine_port.clone();
    let bundles = Arc::new(Mutex::new(BundleSlot::default()));
    let load_bundles = bundles.clone();
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
        .on_page_load(move |webview, payload| match payload.event() {
            PageLoadEvent::Started => {
                if let Ok(mut slot) = load_bundles.lock() {
                    slot.reset();
                }
            }
            PageLoadEvent::Finished => {
                let port = load_port.lock().ok().and_then(|port| *port);
                if !engine_navigation_allowed(payload.url().as_str(), port) {
                    return;
                }
                let waiting = load_bundles
                    .lock()
                    .map(|mut slot| slot.take_for_navigation())
                    .unwrap_or_default();
                for item in waiting {
                    let _ = webview.eval(open_bundle::open_bundle_script(&item));
                }
            }
        })
        .build();
    let app = tauri::Builder::default()
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
        .build(tauri::generate_context!())
        .expect("error while building ShareCut");
    app.run(move |handle, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                let handle = handle.clone();
                let bundles = bundles.clone();
                let inbox_dir = inbox_dir.clone();
                std::thread::spawn(move || receive_bundle(&handle, &bundles, &inbox_dir, &url));
            }
        }
    });
}

/// Copy an opened file into the inbox and tell the page, or hold it until the engine page loads.
/// The copy can be large, so this runs off the main thread.
fn receive_bundle(
    app: &tauri::AppHandle,
    bundles: &Mutex<BundleSlot>,
    inbox_dir: &std::path::Path,
    url: &Url,
) {
    if url.scheme() != "file" {
        return;
    }
    let Ok(source) = url.to_file_path() else {
        return;
    };
    let copied = scope::with_security_scope(&source, || {
        let path =
            open_bundle::bundle_from_file_url(url).ok_or(open_bundle::InboxError::NotAFile)?;
        open_bundle::copy_to_inbox(&path, inbox_dir, open_bundle::MAX_BUNDLE_BYTES)
    });
    let item = match copied {
        Ok(item) => item,
        Err(error) => {
            eprintln!("ShareCut could not receive an opened file: {error}");
            return;
        }
    };
    let push_now = bundles
        .lock()
        .map(|mut slot| slot.offer(item.clone()))
        .unwrap_or(false);
    if push_now {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(open_bundle::open_bundle_script(&item));
        }
    }
}
