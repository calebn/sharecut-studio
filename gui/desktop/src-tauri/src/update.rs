//! Pure in-app update decisions for the native desktop host (no Tauri types).
//!
//! `updater.rs` in the binary drives the Tauri updater plugin; every branch it
//! takes is decided here so it can be tested without a WebView.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::close_guard::CloseDecision;

/// How long the host waits before asking the recording guard again.
pub const GUARD_POLL_INTERVAL: Duration = Duration::from_secs(60);

pub const RECORDING_REFUSAL_MESSAGE: &str =
    "Finish or stop recording first, then check for updates again.";

/// Minimal signed-update settings taken from the distribution profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpdaterConfig {
    pub endpoint: &'static str,
    pub public_key: &'static str,
}

/// Updates are on only when the profile sets both the endpoint and the key.
pub const fn updater_config(
    endpoint: Option<&'static str>,
    public_key: Option<&'static str>,
) -> Option<UpdaterConfig> {
    match (endpoint, public_key) {
        (Some(endpoint), Some(public_key)) => Some(UpdaterConfig {
            endpoint,
            public_key,
        }),
        _ => None,
    }
}

/// Where an update can be applied from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallMode {
    SelfInstall,
    /// A `.deb` install is owned by the package manager, so the host only informs.
    ManualDownload,
}

/// `os` is `std::env::consts::OS`; `appimage` is whether `APPIMAGE` is set;
/// `system_package` is whether the build was bundled as a deb or rpm.
pub fn install_mode(os: &str, appimage: bool, system_package: bool) -> InstallMode {
    if os == "linux" && (!appimage || system_package) {
        InstallMode::ManualDownload
    } else {
        InstallMode::SelfInstall
    }
}

/// Update lifecycle seen by the menu item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateState {
    Idle,
    /// `known` is the version already offered, kept if this check fails.
    Checking {
        known: Option<String>,
    },
    Available {
        version: String,
    },
    Downloading {
        version: String,
    },
    Installing {
        version: String,
    },
    /// The install failed after the engine was restarted on the old version.
    InstallFailed {
        version: String,
    },
    /// Files are replaced; only a relaunch is left.
    Restartable {
        version: String,
    },
}

impl UpdateState {
    /// Start a check, or `None` while one is already running or an install is under way.
    pub fn begin_check(&self) -> Option<UpdateState> {
        match self {
            UpdateState::Idle => Some(UpdateState::Checking { known: None }),
            UpdateState::Available { version } | UpdateState::InstallFailed { version } => {
                Some(UpdateState::Checking {
                    known: Some(version.clone()),
                })
            }
            _ => None,
        }
    }

    /// Settle a check: a newer version makes it available, otherwise back to idle.
    pub fn finish_check(&self, found: Option<&str>) -> UpdateState {
        match (self, found) {
            (UpdateState::Checking { .. }, Some(version)) => UpdateState::Available {
                version: version.to_string(),
            },
            (UpdateState::Checking { .. }, None) => UpdateState::Idle,
            (other, _) => other.clone(),
        }
    }

    /// A failed check keeps whatever was already on offer.
    pub fn fail_check(&self) -> UpdateState {
        match self {
            UpdateState::Checking {
                known: Some(version),
            } => UpdateState::Available {
                version: version.clone(),
            },
            UpdateState::Checking { known: None } => UpdateState::Idle,
            other => other.clone(),
        }
    }

    pub fn begin_download(&self) -> Option<UpdateState> {
        match self {
            UpdateState::Available { version } | UpdateState::InstallFailed { version } => {
                Some(UpdateState::Downloading {
                    version: version.clone(),
                })
            }
            _ => None,
        }
    }

    pub fn begin_install(&self) -> Option<UpdateState> {
        match self {
            UpdateState::Downloading { version } => Some(UpdateState::Installing {
                version: version.clone(),
            }),
            _ => None,
        }
    }

    /// The new version is on disk, so the next step is only a relaunch.
    pub fn finish_install(&self) -> Option<UpdateState> {
        match self {
            UpdateState::Installing { version } => Some(UpdateState::Restartable {
                version: version.clone(),
            }),
            _ => None,
        }
    }

    pub fn fail_install(&self) -> UpdateState {
        match self {
            UpdateState::Installing { version } => UpdateState::InstallFailed {
                version: version.clone(),
            },
            other => other.clone(),
        }
    }

    /// Where a worker that panicked mid-step leaves the menu.
    pub fn recover(&self) -> UpdateState {
        match self {
            UpdateState::Checking { .. } => self.fail_check(),
            UpdateState::Downloading { .. } | UpdateState::Installing { .. } => {
                self.back_to_available()
            }
            other => other.clone(),
        }
    }

    /// The version a menu click should offer again, including after a failed install.
    pub fn retry_version(&self) -> Option<&str> {
        match self {
            UpdateState::Available { version } | UpdateState::InstallFailed { version } => {
                Some(version)
            }
            _ => None,
        }
    }

    pub fn is_installing(&self) -> bool {
        matches!(self, UpdateState::Installing { .. })
    }

    pub fn restartable(&self) -> bool {
        matches!(self, UpdateState::Restartable { .. })
    }

    /// A refused or failed install leaves the update on offer for another try.
    pub fn back_to_available(&self) -> UpdateState {
        match self {
            UpdateState::Downloading { version } | UpdateState::Installing { version } => {
                UpdateState::Available {
                    version: version.clone(),
                }
            }
            other => other.clone(),
        }
    }

    pub fn available_version(&self) -> Option<&str> {
        match self {
            UpdateState::Available { version } => Some(version),
            _ => None,
        }
    }

    pub fn menu_label(&self) -> String {
        match self {
            UpdateState::Idle => "Check for Updates…".to_string(),
            UpdateState::Checking { .. } => "Checking for Updates…".to_string(),
            UpdateState::Available { version } => format!("Update to v{version} Available…"),
            UpdateState::Downloading { .. } => "Downloading Update…".to_string(),
            UpdateState::Installing { .. } => "Installing Update…".to_string(),
            UpdateState::InstallFailed { .. } => "Update failed — retry…".to_string(),
            UpdateState::Restartable { .. } => "Restart to Finish Update…".to_string(),
        }
    }

    pub fn menu_enabled(&self) -> bool {
        matches!(
            self,
            UpdateState::Idle
                | UpdateState::Available { .. }
                | UpdateState::InstallFailed { .. }
                | UpdateState::Restartable { .. }
        )
    }
}

/// Updating restarts the app, so only a clear recording guard permits it.
/// There is deliberately no "update anyway" path, unlike quitting.
pub fn may_update(decision: CloseDecision) -> bool {
    decision == CloseDecision::Allow
}

/// An offer the user already declined is not shown again by the launch check.
pub fn is_offered(state: &UpdateState, declined: Option<&str>, version: &str) -> bool {
    state.available_version() == Some(version) && declined != Some(version)
}

/// The directory whose write access decides whether the app can replace itself.
/// `None` where no pre-flight applies (Windows installers elevate on their own).
pub fn install_dir(os: &str, exe: &Path, appimage: Option<&Path>) -> Option<PathBuf> {
    match os {
        "macos" => exe
            .ancestors()
            .find(|path| path.extension().is_some_and(|ext| ext == "app"))
            .and_then(Path::parent)
            .map(Path::to_path_buf),
        "linux" => appimage.and_then(Path::parent).map(Path::to_path_buf),
        _ => None,
    }
}

fn runs_from_disk_image(os: &str, exe: &Path) -> bool {
    os == "macos"
        && (exe
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
            || exe.starts_with("/Volumes"))
}

/// A notice when the app cannot replace itself where it is installed.
pub fn placement_notice(os: &str, exe: &Path, writable: bool) -> Option<String> {
    if runs_from_disk_image(os, exe) {
        Some(
            "Move Sharecut Studio to Applications first, then check for updates again.".to_string(),
        )
    } else if writable {
        None
    } else {
        Some(
            "Sharecut Studio can't update itself from this location. Download the new version from the Sharecut Studio site."
                .to_string(),
        )
    }
}

/// What an exit request means while an update restart may be pending.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestartGate {
    /// No update restart is pending: the normal quit guard applies.
    NotPending,
    /// The guard is clear, so the exit may go ahead and the host relaunches.
    Proceed,
    /// The guard turned active: drop the pending restart and keep the app open.
    Refuse,
    /// A bundle swap is under way: an exit not started by the restart waits.
    Installing,
}

/// The last guard read happens inside the exit request itself, so a refused
/// restart is cleared by the host and never left armed for a later quit.
pub fn restart_gate(pending: bool, guard: CloseDecision) -> RestartGate {
    match (pending, may_update(guard)) {
        (false, _) => RestartGate::NotPending,
        (true, true) => RestartGate::Proceed,
        (true, false) => RestartGate::Refuse,
    }
}

/// Replacing a bundle needs ownership of it, or of the folder it sits in
/// (`/Applications` is sticky, so a bundle owned by someone else cannot be swapped).
pub fn may_replace_bundle(euid: u32, bundle_uid: u32, parent_uid: u32) -> bool {
    euid == 0 || bundle_uid == euid || parent_uid == euid
}

/// The ExitRequested decision. A refused restart is disarmed here, in the same
/// step that read the guard, so it can never fire on a later quit.
pub fn exit_gate(
    pending: &AtomicBool,
    installing: bool,
    read_guard: impl FnOnce() -> CloseDecision,
) -> RestartGate {
    if !pending.load(Ordering::Acquire) {
        return if installing {
            RestartGate::Installing
        } else {
            RestartGate::NotPending
        };
    }
    let gate = restart_gate(true, read_guard());
    if gate == RestartGate::Refuse {
        pending.store(false, Ordering::Release);
    }
    gate
}

/// The engine port other code trusts for navigation and microphone access
/// must not outlive the engine it named, or a squatter could inherit it.
pub fn clear_engine_port(slot: &Mutex<Option<u16>>) {
    if let Ok(mut port) = slot.lock() {
        *port = None;
    }
}

/// A respawn that races a quit must not leave an engine behind after exit.
pub fn spawn_allowed(exiting: &AtomicBool) -> bool {
    !exiting.load(Ordering::Acquire)
}

pub fn mark_exiting(exiting: &AtomicBool) {
    exiting.store(true, Ordering::Release);
}

pub fn arm_restart(pending: &AtomicBool) {
    pending.store(true, Ordering::Release);
}

/// True once when the exit that just happened was an approved update restart.
pub fn take_restart(pending: &AtomicBool) -> bool {
    pending.swap(false, Ordering::AcqRel)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepError {
    pub kind: FailureKind,
    pub detail: String,
}

/// Side effects of one install, in the order `run_install` performs them.
pub trait InstallSteps {
    type Bytes;
    fn guard_allows(&mut self) -> bool;
    fn placement_blocker(&mut self) -> Option<String>;
    /// Claim the single install slot; false when another install already holds it.
    fn claim(&mut self) -> bool;
    fn download(&mut self) -> Result<Self::Bytes, StepError>;
    fn stop_engine(&mut self);
    fn install(&mut self, bytes: &Self::Bytes) -> Result<(), StepError>;
    fn request_restart(&mut self);
    fn respawn_engine(&mut self) -> bool;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallOutcome {
    RefusedByGuard,
    Blocked(String),
    DownloadFailed(StepError),
    /// Another install already holds the slot.
    Busy,
    /// The guard or the install location changed during the download.
    Skipped,
    InstallFailed {
        error: StepError,
        respawned: bool,
    },
    Restarting,
}

/// Guard, preflight, download, guard again, stop the engine, install, relaunch.
/// The engine is stopped only once nothing can refuse the install any more.
pub fn run_install<S: InstallSteps>(steps: &mut S) -> InstallOutcome {
    if !steps.guard_allows() {
        return InstallOutcome::RefusedByGuard;
    }
    if let Some(notice) = steps.placement_blocker() {
        return InstallOutcome::Blocked(notice);
    }
    if !steps.claim() {
        return InstallOutcome::Busy;
    }
    let bytes = match steps.download() {
        Ok(bytes) => bytes,
        Err(error) => return InstallOutcome::DownloadFailed(error),
    };
    if !steps.guard_allows() || steps.placement_blocker().is_some() {
        return InstallOutcome::Skipped;
    }
    steps.stop_engine();
    if let Err(error) = steps.install(&bytes) {
        let respawned = steps.respawn_engine();
        return InstallOutcome::InstallFailed { error, respawned };
    }
    steps.request_restart();
    InstallOutcome::Restarting
}

/// What the launch-time check should do on each poll of the recording guard.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchPrompt {
    Show,
    Wait,
    Skip,
}

/// `still_offered` is false once the user acted on the update or it was replaced.
pub fn launch_prompt(mode: InstallMode, guard: CloseDecision, still_offered: bool) -> LaunchPrompt {
    if !still_offered || mode == InstallMode::ManualDownload {
        LaunchPrompt::Skip
    } else if may_update(guard) {
        LaunchPrompt::Show
    } else {
        LaunchPrompt::Wait
    }
}

/// Whole percent downloaded, or `None` when the server sent no length.
pub fn progress_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some((downloaded.min(total) * 100 / total) as u8)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureKind {
    Offline,
    Other,
}

pub fn up_to_date_message(current_version: &str) -> String {
    format!("You're on the latest version ({current_version}).")
}

pub fn offer_message(product: &str, version: &str) -> String {
    format!("{product} {version} is available.")
}

pub fn manual_download_message(version: &str) -> String {
    format!(
        "Version {version} is available. Download the new package from the Sharecut Studio site."
    )
}

pub fn check_failure_message(kind: FailureKind, detail: &str) -> String {
    match kind {
        FailureKind::Offline => {
            "Couldn't reach the update server. Check your internet connection and try again."
                .to_string()
        }
        FailureKind::Other => format!("Couldn't check for updates: {detail}"),
    }
}

pub fn install_failure_message(kind: FailureKind, detail: &str) -> String {
    match kind {
        FailureKind::Offline => {
            "The update download was interrupted. Check your internet connection and try again."
                .to_string()
        }
        FailureKind::Other => format!("Couldn't install the update: {detail}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::close_guard::CloseRisk;

    fn available(version: &str) -> UpdateState {
        UpdateState::Available {
            version: version.to_string(),
        }
    }

    #[test]
    fn config_needs_both_endpoint_and_key() {
        assert_eq!(updater_config(None, None), None);
        assert_eq!(
            updater_config(Some("https://u.test/latest.json"), None),
            None
        );
        assert_eq!(updater_config(None, Some("KEY")), None);
        assert_eq!(
            updater_config(Some("https://u.test/latest.json"), Some("KEY")),
            Some(UpdaterConfig {
                endpoint: "https://u.test/latest.json",
                public_key: "KEY",
            })
        );
    }

    #[test]
    fn only_linux_without_appimage_installs_manually() {
        assert_eq!(
            install_mode("linux", false, false),
            InstallMode::ManualDownload
        );
        assert_eq!(install_mode("linux", true, false), InstallMode::SelfInstall);
        assert_eq!(
            install_mode("linux", true, true),
            InstallMode::ManualDownload
        );
        assert_eq!(
            install_mode("macos", false, false),
            InstallMode::SelfInstall
        );
        assert_eq!(
            install_mode("windows", false, false),
            InstallMode::SelfInstall
        );
    }

    #[test]
    fn a_found_update_walks_check_download_install() {
        let state = UpdateState::Idle.begin_check().unwrap();
        assert_eq!(state, UpdateState::Checking { known: None });
        let state = state.finish_check(Some("1.2.0"));
        assert_eq!(state, available("1.2.0"));
        let state = state.begin_download().unwrap();
        assert_eq!(
            state,
            UpdateState::Downloading {
                version: "1.2.0".into()
            }
        );
        assert_eq!(
            state.begin_install().unwrap(),
            UpdateState::Installing {
                version: "1.2.0".into()
            }
        );
    }

    #[test]
    fn up_to_date_check_returns_to_idle() {
        let state = UpdateState::Idle.begin_check().unwrap();
        assert_eq!(state.finish_check(None), UpdateState::Idle);
    }

    #[test]
    fn failed_check_keeps_a_known_offer_and_drops_nothing_else() {
        let rechecking = available("1.2.0").begin_check().unwrap();
        assert_eq!(rechecking.fail_check(), available("1.2.0"));
        let first = UpdateState::Idle.begin_check().unwrap();
        assert_eq!(first.fail_check(), UpdateState::Idle);
    }

    #[test]
    fn busy_states_refuse_a_second_check_or_download() {
        let checking = UpdateState::Idle.begin_check().unwrap();
        assert_eq!(checking.begin_check(), None);
        assert_eq!(checking.begin_download(), None);
        let downloading = available("1.2.0").begin_download().unwrap();
        assert_eq!(downloading.begin_check(), None);
        assert_eq!(UpdateState::Idle.begin_download(), None);
        assert_eq!(available("1.2.0").begin_install(), None);
    }

    #[test]
    fn refused_or_failed_install_returns_to_available() {
        let downloading = available("1.2.0").begin_download().unwrap();
        assert_eq!(downloading.back_to_available(), available("1.2.0"));
        let installing = downloading.begin_install().unwrap();
        assert_eq!(installing.back_to_available(), available("1.2.0"));
        assert_eq!(UpdateState::Idle.back_to_available(), UpdateState::Idle);
    }

    #[test]
    fn menu_label_and_enabled_follow_the_state() {
        assert_eq!(UpdateState::Idle.menu_label(), "Check for Updates…");
        assert!(UpdateState::Idle.menu_enabled());
        assert_eq!(
            UpdateState::Idle.begin_check().unwrap().menu_label(),
            "Checking for Updates…"
        );
        assert!(!UpdateState::Idle.begin_check().unwrap().menu_enabled());
        assert_eq!(
            available("1.2.0").menu_label(),
            "Update to v1.2.0 Available…"
        );
        assert!(available("1.2.0").menu_enabled());
        let downloading = available("1.2.0").begin_download().unwrap();
        assert_eq!(downloading.menu_label(), "Downloading Update…");
        assert!(!downloading.menu_enabled());
        let installing = downloading.begin_install().unwrap();
        assert_eq!(installing.menu_label(), "Installing Update…");
        assert!(!installing.menu_enabled());
    }

    #[test]
    fn only_a_clear_guard_may_update() {
        assert!(may_update(CloseDecision::Allow));
        assert!(!may_update(CloseDecision::Confirm(CloseRisk::Host)));
        assert!(!may_update(CloseDecision::Confirm(CloseRisk::Guest)));
        assert!(!may_update(CloseDecision::Confirm(CloseRisk::Unknown)));
    }

    #[test]
    fn an_installed_update_offers_a_restart_not_another_download() {
        let installing = available("1.2.0")
            .begin_download()
            .unwrap()
            .begin_install()
            .unwrap();
        let done = installing.finish_install().unwrap();
        assert_eq!(
            done,
            UpdateState::Restartable {
                version: "1.2.0".into()
            }
        );
        assert!(done.restartable());
        assert_eq!(done.menu_label(), "Restart to Finish Update…");
        assert!(done.menu_enabled());
        assert_eq!(done.begin_check(), None);
        assert_eq!(done.begin_download(), None);
        assert_eq!(done.available_version(), None);
        assert_eq!(UpdateState::Idle.finish_install(), None);
    }

    #[test]
    fn a_declined_version_is_not_offered_again() {
        let state = available("1.2.0");
        assert!(is_offered(&state, None, "1.2.0"));
        assert!(!is_offered(&state, Some("1.2.0"), "1.2.0"));
        assert!(is_offered(&state, Some("1.1.0"), "1.2.0"));
        assert!(!is_offered(&UpdateState::Idle, None, "1.2.0"));
        assert!(!is_offered(&state, None, "1.3.0"));
    }

    #[test]
    fn install_dir_is_the_parent_of_the_bundle_or_appimage() {
        let exe = Path::new("/Applications/Sharecut Studio.app/Contents/MacOS/sharecut");
        assert_eq!(
            install_dir("macos", exe, None),
            Some(PathBuf::from("/Applications"))
        );
        assert_eq!(
            install_dir(
                "linux",
                Path::new("/tmp/.mount_x/usr/bin/sharecut"),
                Some(Path::new("/home/me/apps/Sharecut.AppImage"))
            ),
            Some(PathBuf::from("/home/me/apps"))
        );
        assert_eq!(install_dir("linux", exe, None), None);
        assert_eq!(install_dir("windows", exe, None), None);
    }

    #[test]
    fn placement_notice_explains_disk_images_and_read_only_installs() {
        let applications = Path::new("/Applications/Sharecut Studio.app/Contents/MacOS/sharecut");
        let dmg = Path::new("/Volumes/Sharecut Studio/Sharecut Studio.app/Contents/MacOS/sharecut");
        let translocated = Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/Sharecut Studio.app/Contents/MacOS/sharecut",
        );
        assert_eq!(placement_notice("macos", applications, true), None);
        assert_eq!(
            placement_notice("macos", dmg, true).as_deref(),
            Some("Move Sharecut Studio to Applications first, then check for updates again.")
        );
        assert_eq!(
            placement_notice("macos", translocated, false).as_deref(),
            Some("Move Sharecut Studio to Applications first, then check for updates again.")
        );
        assert_eq!(
            placement_notice("macos", applications, false).as_deref(),
            Some("Sharecut Studio can't update itself from this location. Download the new version from the Sharecut Studio site.")
        );
        assert_eq!(placement_notice("linux", Path::new("/opt/a"), true), None);
    }

    #[derive(Default)]
    struct Mock {
        calls: Vec<&'static str>,
        guard: Vec<bool>,
        blockers: Vec<Option<String>>,
        busy: bool,
        download_fails: bool,
        install_fails: bool,
        respawns: bool,
    }

    impl InstallSteps for Mock {
        type Bytes = u8;
        fn guard_allows(&mut self) -> bool {
            self.calls.push("guard");
            if self.guard.is_empty() {
                true
            } else {
                self.guard.remove(0)
            }
        }
        fn placement_blocker(&mut self) -> Option<String> {
            self.calls.push("preflight");
            if self.blockers.is_empty() {
                None
            } else {
                self.blockers.remove(0)
            }
        }
        fn claim(&mut self) -> bool {
            self.calls.push("claim");
            !self.busy
        }
        fn download(&mut self) -> Result<u8, StepError> {
            self.calls.push("download");
            if self.download_fails {
                Err(step_error("net"))
            } else {
                Ok(7)
            }
        }
        fn stop_engine(&mut self) {
            self.calls.push("stop");
        }
        fn install(&mut self, bytes: &u8) -> Result<(), StepError> {
            assert_eq!(*bytes, 7);
            self.calls.push("install");
            if self.install_fails {
                Err(step_error("disk"))
            } else {
                Ok(())
            }
        }
        fn request_restart(&mut self) {
            self.calls.push("restart");
        }
        fn respawn_engine(&mut self) -> bool {
            self.calls.push("respawn");
            self.respawns
        }
    }

    fn step_error(detail: &str) -> StepError {
        StepError {
            kind: FailureKind::Other,
            detail: detail.to_string(),
        }
    }

    #[test]
    fn install_runs_guard_preflight_download_guard_stop_install_restart_in_order() {
        let mut steps = Mock::default();
        assert_eq!(run_install(&mut steps), InstallOutcome::Restarting);
        assert_eq!(
            steps.calls,
            vec![
                "guard",
                "preflight",
                "claim",
                "download",
                "guard",
                "preflight",
                "stop",
                "install",
                "restart"
            ]
        );
    }

    #[test]
    fn a_recording_at_click_time_stops_before_anything_else() {
        let mut steps = Mock {
            guard: vec![false],
            ..Mock::default()
        };
        assert_eq!(run_install(&mut steps), InstallOutcome::RefusedByGuard);
        assert_eq!(steps.calls, vec!["guard"]);
    }

    #[test]
    fn a_blocked_location_never_downloads() {
        let mut steps = Mock {
            blockers: vec![Some("move it".into())],
            ..Mock::default()
        };
        assert_eq!(
            run_install(&mut steps),
            InstallOutcome::Blocked("move it".into())
        );
        assert_eq!(steps.calls, vec!["guard", "preflight"]);
    }

    #[test]
    fn a_recording_that_starts_during_the_download_skips_stop_and_install() {
        let mut steps = Mock {
            guard: vec![true, false],
            ..Mock::default()
        };
        assert_eq!(run_install(&mut steps), InstallOutcome::Skipped);
        assert_eq!(
            steps.calls,
            vec!["guard", "preflight", "claim", "download", "guard"]
        );
    }

    #[test]
    fn a_location_that_changes_only_after_the_download_skips_stop_and_install() {
        let mut steps = Mock {
            blockers: vec![None, Some("moved".into())],
            ..Mock::default()
        };
        assert_eq!(run_install(&mut steps), InstallOutcome::Skipped);
        assert_eq!(
            steps.calls,
            vec![
                "guard",
                "preflight",
                "claim",
                "download",
                "guard",
                "preflight"
            ]
        );
    }

    #[test]
    fn a_second_install_that_cannot_claim_the_slot_does_nothing() {
        let mut steps = Mock {
            busy: true,
            ..Mock::default()
        };
        assert_eq!(run_install(&mut steps), InstallOutcome::Busy);
        assert_eq!(steps.calls, vec!["guard", "preflight", "claim"]);
    }

    #[test]
    fn each_outcome_leaves_the_menu_state_the_glue_expects() {
        let offered = available("1.2.0");
        let downloading = offered.begin_download().unwrap();
        let installing = downloading.begin_install().unwrap();
        assert_eq!(
            installing.finish_install().unwrap(),
            UpdateState::Restartable {
                version: "1.2.0".into()
            }
        );
        assert_eq!(downloading.back_to_available(), offered);
        assert_eq!(installing.back_to_available(), offered);
        assert_eq!(
            installing.fail_install(),
            UpdateState::InstallFailed {
                version: "1.2.0".into()
            }
        );
        assert_eq!(downloading.begin_download(), None);
        assert_eq!(installing.begin_download(), None);
        assert!(installing.is_installing());
        assert!(!downloading.is_installing());
    }

    #[test]
    fn engine_port_is_cleared_and_respawn_is_refused_once_exiting() {
        let slot = Mutex::new(Some(8765u16));
        clear_engine_port(&slot);
        assert_eq!(*slot.lock().unwrap(), None);
        let exiting = AtomicBool::new(false);
        assert!(spawn_allowed(&exiting));
        mark_exiting(&exiting);
        assert!(!spawn_allowed(&exiting));
    }

    #[test]
    fn a_download_error_never_stops_the_engine() {
        let mut steps = Mock {
            download_fails: true,
            ..Mock::default()
        };
        assert_eq!(
            run_install(&mut steps),
            InstallOutcome::DownloadFailed(step_error("net"))
        );
        assert_eq!(steps.calls, vec!["guard", "preflight", "claim", "download"]);
    }

    #[test]
    fn an_install_error_after_stopping_respawns_the_engine() {
        let mut steps = Mock {
            install_fails: true,
            respawns: true,
            ..Mock::default()
        };
        assert_eq!(
            run_install(&mut steps),
            InstallOutcome::InstallFailed {
                error: step_error("disk"),
                respawned: true
            }
        );
        assert_eq!(
            steps.calls,
            vec![
                "guard",
                "preflight",
                "claim",
                "download",
                "guard",
                "preflight",
                "stop",
                "install",
                "respawn"
            ]
        );
        let mut down = Mock {
            install_fails: true,
            ..Mock::default()
        };
        assert_eq!(
            run_install(&mut down),
            InstallOutcome::InstallFailed {
                error: step_error("disk"),
                respawned: false
            }
        );
    }

    #[test]
    fn exit_gate_reads_the_guard_only_when_pending_and_disarms_a_refusal() {
        let pending = AtomicBool::new(false);
        let host = CloseDecision::Confirm(CloseRisk::Host);
        assert_eq!(
            exit_gate(&pending, false, || panic!("guard read while not pending")),
            RestartGate::NotPending
        );
        arm_restart(&pending);
        assert_eq!(exit_gate(&pending, false, || host), RestartGate::Refuse);
        assert!(!take_restart(&pending));
        arm_restart(&pending);
        assert_eq!(
            exit_gate(&pending, false, || CloseDecision::Allow),
            RestartGate::Proceed
        );
        assert!(take_restart(&pending));
        assert!(!take_restart(&pending));
    }

    #[test]
    fn an_exit_during_the_bundle_swap_waits_without_reading_the_guard() {
        let pending = AtomicBool::new(false);
        assert_eq!(
            exit_gate(&pending, true, || panic!("guard read during install")),
            RestartGate::Installing
        );
        arm_restart(&pending);
        assert_eq!(
            exit_gate(&pending, true, || CloseDecision::Allow),
            RestartGate::Proceed
        );
    }

    #[test]
    fn bundle_ownership_allows_owner_of_bundle_or_folder_or_root() {
        assert!(may_replace_bundle(501, 501, 0));
        assert!(may_replace_bundle(501, 0, 501));
        assert!(may_replace_bundle(0, 502, 0));
        assert!(!may_replace_bundle(501, 502, 0));
    }

    #[test]
    fn a_failed_install_keeps_the_retry_visible_and_recovers_after_a_panic() {
        let installing = available("1.2.0")
            .begin_download()
            .unwrap()
            .begin_install()
            .unwrap();
        let failed = installing.fail_install();
        assert_eq!(failed.menu_label(), "Update failed — retry…");
        assert!(failed.menu_enabled());
        assert_eq!(failed.retry_version(), Some("1.2.0"));
        assert_eq!(failed.available_version(), None);
        assert!(failed.begin_download().is_some());
        assert_eq!(installing.recover(), available("1.2.0"));
        assert_eq!(
            available("1.2.0").begin_check().unwrap().recover(),
            available("1.2.0")
        );
        assert_eq!(
            UpdateState::Idle.begin_check().unwrap().recover(),
            UpdateState::Idle
        );
        assert_eq!(failed.recover(), failed);
    }

    #[test]
    fn restart_gate_decides_from_pending_and_guard() {
        let host = CloseDecision::Confirm(CloseRisk::Host);
        let unknown = CloseDecision::Confirm(CloseRisk::Unknown);
        assert_eq!(
            restart_gate(false, CloseDecision::Allow),
            RestartGate::NotPending
        );
        assert_eq!(restart_gate(false, host), RestartGate::NotPending);
        assert_eq!(
            restart_gate(true, CloseDecision::Allow),
            RestartGate::Proceed
        );
        assert_eq!(restart_gate(true, host), RestartGate::Refuse);
        assert_eq!(restart_gate(true, unknown), RestartGate::Refuse);
    }

    #[test]
    fn launch_prompt_waits_for_the_guard_and_skips_when_moot() {
        let allow = CloseDecision::Allow;
        let host = CloseDecision::Confirm(CloseRisk::Host);
        assert_eq!(
            launch_prompt(InstallMode::SelfInstall, allow, true),
            LaunchPrompt::Show
        );
        assert_eq!(
            launch_prompt(InstallMode::SelfInstall, host, true),
            LaunchPrompt::Wait
        );
        assert_eq!(
            launch_prompt(
                InstallMode::SelfInstall,
                CloseDecision::Confirm(CloseRisk::Unknown),
                true
            ),
            LaunchPrompt::Wait
        );
        assert_eq!(
            launch_prompt(InstallMode::SelfInstall, allow, false),
            LaunchPrompt::Skip
        );
        assert_eq!(
            launch_prompt(InstallMode::ManualDownload, allow, true),
            LaunchPrompt::Skip
        );
    }

    #[test]
    fn progress_percent_is_whole_and_clamped() {
        assert_eq!(progress_percent(0, Some(200)), Some(0));
        assert_eq!(progress_percent(50, Some(200)), Some(25));
        assert_eq!(progress_percent(999, Some(200)), Some(100));
        assert_eq!(progress_percent(50, None), None);
        assert_eq!(progress_percent(50, Some(0)), None);
    }

    #[test]
    fn messages_use_the_agreed_wording() {
        assert_eq!(
            up_to_date_message("1.0.0"),
            "You're on the latest version (1.0.0)."
        );
        assert_eq!(
            offer_message("Sharecut Studio", "1.2.0"),
            "Sharecut Studio 1.2.0 is available."
        );
        assert_eq!(
            manual_download_message("1.2.0"),
            "Version 1.2.0 is available. Download the new package from the Sharecut Studio site."
        );
        assert_eq!(
            check_failure_message(FailureKind::Offline, "dns"),
            "Couldn't reach the update server. Check your internet connection and try again."
        );
        assert_eq!(
            check_failure_message(FailureKind::Other, "bad signature"),
            "Couldn't check for updates: bad signature"
        );
        assert_eq!(
            install_failure_message(FailureKind::Other, "disk full"),
            "Couldn't install the update: disk full"
        );
        assert_eq!(
            RECORDING_REFUSAL_MESSAGE,
            "Finish or stop recording first, then check for updates again."
        );
    }
}
