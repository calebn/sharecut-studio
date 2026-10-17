//! Glue between the native menu, the Tauri updater plugin, and the pure
//! decisions in `sharecut::update`. Everything here runs natively: the loopback
//! renderer never receives an updater capability or command.

use std::path::PathBuf;
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
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);
const DIALOG_TITLE: &str = "Software Update";

struct UpdateController {
    item: MenuItem<Wry>,
    state: Mutex<UpdateState>,
    pending: Mutex<Option<Update>>,
    declined: Mutex<Option<String>>,
    prompting: AtomicBool,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Puts the menu back if a worker panics mid-step instead of leaving it disabled.
struct PanicRestore<'a>(&'a UpdateController);

impl Drop for PanicRestore<'_> {
    fn drop(&mut self) {
        if thread::panicking() {
            self.0.transition(|s| Some(s.recover()));
        }
    }
}

/// How an offer was reached. Only a click on the menu item itself may show the
/// recording refusal as a modal; everything else could land while recording.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
    Click,
    ManualCheck,
    Launch,
}

impl UpdateController {
    fn snapshot(&self) -> UpdateState {
        locked(&self.state).clone()
    }

    /// Apply `next` when `decide` returns one, and mirror it on the menu item.
    /// The menu hops to the main thread, which may itself be waiting on this
    /// controller, so the state lock is released first.
    fn transition(&self, decide: impl FnOnce(&UpdateState) -> Option<UpdateState>) -> Option<()> {
        let next = {
            let mut state = locked(&self.state);
            let next = decide(&state)?;
            *state = next.clone();
            next
        };
        if let Err(err) = self.item.set_text(next.menu_label()) {
            eprintln!("Sharecut Studio: could not update the update menu label: {err}");
        }
        if let Err(err) = self.item.set_enabled(next.menu_enabled()) {
            eprintln!("Sharecut Studio: could not update the update menu state: {err}");
        }
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
        declined: Mutex::new(None),
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
        let state = ctl.snapshot();
        if state.restartable() {
            restart_now(&win);
        } else if let Some(version) = state.retry_version().map(str::to_owned) {
            *locked(&ctl.declined) = None;
            offer(&app, &win, &version, Origin::Click);
        } else {
            manual_check(&app, &win);
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
        let restore = PanicRestore(&ctl);
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
        drop(restore);
        loop {
            let Some(win) = app.get_webview_window("main") else {
                return;
            };
            let offered =
                sharecut::is_offered(&ctl.snapshot(), locked(&ctl.declined).as_deref(), &version);
            let mode = if install_blocker(&version).is_some() {
                sharecut::InstallMode::ManualDownload
            } else {
                sharecut::InstallMode::SelfInstall
            };
            match sharecut::launch_prompt(mode, crate::close_guard_decision(&win), offered) {
                sharecut::LaunchPrompt::Skip => return,
                sharecut::LaunchPrompt::Wait => thread::sleep(sharecut::GUARD_POLL_INTERVAL),
                sharecut::LaunchPrompt::Show => {
                    offer(&app, &win, &version, Origin::Launch);
                    return;
                }
            }
        }
    });
}

fn current_install_mode() -> sharecut::InstallMode {
    let system_package = matches!(
        tauri::utils::platform::bundle_type(),
        Some(tauri::utils::config::BundleType::Deb | tauri::utils::config::BundleType::Rpm)
    );
    sharecut::install_mode(
        std::env::consts::OS,
        std::env::var_os("APPIMAGE").is_some(),
        system_package,
    )
}

/// Create and remove a probe file. On success returns the owner id of the new
/// file, which is this process's effective user id (0 where ids do not apply).
fn probe_dir(dir: &std::path::Path) -> Option<u32> {
    let probe = dir.join(format!(".sharecut-write-probe-{}", std::process::id()));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .ok()?;
    #[cfg(unix)]
    let owner = {
        use std::os::unix::fs::MetadataExt;
        file.metadata().map(|meta| meta.uid()).unwrap_or(u32::MAX)
    };
    #[cfg(not(unix))]
    let owner = 0;
    drop(file);
    let _ = std::fs::remove_file(&probe);
    Some(owner)
}

#[cfg(target_os = "macos")]
fn owns_bundle(euid: u32, dir: &std::path::Path, exe: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Some(bundle) = exe
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
    else {
        return true;
    };
    match (std::fs::metadata(bundle), std::fs::metadata(dir)) {
        (Ok(bundle), Ok(dir)) => sharecut::may_replace_bundle(euid, bundle.uid(), dir.uid()),
        _ => false,
    }
}

#[cfg(not(target_os = "macos"))]
fn owns_bundle(_euid: u32, _dir: &std::path::Path, _exe: &std::path::Path) -> bool {
    true
}

/// Why this install cannot update itself, if it cannot. The plugin would
/// otherwise raise an administrator prompt that blocks with no limit.
fn install_blocker(version: &str) -> Option<String> {
    if current_install_mode() == sharecut::InstallMode::ManualDownload {
        return Some(sharecut::manual_download_message(version));
    }
    let exe = std::env::current_exe().ok()?;
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let dir = sharecut::install_dir(std::env::consts::OS, &exe, appimage.as_deref())?;
    let writable = probe_dir(&dir).is_some_and(|euid| owns_bundle(euid, &dir, &exe));
    sharecut::placement_notice(std::env::consts::OS, &exe, writable)
}

fn guard_allows(win: &WebviewWindow) -> bool {
    sharecut::may_update(crate::close_guard_decision(win))
}

/// A modal sheet can cover the recording UI, so every notice goes through this
/// guard re-read; while recording it is logged instead and the menu label
/// carries the state. The one exception is the recording refusal shown right
/// after the user's own click on the menu item (or on Restart).
fn notify_if_idle(win: &WebviewWindow, text: &str) {
    if guard_allows(win) {
        notify(win, text);
    } else {
        eprintln!("Sharecut Studio: update notice withheld during recording: {text}");
    }
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
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()?;
    let found = tauri::async_runtime::block_on(updater.check())?;
    // The check timeout is per request; the download body must not inherit it.
    Ok(found.map(|mut update| {
        update.timeout = None;
        update
    }))
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
    let restore = PanicRestore(&ctl);
    let result = check(app);
    drop(restore);
    match result {
        Ok(Some(update)) => {
            let version = update.version.clone();
            *locked(&ctl.pending) = Some(update);
            ctl.transition(|s| Some(s.finish_check(Some(&version))));
            offer(app, win, &version, Origin::ManualCheck);
        }
        Ok(None) => {
            *locked(&ctl.pending) = None;
            ctl.transition(|s| Some(s.finish_check(None)));
            notify_if_idle(
                win,
                &sharecut::up_to_date_message(&app.package_info().version.to_string()),
            );
        }
        Err(err) => {
            ctl.transition(|s| Some(s.fail_check()));
            notify_if_idle(
                win,
                &sharecut::check_failure_message(failure_kind(&err), &err.to_string()),
            );
        }
    }
}

/// Ask once whether to install `version`.
fn offer(app: &AppHandle, win: &WebviewWindow, version: &str, origin: Origin) {
    let Some(ctl) = app.try_state::<UpdateController>() else {
        return;
    };
    if let Some(notice) = install_blocker(version) {
        if origin != Origin::Launch {
            notify_if_idle(win, &notice);
        }
        return;
    }
    if !guard_allows(win) {
        refuse_for_recording(win, origin);
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
    if confirmed {
        install(app, win, origin);
    } else {
        *locked(&ctl.declined) = Some(version.to_string());
    }
    ctl.prompting.store(false, Ordering::Release);
}

fn refuse_for_recording(win: &WebviewWindow, origin: Origin) {
    if origin == Origin::Click {
        notify(win, sharecut::RECORDING_REFUSAL_MESSAGE);
    } else {
        notify_if_idle(win, sharecut::RECORDING_REFUSAL_MESSAGE);
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

struct LiveInstall<'a> {
    app: &'a AppHandle,
    win: &'a WebviewWindow,
    ctl: &'a UpdateController,
    update: &'a Update,
}

impl sharecut::InstallSteps for LiveInstall<'_> {
    type Bytes = Vec<u8>;

    fn guard_allows(&mut self) -> bool {
        guard_allows(self.win)
    }

    fn placement_blocker(&mut self) -> Option<String> {
        install_blocker(&self.update.version)
    }

    fn claim(&mut self) -> bool {
        self.ctl.transition(UpdateState::begin_download).is_some()
    }

    fn download(&mut self) -> Result<Vec<u8>, sharecut::StepError> {
        let bytes = download(self.win, self.update).map_err(step_error)?;
        self.ctl.transition(UpdateState::begin_install);
        Ok(bytes)
    }

    fn stop_engine(&mut self) {
        sharecut::clear_engine_port(&self.app.state::<crate::EnginePortState>().0);
        crate::shutdown_sidecar(self.app);
    }

    fn install(&mut self, bytes: &Vec<u8>) -> Result<(), sharecut::StepError> {
        self.update.install(bytes).map_err(step_error)
    }

    // On Windows `update.install` exits the process, so this relaunch branch
    // only runs on macOS and Linux.
    fn request_restart(&mut self) {
        self.ctl.transition(UpdateState::finish_install);
        request_restart(self.app);
    }

    fn respawn_engine(&mut self) -> bool {
        match crate::respawn_engine(self.app) {
            Ok(()) => true,
            Err(err) => {
                eprintln!(
                    "Sharecut Studio: could not restart the engine after a failed update: {err}"
                );
                crate::show_sidecar_error(self.app, &err);
                false
            }
        }
    }
}

fn step_error(err: tauri_plugin_updater::Error) -> sharecut::StepError {
    sharecut::StepError {
        kind: failure_kind(&err),
        detail: err.to_string(),
    }
}

/// Run the install and show its outcome. The step order lives in
/// `sharecut::run_install`; the recording guard is read at click time, after the
/// download, and at the exit request. There is no override.
fn install(app: &AppHandle, win: &WebviewWindow, origin: Origin) {
    let Some(ctl) = app.try_state::<UpdateController>() else {
        return;
    };
    let Some(update) = locked(&ctl.pending).clone() else {
        return;
    };
    let restore = PanicRestore(&ctl);
    let outcome = sharecut::run_install(&mut LiveInstall {
        app,
        win,
        ctl: &ctl,
        update: &update,
    });
    drop(restore);
    match outcome {
        sharecut::InstallOutcome::Restarting | sharecut::InstallOutcome::Busy => {}
        sharecut::InstallOutcome::RefusedByGuard => refuse_for_recording(win, origin),
        sharecut::InstallOutcome::Blocked(notice) => notify_if_idle(win, &notice),
        sharecut::InstallOutcome::DownloadFailed(error) => {
            ctl.transition(|s| Some(s.back_to_available()));
            notify_if_idle(
                win,
                &sharecut::install_failure_message(error.kind, &error.detail),
            );
        }
        sharecut::InstallOutcome::Skipped => {
            ctl.transition(|s| Some(s.back_to_available()));
            eprintln!(
                "Sharecut Studio: update install skipped; recording or install location changed, download discarded"
            );
        }
        sharecut::InstallOutcome::InstallFailed { error, respawned } => {
            ctl.transition(|s| Some(s.fail_install()));
            let detail = sharecut::install_failure_message(error.kind, &error.detail);
            let tail = if respawned {
                "Sharecut Studio is still on the old version."
            } else {
                "The engine was stopped, so restart Sharecut Studio."
            };
            notify_if_idle(win, &format!("{detail} {tail}"));
        }
    }
}

fn request_restart(app: &AppHandle) {
    sharecut::arm_restart(&RESTART_PENDING);
    app.exit(0);
}

/// Menu action once files are replaced: relaunch, guarded like the install.
fn restart_now(win: &WebviewWindow) {
    if guard_allows(win) {
        request_restart(win.app_handle());
    } else {
        notify(win, sharecut::RECORDING_REFUSAL_MESSAGE);
    }
}

/// Called from `ExitRequested`; the decision is `sharecut::exit_gate`.
pub fn gate_exit(app: &AppHandle) -> sharecut::RestartGate {
    let installing = app
        .try_state::<UpdateController>()
        .is_some_and(|ctl| ctl.snapshot().is_installing());
    sharecut::exit_gate(&RESTART_PENDING, installing, || {
        match app.get_webview_window("main") {
            Some(win) => crate::close_guard_decision(&win),
            None => sharecut::close_decision_from_url(None),
        }
    })
}

/// True once when the exit that just happened was an approved update restart.
pub fn take_restart_on_exit() -> bool {
    sharecut::take_restart(&RESTART_PENDING)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_config_adds_the_updater_plugin_entry() {
        let mut config = tauri::Config::default();
        inject_config(
            &mut config,
            UpdaterConfig {
                endpoint: "https://downloads.example.test/latest.json",
                public_key: "PUBLIC-KEY",
            },
        );

        assert_eq!(
            config.plugins.0.get("updater"),
            Some(&serde_json::json!({
                "endpoints": ["https://downloads.example.test/latest.json"],
                "pubkey": "PUBLIC-KEY",
            }))
        );
    }

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
