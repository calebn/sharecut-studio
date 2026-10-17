//! Glue between the native menu, the Tauri updater plugin, and the pure
//! decisions in `sharecut::update`. Everything here runs natively: the loopback
//! renderer never receives an updater capability or command.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use sharecut::{UpdateState, UpdaterConfig};
use tauri::menu::MenuItem;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const MENU_ID: &str = "sharecut-check-for-updates";
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);
const DIALOG_TITLE: &str = "Software Update";

struct UpdateController {
    item: MenuItem<Wry>,
    state: Mutex<UpdateState>,
    pending: Mutex<Option<Update>>,
    prompting: AtomicBool,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl UpdateController {
    fn snapshot(&self) -> UpdateState {
        locked(&self.state).clone()
    }

    /// Apply `next` when `decide` returns one, and mirror it on the menu item.
    fn transition(&self, decide: impl FnOnce(&UpdateState) -> Option<UpdateState>) -> Option<()> {
        let mut state = locked(&self.state);
        let next = decide(&state)?;
        if let Err(err) = self.item.set_text(next.menu_label()) {
            eprintln!("Sharecut Studio: could not update the update menu label: {err}");
        }
        if let Err(err) = self.item.set_enabled(next.menu_enabled()) {
            eprintln!("Sharecut Studio: could not update the update menu state: {err}");
        }
        *state = next;
        Some(())
    }
}

/// Make the updater plugin read its endpoint and key from the generated
/// distribution constants instead of a static `plugins.updater` block.
pub fn inject_config(config: &mut tauri::Config, updater: UpdaterConfig) {
    config
        .plugins
        .0
        .insert("updater".into(), plugin_config(updater));
}

fn plugin_config(updater: UpdaterConfig) -> serde_json::Value {
    serde_json::json!({
        "endpoints": [updater.endpoint],
        "pubkey": updater.public_key,
    })
}

/// The "Check for Updates…" menu item, present only when the build has an updater.
pub fn menu_item(app: &AppHandle<Wry>) -> tauri::Result<Option<MenuItem<Wry>>> {
    if sharecut::updater_config().is_none() {
        return Ok(None);
    }
    let item = MenuItem::with_id(
        app,
        MENU_ID,
        UpdateState::Idle.menu_label(),
        true,
        None::<&str>,
    )?;
    app.manage(UpdateController {
        item: item.clone(),
        state: Mutex::new(UpdateState::Idle),
        pending: Mutex::new(None),
        prompting: AtomicBool::new(false),
    });
    Ok(Some(item))
}

pub fn on_menu_click(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let (Some(ctl), Some(win)) = (
            app.try_state::<UpdateController>(),
            app.get_webview_window("main"),
        ) else {
            return;
        };
        match ctl.snapshot().available_version().map(str::to_owned) {
            Some(version) => offer(&app, &win, &version, true),
            None => manual_check(&app, &win),
        }
    });
}

/// Quiet background check. Failures are logged, never shown.
pub fn start_launch_check(app: &AppHandle) {
    if sharecut::updater_config().is_none() {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let Some(ctl) = app.try_state::<UpdateController>() else {
            return;
        };
        if ctl.transition(UpdateState::begin_check).is_none() {
            return;
        }
        let update = match check(&app) {
            Ok(Some(update)) => update,
            Ok(None) => {
                ctl.transition(|s| Some(s.finish_check(None)));
                return;
            }
            Err(err) => {
                eprintln!("Sharecut Studio: launch update check failed: {err}");
                ctl.transition(|s| Some(s.fail_check()));
                return;
            }
        };
        let version = update.version.clone();
        *locked(&ctl.pending) = Some(update);
        ctl.transition(|s| Some(s.finish_check(Some(&version))));
        let mode = current_install_mode();
        loop {
            let Some(win) = app.get_webview_window("main") else {
                return;
            };
            let offered = ctl.snapshot().available_version() == Some(version.as_str());
            match sharecut::launch_prompt(mode, crate::close_guard_decision(&win), offered) {
                sharecut::LaunchPrompt::Skip => return,
                sharecut::LaunchPrompt::Wait => thread::sleep(sharecut::GUARD_POLL_INTERVAL),
                sharecut::LaunchPrompt::Show => {
                    offer(&app, &win, &version, false);
                    return;
                }
            }
        }
    });
}

fn current_install_mode() -> sharecut::InstallMode {
    sharecut::install_mode(std::env::consts::OS, std::env::var_os("APPIMAGE").is_some())
}

fn guard_allows(win: &WebviewWindow) -> bool {
    sharecut::may_update(crate::close_guard_decision(win))
}

fn notify(win: &WebviewWindow, text: &str) {
    win.dialog()
        .message(text)
        .title(DIALOG_TITLE)
        .buttons(MessageDialogButtons::Ok)
        .parent(win)
        .blocking_show();
}

fn check(app: &AppHandle) -> Result<Option<Update>, tauri_plugin_updater::Error> {
    let updater = app.updater_builder().timeout(NETWORK_TIMEOUT).build()?;
    tauri::async_runtime::block_on(updater.check())
}

fn failure_kind(err: &tauri_plugin_updater::Error) -> sharecut::FailureKind {
    match err {
        tauri_plugin_updater::Error::Reqwest(err) if err.is_connect() || err.is_timeout() => {
            sharecut::FailureKind::Offline
        }
        _ => sharecut::FailureKind::Other,
    }
}

fn manual_check(app: &AppHandle, win: &WebviewWindow) {
    let Some(ctl) = app.try_state::<UpdateController>() else {
        return;
    };
    if ctl.transition(UpdateState::begin_check).is_none() {
        return;
    }
    match check(app) {
        Ok(Some(update)) => {
            let version = update.version.clone();
            *locked(&ctl.pending) = Some(update);
            ctl.transition(|s| Some(s.finish_check(Some(&version))));
            offer(app, win, &version, true);
        }
        Ok(None) => {
            *locked(&ctl.pending) = None;
            ctl.transition(|s| Some(s.finish_check(None)));
            notify(
                win,
                &sharecut::up_to_date_message(&app.package_info().version.to_string()),
            );
        }
        Err(err) => {
            ctl.transition(|s| Some(s.fail_check()));
            notify(
                win,
                &sharecut::check_failure_message(failure_kind(&err), &err.to_string()),
            );
        }
    }
}

/// Ask once whether to install `version`. `interactive` is true when the user
/// asked, so a refusal is explained; the launch prompt stays silent instead.
fn offer(app: &AppHandle, win: &WebviewWindow, version: &str, interactive: bool) {
    let Some(ctl) = app.try_state::<UpdateController>() else {
        return;
    };
    if current_install_mode() == sharecut::InstallMode::ManualDownload {
        if interactive {
            notify(win, &sharecut::manual_download_message(version));
        }
        return;
    }
    if !guard_allows(win) {
        if interactive {
            notify(win, sharecut::RECORDING_REFUSAL_MESSAGE);
        }
        return;
    }
    if ctl.prompting.swap(true, Ordering::AcqRel) {
        return;
    }
    let confirmed = win
        .dialog()
        .message(sharecut::offer_message(
            sharecut::distribution::PRODUCT_NAME,
            version,
        ))
        .title(DIALOG_TITLE)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and restart".into(),
            "Later".into(),
        ))
        .parent(win)
        .blocking_show();
    ctl.prompting.store(false, Ordering::Release);
    if confirmed {
        install(app, win);
    }
}

fn set_progress(win: &WebviewWindow, status: ProgressBarStatus, progress: Option<u64>) {
    if let Err(err) = win.set_progress_bar(ProgressBarState {
        status: Some(status),
        progress,
    }) {
        eprintln!("Sharecut Studio: could not show update progress: {err}");
    }
}

fn download(win: &WebviewWindow, update: &Update) -> Result<Vec<u8>, tauri_plugin_updater::Error> {
    let mut downloaded = 0u64;
    let mut shown = None;
    set_progress(win, ProgressBarStatus::Indeterminate, None);
    let bytes = tauri::async_runtime::block_on(update.download(
        |chunk, total| {
            downloaded += chunk as u64;
            let percent = sharecut::progress_percent(downloaded, total);
            if percent != shown {
                shown = percent;
                if let Some(percent) = percent {
                    set_progress(win, ProgressBarStatus::Normal, Some(u64::from(percent)));
                }
            }
        },
        || {},
    ));
    set_progress(win, ProgressBarStatus::None, None);
    bytes
}

/// Download, install, and restart. The recording guard is read at click time,
/// again after the download, and once more before the restart. There is no
/// override, so a possibly live recording is never interrupted by an update.
fn install(app: &AppHandle, win: &WebviewWindow) {
    let Some(ctl) = app.try_state::<UpdateController>() else {
        return;
    };
    let Some(update) = locked(&ctl.pending).clone() else {
        return;
    };
    if !guard_allows(win) {
        notify(win, sharecut::RECORDING_REFUSAL_MESSAGE);
        return;
    }
    if ctl.transition(UpdateState::begin_download).is_none() {
        return;
    }
    let bytes = match download(win, &update) {
        Ok(bytes) => bytes,
        Err(err) => {
            ctl.transition(|s| Some(s.back_to_available()));
            notify(
                win,
                &sharecut::install_failure_message(failure_kind(&err), &err.to_string()),
            );
            return;
        }
    };
    ctl.transition(UpdateState::begin_install);
    if !guard_allows(win) {
        ctl.transition(|s| Some(s.back_to_available()));
        notify(win, sharecut::RECORDING_REFUSAL_MESSAGE);
        return;
    }
    // The Windows installer exits this process and replaces files the engine
    // holds open, so the engine must already be gone.
    if cfg!(windows) {
        crate::shutdown_sidecar(app);
    }
    if let Err(err) = update.install(&bytes) {
        ctl.transition(|s| Some(s.back_to_available()));
        let detail = sharecut::install_failure_message(failure_kind(&err), &err.to_string());
        let restart_hint = if cfg!(windows) {
            " The engine was stopped, so restart Sharecut Studio."
        } else {
            ""
        };
        notify(win, &format!("{detail}{restart_hint}"));
        return;
    }
    RESTART_PENDING.store(true, Ordering::Release);
    app.exit(0);
}

/// Called from `ExitRequested`. Reads the recording guard at the moment of
/// exit, so a pending update restart is either allowed or cleared right there.
pub fn gate_exit(app: &AppHandle) -> sharecut::RestartGate {
    let pending = RESTART_PENDING.load(Ordering::Acquire);
    if !pending {
        return sharecut::RestartGate::NotPending;
    }
    let guard = match app.get_webview_window("main") {
        Some(win) => crate::close_guard_decision(&win),
        None => sharecut::close_decision_from_url(None),
    };
    let gate = sharecut::restart_gate(pending, guard);
    if gate == sharecut::RestartGate::Refuse {
        RESTART_PENDING.store(false, Ordering::Release);
        if let Some(ctl) = app.try_state::<UpdateController>() {
            ctl.transition(|_| Some(UpdateState::Idle));
        }
        if let Some(win) = app.get_webview_window("main") {
            win.dialog()
                .message(format!(
                    "The update is installed. {}",
                    sharecut::RECORDING_REFUSAL_MESSAGE
                ))
                .title(DIALOG_TITLE)
                .buttons(MessageDialogButtons::Ok)
                .parent(&win)
                .show(|_| {});
        }
    }
    gate
}

/// True once when the exit that just happened was an approved update restart.
pub fn take_restart_on_exit() -> bool {
    RESTART_PENDING.swap(false, Ordering::AcqRel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_config_deserializes_into_the_updater_plugin_config() {
        let config: tauri_plugin_updater::Config =
            serde_json::from_value(plugin_config(UpdaterConfig {
                endpoint: "https://downloads.example.test/latest.json",
                public_key: "PUBLIC-KEY",
            }))
            .expect("updater plugin config");

        assert_eq!(
            config
                .endpoints
                .iter()
                .map(|u| u.as_str())
                .collect::<Vec<_>>(),
            vec!["https://downloads.example.test/latest.json"]
        );
        assert_eq!(config.pubkey, "PUBLIC-KEY");
    }
}
