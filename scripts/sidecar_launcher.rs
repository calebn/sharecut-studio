//! Tiny frozen sidecar: set PODCAST_GUI_DIST + PYTHONHOME, rewrite pyvenv.cfg, exec Python.
//! Compiled by scripts/build_sidecar.py (no crates).

#![cfg_attr(windows, windows_subsystem = "windows")]

#[path = "sidecar_shared.rs"]
mod sidecar_shared;

use sidecar_shared::{apply_create_no_window, open_sidecar_log};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};

const PYTHON_HOME_MARKER: &str = ".python-home";

#[derive(Debug, PartialEq, Eq)]
enum LauncherMode {
    Gui,
    Cli(Vec<String>),
}

fn parse_mode(args: impl IntoIterator<Item = String>) -> LauncherMode {
    let mut args = args.into_iter();
    match args.next().as_deref() {
        Some("--cli") => LauncherMode::Cli(args.collect()),
        _ => LauncherMode::Gui,
    }
}

fn is_gui_cli_request(mode: &LauncherMode) -> bool {
    matches!(mode, LauncherMode::Cli(args) if args.first().is_some_and(|arg| arg == "gui"))
}

fn runtime_dir(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    let mut candidates = vec![
        dir.join("sharecut-runtime"),
        dir.join("resources").join("sharecut-runtime"),
    ];
    if let Some(parent) = dir.parent() {
        candidates.push(parent.join("Resources").join("sharecut-runtime"));
        candidates.push(
            parent
                .join("lib")
                .join("SharecutStudio")
                .join("sharecut-runtime"),
        );
        if let Ok(entries) = parent.join("lib").read_dir() {
            for entry in entries.flatten() {
                let nested = entry.path().join("sharecut-runtime");
                if nested.is_dir() {
                    candidates.push(nested);
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.is_dir())
}

fn python_bin(runtime: &Path) -> PathBuf {
    if cfg!(windows) {
        runtime.join("venv").join("Scripts").join("python.exe")
    } else {
        runtime.join("venv").join("bin").join("python")
    }
}

fn encodings_dir(lib_or_py: &Path) -> bool {
    lib_or_py.join("encodings").is_dir()
}

fn is_cpython_prefix(cand: &Path) -> bool {
    if let Ok(entries) = cand.join("lib").read_dir() {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("python"))
                && encodings_dir(&path)
            {
                return true;
            }
        }
    }
    encodings_dir(&cand.join("Lib"))
}

/// Prefer freeze-time `.python-home` marker, then discover `python/cpython-*`.
fn bundled_cpython_prefix(runtime: &Path) -> Option<PathBuf> {
    let marker = runtime.join(PYTHON_HOME_MARKER);
    if let Ok(rel) = fs::read_to_string(&marker) {
        let rel = rel.trim();
        if !rel.is_empty() {
            let cand = runtime.join(rel);
            if is_cpython_prefix(&cand) {
                return Some(cand);
            }
        }
    }
    let root = runtime.join("python");
    let mut dirs: Vec<PathBuf> = match root.read_dir() {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("cpython-"))
            })
            .collect(),
        Err(_) => return None,
    };
    dirs.sort();
    dirs.into_iter().find(|cand| is_cpython_prefix(cand))
}

fn base_python_exe(home: &Path) -> PathBuf {
    let candidates = [
        home.join("python.exe"),
        home.join("Scripts").join("python.exe"),
        home.join("bin").join("python"),
        home.join("python"),
    ];
    for cand in candidates {
        if cand.is_file() {
            return cand;
        }
    }
    if cfg!(windows) {
        home.join("python.exe")
    } else {
        home.join("bin").join("python")
    }
}

/// Windows `venv\Scripts\python.exe` is a stub that reads absolute `home` /
/// `executable` from `pyvenv.cfg`. After NSIS/AppImage relocate those still
/// point at the freeze host (e.g. `D:\a\sharecut-studio\...`).
fn rewrite_pyvenv_cfg(runtime: &Path, home: &Path) {
    let cfg_path = runtime.join("venv").join("pyvenv.cfg");
    let Ok(text) = fs::read_to_string(&cfg_path) else {
        return;
    };
    let exe = base_python_exe(home);
    let home_s = home.display().to_string();
    let exe_s = exe.display().to_string();
    let mut out = Vec::new();
    let mut saw_home = false;
    let mut saw_executable = false;
    let mut saw_base = false;
    for line in text.lines() {
        let key = line.split_once('=').map(|(k, _)| k.trim());
        match key {
            Some("home") => {
                out.push(format!("home = {home_s}"));
                saw_home = true;
            }
            Some("executable") => {
                out.push(format!("executable = {exe_s}"));
                saw_executable = true;
            }
            Some("base-executable") => {
                out.push(format!("base-executable = {exe_s}"));
                saw_base = true;
            }
            _ => out.push(line.to_string()),
        }
    }
    if !saw_home {
        out.push(format!("home = {home_s}"));
    }
    if !saw_executable {
        out.push(format!("executable = {exe_s}"));
    }
    if !saw_base {
        out.push(format!("base-executable = {exe_s}"));
    }
    let _ = fs::write(&cfg_path, out.join("\n") + "\n");
}

fn apply_python_home(cmd: &mut Command, runtime: &Path) {
    if env::var_os("PYTHONHOME").is_some() {
        return;
    }
    if let Some(home) = bundled_cpython_prefix(runtime) {
        rewrite_pyvenv_cfg(runtime, &home);
        cmd.env("PYTHONHOME", home);
    }
}

fn python_command(py: &Path, dist: &Path, runtime: &Path, mode: &LauncherMode) -> Command {
    let mut cmd = Command::new(py);
    cmd.env("PODCAST_GUI_DIST", dist);
    match mode {
        LauncherMode::Gui => {
            cmd.current_dir(runtime)
                .env("PODCAST_MAGIC_LINK_PRINT", "0")
                .env("PODCAST_GUI_OPENAPI", "0")
                // Dummy CLI port; Python resolved_bind_port honors PODCAST_SIDECAR_EPHEMERAL.
                .args([
                    "-m",
                    "podcast_mcp.cli.main",
                    "gui",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "8765",
                    "--no-open",
                ]);
        }
        LauncherMode::Cli(args) => {
            cmd.args(["-m", "podcast_mcp.cli.main"]).args(args);
        }
    }
    apply_python_home(&mut cmd, runtime);
    if matches!(mode, LauncherMode::Gui) {
        apply_create_no_window(&mut cmd);
        if let Some(log) = open_sidecar_log() {
            if let Ok(err_log) = log.try_clone() {
                cmd.stdout(Stdio::from(log)).stderr(Stdio::from(err_log));
            } else {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        } else {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    cmd
}

fn main() {
    let mode = parse_mode(env::args().skip(1));
    if is_gui_cli_request(&mode) {
        eprintln!("Sharecut Studio packaged launcher: '--cli gui' is not supported; launch or focus the installed Sharecut Studio app instead.");
        exit(2);
    }
    let exe = env::current_exe().unwrap_or_else(|err| {
        eprintln!("Sharecut Studio sidecar: current_exe failed: {err}");
        exit(1);
    });
    let Some(runtime) = runtime_dir(&exe) else {
        eprintln!(
            "Sharecut Studio sidecar: sharecut-runtime not found next to {}",
            exe.display()
        );
        exit(1);
    };
    let dist = runtime.join("web-dist");
    let py = python_bin(&runtime);
    if !py.is_file() {
        eprintln!(
            "Sharecut Studio sidecar: python not found at {}",
            py.display()
        );
        exit(1);
    }
    let mut cmd = python_command(&py, &dist, &runtime, &mode);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        eprintln!("Sharecut Studio sidecar: exec failed: {err}");
        exit(1);
    }
    #[cfg(not(unix))]
    {
        match cmd.spawn() {
            Ok(child) => exit(wait_windows_python(child)),
            Err(err) => {
                eprintln!("Sharecut Studio sidecar: spawn failed: {err}");
                exit(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_cli_flag_preserves_gui_mode() {
        assert_eq!(parse_mode(Vec::<String>::new()), LauncherMode::Gui);
        assert_eq!(parse_mode(["--other"].map(String::from)), LauncherMode::Gui);
    }

    #[test]
    fn cli_mode_forwards_every_argument_after_flag() {
        assert_eq!(
            parse_mode(["--cli", "doctor", "--json"].map(String::from)),
            LauncherMode::Cli(vec!["doctor".into(), "--json".into()])
        );
    }

    #[test]
    fn cli_command_uses_python_module_and_forwards_args() {
        let mode = LauncherMode::Cli(vec!["doctor".into(), "--json".into()]);
        let cmd = python_command(
            Path::new("python"),
            Path::new("dist"),
            Path::new("runtime"),
            &mode,
        );
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec!["-m", "podcast_mcp.cli.main", "doctor", "--json"]
        );
        assert_eq!(cmd.get_current_dir(), None);
    }

    #[test]
    fn gui_command_runs_from_runtime_and_rejects_cli_gui() {
        let gui = python_command(
            Path::new("python"),
            Path::new("dist"),
            Path::new("runtime"),
            &LauncherMode::Gui,
        );
        assert_eq!(gui.get_current_dir(), Some(Path::new("runtime")));
        assert!(is_gui_cli_request(&LauncherMode::Cli(vec!["gui".into()])));
        assert!(!is_gui_cli_request(&LauncherMode::Cli(vec![
            "doctor".into()
        ])));
    }
}

#[cfg(windows)]
fn wait_windows_python(mut child: std::process::Child) -> i32 {
    assign_kill_on_job_close(&child);
    match child.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!("Sharecut Studio sidecar: wait failed: {err}");
            1
        }
    }
}

/// When this launcher process dies, close the job and kill nested Python.
#[cfg(windows)]
fn assign_kill_on_job_close(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(
            attrs: *mut core::ffi::c_void,
            name: *const u16,
        ) -> *mut core::ffi::c_void;
        fn SetInformationJobObject(
            job: *mut core::ffi::c_void,
            info_class: i32,
            info: *mut core::ffi::c_void,
            info_len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(
            job: *mut core::ffi::c_void,
            process: *mut core::ffi::c_void,
        ) -> i32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[repr(C)]
    struct JobExtendedLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        _pad_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        _pad_active: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
        io_read_ops: u64,
        io_write_ops: u64,
        io_other_ops: u64,
        io_read_bytes: u64,
        io_write_bytes: u64,
        io_other_bytes: u64,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    unsafe {
        let job = CreateJobObjectW(core::ptr::null_mut(), core::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info = JobExtendedLimit {
            per_process_user_time_limit: 0,
            per_job_user_time_limit: 0,
            limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            _pad_flags: 0,
            minimum_working_set_size: 0,
            maximum_working_set_size: 0,
            active_process_limit: 0,
            _pad_active: 0,
            affinity: 0,
            priority_class: 0,
            scheduling_class: 0,
            io_read_ops: 0,
            io_write_ops: 0,
            io_other_ops: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_other_bytes: 0,
            process_memory_limit: 0,
            job_memory_limit: 0,
            peak_process_memory_used: 0,
            peak_job_memory_used: 0,
        };
        if SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<JobExtendedLimit>() as u32,
        ) == 0
        {
            return;
        }
        let handle = child.as_raw_handle() as *mut core::ffi::c_void;
        let _ = AssignProcessToJobObject(job, handle);
        // Leak `job` so KILL_ON_JOB_CLOSE runs when this process exits.
    }
}
