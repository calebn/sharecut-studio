//! Native, opt-in shell links for the packaged console launchers.
//! This module never accepts a path from the WebView.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};

pub const INSTALL_MENU_ID: &str = "native-cli-install";
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

pub fn run_appimage_command(
    exe: &Path,
    launcher: &str,
    args: &[OsString],
) -> io::Result<ExitStatus> {
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::other("app binary has no parent"))?;
    // Command inherits the terminal's cwd, stdin, stdout, stderr, and environment.
    Command::new(dir.join(launcher)).args(args).status()
}

#[cfg(unix)]
fn appimage_wrapper(appimage: &Path, launcher: &str) -> io::Result<Vec<u8>> {
    use std::os::unix::ffi::OsStrExt;
    if !appimage.is_absolute() || !fs::metadata(appimage)?.is_file() {
        return Err(io::Error::other(
            "APPIMAGE must name an absolute AppImage file",
        ));
    }
    let mut script = b"#!/bin/sh\n# Sharecut Studio AppImage CLI wrapper v1\nexec '".to_vec();
    for byte in appimage.as_os_str().as_bytes() {
        if *byte == b'\'' {
            script.extend_from_slice(b"'\\''");
        } else {
            script.push(*byte);
        }
    }
    script.extend_from_slice(b"' ");
    script.extend_from_slice(if launcher == "podcast" {
        b"--cli"
    } else {
        b"--mcp"
    });
    script.extend_from_slice(b" \"$@\"\n");
    Ok(script)
}

#[cfg(unix)]
pub fn appimage_wrappers(appimage: &Path) -> io::Result<[(String, Vec<u8>); 2]> {
    Ok([
        ("podcast".into(), appimage_wrapper(appimage, "podcast")?),
        (
            "podcast-mcp".into(),
            appimage_wrapper(appimage, "podcast-mcp")?,
        ),
    ])
}

#[cfg(unix)]
fn wrapper_matches(path: &Path, expected: &[u8]) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    Ok(metadata.file_type().is_file() && fs::read(path)? == expected)
}

#[cfg(unix)]
pub fn install_appimage(bin: &Path, wrappers: &[(String, Vec<u8>); 2]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(bin)?;
    for (name, content) in wrappers {
        let path = bin.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) if !wrapper_matches(&path, content)? => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "{} already exists; move it manually before installing",
                        path.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    for (name, content) in wrappers {
        let path = bin.join(name);
        if wrapper_matches(&path, content)? {
            continue;
        }
        let temp = bin.join(format!(
            ".{name}.sharecut-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&temp)?;
        use std::io::Write;
        let result = file
            .write_all(content)
            .and_then(|()| file.sync_all())
            .and_then(|()| fs::hard_link(&temp, &path));
        drop(file);
        let _ = fs::remove_file(&temp);
        match result {
            Ok(()) => {}
            Err(err)
                if err.kind() == io::ErrorKind::AlreadyExists
                    && wrapper_matches(&path, content)? => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

#[cfg(unix)]
pub fn remove_appimage(bin: &Path, wrappers: &[(String, Vec<u8>); 2]) -> io::Result<()> {
    for (name, content) in wrappers {
        let path = bin.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) if !wrapper_matches(&path, content)? => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "{} is not this app's wrapper; it was left alone",
                        path.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    for (name, content) in wrappers {
        let path = bin.join(name);
        if wrapper_matches(&path, content)? {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn existing_link_matches(link: &Path, target: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(link) {
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(fs::read_link(link)? == target),
        Ok(_) => Ok(false),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
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

/// Symlink creation is exclusive: an existing file or even a dangling link is
/// never replaced. Existing links to these exact packaged launchers are idempotent.
#[cfg(unix)]
pub fn install(bin: &Path, launchers: &[(String, PathBuf); 2]) -> io::Result<()> {
    use std::os::unix::fs::symlink;
    fs::create_dir_all(bin)?;
    // Catch ordinary conflicts before writing either link. symlink() still
    // performs the exclusive final check if another process changes a path.
    for (name, target) in launchers {
        let link = bin.join(name);
        match fs::symlink_metadata(&link) {
            Ok(_) if !existing_link_matches(&link, target)? => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "{} already exists; move it manually before installing",
                        link.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    for (name, target) in launchers {
        let link = bin.join(name);
        match symlink(target, &link) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                if !existing_link_matches(&link, target)? {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!(
                            "{} already exists; move it manually before installing",
                            link.display()
                        ),
                    ));
                }
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Remove only links whose literal destination is a packaged launcher next to
/// this running app. A missing link is already removed.
pub fn remove(bin: &Path, launchers: &[(String, PathBuf); 2]) -> io::Result<()> {
    for (name, target) in launchers {
        let link = bin.join(name);
        match fs::symlink_metadata(&link) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if existing_link_matches(&link, target)? {
                    fs::remove_file(&link)?;
                } else {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!("{} points elsewhere; it was left alone", link.display()),
                    ));
                }
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "{} is not a Sharecut link; it was left alone",
                        link.display()
                    ),
                ))
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

pub fn bin_on_path(bin: &Path, path: Option<&std::ffi::OsStr>) -> bool {
    path.map(|value| std::env::split_paths(value).any(|entry| entry == bin))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn links_are_exclusive_idempotent_and_only_owned_links_are_removed() {
        let root = std::env::temp_dir().join(format!(
            "sharecut-cli-links-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("app")).unwrap();
        for name in NAMES {
            fs::write(root.join("app").join(name), b"launcher").unwrap();
        }
        let launchers = targets(&root.join("app/sharecut")).unwrap();
        let bin = root.join("bin");
        install(&bin, &launchers).unwrap();
        install(&bin, &launchers).unwrap();
        remove(&bin, &launchers).unwrap();
        assert!(!bin.join("podcast").exists());
        std::os::unix::fs::symlink(root.join("missing"), bin.join("podcast")).unwrap();
        assert_eq!(
            install(&bin, &launchers).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(fs::symlink_metadata(bin.join("podcast")).is_ok());
        assert!(remove(&bin, &launchers).is_err());
        fs::remove_file(bin.join("podcast")).unwrap();
        fs::write(bin.join("podcast-mcp"), b"foreign").unwrap();
        assert_eq!(
            install(&bin, &launchers).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(fs::symlink_metadata(bin.join("podcast")).is_err());
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
    fn appimage_wrappers_are_owned_and_keep_shell_arguments() {
        let root =
            std::env::temp_dir().join(format!("sharecut-appimage-links-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let image = root.join("Sharecut's Studio.AppImage");
        fs::write(&image, b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&image, fs::Permissions::from_mode(0o755)).unwrap();
        let wrappers = appimage_wrappers(&image).unwrap();
        assert!(String::from_utf8_lossy(&wrappers[0].1)
            .contains("Sharecut'\\''s Studio.AppImage' --cli \"$@\""));
        let bin = root.join("bin");
        install_appimage(&bin, &wrappers).unwrap();
        install_appimage(&bin, &wrappers).unwrap();
        assert_eq!(fs::read(bin.join("podcast")).unwrap(), wrappers[0].1);
        assert_eq!(fs::read_dir(&bin).unwrap().count(), 2);
        let output = Command::new(bin.join("podcast"))
            .arg("an argument with spaces")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"--cli\nan argument with spaces\n");
        remove_appimage(&bin, &wrappers).unwrap();
        assert!(fs::symlink_metadata(bin.join("podcast")).is_err());
        std::os::unix::fs::symlink(&image, bin.join("podcast")).unwrap();
        assert_eq!(
            install_appimage(&bin, &wrappers).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            remove_appimage(&bin, &wrappers).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        fs::remove_file(bin.join("podcast")).unwrap();
        fs::write(bin.join("podcast"), b"foreign").unwrap();
        assert_eq!(
            install_appimage(&bin, &wrappers).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        fs::remove_dir_all(root).unwrap();
    }
}
