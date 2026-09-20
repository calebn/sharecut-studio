//! Shared by `sidecar_launcher.rs` (rustc) and the Tauri `sharecut` lib (`include!`).

use std::env;
use std::fs::{create_dir_all, File, OpenOptions};
use std::path::PathBuf;
use std::process::Command;

/// Sidecar stdout/stderr log (GUI-subsystem Windows has no console).
pub fn sidecar_log_path() -> PathBuf {
    if let Ok(dir) = env::var("LOCALAPPDATA") {
        if !dir.is_empty() {
            return PathBuf::from(dir)
                .join("SharecutStudio")
                .join("sidecar.log");
        }
    }
    if let Ok(dir) = env::var("XDG_STATE_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir)
                .join("SharecutStudio")
                .join("sidecar.log");
        }
    }
    if let Ok(home) = env::var("HOME") {
        if cfg!(target_os = "macos") {
            return PathBuf::from(home)
                .join("Library")
                .join("Logs")
                .join("Sharecut Studio")
                .join("sidecar.log");
        }
        return PathBuf::from(home)
            .join(".local")
            .join("state")
            .join("SharecutStudio")
            .join("sidecar.log");
    }
    env::temp_dir().join("sharecut-sidecar.log")
}

pub fn sidecar_listen_path() -> PathBuf {
    sidecar_log_path().with_file_name(format!("sidecar.listen.{}.json", std::process::id()))
}

pub fn open_sidecar_log() -> Option<File> {
    let path = sidecar_log_path();
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

/// Windows `CREATE_NO_WINDOW` — hide the console for GUI-subsystem hosts.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub fn apply_create_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn apply_create_no_window(_cmd: &mut Command) {}
