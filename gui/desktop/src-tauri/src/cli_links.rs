//! Native, opt-in shell links for the packaged console launchers.
//! This module never accepts a path from the WebView.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::Command;

pub const INSTALL_MENU_ID: &str = "native-cli-install";
pub const STATUS_MENU_ID: &str = "native-cli-status";
pub const REMOVE_MENU_ID: &str = "native-cli-remove";
const NAMES: [&str; 2] = ["podcast", "podcast-mcp"];

/// Dispatch before Tauri creates a WebView or starts the GUI sidecar.
/// OsString keeps paths and arguments with non-UTF-8 bytes intact.
pub fn appimage_command(
    args: impl IntoIterator<Item = OsString>,
) -> Option<(&'static str, Vec<OsString>)> {
    let mut args = args.into_iter();
    let launcher = match args.next()?.as_os_str() {
        value if value == OsStr::new("--cli") => "podcast",
        value if value == OsStr::new("--mcp") => "podcast-mcp",
        _ => return None,
    };
    Some((launcher, args.collect()))
}

#[cfg(target_os = "linux")]
pub fn run_appimage_command(exe: &Path, launcher: &str, args: &[OsString]) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::other("app binary has no parent"))?;
    // exec keeps the AppImage PID, terminal streams, cwd, environment, and signals.
    Err(Command::new(dir.join(launcher)).args(args).exec())
}

#[cfg(unix)]
const WRAPPER_MARK: &[u8] = b"#!/bin/sh\n# Sharecut Studio ";

/// A tiny shell script that execs the real launcher. A script, not a symlink,
/// because a launcher started through a symlink can lose track of where its
/// runtime lives (0.1.3 on macOS: "sharecut-runtime not found next to ~/.local/bin/podcast").
#[cfg(unix)]
fn shell_wrapper(target: &Path, flag: Option<&str>) -> io::Result<Vec<u8>> {
    use std::os::unix::ffi::OsStrExt;
    if !target.is_absolute() || !fs::metadata(target)?.is_file() {
        return Err(io::Error::other(format!(
            "{} must be an absolute path to a file",
            target.display()
        )));
    }
    let mut script = b"#!/bin/sh\n# Sharecut Studio CLI wrapper v2\nexec '".to_vec();
    for byte in target.as_os_str().as_bytes() {
        if *byte == b'\'' {
            script.extend_from_slice(b"'\\''");
        } else {
            script.push(*byte);
        }
    }
    script.extend_from_slice(b"' ");
    if let Some(flag) = flag {
        script.extend_from_slice(flag.as_bytes());
        script.push(b' ');
    }
    script.extend_from_slice(b"\"$@\"\n");
    Ok(script)
}

#[cfg(unix)]
pub type Tools = [(String, Vec<u8>); 2];

#[cfg(unix)]
pub fn link_tools(launchers: &[(String, PathBuf); 2]) -> io::Result<Tools> {
    Ok([
        (
            launchers[0].0.clone(),
            shell_wrapper(&launchers[0].1, None)?,
        ),
        (
            launchers[1].0.clone(),
            shell_wrapper(&launchers[1].1, None)?,
        ),
    ])
}

#[cfg(unix)]
pub fn appimage_tools(appimage: &Path) -> io::Result<Tools> {
    Ok([
        ("podcast".into(), shell_wrapper(appimage, Some("--cli"))?),
        (
            "podcast-mcp".into(),
            shell_wrapper(appimage, Some("--mcp"))?,
        ),
    ])
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Missing,
    Current,
    /// Put there by a ShareCut app, but differs (moved app, old wrapper, lost execute bit).
    Stale,
    /// Something else lives there; never touched unless the user agrees.
    Foreign,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Added,
    Updated,
    Replaced { backup: PathBuf },
    Removed,
    Unchanged,
    SkippedForeign,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolReport {
    pub name: String,
    pub before: State,
    pub action: Action,
}

/// A symlink counts as ShareCut's own only when a packaged app could have made
/// it: this command inside a macOS `*sharecut*.app` bundle, or under the
/// `.deb` roots (`/usr/lib`, `/usr/bin`, `/opt`) in a directory named for
/// sharecut. A developer link into a checkout or venv is someone else's.
#[cfg(unix)]
fn owned_link_target(target: &Path, name: &str) -> bool {
    use std::path::Component;
    let lower = |part: &OsStr| part.to_string_lossy().to_lowercase();
    if !target.is_absolute()
        || target.file_name() != Some(OsStr::new(name))
        || target.components().any(|c| c == Component::ParentDir)
    {
        return false;
    }
    let in_bundle = target.components().any(|c| match c {
        Component::Normal(part) => {
            let part = lower(part);
            part.ends_with(".app") && part.contains("sharecut")
        }
        _ => false,
    });
    let in_package_root = ["/usr/lib", "/usr/bin", "/opt"].iter().any(|root| {
        target.strip_prefix(root).is_ok_and(|rest| {
            rest.parent().is_some_and(|dirs| {
                dirs.components().any(
                    |c| matches!(c, Component::Normal(part) if lower(part).contains("sharecut")),
                )
            })
        })
    });
    in_bundle || in_package_root
}

#[cfg(unix)]
fn classify(path: &Path, name: &str, expected: &[u8]) -> io::Result<State> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(State::Missing),
        Err(err) => return Err(err),
    };
    if metadata.file_type().is_symlink() {
        // Earlier versions linked straight to the launcher, which breaks on macOS.
        return Ok(if owned_link_target(&fs::read_link(path)?, name) {
            State::Stale
        } else {
            State::Foreign
        });
    }
    if !metadata.file_type().is_file() {
        return Ok(State::Foreign);
    }
    let content = match fs::read(path) {
        Ok(value) => value,
        // Only a file of the wrapper's exact size can be ours that lost its read
        // bit. Anything else unreadable is someone else's and must not be replaced.
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            return Ok(if metadata.len() == expected.len() as u64 {
                State::Stale
            } else {
                State::Foreign
            });
        }
        Err(err) => return Err(err),
    };
    // The installer creates the wrapper as this user, so its owner bit must
    // permit that user to execute it; group/other bits are insufficient.
    let executable = metadata.permissions().mode() & 0o100 != 0;
    Ok(if content == expected && executable {
        State::Current
    } else if content == expected || content.starts_with(WRAPPER_MARK) {
        State::Stale
    } else {
        State::Foreign
    })
}

#[cfg(unix)]
pub fn status(bin: &Path, tools: &Tools) -> io::Result<Vec<(String, State)>> {
    tools
        .iter()
        .map(|(name, expected)| Ok((name.clone(), classify(&bin.join(name), name, expected)?)))
        .collect()
}

#[cfg(unix)]
fn temp_path(bin: &Path, name: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    bin.join(format!(
        ".{name}.sharecut-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Writes the command next to `path`, then renames it into place so a reader
/// never sees a half-written wrapper or a missing command.
#[cfg(unix)]
fn place(bin: &Path, name: &str, content: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = bin.join(name);
    let temp = temp_path(bin, name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(&temp)?;
    let written = file.write_all(content).and_then(|()| file.sync_all());
    // A wrapper still open for writing makes exec fail with ETXTBSY, so close first.
    drop(file);
    let result = written.and_then(|()| fs::rename(&temp, &path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Renames `from` to `to` without ever replacing something already at `to`.
/// `rename` silently overwrites, so the destination name is claimed first with
/// an operation that fails with AlreadyExists: a hard link for files, a new
/// symlink for links, a new empty directory for directories.
#[cfg(unix)]
fn move_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    let kind = fs::symlink_metadata(from)?.file_type();
    if kind.is_dir() {
        fs::create_dir(to)?;
        if let Err(err) = fs::rename(from, to) {
            let _ = fs::remove_dir(to);
            return Err(err);
        }
        return Ok(());
    }
    if kind.is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
    } else {
        fs::hard_link(from, to)?;
    }
    if let Err(err) = fs::remove_file(from) {
        let _ = fs::remove_file(to);
        return Err(err);
    }
    Ok(())
}

#[cfg(unix)]
fn take_backup(bin: &Path, name: &str) -> io::Result<PathBuf> {
    let from = bin.join(name);
    let mut candidate = bin.join(format!("{name}.sharecut-backup"));
    for n in 2u32.. {
        match move_no_clobber(&from, &candidate) {
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                candidate = bin.join(format!("{name}.sharecut-backup-{n}"));
            }
            other => return other.map(|()| candidate),
        }
    }
    unreachable!("an unused backup name")
}

/// Moves the original aside, then runs `put`. If `put` fails the original is
/// moved back (best effort) and the error names the command and the backup.
#[cfg(unix)]
fn replace_with(
    bin: &Path,
    name: &str,
    put: impl FnOnce() -> io::Result<()>,
) -> io::Result<PathBuf> {
    let backup = take_backup(bin, name)?;
    match put() {
        Ok(()) => Ok(backup),
        Err(err) => {
            let outcome = match move_no_clobber(&backup, &bin.join(name)) {
                Ok(()) => format!("the original {name} was restored from {}", backup.display()),
                Err(restore) => format!(
                    "restoring failed ({restore}); the original {name} is kept at {}",
                    backup.display()
                ),
            };
            Err(io::Error::new(
                err.kind(),
                format!("could not install {name}: {err}; {outcome}"),
            ))
        }
    }
}

/// Adds missing commands and refreshes ones a ShareCut app installed earlier.
/// A command something else owns is skipped, or with `replace_foreign` moved
/// to `<name>.sharecut-backup` first, so it is never lost. Only names listed
/// in `replace` (the ones the user agreed to) are replaced.
#[cfg(unix)]
pub fn install(bin: &Path, tools: &Tools, replace: &[String]) -> io::Result<Vec<ToolReport>> {
    fs::create_dir_all(bin)?;
    let mut reports = Vec::new();
    for (name, expected) in tools {
        let path = bin.join(name);
        let before = classify(&path, name, expected)?;
        let action = match before {
            State::Current => Action::Unchanged,
            State::Missing => {
                place(bin, name, expected)?;
                Action::Added
            }
            State::Stale => {
                place(bin, name, expected)?;
                Action::Updated
            }
            State::Foreign if replace.contains(name) => {
                let backup = replace_with(bin, name, || place(bin, name, expected))?;
                Action::Replaced { backup }
            }
            State::Foreign => Action::SkippedForeign,
        };
        reports.push(ToolReport {
            name: name.clone(),
            before,
            action,
        });
    }
    Ok(reports)
}

#[cfg(unix)]
pub fn remove(bin: &Path, tools: &Tools) -> io::Result<Vec<ToolReport>> {
    let mut reports = Vec::new();
    for (name, expected) in tools {
        let path = bin.join(name);
        let before = classify(&path, name, expected)?;
        let action = match before {
            State::Current | State::Stale => {
                fs::remove_file(&path)?;
                Action::Removed
            }
            State::Missing => Action::Unchanged,
            State::Foreign => Action::SkippedForeign,
        };
        reports.push(ToolReport {
            name: name.clone(),
            before,
            action,
        });
    }
    Ok(reports)
}

#[cfg(unix)]
pub fn describe_status(status: &[(String, State)]) -> String {
    status
        .iter()
        .map(|(name, state)| {
            let text = match state {
                State::Missing => "not installed",
                State::Current => "installed, up to date",
                State::Stale => "installed by ShareCut, needs an update",
                State::Foreign => "present, but not installed by ShareCut",
            };
            format!("{name}: {text}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(unix)]
pub fn describe_reports(reports: &[ToolReport]) -> String {
    reports
        .iter()
        .map(|report| {
            let name = &report.name;
            match &report.action {
                Action::Added => format!("{name}: installed"),
                Action::Updated => format!("{name}: updated"),
                Action::Replaced { backup } => {
                    format!("{name}: replaced (old one kept as {})", backup.display())
                }
                Action::Removed => format!("{name}: removed"),
                Action::Unchanged if report.before == State::Missing => {
                    format!("{name}: not installed")
                }
                Action::Unchanged => format!("{name}: already up to date"),
                Action::SkippedForeign => {
                    format!("{name}: left alone, it was not installed by ShareCut")
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn targets(exe: &Path) -> io::Result<[(String, PathBuf); 2]> {
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::other("app binary has no parent"))?;
    let result = NAMES.map(|name| (name.to_string(), dir.join(name)));
    for (_, target) in &result {
        if !fs::metadata(target)?.is_file() {
            return Err(io::Error::other(format!(
                "missing packaged launcher: {}",
                target.display()
            )));
        }
    }
    Ok(result)
}

pub fn bin_on_path(bin: &Path, path: Option<&std::ffi::OsStr>) -> bool {
    path.map(|value| std::env::split_paths(value).any(|entry| entry == bin))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "clilinks-{label}-{}-{}",
            std::process::id(),
            std::thread::current()
                .name()
                .unwrap_or("test")
                .replace("::", "-")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[cfg(unix)]
    fn app_tools(root: &Path) -> Tools {
        fs::create_dir_all(root.join("ShareCut.app")).unwrap();
        for name in NAMES {
            fs::write(root.join("ShareCut.app").join(name), b"launcher").unwrap();
        }
        link_tools(&targets(&root.join("ShareCut.app/sharecut")).unwrap()).unwrap()
    }

    #[cfg(unix)]
    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| n.to_string()).collect()
    }

    #[cfg(unix)]
    fn states(bin: &Path, tools: &Tools) -> Vec<State> {
        status(bin, tools)
            .unwrap()
            .into_iter()
            .map(|(_, s)| s)
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn install_adds_missing_and_is_idempotent() {
        let root = scratch("add");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        assert_eq!(states(&bin, &tools), [State::Missing, State::Missing]);
        let reports = install(&bin, &tools, &[]).unwrap();
        assert!(reports.iter().all(|r| r.action == Action::Added));
        assert_eq!(states(&bin, &tools), [State::Current, State::Current]);
        let again = install(&bin, &tools, &[]).unwrap();
        assert!(again.iter().all(|r| r.action == Action::Unchanged));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn install_updates_moved_app_links_and_adds_the_missing_one() {
        let root = scratch("stale");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let old = root.join("Old ShareCut.app/podcast");
        std::os::unix::fs::symlink(&old, bin.join("podcast")).unwrap();
        assert_eq!(states(&bin, &tools), [State::Stale, State::Missing]);
        let reports = install(&bin, &tools, &[]).unwrap();
        assert_eq!(reports[0].action, Action::Updated);
        assert_eq!(reports[1].action, Action::Added);
        assert_eq!(fs::read(bin.join("podcast")).unwrap(), tools[0].1);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_to_the_launcher_are_replaced_by_a_working_wrapper() {
        let root = scratch("symlink");
        let tools = app_tools(&root);
        let launcher = root.join("ShareCut.app/podcast");
        fs::write(&launcher, b"#!/bin/sh\necho \"launcher $0 $@\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(&launcher, bin.join("podcast")).unwrap();
        assert_eq!(states(&bin, &tools)[0], State::Stale);
        install(&bin, &tools, &[]).unwrap();
        assert_eq!(states(&bin, &tools)[0], State::Current);
        assert!(!fs::symlink_metadata(bin.join("podcast"))
            .unwrap()
            .file_type()
            .is_symlink());
        let output = Command::new(bin.join("podcast"))
            .arg("hi")
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            format!("launcher {} hi", launcher.display())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn older_appimage_wrappers_are_stale_not_foreign() {
        let root = scratch("v1");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(
            bin.join("podcast"),
            b"#!/bin/sh\n# Sharecut Studio AppImage CLI wrapper v1\nexec 'x' --cli \"$@\"\n",
        )
        .unwrap();
        assert_eq!(states(&bin, &tools)[0], State::Stale);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn foreign_commands_are_skipped_or_backed_up_never_lost() {
        let root = scratch("foreign");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("podcast"), b"#!/bin/sh\necho dev venv\n").unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere/podcast-mcp"), bin.join("podcast-mcp"))
            .unwrap();
        assert_eq!(states(&bin, &tools), [State::Foreign, State::Foreign]);
        let skipped = install(&bin, &tools, &[]).unwrap();
        assert!(skipped.iter().all(|r| r.action == Action::SkippedForeign));
        assert_eq!(
            fs::read(bin.join("podcast")).unwrap(),
            b"#!/bin/sh\necho dev venv\n"
        );
        let replaced = install(&bin, &tools, &names(&["podcast", "podcast-mcp"])).unwrap();
        assert!(matches!(replaced[0].action, Action::Replaced { .. }));
        assert_eq!(
            fs::read(bin.join("podcast.sharecut-backup")).unwrap(),
            b"#!/bin/sh\necho dev venv\n"
        );
        assert!(fs::symlink_metadata(bin.join("podcast-mcp.sharecut-backup")).is_ok());
        assert_eq!(states(&bin, &tools), [State::Current, State::Current]);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn remove_only_takes_owned_commands() {
        let root = scratch("remove");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        install(&bin, &tools, &[]).unwrap();
        fs::remove_file(bin.join("podcast-mcp")).unwrap();
        fs::write(bin.join("podcast-mcp"), b"foreign").unwrap();
        let reports = remove(&bin, &tools).unwrap();
        assert_eq!(reports[0].action, Action::Removed);
        assert_eq!(reports[1].action, Action::SkippedForeign);
        assert!(fs::symlink_metadata(bin.join("podcast")).is_err());
        assert_eq!(fs::read(bin.join("podcast-mcp")).unwrap(), b"foreign");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_of_another_size_is_foreign_and_untouched() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("unreadable");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let foreign = bin.join("podcast");
        fs::write(&foreign, b"someone else's tool").unwrap();
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o000)).unwrap();
        assert_ne!(tools[0].1.len(), b"someone else's tool".len());
        assert_eq!(states(&bin, &tools)[0], State::Foreign);
        let skipped = install(&bin, &tools, &[]).unwrap();
        assert_eq!(skipped[0].action, Action::SkippedForeign);
        let removed = remove(&bin, &tools).unwrap();
        assert_eq!(removed[0].action, Action::SkippedForeign);
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(fs::read(&foreign).unwrap(), b"someone else's tool");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn only_packaged_app_links_count_as_owned() {
        let owned = |p: &str| owned_link_target(Path::new(p), "podcast");
        assert!(owned(
            "/Applications/ShareCut Studio.app/Contents/MacOS/podcast"
        ));
        assert!(owned("/Users/a/Old sharecut.APP/podcast"));
        assert!(owned("/opt/sharecut-studio/podcast"));
        assert!(owned("/usr/lib/Sharecut Studio/podcast"));
        assert!(owned("/usr/bin/sharecut/podcast"));
        assert!(!owned("/home/a/src/sharecut-studio/.venv/bin/podcast"));
        assert!(!owned("/home/a/sharecut.app.bak/podcast"));
        assert!(!owned("/Applications/Other.app/Contents/MacOS/podcast"));
        assert!(!owned("/usr/bin/podcast"));
        assert!(!owned("/opt/tools/podcast"));
        assert!(!owned("/opt/sharecut/../../home/a/bin/podcast"));
        assert!(!owned("/home/a/opt/sharecut/podcast"));
        assert!(!owned("sharecut/ShareCut.app/podcast"));
        assert!(!owned_link_target(
            Path::new("/Applications/ShareCut.app/podcast-mcp"),
            "podcast"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn developer_symlink_into_a_sharecut_checkout_is_foreign_and_survives_remove() {
        let root = scratch("devlink");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let dev = root.join("src/sharecut-studio/.venv/bin/podcast");
        std::os::unix::fs::symlink(&dev, bin.join("podcast")).unwrap();
        assert_eq!(states(&bin, &tools)[0], State::Foreign);
        let skipped = install(&bin, &tools, &[]).unwrap();
        assert_eq!(skipped[0].action, Action::SkippedForeign);
        let removed = remove(&bin, &tools).unwrap();
        assert_eq!(removed[0].action, Action::SkippedForeign);
        assert_eq!(fs::read_link(bin.join("podcast")).unwrap(), dev);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn move_never_overwrites_an_existing_destination() {
        let root = scratch("noclobber");
        let from = root.join("from");
        let to = root.join("to");
        fs::write(&from, b"new").unwrap();
        fs::write(&to, b"precious").unwrap();
        let err = move_no_clobber(&from, &to).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&from).unwrap(), b"new");
        assert_eq!(fs::read(&to).unwrap(), b"precious");
        fs::remove_file(&to).unwrap();
        move_no_clobber(&from, &to).unwrap();
        assert!(fs::symlink_metadata(&from).is_err());
        assert_eq!(fs::read(&to).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn move_handles_symlinks_and_directories_without_clobbering() {
        let root = scratch("movekinds");
        let link = root.join("link");
        std::os::unix::fs::symlink("somewhere", &link).unwrap();
        let moved = root.join("moved-link");
        move_no_clobber(&link, &moved).unwrap();
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read_link(&moved).unwrap(), Path::new("somewhere"));
        std::os::unix::fs::symlink("other", &link).unwrap();
        assert_eq!(
            move_no_clobber(&link, &moved).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read_link(&moved).unwrap(), Path::new("somewhere"));
        let dir = root.join("dir");
        fs::create_dir_all(dir.join("inner")).unwrap();
        let taken = root.join("taken");
        fs::create_dir(&taken).unwrap();
        assert_eq!(
            move_no_clobber(&dir, &taken).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(dir.join("inner").is_dir());
        let free = root.join("free");
        move_no_clobber(&dir, &free).unwrap();
        assert!(free.join("inner").is_dir());
        assert!(fs::symlink_metadata(&dir).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replace_keeps_an_existing_backup_and_picks_the_next_name() {
        let root = scratch("backups");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("podcast.sharecut-backup"), b"first").unwrap();
        fs::write(bin.join("podcast.sharecut-backup-2"), b"second").unwrap();
        fs::write(bin.join("podcast"), b"third").unwrap();
        let reports = install(&bin, &tools, &names(&["podcast"])).unwrap();
        assert_eq!(
            reports[0].action,
            Action::Replaced {
                backup: bin.join("podcast.sharecut-backup-3")
            }
        );
        assert_eq!(
            fs::read(bin.join("podcast.sharecut-backup")).unwrap(),
            b"first"
        );
        assert_eq!(
            fs::read(bin.join("podcast.sharecut-backup-2")).unwrap(),
            b"second"
        );
        assert_eq!(
            fs::read(bin.join("podcast.sharecut-backup-3")).unwrap(),
            b"third"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_replace_restores_the_original_and_names_the_backup() {
        let root = scratch("rollback");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("podcast"), b"mine").unwrap();
        let err = replace_with(&bin, "podcast", || Err(io::Error::other("disk full"))).unwrap_err();
        assert_eq!(fs::read(bin.join("podcast")).unwrap(), b"mine");
        assert!(fs::symlink_metadata(bin.join("podcast.sharecut-backup")).is_err());
        let text = err.to_string();
        assert!(text.contains("podcast"), "{text}");
        assert!(text.contains("disk full"), "{text}");
        assert!(text.contains("podcast.sharecut-backup"), "{text}");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_replace_whose_restore_also_fails_leaves_the_backup() {
        let root = scratch("rollback-blocked");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("podcast"), b"mine").unwrap();
        let blocker = bin.join("podcast");
        let err = replace_with(&bin, "podcast", || {
            fs::write(&blocker, b"someone else")?;
            Err(io::Error::other("disk full"))
        })
        .unwrap_err();
        assert_eq!(fs::read(&blocker).unwrap(), b"someone else");
        assert_eq!(
            fs::read(bin.join("podcast.sharecut-backup")).unwrap(),
            b"mine"
        );
        assert!(err.to_string().contains("podcast.sharecut-backup"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replace_only_touches_the_consented_names() {
        let root = scratch("consent");
        let tools = app_tools(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("podcast"), b"one").unwrap();
        fs::write(bin.join("podcast-mcp"), b"two").unwrap();
        let reports = install(&bin, &tools, &names(&["podcast"])).unwrap();
        assert!(matches!(reports[0].action, Action::Replaced { .. }));
        assert_eq!(reports[1].action, Action::SkippedForeign);
        assert_eq!(fs::read(bin.join("podcast-mcp")).unwrap(), b"two");
        assert!(fs::symlink_metadata(bin.join("podcast-mcp.sharecut-backup")).is_err());
        let none = install(&bin, &tools, &names(&["unrelated"])).unwrap();
        assert_eq!(none[1].action, Action::SkippedForeign);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_uses_whole_entries() {
        let bin = Path::new("/home/test/.local/bin");
        assert!(!bin_on_path(
            bin,
            Some("/home/test/.local/bin-extra".as_ref())
        ));
        assert!(bin_on_path(
            bin,
            Some("/usr/bin:/home/test/.local/bin".as_ref())
        ));
    }

    #[test]
    fn appimage_dispatch_only_consumes_its_own_flag() {
        let args = vec!["--cli".into(), "--help".into()];
        assert_eq!(
            appimage_command(args),
            Some(("podcast", vec!["--help".into()]))
        );
        assert_eq!(
            appimage_command(vec!["--mcp".into()]),
            Some(("podcast-mcp", vec![]))
        );
        assert_eq!(appimage_command(vec!["--help".into()]), None);
    }

    #[cfg(unix)]
    #[test]
    fn appimage_wrappers_are_owned_repaired_and_keep_shell_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("appimage");
        let image = root.join("Sharecut's Studio.AppImage");
        fs::write(&image, b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        fs::set_permissions(&image, fs::Permissions::from_mode(0o755)).unwrap();
        let tools = appimage_tools(&image).unwrap();
        let first = &tools[0].1;
        assert!(
            String::from_utf8_lossy(first).contains("Sharecut'\\''s Studio.AppImage' --cli \"$@\"")
        );
        let bin = root.join("bin");
        install(&bin, &tools, &[]).unwrap();
        assert_eq!(states(&bin, &tools), [State::Current, State::Current]);
        for mode in [0o644, 0o001, 0o010, 0o401, 0o410] {
            fs::set_permissions(bin.join("podcast"), fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(states(&bin, &tools)[0], State::Stale);
            install(&bin, &tools, &[]).unwrap();
            assert_eq!(states(&bin, &tools)[0], State::Current);
        }
        assert_eq!(fs::read_dir(&bin).unwrap().count(), 2);
        let output = Command::new(bin.join("podcast"))
            .arg("an argument with spaces")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"--cli\nan argument with spaces\n");

        let other = root.join("Moved Sharecut.AppImage");
        fs::copy(&image, &other).unwrap();
        let moved = appimage_tools(&other).unwrap();
        assert_eq!(states(&bin, &moved), [State::Stale, State::Stale]);
        install(&bin, &moved, &[]).unwrap();
        assert_eq!(states(&bin, &moved), [State::Current, State::Current]);

        remove(&bin, &moved).unwrap();
        assert!(fs::symlink_metadata(bin.join("podcast")).is_err());
        fs::write(bin.join("podcast"), b"foreign").unwrap();
        assert_eq!(states(&bin, &tools)[0], State::Foreign);
        fs::remove_dir_all(root).unwrap();
    }
}
