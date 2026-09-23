//! Pure close-risk decisions for the native desktop host.
//!
//! The web client writes `sc_close_guard` into its own loopback URL while a
//! recording could still need finalization. Native code reads that marker; the
//! loopback page never receives a Tauri IPC capability.

use url::Url;

const CLOSE_GUARD_PARAM: &str = "sc_close_guard";
pub const GUARDED_QUIT_MENU_ID: &str = "sharecut-guarded-quit";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseRisk {
    Host,
    Guest,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseDecision {
    Allow,
    Confirm(CloseRisk),
}

/// Decide conservatively when the host cannot read the current WebView URL.
pub fn close_decision_from_url(url: Option<&Url>) -> CloseDecision {
    url.map_or(CloseDecision::Confirm(CloseRisk::Unknown), close_decision)
}

/// True only for the macOS menu item that routes Quit through `AppHandle::exit`.
pub fn is_guarded_quit_menu_item(id: &str) -> bool {
    id == GUARDED_QUIT_MENU_ID
}

/// Decide whether a native close must ask the user for confirmation.
///
/// A missing marker is safe. Any malformed or repeated marker is conservative:
/// confirmation prevents a malformed renderer value from bypassing the guard.
pub fn close_decision(url: &Url) -> CloseDecision {
    let values = url
        .query_pairs()
        .filter_map(|(key, value)| (key == CLOSE_GUARD_PARAM).then_some(value));
    let mut values = values.peekable();
    let Some(value) = values.next() else {
        return CloseDecision::Allow;
    };
    if values.next().is_some() {
        return CloseDecision::Confirm(CloseRisk::Unknown);
    }
    match value.as_ref() {
        "host" => CloseDecision::Confirm(CloseRisk::Host),
        "guest" => CloseDecision::Confirm(CloseRisk::Guest),
        _ => CloseDecision::Confirm(CloseRisk::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_urls_without_a_close_marker() {
        let url = Url::parse("http://127.0.0.1:8765/record?session=one").unwrap();
        assert_eq!(close_decision(&url), CloseDecision::Allow);
    }

    #[test]
    fn confirms_for_each_known_recording_role() {
        let host = Url::parse("http://127.0.0.1:8765/?sc_close_guard=host").unwrap();
        let guest = Url::parse("http://127.0.0.1:8765/?sc_close_guard=guest").unwrap();
        assert_eq!(
            close_decision(&host),
            CloseDecision::Confirm(CloseRisk::Host)
        );
        assert_eq!(
            close_decision(&guest),
            CloseDecision::Confirm(CloseRisk::Guest)
        );
    }

    #[test]
    fn confirms_when_the_renderer_marker_is_malformed_or_ambiguous() {
        let malformed = Url::parse("http://127.0.0.1:8765/?sc_close_guard=nope").unwrap();
        let repeated =
            Url::parse("http://127.0.0.1:8765/?sc_close_guard=host&sc_close_guard=guest").unwrap();
        assert_eq!(
            close_decision(&malformed),
            CloseDecision::Confirm(CloseRisk::Unknown)
        );
        assert_eq!(
            close_decision(&repeated),
            CloseDecision::Confirm(CloseRisk::Unknown)
        );
    }

    #[test]
    fn confirms_when_the_webview_url_cannot_be_read() {
        assert_eq!(
            close_decision_from_url(None),
            CloseDecision::Confirm(CloseRisk::Unknown)
        );
    }

    #[test]
    fn recognizes_only_the_guarded_quit_menu_item() {
        assert!(is_guarded_quit_menu_item(GUARDED_QUIT_MENU_ID));
        assert!(!is_guarded_quit_menu_item("quit"));
    }
}
