//! Pure helpers for the Sharecut Studio Tauri host (no WebView / sidecar IO).

mod close_guard;
mod share_url;
mod sidecar;

use std::process::Command;

pub mod distribution {
    include!(concat!(env!("OUT_DIR"), "/distribution.rs"));
}

/// Public links generated from the selected distribution profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DistributionMetadata {
    pub support_url: &'static str,
    pub privacy_url: &'static str,
    pub repository_url: &'static str,
    pub release_manifest_url: Option<&'static str>,
}

/// Return the public distribution metadata embedded by the build script.
pub const fn distribution_metadata() -> DistributionMetadata {
    DistributionMetadata {
        support_url: distribution::SUPPORT_URL,
        privacy_url: distribution::PRIVACY_URL,
        repository_url: distribution::REPOSITORY_URL,
        release_manifest_url: distribution::RELEASE_MANIFEST_URL,
    }
}

/// Apply public build-time distribution links to a Python sidecar command.
///
/// Optional release metadata is removed when the selected distribution profile
/// does not provide it so an inherited parent environment cannot leak it.
pub fn apply_distribution_metadata(cmd: &mut Command) {
    apply_distribution_metadata_values(cmd, distribution_metadata());
}

/// Apply one metadata value without reading process state or spawning a child.
pub fn apply_distribution_metadata_values(cmd: &mut Command, metadata: DistributionMetadata) {
    cmd.env("PODCAST_DISTRIBUTION_SUPPORT_URL", metadata.support_url);
    cmd.env("PODCAST_DISTRIBUTION_PRIVACY_URL", metadata.privacy_url);
    cmd.env(
        "PODCAST_DISTRIBUTION_REPOSITORY_URL",
        metadata.repository_url,
    );
    match metadata.release_manifest_url {
        Some(url) => {
            cmd.env("PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL", url);
        }
        None => {
            cmd.env_remove("PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL");
        }
    }
}

pub use close_guard::{
    close_decision, close_decision_from_url, is_guarded_quit_menu_item, CloseDecision, CloseRisk,
    GUARDED_QUIT_MENU_ID,
};
pub use share_url::{
    allow_engine_microphone, decide_webview_media, is_allowed_share_url,
    is_allowed_webview_navigation, parse_share_deep_link, ShareDeepLink, ShareDeepLinkError,
    WebviewMediaDecision, WebviewMediaKind,
};
pub use sidecar::{
    apply_create_no_window, bundled_sidecar_path, open_sidecar_log, parse_listen_json,
    random_boot_token, read_health_response, sidecar_listen_path, sidecar_log_path,
    sidecar_owns_listen,
};

#[cfg(test)]
mod distribution_tests {
    use super::*;
    use std::ffi::OsStr;

    fn command_env(command: &Command, name: &str) -> Option<Option<std::ffi::OsString>> {
        command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(name))
            .map(|(_, value)| value.map(OsStr::to_os_string))
    }

    #[test]
    fn applies_required_distribution_metadata_to_sidecar_command() {
        let mut command = Command::new("sidecar");
        apply_distribution_metadata(&mut command);

        assert_eq!(
            command_env(&command, "PODCAST_DISTRIBUTION_SUPPORT_URL"),
            Some(Some(OsStr::new(distribution::SUPPORT_URL).to_os_string()))
        );
        assert_eq!(
            command_env(&command, "PODCAST_DISTRIBUTION_PRIVACY_URL"),
            Some(Some(OsStr::new(distribution::PRIVACY_URL).to_os_string()))
        );
        assert_eq!(
            command_env(&command, "PODCAST_DISTRIBUTION_REPOSITORY_URL"),
            Some(Some(
                OsStr::new(distribution::REPOSITORY_URL).to_os_string()
            ))
        );
    }

    #[test]
    fn applies_or_removes_optional_release_manifest() {
        let mut command = Command::new("sidecar");
        command.env("PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL", "stale");
        apply_distribution_metadata_values(
            &mut command,
            DistributionMetadata {
                support_url: "https://support.example.test",
                privacy_url: "https://privacy.example.test",
                repository_url: "https://code.example.test/repository",
                release_manifest_url: Some("https://downloads.example.test/latest.json"),
            },
        );

        assert_eq!(
            command_env(&command, "PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL"),
            Some(Some(
                OsStr::new("https://downloads.example.test/latest.json").to_os_string()
            ))
        );

        apply_distribution_metadata_values(
            &mut command,
            DistributionMetadata {
                release_manifest_url: None,
                ..distribution_metadata()
            },
        );
        assert_eq!(
            command_env(&command, "PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL"),
            Some(None)
        );
    }
}
