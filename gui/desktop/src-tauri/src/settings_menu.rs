//! The native **Settings…** menu item. It opens the web app's own Settings sheet.
//!
//! The loopback page gets no Tauri IPC, so the host reaches it the way it already
//! reaches the page for the engine URL: it evaluates a script that dispatches a
//! DOM event on `window`. The web app listens for the same name
//! (`gui/web/src/desktop/useNativeSettings.ts`).

pub const SETTINGS_MENU_ID: &str = "sharecut-open-settings";

/// Cmd+, on macOS, Ctrl+, on Linux and Windows.
pub const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// Must match `NATIVE_SETTINGS_EVENT` in the web app.
pub const SETTINGS_EVENT: &str = "sharecut:open-settings";

pub fn is_settings_menu_item(id: &str) -> bool {
    id == SETTINGS_MENU_ID
}

/// The script that tells the page to open its Settings sheet.
pub fn open_settings_script() -> String {
    format!("window.dispatchEvent(new CustomEvent('{SETTINGS_EVENT}'));")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_settings_menu_item() {
        assert!(is_settings_menu_item(SETTINGS_MENU_ID));
        assert!(!is_settings_menu_item("sharecut-guarded-quit"));
    }

    #[test]
    fn the_script_dispatches_the_event_the_web_app_listens_for() {
        assert_eq!(
            open_settings_script(),
            "window.dispatchEvent(new CustomEvent('sharecut:open-settings'));"
        );
    }
}
