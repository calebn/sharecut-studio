//! Pure in-app update decisions for the native desktop host (no Tauri types).
//!
//! `updater.rs` in the binary drives the Tauri updater plugin; every branch it
//! takes is decided here so it can be tested without a WebView.

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

/// `os` is `std::env::consts::OS`; `appimage` is whether `APPIMAGE` is set.
pub fn install_mode(os: &str, appimage: bool) -> InstallMode {
    if os == "linux" && !appimage {
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
}

impl UpdateState {
    /// Start a check, or `None` while one is already running or an install is under way.
    pub fn begin_check(&self) -> Option<UpdateState> {
        match self {
            UpdateState::Idle => Some(UpdateState::Checking { known: None }),
            UpdateState::Available { version } => Some(UpdateState::Checking {
                known: Some(version.clone()),
            }),
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
            UpdateState::Available { version } => Some(UpdateState::Downloading {
                version: version.clone(),
            }),
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
        }
    }

    pub fn menu_enabled(&self) -> bool {
        matches!(self, UpdateState::Idle | UpdateState::Available { .. })
    }
}

/// Updating restarts the app, so only a clear recording guard permits it.
/// There is deliberately no "update anyway" path, unlike quitting.
pub fn may_update(decision: CloseDecision) -> bool {
    decision == CloseDecision::Allow
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
        assert_eq!(install_mode("linux", false), InstallMode::ManualDownload);
        assert_eq!(install_mode("linux", true), InstallMode::SelfInstall);
        assert_eq!(install_mode("macos", false), InstallMode::SelfInstall);
        assert_eq!(install_mode("windows", false), InstallMode::SelfInstall);
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
