//! Native, opt-in shell links for the packaged console launchers.
//! This module never accepts a path from the WebView.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const INSTALL_MENU_ID: &str = "native-cli-install";
pub const REMOVE_MENU_ID: &str = "native-cli-remove";
const NAMES: [&str; 2] = ["podcast", "podcast-mcp"];

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
}
