// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{self, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sharecut::{
    bundled_sidecar_path, detach_to_sidecar_log, parse_listen_json, random_boot_token,
    read_health_response, sidecar_listen_path, sidecar_log_path, sidecar_owns_listen,
};
use tauri::{Manager, RunEvent, WebviewWindow, Window};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::ShellExt;

mod media_capture;

struct SidecarHandle {
    child: Child,
    listen_path: Option<PathBuf>,
    boot_token: Option<String>,
}

struct SidecarState(Mutex<Option<SidecarHandle>>);

struct LastOpenedShare(Mutex<Option<(String, Instant)>>);

/// State kept only by the native host while a confirmation dialog is visible.
/// The loopback renderer can request a guard, but can never invoke this state.
struct CloseGuardState(Mutex<CloseGuardStatus>);

#[derive(Default)]
struct CloseGuardStatus {
    confirming: bool,
    exiting: bool,
}

const HEALTH_IO_TIMEOUT: Duration = Duration::from_millis(400);
const HEALTH_READ_CAP: usize = 4096;
const FALLBACK_PORT: u16 = 8765;
const SHARE_OPEN_DEBOUNCE: Duration = Duration::from_millis(1500);

fn close_guard_decision(window: &WebviewWindow) -> sharecut::CloseDecision {
    match window.url() {
        Ok(url) => sharecut::close_decision(&url),
        Err(err) => {
            eprintln!("Sharecut Studio: could not read close-guard URL: {err}");
            // Failing to inspect the renderer state must never silently close
            // a possibly active recording.
            sharecut::close_decision_from_url(None)
        }
    }
}

fn is_confirmed_exit(app: &tauri::AppHandle) -> bool {
    app.try_state::<CloseGuardState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.exiting))
        .unwrap_or(false)
}

fn close_guard_message(risk: sharecut::CloseRisk) -> (&'static str, &'static str) {
    match risk {
        sharecut::CloseRisk::Host => (
            "Recording may still be writing",
            "Quitting stops this room for everyone and may lose the host recording. Quit anyway?",
        ),
        sharecut::CloseRisk::Guest => (
            "Recording may still be writing",
            "Your guest recording is active or finishing. Quit Sharecut Studio anyway?",
        ),
        sharecut::CloseRisk::Unknown => (
            "Recording status could not be verified",
            "Sharecut Studio could not verify whether recording has finished. Quit anyway?",
        ),
    }
}

/// Show one native confirmation dialog for a guarded main-window close.
/// The close event has already been prevented when this is called.
fn request_close_confirmation(webview: &WebviewWindow, risk: sharecut::CloseRisk) {
    let app = webview.app_handle();
    let Some(state) = app.try_state::<CloseGuardState>() else {
        eprintln!("Sharecut Studio: main close guard state is unavailable");
        return;
    };
    let Ok(mut status) = state.0.lock() else {
        eprintln!("Sharecut Studio: main close guard state is poisoned");
        return;
    };
    if status.confirming || status.exiting {
        return;
    }
    status.confirming = true;
    drop(status);

    let (title, message) = close_guard_message(risk);
    let app = app.clone();
    let closing_webview = webview.clone();
    webview
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".into(),
            "Keep recording".into(),
        ))
        .parent(webview)
        .show(move |confirmed| {
            let Some(state) = app.try_state::<CloseGuardState>() else {
                eprintln!("Sharecut Studio: main close guard state disappeared");
                return;
            };
            let Ok(mut status) = state.0.lock() else {
                eprintln!("Sharecut Studio: main close guard state is poisoned");
                return;
            };
            status.confirming = false;
            if !confirmed {
                return;
            }
            status.exiting = true;
            drop(status);

            if let Err(err) = closing_webview.destroy() {
                eprintln!("Sharecut Studio: could not destroy confirmed close: {err}");
                if let Ok(mut status) = state.0.lock() {
                    status.exiting = false;
                }
                closing_webview
                    .dialog()
                    .message("Sharecut Studio could not close the window. The recording room remains open. Try Quit again.")
                    .title("Could not quit")
                    .buttons(MessageDialogButtons::Ok)
                    .parent(&closing_webview)
                    .show(|_| {});
                return;
            }
            app.exit(0);
        });
}

fn handle_main_window_close(window: &Window, risk: sharecut::CloseRisk) {
    if window.label() != "main" || is_confirmed_exit(window.app_handle()) {
        return;
    }
    let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
        eprintln!("Sharecut Studio: main close guard has no webview");
        return;
    };
    request_close_confirmation(&webview, risk);
}

fn handle_exit_requested(app: &tauri::AppHandle) -> Option<sharecut::CloseRisk> {
    if is_confirmed_exit(app) {
        return None;
    }
    let Some(webview) = app.get_webview_window("main") else {
        eprintln!("Sharecut Studio: main close guard has no webview; preventing exit");
        return Some(sharecut::CloseRisk::Unknown);
    };
    match close_guard_decision(&webview) {
        sharecut::CloseDecision::Allow => None,
        sharecut::CloseDecision::Confirm(risk) => Some(risk),
    }
}

#[cfg(target_os = "macos")]
fn macos_guarded_menu(
    app: &tauri::AppHandle<tauri::Wry>,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };

    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let guarded_quit = MenuItem::with_id(
        app,
        sharecut::GUARDED_QUIT_MENU_ID,
        format!("Quit {}", package.name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_menu = Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &guarded_quit,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;
    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

fn configure_sidecar_cmd(cmd: &mut Command) {
    sharecut::apply_distribution_metadata(cmd);
    cmd.env("PODCAST_MAGIC_LINK_PRINT", "0");
    detach_to_sidecar_log(cmd);
}

fn spawn_bundled(path: PathBuf) -> Result<SidecarHandle, String> {
    let mut cmd = Command::new(path);
    configure_sidecar_cmd(&mut cmd);
    // Packaged release: ephemeral bind + boot token. `tauri dev` keeps :8765.
    let (listen_path, boot_token) = if cfg!(debug_assertions) {
        (None, None)
    } else {
        let token = random_boot_token()?;
        let listen = sidecar_listen_path();
        if let Err(err) = std::fs::remove_file(&listen) {
            if err.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "Sharecut Studio: could not remove listen file {}: {err}",
                    listen.display()
                );
            }
        }
        cmd.env("PODCAST_SIDECAR_EPHEMERAL", "1");
        cmd.env("PODCAST_SIDECAR_BOOT_TOKEN", &token);
        cmd.env("PODCAST_SIDECAR_LISTEN_FILE", &listen);
        cmd.env("PODCAST_GUI_OPENAPI", "0");
        if std::env::var_os("PODCAST_BOOTSTRAP_CDN_BASE").is_none() {
            if let Some(cdn_base) = sharecut::distribution::BOOTSTRAP_CDN_BASE {
                cmd.env("PODCAST_BOOTSTRAP_CDN_BASE", cdn_base);
            }
        }
        (Some(listen), Some(token))
    };
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    Ok(SidecarHandle {
        child,
        listen_path,
        boot_token,
    })
}

fn spawn_fallback(mut cmd: Command) -> Result<SidecarHandle, String> {
    configure_sidecar_cmd(&mut cmd);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    Ok(SidecarHandle {
        child,
        listen_path: None,
        boot_token: None,
    })
}

fn spawn_sidecar() -> Result<SidecarHandle, String> {
    let mut last_err = String::from("no sidecar candidates");
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(bundled) = bundled_sidecar_path(dir, cfg!(windows)) {
                match spawn_bundled(bundled) {
                    Ok(handle) => return Ok(handle),
                    Err(e) => last_err = e,
                }
            }
        }
    }
    if cfg!(debug_assertions) {
        let mut c = Command::new("podcast");
        c.args(["gui", "--host", "127.0.0.1", "--port", "8765", "--no-open"]);
        match spawn_fallback(c) {
            Ok(handle) => return Ok(handle),
            Err(e) => last_err = e,
        }
        let mut c2 = Command::new("uv");
        c2.args([
            "run",
            "podcast",
            "gui",
            "--host",
            "127.0.0.1",
            "--port",
            "8765",
            "--no-open",
        ]);
        return spawn_fallback(c2).map_err(|e| {
            if last_err.is_empty() {
                e
            } else {
                format!("{last_err}; {e}")
            }
        });
    }
    Err(last_err)
}

fn child_exited(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<SidecarState>();
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "sidecar lock poisoned".to_string())?;
    match guard.as_mut() {
        None => Err("sidecar handle missing".into()),
        Some(handle) => match handle.child.try_wait() {
            Ok(Some(status)) => Ok(Some(format!("sidecar exited ({status})"))),
            Ok(None) => Ok(None),
            Err(err) => Err(format!("sidecar wait failed: {err}")),
        },
    }
}

fn sidecar_probe(app: &tauri::AppHandle) -> Result<(u32, Option<PathBuf>, Option<String>), String> {
    let state = app.state::<SidecarState>();
    let guard = state
        .0
        .lock()
        .map_err(|_| "sidecar lock poisoned".to_string())?;
    let handle = guard
        .as_ref()
        .ok_or_else(|| "sidecar handle missing".to_string())?;
    Ok((
        handle.child.id(),
        handle.listen_path.clone(),
        handle.boot_token.clone(),
    ))
}

fn wait_for_engine(app: &tauri::AppHandle, timeout: Duration) -> Result<u16, String> {
    let start = Instant::now();
    let mut last = String::from("waiting");
    while start.elapsed() < timeout {
        if let Some(detail) = child_exited(app)? {
            return Err(format!("{detail} before health"));
        }
        match try_engine_ready(app) {
            Ok(port) => {
                if let Some(detail) = child_exited(app)? {
                    return Err(format!("{detail} after health"));
                }
                return Ok(port);
            }
            Err(err) => last = err,
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!("timed out waiting for sidecar health ({last})"))
}

fn try_engine_ready(app: &tauri::AppHandle) -> Result<u16, String> {
    let (sidecar_pid, listen_path, boot_token) = sidecar_probe(app)?;
    let (port, token) = match listen_path.as_deref() {
        Some(path) => {
            let text =
                std::fs::read_to_string(path).map_err(|_| "listen file missing".to_string())?;
            let (port, listen_pid) =
                parse_listen_json(&text).ok_or_else(|| "listen json invalid".to_string())?;
            if !sidecar_owns_listen(port, sidecar_pid, listen_pid) {
                return Err("loopback listener not owned by sidecar".into());
            }
            (port, boot_token.as_deref())
        }
        None => (FALLBACK_PORT, None),
    };
    if !tcp_get_health(port, token).unwrap_or(false) {
        return Err(format!("health not ok on 127.0.0.1:{port}"));
    }
    Ok(port)
}

fn tcp_get_health(port: u16, boot_token: Option<&str>) -> Result<bool, ()> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(HEALTH_IO_TIMEOUT))
        .map_err(|_| ())?;
    stream
        .set_write_timeout(Some(HEALTH_IO_TIMEOUT))
        .map_err(|_| ())?;
    // Connection: close helps the failure path finish with EOF after the body;
    // success still returns as soon as the buffer contains HTTP 200 + `"ok": true`.
    let mut req = String::from("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n");
    if let Some(token) = boot_token {
        req.push_str("X-Sharecut-Boot-Token: ");
        req.push_str(token);
        req.push_str("\r\n");
    }
    req.push_str("Connection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|_| ())?;
    Ok(read_health_response(&mut stream, HEALTH_READ_CAP))
}

fn eval_js(win: &WebviewWindow, js: &str) {
    for attempt in 0..5 {
        match win.eval(js) {
            Ok(()) => return,
            Err(err) => {
                eprintln!("Sharecut Studio: webview eval failed (attempt {attempt}): {err}");
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn show_sidecar_error(app: &tauri::AppHandle, detail: &str) {
    let log = sidecar_log_path();
    let msg = format!(
        "Could not start the Sharecut engine ({detail}). Log: {}",
        log.display()
    );
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(js) = serde_json::to_string(&msg) {
            eval_js(
                &win,
                &format!("var el=document.getElementById('status'); if(el) el.textContent={js};"),
            );
        }
    }
}

fn open_engine_window(app: &tauri::AppHandle, port: u16) {
    if let Some(win) = app.get_webview_window("main") {
        eval_js(
            &win,
            &format!("window.location.replace('http://127.0.0.1:{port}/')"),
        );
    }
}

fn wait_for_main_window(app: &tauri::AppHandle) -> bool {
    for _ in 0..50 {
        if app.get_webview_window("main").is_some() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn should_open_share(app: &tauri::AppHandle, open_url: &str) -> bool {
    let Some(state) = app.try_state::<LastOpenedShare>() else {
        return false;
    };
    let Ok(guard) = state.0.lock() else {
        return false;
    };
    let now = Instant::now();
    if let Some((prev, at)) = guard.as_ref() {
        if prev == open_url && now.saturating_duration_since(*at) < SHARE_OPEN_DEBOUNCE {
            return false;
        }
    }
    true
}

fn record_share_open(app: &tauri::AppHandle, open_url: &str) {
    let Some(state) = app.try_state::<LastOpenedShare>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    *guard = Some((open_url.to_string(), Instant::now()));
}

fn open_allowed_share(app: &tauri::AppHandle, raw: &str) -> Result<&'static str, String> {
    let link =
        sharecut::parse_share_deep_link(raw).map_err(|_| "unsupported URL scheme".to_string())?;
    if !should_open_share(app, &link.open_url) {
        return Ok("skipped");
    }
    focus_main_window(app);
    #[allow(deprecated)]
    app.shell()
        .open(&link.open_url, None)
        .map_err(|e| e.to_string())?;
    record_share_open(app, &link.open_url);
    Ok("opened")
}

fn setup_deep_links(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link().register_all()?;

    let start_handle = app.handle().clone();
    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                if let Err(err) = open_allowed_share(&start_handle, url.as_str()) {
                    eprintln!("Sharecut Studio: deep link open failed: {err}");
                }
            }
        }
        Ok(None) => {}
        Err(err) => {
            eprintln!("Sharecut Studio: could not read startup deep link: {err}");
        }
    }

    let warm_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            if let Err(err) = open_allowed_share(&warm_handle, url.as_str()) {
                eprintln!("Sharecut Studio: deep link open failed: {err}");
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn open_share_url(app: tauri::AppHandle, url: String) -> Result<&'static str, String> {
    open_allowed_share(&app, &url)
}

fn engine_navigation_allowed(url: &str, engine_port: Option<u16>) -> bool {
    if sharecut::is_allowed_webview_navigation(url, engine_port) {
        return true;
    }
    cfg!(debug_assertions) && sharecut::is_allowed_webview_navigation(url, Some(FALLBACK_PORT))
}

fn main() {
    let engine_port = Arc::new(Mutex::new(None::<u16>));
    let nav_port = engine_port.clone();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("engine-nav")
                .on_navigation(move |_webview, url| {
                    engine_navigation_allowed(url.as_str(), nav_port.lock().ok().and_then(|g| *g))
                })
                .build(),
        );
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(macos_guarded_menu)
        .on_menu_event(|app, event| {
            if sharecut::is_guarded_quit_menu_item(event.id().as_ref()) {
                app.exit(0);
            }
        });
    builder
        .manage(SidecarState(Mutex::new(None)))
        .manage(LastOpenedShare(Mutex::new(None)))
        .manage(CloseGuardState(Mutex::new(CloseGuardStatus::default())))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" || is_confirmed_exit(window.app_handle()) {
                    return;
                }
                let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
                    api.prevent_close();
                    eprintln!("Sharecut Studio: main close guard has no webview; preventing close");
                    return;
                };
                api.prevent_close();
                match close_guard_decision(&webview) {
                    sharecut::CloseDecision::Allow => {
                        // Exit while the WebView still exists so ExitRequested can
                        // inspect its current guard instead of seeing a missing
                        // window after Tauri's default close destroys it.
                        window.app_handle().exit(0);
                    }
                    sharecut::CloseDecision::Confirm(risk) => {
                        handle_main_window_close(window, risk);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![open_share_url])
        .setup(move |app| {
            setup_deep_links(app)?;
            if let Some(win) = app.get_webview_window("main") {
                media_capture::install_engine_microphone_handler(&win, engine_port.clone());
            }
            let handle = app.handle().clone();
            let engine_port = engine_port.clone();
            match spawn_sidecar() {
                Ok(child) => {
                    *app.state::<SidecarState>().0.lock().unwrap() = Some(child);
                    thread::spawn(move || {
                        let health = wait_for_engine(&handle, Duration::from_secs(45));
                        if !wait_for_main_window(&handle) {
                            eprintln!(
                                "Sharecut Studio: main window missing after sidecar wait ({health:?})"
                            );
                            return;
                        }
                        match health {
                            Ok(port) => match engine_port.lock() {
                                Ok(mut guard) => {
                                    *guard = Some(port);
                                    drop(guard);
                                    open_engine_window(&handle, port);
                                }
                                Err(_) => {
                                    show_sidecar_error(&handle, "engine port lock poisoned");
                                }
                            },
                            Err(detail) => show_sidecar_error(&handle, &detail),
                        }
                    });
                }
                Err(err) => {
                    eprintln!("Sharecut Studio: failed to start Python sidecar: {err}");
                    eprintln!("Ensure `podcast` is on PATH or bundle sharecut-sidecar.");
                    let handle = app.handle().clone();
                    thread::spawn(move || {
                        if wait_for_main_window(&handle) {
                            show_sidecar_error(&handle, &err);
                        } else {
                            eprintln!(
                                "Sharecut Studio: main window missing; spawn error was: {err}"
                            );
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Sharecut Studio")
        .run(|app_handle, event| {
            match event {
                RunEvent::ExitRequested { api, .. } => {
                    if let Some(risk) = handle_exit_requested(app_handle) {
                        api.prevent_exit();
                        if let Some(webview) = app_handle.get_webview_window("main") {
                            request_close_confirmation(&webview, risk);
                        } else {
                            eprintln!("Sharecut Studio: could not show close confirmation");
                        }
                    }
                }
                RunEvent::Exit => {
                    let taken = app_handle.try_state::<SidecarState>().and_then(|state| {
                        state.0.lock().ok().and_then(|mut guard| guard.take())
                    });
                    if let Some(mut handle) = taken {
                    if let Some(path) = &handle.listen_path {
                        if let Err(err) = std::fs::remove_file(path) {
                            if err.kind() != io::ErrorKind::NotFound {
                                eprintln!(
                                    "Sharecut Studio: could not remove listen file {}: {err}",
                                    path.display()
                                );
                            }
                        }
                    }
                    #[cfg(windows)]
                    {
                        let pid = handle.child.id();
                        let _ = Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status();
                    }
                    let _ = handle.child.kill();
                    let _ = handle.child.wait();
                    }
                }
                _ => {}
            }
        });
}
