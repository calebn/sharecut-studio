//! Project files handed to the host by the OS (double-click, argv, Finder).
//! Pure filtering and hand-off helpers: no Tauri, no WebView. The engine
//! re-validates every path, so this module is a convenience filter only.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use url::Url;

pub const PROJECT_FILE_EXTENSION: &str = "sharecut";
pub const OPEN_PROJECT_FRAGMENT_KEY: &str = "open-project";
pub const OPEN_PROJECT_EVENT: &str = "sharecut:open-project-file";
pub const OPEN_PROJECT_QUEUE: &str = "__sharecutOpenQueue";

/// First argument that is a usable project file; `args` must already skip argv[0].
/// A relative path resolves against `cwd`, which is the calling process's own directory.
pub fn project_file_from_args<I>(args: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = OsString>,
{
    args.into_iter()
        .find_map(|arg| project_file_from_arg(&arg, cwd))
}

fn project_file_from_arg(arg: &OsString, cwd: &Path) -> Option<PathBuf> {
    let text = arg.to_str()?;
    if text.starts_with('-') || has_url_scheme(text) || is_network_path(text) {
        return None;
    }
    let path = Path::new(text);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else if cwd.is_absolute() {
        cwd.join(path)
    } else {
        return None;
    };
    validated_project_file(path)
}

/// A `file:` URL from the OS (macOS `RunEvent::Opened`); any other scheme is refused.
pub fn project_file_from_file_url(url: &Url) -> Option<PathBuf> {
    if url.scheme() != "file" {
        return None;
    }
    if !matches!(url.host_str(), None | Some("") | Some("localhost")) {
        return None;
    }
    validated_project_file(url.to_file_path().ok()?)
}

fn validated_project_file(path: PathBuf) -> Option<PathBuf> {
    let text = path.to_str()?;
    if text.chars().any(char::is_control) || !path.is_absolute() {
        return None;
    }
    if path.components().any(|part| match part {
        Component::ParentDir => true,
        Component::Prefix(prefix) => !matches!(
            prefix.kind(),
            std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
        ),
        _ => false,
    }) {
        return None;
    }
    if !has_project_extension(&path) {
        return None;
    }
    std::fs::metadata(&path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|_| path)
}

fn has_project_extension(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    if cfg!(any(windows, target_os = "macos")) {
        ext.eq_ignore_ascii_case(PROJECT_FILE_EXTENSION)
    } else {
        ext == PROJECT_FILE_EXTENSION
    }
}

/// `scheme:` of two or more characters; a one-letter scheme is a Windows drive.
fn has_url_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once(':') else {
        return false;
    };
    scheme.len() >= 2
        && scheme
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

fn is_network_path(text: &str) -> bool {
    text.starts_with("\\\\") || text.starts_with("//")
}

/// Same escaping as JavaScript `encodeURIComponent`, so the page can `decodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Engine page URL, carrying the project file in the fragment so it never reaches the server.
pub fn engine_url(port: u16, project: Option<&Path>) -> String {
    let base = format!("http://127.0.0.1:{port}/");
    match project.and_then(Path::to_str) {
        Some(path) => format!(
            "{base}#{OPEN_PROJECT_FRAGMENT_KEY}={}",
            encode_uri_component(path)
        ),
        None => base,
    }
}

/// Script that queues one path for the page and wakes its listener; `path_json` is a JSON string literal.
pub fn open_project_script(path_json: &str) -> String {
    format!(
        "(function(p){{(window.{OPEN_PROJECT_QUEUE}=window.{OPEN_PROJECT_QUEUE}||[]).push(p);\
window.dispatchEvent(new CustomEvent('{OPEN_PROJECT_EVENT}',{{detail:{{path:p}}}}))}})({path_json})"
    )
}

/// One pending project file between the OS and the engine page, taken once.
#[derive(Debug, Default)]
pub struct ProjectFileSlot {
    pending: Option<PathBuf>,
    page_ready: bool,
}

impl ProjectFileSlot {
    /// True when the page is loaded and the caller should push `path` now; otherwise it is kept.
    pub fn offer(&mut self, path: PathBuf) -> bool {
        if self.page_ready {
            return true;
        }
        self.pending = Some(path);
        false
    }

    /// Called right before the engine page loads: hands over the pending path and marks the page ready.
    pub fn take_for_navigation(&mut self) -> Option<PathBuf> {
        self.page_ready = true;
        self.pending.take()
    }

    /// The engine page is going away (engine restart); later offers wait again.
    pub fn reset(&mut self) {
        self.page_ready = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "sharecut-project-file-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create dir");
            Dir(dir)
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
            fs::write(&path, "{}").expect("write");
            path
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn os(text: &str) -> OsString {
        OsString::from(text)
    }

    fn from_args(args: &[&str], cwd: &Path) -> Option<PathBuf> {
        project_file_from_args(args.iter().map(|arg| os(arg)), cwd)
    }

    #[test]
    fn extension_constant_is_sharecut() {
        assert_eq!(PROJECT_FILE_EXTENSION, "sharecut");
    }

    #[test]
    fn accepts_an_absolute_project_file_whatever_its_basename() {
        let dir = Dir::new("absolute");
        for name in ["episode.sharecut", "renamed copy.sharecut"] {
            let file = dir.file(name);
            assert_eq!(
                from_args(&[file.to_str().unwrap()], &dir.0),
                Some(file.clone())
            );
        }
    }

    #[test]
    fn accepts_spaces_non_ascii_and_percent_in_names() {
        let dir = Dir::new("names");
        for name in [
            "My Show/episode.sharecut",
            "Épisode ünï/épisode.sharecut",
            "100% done/a%20b.sharecut",
            "日本語/episode.sharecut",
        ] {
            let file = dir.file(name);
            assert_eq!(
                from_args(&[file.to_str().unwrap()], &dir.0),
                Some(file.clone()),
                "{name}"
            );
        }
    }

    #[test]
    fn resolves_a_relative_path_against_the_given_cwd() {
        let dir = Dir::new("relative");
        let file = dir.file("show/episode.sharecut");
        assert_eq!(from_args(&["show/episode.sharecut"], &dir.0), Some(file));
        assert_eq!(
            from_args(&["show/episode.sharecut"], Path::new("relative-cwd")),
            None
        );
    }

    #[test]
    fn picks_the_first_qualifying_argument_and_skips_the_rest() {
        let dir = Dir::new("first");
        let first = dir.file("a/episode.sharecut");
        let second = dir.file("b/episode.sharecut");
        let args = [
            "--flag",
            "notes.txt",
            first.to_str().unwrap(),
            second.to_str().unwrap(),
        ];
        assert_eq!(from_args(&args, &dir.0), Some(first));
    }

    #[test]
    fn rejects_flags_urls_and_network_paths() {
        let dir = Dir::new("rejects");
        let file = dir.file("episode.sharecut");
        let path = file.to_str().unwrap().to_string();
        // Real files, so only the flag check can be the reason these are refused.
        dir.file("-episode.sharecut");
        dir.file("--open.sharecut");
        let rejected = [
            format!("--open={path}"),
            "-episode.sharecut".to_string(),
            "--open.sharecut".to_string(),
            format!("file://{path}"),
            "https://example.test/episode.sharecut".to_string(),
            "sharecut-dev://r/token".to_string(),
            "\\\\server\\share\\episode.sharecut".to_string(),
            "//server/share/episode.sharecut".to_string(),
            String::new(),
        ];
        for arg in rejected {
            assert_eq!(from_args(&[arg.as_str()], &dir.0), None, "{arg:?}");
        }
    }

    #[test]
    fn rejects_parent_components_even_when_the_target_exists() {
        let dir = Dir::new("parent");
        dir.file("episode.sharecut");
        dir.file("inner/keep.txt");
        let traversal = format!("{}/inner/../episode.sharecut", dir.0.display());
        assert_eq!(from_args(&[traversal.as_str()], &dir.0), None);
        assert_eq!(
            from_args(&["../episode.sharecut"], &dir.0.join("inner")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_control_characters_and_nul() {
        let dir = Dir::new("control");
        // Real files for the ones the OS allows, so the control-character check is what refuses them.
        for name in ["a\nb.sharecut", "a\tb.sharecut"] {
            let file = dir.file(name);
            assert!(file.exists(), "{name:?}");
            assert_eq!(
                from_args(&[file.to_str().unwrap()], &dir.0),
                None,
                "{name:?}"
            );
        }
        let nul = format!("{}/a\u{0}b.sharecut", dir.0.display());
        assert_eq!(from_args(&[nul.as_str()], &dir.0), None);
    }

    #[test]
    fn rejects_the_wrong_extension_and_extensionless_names() {
        let dir = Dir::new("extension");
        for name in [
            "episode.json",
            "episode.sharecut.bak",
            "sharecut",
            ".sharecut",
        ] {
            let file = dir.file(name);
            assert_eq!(from_args(&[file.to_str().unwrap()], &dir.0), None, "{name}");
        }
    }

    #[test]
    fn upper_case_extension_follows_the_platform() {
        let dir = Dir::new("case");
        let file = dir.file("EPISODE.SHARECUT");
        let expected = cfg!(any(windows, target_os = "macos"));
        assert_eq!(
            from_args(&[file.to_str().unwrap()], &dir.0).is_some(),
            expected
        );
    }

    #[test]
    fn rejects_directories_and_missing_files() {
        let dir = Dir::new("kinds");
        let folder = dir.0.join("folder.sharecut");
        fs::create_dir_all(&folder).expect("dir");
        assert_eq!(from_args(&[folder.to_str().unwrap()], &dir.0), None);
        let missing = dir.0.join("missing.sharecut");
        assert_eq!(from_args(&[missing.to_str().unwrap()], &dir.0), None);
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_symlink_to_a_file_and_rejects_one_to_a_directory() {
        use std::os::unix::fs::symlink;
        let dir = Dir::new("symlink");
        let target = dir.file("real/episode.sharecut");
        let link = dir.0.join("link.sharecut");
        symlink(&target, &link).expect("symlink");
        assert_eq!(from_args(&[link.to_str().unwrap()], &dir.0), Some(link));
        let folder = dir.0.join("folder");
        fs::create_dir_all(&folder).expect("dir");
        let dir_link = dir.0.join("dir-link.sharecut");
        symlink(&folder, &dir_link).expect("symlink");
        assert_eq!(from_args(&[dir_link.to_str().unwrap()], &dir.0), None);
        let dangling = dir.0.join("dangling.sharecut");
        symlink(dir.0.join("gone"), &dangling).expect("symlink");
        assert_eq!(from_args(&[dangling.to_str().unwrap()], &dir.0), None);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_utf8_arguments() {
        use std::os::unix::ffi::OsStringExt;
        let dir = Dir::new("non-utf8");
        let mut bytes = dir.0.to_str().unwrap().as_bytes().to_vec();
        bytes.extend_from_slice(b"/bad\xff.sharecut");
        let arg = OsString::from_vec(bytes);
        assert_eq!(project_file_from_args([arg], &dir.0), None);
    }

    #[test]
    fn no_arguments_gives_nothing() {
        let dir = Dir::new("empty");
        assert_eq!(project_file_from_args(Vec::<OsString>::new(), &dir.0), None);
    }

    #[test]
    fn file_url_accepts_a_local_file_and_decodes_percent_escapes() {
        let dir = Dir::new("file-url");
        let file = dir.file("My Show/100% done/episode.sharecut");
        let url = Url::from_file_path(&file).expect("file url");
        assert!(url.as_str().contains("%20"));
        assert_eq!(project_file_from_file_url(&url), Some(file));
    }

    #[test]
    fn file_url_rejects_other_schemes_remote_hosts_and_bad_targets() {
        let dir = Dir::new("file-url-rejects");
        let file = dir.file("episode.sharecut");
        let text = Url::from_file_path(&file).unwrap().to_string();
        let plain = dir.file("notes.txt");
        let folder = dir.0.join("folder.sharecut");
        fs::create_dir_all(&folder).expect("dir");
        let encoded_nul = text.replace("episode", "epi%00sode");
        let remote = text.replacen("file://", "file://server", 1);
        let cases = [
            "https://example.test/episode.sharecut".to_string(),
            "sharecut-dev://r/token".to_string(),
            remote,
            Url::from_file_path(&plain).unwrap().to_string(),
            Url::from_file_path(&folder).unwrap().to_string(),
            encoded_nul,
        ];
        for case in cases {
            let url = Url::parse(&case).expect("url");
            assert_eq!(project_file_from_file_url(&url), None, "{case}");
        }
        let localhost = Url::parse(&text.replacen("file://", "file://localhost", 1)).unwrap();
        assert_eq!(project_file_from_file_url(&localhost), Some(file));
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(
            encode_uri_component("/a b/c.sharecut"),
            "%2Fa%20b%2Fc.sharecut"
        );
        assert_eq!(encode_uri_component("100% é"), "100%25%20%C3%A9");
        assert_eq!(encode_uri_component("a+b&c=d#e?f"), "a%2Bb%26c%3Dd%23e%3Ff");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_uri_component("C:\\x y"), "C%3A%5Cx%20y");
    }

    #[test]
    fn engine_url_carries_the_project_in_the_fragment_only_when_given() {
        assert_eq!(engine_url(51234, None), "http://127.0.0.1:51234/");
        assert_eq!(
            engine_url(51234, Some(Path::new("/a b/episode.sharecut"))),
            "http://127.0.0.1:51234/#open-project=%2Fa%20b%2Fepisode.sharecut"
        );
    }

    #[test]
    fn engine_url_with_a_fragment_stays_an_allowed_navigation() {
        let url = engine_url(51234, Some(Path::new("/a b/100%/episode.sharecut")));
        assert!(crate::engine::engine_navigation_allowed(&url, Some(51234)));
        assert!(!crate::engine::engine_navigation_allowed(&url, Some(9)));
    }

    #[test]
    fn open_script_embeds_the_json_literal_and_names_the_page_contract() {
        let script = open_project_script("\"/a b/episode.sharecut\"");
        assert!(script.contains("window.__sharecutOpenQueue"));
        assert!(script.contains("'sharecut:open-project-file'"));
        assert!(script.ends_with("(\"/a b/episode.sharecut\")"));
    }

    #[test]
    fn slot_keeps_the_latest_path_until_the_page_loads_then_hands_it_over_once() {
        let mut slot = ProjectFileSlot::default();
        assert!(!slot.offer(PathBuf::from("/a/episode.sharecut")));
        assert!(!slot.offer(PathBuf::from("/a/episode.sharecut")));
        assert!(!slot.offer(PathBuf::from("/b/episode.sharecut")));
        assert_eq!(
            slot.take_for_navigation(),
            Some(PathBuf::from("/b/episode.sharecut"))
        );
        assert_eq!(slot.take_for_navigation(), None);
    }

    #[test]
    fn slot_pushes_directly_while_the_page_is_ready_and_waits_again_after_reset() {
        let mut slot = ProjectFileSlot::default();
        slot.take_for_navigation();
        assert!(slot.offer(PathBuf::from("/a/episode.sharecut")));
        assert_eq!(slot.take_for_navigation(), None);
        slot.reset();
        assert!(!slot.offer(PathBuf::from("/c/episode.sharecut")));
        assert_eq!(
            slot.take_for_navigation(),
            Some(PathBuf::from("/c/episode.sharecut"))
        );
    }
}
