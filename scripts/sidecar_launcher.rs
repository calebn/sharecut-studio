//! Tiny frozen sidecar: set PODCAST_GUI_DIST + PYTHONHOME, rewrite pyvenv.cfg, exec Python.
//! Compiled by scripts/build_sidecar.py (no crates).
//!
//! `sharecut-sidecar --cli <podcast args>` forwards to the bundled CLI. Which
//! subcommands are allowed is Python's call (`PODCAST_PACKAGED_CLI`, see
//! `services/gui_launch.py`); this launcher never parses the CLI grammar.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[path = "sidecar_shared.rs"]
mod sidecar_shared;

use sidecar_shared::detach_to_sidecar_log;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

const PYTHON_HOME_MARKER: &str = ".python-home";
const CLI_FLAG: &str = "--cli";
/// Python-side marker: the packaged CLI must not start a second GUI host.
const PACKAGED_CLI_ENV: &str = "PODCAST_PACKAGED_CLI";
/// `-P`: never put the (untrusted) caller cwd on `sys.path`. Not `-I`/`-E`,
/// which would ignore the `PYTHONHOME` relocation below.
const PYTHON_MODULE_ARGS: [&str; 3] = ["-P", "-m", "podcast_mcp.cli.main"];
/// Dummy CLI port; Python resolved_bind_port honors PODCAST_SIDECAR_EPHEMERAL.
const GUI_ARGS: [&str; 6] = ["gui", "--host", "127.0.0.1", "--port", "8765", "--no-open"];
/// Shell env (pyenv / conda / venv) that would point the frozen runtime at a
/// foreign stdlib or site-packages.
const FOREIGN_PYTHON_ENV: [&str; 5] = [
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONUSERBASE",
    "VIRTUAL_ENV",
];

#[derive(Debug, PartialEq, Eq)]
enum LauncherMode {
    Gui,
    Cli(Vec<OsString>),
}

fn parse_mode(args: impl IntoIterator<Item = OsString>) -> LauncherMode {
    let mut args = args.into_iter();
    match args.next() {
        Some(first) if first == CLI_FLAG => LauncherMode::Cli(args.collect()),
        _ => LauncherMode::Gui,
    }
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
fn rewritten_pyvenv_cfg(text: &str, home: &Path, exe: &Path) -> String {
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
    out.join("\n") + "\n"
}

/// Point `pyvenv.cfg` at `home`. Returns whether the file was rewritten.
///
/// Concurrent `--cli` calls and the app's own sidecar may all run this, and
/// another interpreter may be reading the file: skip the write when nothing
/// changed (the normal case after first launch) and otherwise replace it
/// atomically via a sibling temp file + rename, never truncate in place.
fn sync_pyvenv_cfg(runtime: &Path, home: &Path) -> io::Result<bool> {
    let cfg_path = runtime.join("venv").join("pyvenv.cfg");
    let text = match fs::read_to_string(&cfg_path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    let updated = rewritten_pyvenv_cfg(&text, home, &base_python_exe(home));
    if updated == text {
        return Ok(false);
    }
    let tmp = cfg_path.with_file_name(format!("pyvenv.cfg.{}.tmp", std::process::id()));
    fs::write(&tmp, updated)?;
    if let Err(err) = fs::rename(&tmp, &cfg_path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(true)
}

/// Set `PYTHONHOME` to the bundled prefix. GUI mode keeps an inherited
/// `PYTHONHOME` (contributor override); CLI mode always uses the bundle.
fn apply_python_home(cmd: &mut Command, runtime: &Path, keep_inherited: bool) {
    if keep_inherited && env::var_os("PYTHONHOME").is_some() {
        return;
    }
    if let Some(home) = bundled_cpython_prefix(runtime) {
        if let Err(err) = sync_pyvenv_cfg(runtime, &home) {
            eprintln!(
                "Sharecut Studio sidecar: could not update {}: {err}",
                runtime.join("venv").join("pyvenv.cfg").display()
            );
        }
        cmd.env("PYTHONHOME", home);
    }
}

/// Build the Python child. `detach` wires GUI-mode stdio (the sidecar log in
/// production); CLI mode never calls it, so it inherits the terminal's stdio.
fn python_command(
    py: &Path,
    dist: &Path,
    runtime: &Path,
    mode: &LauncherMode,
    detach: impl FnOnce(&mut Command),
) -> Command {
    let mut cmd = Command::new(py);
    cmd.env("PODCAST_GUI_DIST", dist).args(PYTHON_MODULE_ARGS);
    match mode {
        LauncherMode::Gui => {
            cmd.current_dir(runtime)
                .env_remove(PACKAGED_CLI_ENV)
                .env("PODCAST_MAGIC_LINK_PRINT", "0")
                .env("PODCAST_GUI_OPENAPI", "0")
                .args(GUI_ARGS);
            apply_python_home(&mut cmd, runtime, true);
            detach(&mut cmd);
        }
        LauncherMode::Cli(args) => {
            for key in FOREIGN_PYTHON_ENV {
                cmd.env_remove(key);
            }
            cmd.env(PACKAGED_CLI_ENV, "1")
                .env("PYTHONNOUSERSITE", "1")
                .args(args);
            apply_python_home(&mut cmd, runtime, false);
        }
    }
    cmd
}

/// The launcher is a GUI-subsystem exe: cmd/PowerShell do not wait for it and
/// a console child would flash in its own window, losing output and exit code.
/// Fail clearly until a console shim ships (#97).
#[cfg(windows)]
fn report_windows_cli_unsupported() {
    use std::io::Write;

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    let msg = "Sharecut Studio sidecar: --cli is not supported on Windows yet; \
               use the installed Sharecut Studio app or the pip `podcast` CLI.";
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    let _ = writeln!(io::stderr(), "{msg}");
    if let Some(mut log) = sidecar_shared::open_sidecar_log() {
        let _ = writeln!(log, "{msg}");
    }
}

fn main() {
    let mode = parse_mode(env::args_os().skip(1));
    #[cfg(windows)]
    {
        if matches!(mode, LauncherMode::Cli(_)) {
            report_windows_cli_unsupported();
            exit(2);
        }
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
    let mut cmd = python_command(&py, &dist, &runtime, &mode, detach_to_sidecar_log);
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
    use std::cell::Cell;
    use std::ffi::OsStr;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn os_args(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    fn build(mode: &LauncherMode, detached: &Cell<bool>) -> Command {
        python_command(
            Path::new("python"),
            Path::new("dist"),
            Path::new("runtime"),
            mode,
            |_| detached.set(true),
        )
    }

    fn env_value(cmd: &Command, key: &str) -> Option<Option<OsString>> {
        cmd.get_envs()
            .find(|(k, _)| *k == OsStr::new(key))
            .map(|(_, v)| v.map(OsStr::to_os_string))
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = env::temp_dir().join(format!(
            "sharecut-launcher-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn missing_cli_flag_preserves_gui_mode() {
        assert_eq!(parse_mode(Vec::<OsString>::new()), LauncherMode::Gui);
        assert_eq!(parse_mode(os_args(&["--other"])), LauncherMode::Gui);
    }

    #[test]
    fn cli_mode_forwards_every_argument_after_flag() {
        assert_eq!(
            parse_mode(os_args(&["--cli", "doctor", "--json"])),
            LauncherMode::Cli(os_args(&["doctor", "--json"]))
        );
    }

    #[test]
    fn cli_flag_alone_forwards_no_arguments() {
        assert_eq!(parse_mode(os_args(&["--cli"])), LauncherMode::Cli(vec![]));
        let detached = Cell::new(false);
        let cmd = build(&LauncherMode::Cli(vec![]), &detached);
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec!["-P", "-m", "podcast_mcp.cli.main"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn cli_mode_forwards_non_utf8_arguments() {
        use std::os::unix::ffi::OsStringExt;
        let latin1 = OsString::from_vec(b"epis\xf3dio.json".to_vec());
        let mode = parse_mode(vec![OsString::from("--cli"), latin1.clone()]);
        assert_eq!(mode, LauncherMode::Cli(vec![latin1.clone()]));
        let cmd = build(&mode, &Cell::new(false));
        assert_eq!(cmd.get_args().last(), Some(latin1.as_os_str()));
    }

    #[test]
    fn cli_command_isolates_cwd_and_forwards_args() {
        let detached = Cell::new(false);
        let cmd = build(
            &LauncherMode::Cli(os_args(&["doctor", "--json"])),
            &detached,
        );
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec!["-P", "-m", "podcast_mcp.cli.main", "doctor", "--json"]
        );
        assert_eq!(cmd.get_current_dir(), None);
    }

    #[test]
    fn cli_command_keeps_inherited_stdio_and_marks_packaged_cli() {
        let detached = Cell::new(false);
        let cmd = build(&LauncherMode::Cli(os_args(&["gui"])), &detached);
        assert!(
            !detached.get(),
            "CLI mode must not redirect to the sidecar log"
        );
        assert_eq!(env_value(&cmd, PACKAGED_CLI_ENV), Some(Some("1".into())));
        assert_eq!(env_value(&cmd, "PODCAST_GUI_OPENAPI"), None);
        assert_eq!(env_value(&cmd, "PODCAST_MAGIC_LINK_PRINT"), None);
    }

    #[test]
    fn cli_command_scrubs_foreign_python_env() {
        let cmd = build(&LauncherMode::Cli(vec![]), &Cell::new(false));
        for key in [
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "VIRTUAL_ENV",
        ] {
            assert_eq!(env_value(&cmd, key), Some(None), "{key} not removed");
        }
        assert_eq!(env_value(&cmd, "PYTHONNOUSERSITE"), Some(Some("1".into())));
    }

    #[test]
    fn gui_command_runs_from_runtime_detached_with_gui_env() {
        let detached = Cell::new(false);
        let cmd = build(&LauncherMode::Gui, &detached);
        assert!(detached.get(), "GUI mode must detach stdio");
        assert_eq!(cmd.get_current_dir(), Some(Path::new("runtime")));
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec![
                "-P",
                "-m",
                "podcast_mcp.cli.main",
                "gui",
                "--host",
                "127.0.0.1",
                "--port",
                "8765",
                "--no-open"
            ]
        );
        assert_eq!(
            env_value(&cmd, "PODCAST_GUI_OPENAPI"),
            Some(Some("0".into()))
        );
        assert_eq!(
            env_value(&cmd, "PODCAST_MAGIC_LINK_PRINT"),
            Some(Some("0".into()))
        );
        assert_eq!(env_value(&cmd, PACKAGED_CLI_ENV), Some(None));
    }

    #[test]
    fn sync_pyvenv_cfg_writes_once_then_skips_unchanged() {
        let runtime = scratch_dir("pyvenv");
        let home = runtime.join("python").join("cpython-3.12");
        fs::create_dir_all(runtime.join("venv")).expect("venv dir");
        let cfg = runtime.join("venv").join("pyvenv.cfg");
        fs::write(&cfg, "home = /install\nversion = 3.12.0\n").expect("seed cfg");

        assert!(sync_pyvenv_cfg(&runtime, &home).expect("first sync"));
        let text = fs::read_to_string(&cfg).expect("read cfg");
        assert!(text.contains(&format!("home = {}", home.display())));
        assert!(text.contains("version = 3.12.0"));
        assert!(text.contains("base-executable = "));

        assert!(!sync_pyvenv_cfg(&runtime, &home).expect("second sync"));
        let leftovers: Vec<_> = fs::read_dir(runtime.join("venv"))
            .expect("list venv")
            .flatten()
            .filter(|e| e.file_name() != "pyvenv.cfg")
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind");
        let _ = fs::remove_dir_all(&runtime);
    }

    #[test]
    fn sync_pyvenv_cfg_missing_file_is_noop() {
        let runtime = scratch_dir("nocfg");
        assert!(!sync_pyvenv_cfg(&runtime, Path::new("/nowhere")).expect("noop"));
        let _ = fs::remove_dir_all(&runtime);
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
