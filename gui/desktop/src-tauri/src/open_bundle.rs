//! Segment and kit files handed to the iOS app by the share sheet or Files.
//! Pure helpers: no Tauri, no WebView. The page fetches the copy from the engine's inbox route
//! and the engine's staged import re-validates every byte, so this is a convenience filter.

use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use url::Url;

pub const OPEN_BUNDLE_EVENT: &str = "sharecut:open-bundle";
pub const OPEN_BUNDLE_QUEUE: &str = "__sharecutOpenBundleQueue";
pub const INBOX_DIR_NAME: &str = "sharecut-inbox";
pub const MAX_BUNDLE_BYTES: u64 = 1 << 30;
pub const INBOX_MAX_AGE: Duration = Duration::from_secs(60 * 60);
const MAX_PENDING: usize = 16;
const MAX_NAME_BYTES: usize = 120;
const BUNDLE_EXTENSIONS: [&str; 3] = ["sharecutseg", "sharecutkit", "zip"];

/// One received file: its inbox id (the engine route's path segment), display name and size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxItem {
    pub id: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InboxError {
    NotAFile,
    TooLarge,
    Io(io::ErrorKind),
}

impl fmt::Display for InboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InboxError::NotAFile => f.write_str("not a regular file"),
            InboxError::TooLarge => f.write_str("larger than the size limit"),
            InboxError::Io(kind) => write!(f, "io error: {kind}"),
        }
    }
}

impl From<io::Error> for InboxError {
    fn from(error: io::Error) -> Self {
        InboxError::Io(error.kind())
    }
}

/// Where received files live under the app's temporary directory.
pub fn inbox_dir(temp_dir: &Path) -> PathBuf {
    temp_dir.join(INBOX_DIR_NAME)
}

/// A `file:` URL from the OS (`RunEvent::Opened`) that names an existing bundle file.
pub fn bundle_from_file_url(url: &Url) -> Option<PathBuf> {
    if url.scheme() != "file" {
        return None;
    }
    if !matches!(url.host_str(), None | Some("") | Some("localhost")) {
        return None;
    }
    let path = url.to_file_path().ok()?;
    if path.to_str()?.chars().any(char::is_control) || !path.is_absolute() {
        return None;
    }
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return None;
    }
    let ext = path.extension()?.to_str()?;
    if !BUNDLE_EXTENSIONS
        .iter()
        .any(|allowed| ext.eq_ignore_ascii_case(allowed))
    {
        return None;
    }
    fs::metadata(&path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|_| path)
}

/// A file name that is safe as one path component and as a download name.
pub fn sanitize_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let (stem, ext) = match trimmed.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.len() <= 12 => (stem, format!(".{ext}")),
        _ => (trimmed, String::new()),
    };
    let mut stem = stem.to_string();
    while stem.len() + ext.len() > MAX_NAME_BYTES && stem.pop().is_some() {}
    let name = format!("{}{ext}", stem.trim_end());
    if name.is_empty() || name == ext {
        format!("bundle{ext}")
    } else {
        name
    }
}

fn new_id() -> io::Result<String> {
    let hex = crate::random_boot_token().map_err(io::Error::other)?;
    let mut digits: Vec<char> = hex.chars().take(32).collect();
    if digits.len() != 32 {
        return Err(io::Error::other("short random token"));
    }
    digits[12] = '4';
    digits[16] = ['8', '9', 'a', 'b'][digits[16].to_digit(16).unwrap_or(0) as usize % 4];
    let part = |from: usize, to: usize| digits[from..to].iter().collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        part(0, 8),
        part(8, 12),
        part(12, 16),
        part(16, 20),
        part(20, 32)
    ))
}

/// Copy `src` to `<inbox_dir>/<uuid>/<sanitised name>`. A symlink, a non-file and anything over
/// `max` bytes is refused, and a refused or failed copy leaves nothing behind.
pub fn copy_to_inbox(src: &Path, inbox_dir: &Path, max: u64) -> Result<InboxItem, InboxError> {
    let meta = fs::symlink_metadata(src)?;
    if !meta.is_file() {
        return Err(InboxError::NotAFile);
    }
    if meta.len() > max {
        return Err(InboxError::TooLarge);
    }
    let name = sanitize_name(
        &src.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    fs::create_dir_all(inbox_dir)?;
    let id = new_id()?;
    let folder = inbox_dir.join(&id);
    fs::create_dir(&folder)?;
    match write_capped(src, &folder.join(&name), max) {
        Ok(size) => Ok(InboxItem { id, name, size }),
        Err(error) => {
            let _ = fs::remove_dir_all(&folder);
            Err(error)
        }
    }
}

fn write_capped(src: &Path, dest: &Path, max: u64) -> Result<u64, InboxError> {
    let source = fs::File::open(src)?;
    let mut target = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)?;
    let copied = io::copy(&mut source.take(max.saturating_add(1)), &mut target)?;
    if copied > max {
        return Err(InboxError::TooLarge);
    }
    Ok(copied)
}

/// Delete inbox entries last changed more than `max_age` before `now`; returns how many went.
/// Symlinks are removed, never followed.
pub fn sweep_inbox(inbox_dir: &Path, max_age: Duration, now: SystemTime) -> usize {
    let Ok(entries) = fs::read_dir(inbox_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if !old {
            continue;
        }
        let gone = if meta.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        removed += usize::from(gone.is_ok());
    }
    removed
}

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Script that queues one received file for the page and wakes its listener.
pub fn open_bundle_script(item: &InboxItem) -> String {
    format!(
        "(function(i){{(window.{OPEN_BUNDLE_QUEUE}=window.{OPEN_BUNDLE_QUEUE}||[]).push(i);\
window.dispatchEvent(new CustomEvent('{OPEN_BUNDLE_EVENT}',{{detail:i}}))}})\
({{id:{},name:{},size:{}}})",
        json_string(&item.id),
        json_string(&item.name),
        item.size
    )
}

/// Received files between the OS and the engine page, each taken once.
#[derive(Debug, Default)]
pub struct BundleSlot {
    pending: Vec<InboxItem>,
    page_ready: bool,
}

impl BundleSlot {
    /// True when the page is loaded and the caller should push `item` now; otherwise it is kept.
    pub fn offer(&mut self, item: InboxItem) -> bool {
        if self.page_ready {
            return true;
        }
        if self.pending.len() == MAX_PENDING {
            self.pending.remove(0);
        }
        self.pending.push(item);
        false
    }

    /// The engine page just loaded: hands over what waited, oldest first, and marks the page ready.
    pub fn take_for_navigation(&mut self) -> Vec<InboxItem> {
        self.page_ready = true;
        std::mem::take(&mut self.pending)
    }

    /// The engine page is going away (a new load or an engine restart); later offers wait again.
    pub fn reset(&mut self) {
        self.page_ready = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "sharecut-open-bundle-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create dir");
            Dir(dir)
        }

        fn file(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
            fs::write(&path, bytes).expect("write");
            path
        }

        fn inbox(&self) -> PathBuf {
            self.0.join("inbox")
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn url_of(path: &Path) -> Url {
        Url::from_file_path(path).expect("file url")
    }

    fn item(name: &str) -> InboxItem {
        InboxItem {
            id: "11111111-1111-4111-8111-111111111111".into(),
            name: name.into(),
            size: 7,
        }
    }

    #[test]
    fn url_accepts_the_bundle_extensions_in_any_case_and_decodes_escapes() {
        let dir = Dir::new("url-ok");
        for name in [
            "My Show/clip.sharecutseg",
            "kit 100%.sharecutkit",
            "name (1).zip",
            "LOUD.SHARECUTSEG",
            "Caf\u{e9}/clip.zip",
        ] {
            let file = dir.file(name, b"x");
            assert_eq!(bundle_from_file_url(&url_of(&file)), Some(file), "{name}");
        }
    }

    #[test]
    fn url_accepts_localhost_and_refuses_other_hosts_and_schemes() {
        let dir = Dir::new("url-hosts");
        let file = dir.file("a.sharecutseg", b"x");
        let text = url_of(&file).to_string();
        let localhost = Url::parse(&text.replacen("file://", "file://localhost", 1)).unwrap();
        assert_eq!(bundle_from_file_url(&localhost), Some(file));
        for case in [
            text.replacen("file://", "file://server", 1),
            "https://example.test/a.sharecutseg".to_string(),
            "sharecut-dev://r/token".to_string(),
        ] {
            assert_eq!(
                bundle_from_file_url(&Url::parse(&case).unwrap()),
                None,
                "{case}"
            );
        }
    }

    #[test]
    fn url_refuses_other_extensions_directories_missing_files_and_control_characters() {
        let dir = Dir::new("url-bad");
        let plain = dir.file("notes.txt", b"x");
        let double = dir.file("a.sharecutseg.bak", b"x");
        let folder = dir.0.join("folder.zip");
        fs::create_dir_all(&folder).unwrap();
        let encoded_nul = url_of(&dir.file("a.zip", b"x"))
            .to_string()
            .replace("a.zip", "a%00b.zip");
        let newline = url_of(&dir.0.join("a.zip"))
            .to_string()
            .replace("a.zip", "a%0Ab.zip");
        for url in [
            url_of(&plain),
            url_of(&double),
            url_of(&folder),
            url_of(&dir.0.join("gone.zip")),
        ] {
            assert_eq!(bundle_from_file_url(&url), None, "{url}");
        }
        for text in [encoded_nul, newline] {
            assert_eq!(
                bundle_from_file_url(&Url::parse(&text).unwrap()),
                None,
                "{text}"
            );
        }
    }

    #[test]
    fn sanitising_keeps_a_plain_name_and_neutralises_the_rest() {
        assert_eq!(sanitize_name("clip.sharecutseg"), "clip.sharecutseg");
        assert_eq!(sanitize_name("My Clip (1).zip"), "My Clip (1).zip");
        assert_eq!(sanitize_name("../../etc/passwd.zip"), "passwd.zip");
        assert_eq!(sanitize_name("a\\b\\c.zip"), "c.zip");
        assert_eq!(sanitize_name("a:b*c?.zip"), "a_b_c_.zip");
        assert_eq!(sanitize_name("tab\there\n.zip"), "tab_here_.zip");
        assert_eq!(sanitize_name("..hidden.zip"), "hidden.zip");
        assert_eq!(
            sanitize_name("Caf\u{e9}.sharecutkit"),
            "Caf\u{e9}.sharecutkit"
        );
    }

    #[test]
    fn sanitising_never_returns_an_empty_or_dot_name() {
        for raw in ["", ".", "..", "   ", "/", ".zip", "a/"] {
            let name = sanitize_name(raw);
            assert!(
                !name.is_empty() && name != "." && name != "..",
                "{raw:?} -> {name:?}"
            );
            assert!(!name.contains('/') && !name.contains('\\'), "{raw:?}");
        }
        assert_eq!(sanitize_name(".."), "bundle");
    }

    #[test]
    fn sanitising_caps_the_length_and_keeps_the_extension() {
        let long = format!("{}.sharecutseg", "\u{e9}".repeat(300));
        let name = sanitize_name(&long);
        assert!(name.len() <= MAX_NAME_BYTES);
        assert!(name.ends_with(".sharecutseg"));
        assert!(name.starts_with('\u{e9}'));
    }

    #[test]
    fn ids_are_lowercase_version_four_uuids_and_differ() {
        let a = new_id().unwrap();
        let b = new_id().unwrap();
        assert_ne!(a, b);
        for id in [a, b] {
            let parts: Vec<&str> = id.split('-').collect();
            assert_eq!(
                parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
                [8, 4, 4, 4, 12]
            );
            assert!(parts[2].starts_with('4'));
            assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
            assert!(id
                .chars()
                .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c)));
        }
    }

    #[test]
    fn copy_puts_the_file_under_a_uuid_folder_with_a_clean_name() {
        let dir = Dir::new("copy");
        let src = dir.file("in/My Clip.sharecutseg", b"PK-bytes");
        let copied = copy_to_inbox(&src, &dir.inbox(), 1024).unwrap();
        assert_eq!(copied.name, "My Clip.sharecutseg");
        assert_eq!(copied.size, 8);
        let stored = dir.inbox().join(&copied.id).join(&copied.name);
        assert_eq!(fs::read(stored).unwrap(), b"PK-bytes");
        assert_eq!(
            fs::read_dir(dir.inbox().join(&copied.id)).unwrap().count(),
            1
        );
        assert_eq!(fs::read(&src).unwrap(), b"PK-bytes");
    }

    #[test]
    fn copy_accepts_exactly_the_cap_and_refuses_one_byte_more_leaving_nothing() {
        let dir = Dir::new("cap");
        let src = dir.file("in/a.zip", b"12345");
        assert_eq!(copy_to_inbox(&src, &dir.inbox(), 5).unwrap().size, 5);
        let before = fs::read_dir(dir.inbox()).unwrap().count();
        assert_eq!(
            copy_to_inbox(&src, &dir.inbox(), 4),
            Err(InboxError::TooLarge)
        );
        assert_eq!(fs::read_dir(dir.inbox()).unwrap().count(), before);
    }

    #[test]
    fn the_cap_holds_while_copying_when_the_size_was_read_too_low() {
        let dir = Dir::new("cap-stream");
        let src = dir.file("in/a.zip", b"123456");
        let folder = dir.inbox().join("x");
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            write_capped(&src, &folder.join("a.zip"), 5),
            Err(InboxError::TooLarge)
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_refuses_a_symlink_and_a_directory() {
        use std::os::unix::fs::symlink;
        let dir = Dir::new("symlink");
        let target = dir.file("real/a.zip", b"x");
        let link = dir.0.join("link.zip");
        symlink(&target, &link).unwrap();
        assert_eq!(
            copy_to_inbox(&link, &dir.inbox(), 1024),
            Err(InboxError::NotAFile)
        );
        let folder = dir.0.join("folder.zip");
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            copy_to_inbox(&folder, &dir.inbox(), 1024),
            Err(InboxError::NotAFile)
        );
        assert!(!dir.inbox().exists());
    }

    #[test]
    fn copy_of_a_missing_file_is_an_io_error() {
        let dir = Dir::new("missing");
        assert!(matches!(
            copy_to_inbox(&dir.0.join("gone.zip"), &dir.inbox(), 1024),
            Err(InboxError::Io(_))
        ));
    }

    #[test]
    fn sweep_removes_only_entries_older_than_the_limit() {
        let dir = Dir::new("sweep");
        let old = dir.file("inbox/old-id/a.zip", b"x");
        let fresh = dir.file("inbox/fresh-id/a.zip", b"x");
        let stray = dir.file("inbox/stray.txt", b"x");
        let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);
        assert_eq!(
            sweep_inbox(&dir.inbox(), INBOX_MAX_AGE, SystemTime::now()),
            0
        );
        assert!(old.exists() && fresh.exists() && stray.exists());
        assert_eq!(sweep_inbox(&dir.inbox(), INBOX_MAX_AGE, later), 3);
        assert!(!dir.inbox().join("old-id").exists());
        assert!(!stray.exists());
        assert!(dir.inbox().exists());
    }

    #[test]
    fn sweep_of_a_missing_folder_does_nothing() {
        let dir = Dir::new("sweep-missing");
        assert_eq!(
            sweep_inbox(&dir.inbox(), Duration::ZERO, SystemTime::now()),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn sweep_removes_a_symlink_without_touching_its_target() {
        use std::os::unix::fs::symlink;
        let dir = Dir::new("sweep-link");
        let outside = dir.file("outside/keep.txt", b"x");
        fs::create_dir_all(dir.inbox()).unwrap();
        symlink(dir.0.join("outside"), dir.inbox().join("link")).unwrap();
        let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);
        assert_eq!(sweep_inbox(&dir.inbox(), INBOX_MAX_AGE, later), 1);
        assert!(outside.exists());
        assert!(!dir.inbox().join("link").exists());
    }

    #[test]
    fn inbox_dir_sits_under_the_temp_dir() {
        assert_eq!(
            inbox_dir(Path::new("/var/tmp")),
            PathBuf::from("/var/tmp/sharecut-inbox")
        );
    }

    #[test]
    fn script_names_the_page_contract_and_embeds_the_item() {
        let script = open_bundle_script(&item("a.sharecutseg"));
        assert!(script.contains("window.__sharecutOpenBundleQueue"));
        assert!(script.contains("'sharecut:open-bundle'"));
        assert!(script.ends_with(
            "({id:\"11111111-1111-4111-8111-111111111111\",name:\"a.sharecutseg\",size:7})"
        ));
    }

    #[test]
    fn script_escapes_quotes_backslashes_controls_and_line_separators() {
        let script = open_bundle_script(&item("a\"b\\c\n\u{2028}.zip"));
        assert!(script.contains("name:\"a\\\"b\\\\c\\u000a\\u2028.zip\""));
        assert!(!script.contains('\n'));
        assert!(!script.contains('\u{2028}'));
    }

    #[test]
    fn slot_keeps_items_in_order_until_the_page_loads_then_hands_them_over_once() {
        let mut slot = BundleSlot::default();
        assert!(!slot.offer(item("a.zip")));
        assert!(!slot.offer(item("b.zip")));
        let names: Vec<_> = slot
            .take_for_navigation()
            .into_iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(names, ["a.zip", "b.zip"]);
        assert!(slot.take_for_navigation().is_empty());
    }

    #[test]
    fn slot_pushes_directly_while_the_page_is_ready_and_waits_again_after_reset() {
        let mut slot = BundleSlot::default();
        slot.take_for_navigation();
        assert!(slot.offer(item("a.zip")));
        assert!(slot.take_for_navigation().is_empty());
        slot.reset();
        assert!(!slot.offer(item("c.zip")));
        assert_eq!(slot.take_for_navigation(), vec![item("c.zip")]);
    }

    #[test]
    fn slot_drops_the_oldest_beyond_its_bound() {
        let mut slot = BundleSlot::default();
        for index in 0..MAX_PENDING + 2 {
            slot.offer(item(&format!("{index}.zip")));
        }
        let names: Vec<_> = slot
            .take_for_navigation()
            .into_iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(names.len(), MAX_PENDING);
        assert_eq!(names[0], "2.zip");
    }
}
