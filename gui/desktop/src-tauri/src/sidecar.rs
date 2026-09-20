//! Sidecar binary lookup next to the Tauri exe (no WebView / process spawn).

#[path = "../../../../scripts/sidecar_shared.rs"]
mod sidecar_shared;

use std::path::{Path, PathBuf};

pub use sidecar_shared::{
    apply_create_no_window, open_sidecar_log, sidecar_listen_path, sidecar_log_path,
};

/// Filenames to try beside the host executable (Windows first).
pub fn sidecar_file_names(windows: bool) -> &'static [&'static str] {
    if windows {
        &[
            "sharecut-sidecar.exe",
            "sharecut-sidecar.cmd",
            "sharecut-sidecar",
        ]
    } else {
        &["sharecut-sidecar"]
    }
}

/// First existing sidecar path in `exe_dir`, if any.
pub fn bundled_sidecar_path(exe_dir: &Path, windows: bool) -> Option<PathBuf> {
    sidecar_file_names(windows)
        .iter()
        .map(|name| exe_dir.join(name))
        .find(|path| path.exists())
}

/// FastAPI `/api/health` JSON body must report `"ok": true` (not bare HTTP 200).
pub fn health_body_ok(buf: &str) -> bool {
    let body = match buf.rsplit_once("\r\n\r\n") {
        Some((_, b)) => b,
        None => match buf.rsplit_once("\n\n") {
            Some((_, b)) => b,
            None => buf,
        },
    };
    let trimmed = body.trim();
    trimmed.contains("\"ok\": true") || trimmed.contains("\"ok\":true")
}

/// Read an HTTP health response until `"ok": true` appears, EOF, cap, or timeout.
///
/// Uvicorn often sends headers and the tiny JSON body in separate TCP segments on
/// Windows localhost; a single `read()` then sees only headers and looks unhealthy.
pub fn read_health_response(stream: &mut impl std::io::Read, cap: usize) -> bool {
    let mut buf = Vec::with_capacity(cap.min(512));
    let mut tmp = [0u8; 512];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                let take = n.min(cap.saturating_sub(buf.len()));
                buf.extend_from_slice(&tmp[..take]);
                if health_http_ok(&String::from_utf8_lossy(&buf)) {
                    return true;
                }
                if buf.len() >= cap {
                    break;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break;
            }
            Err(_) => return false,
        }
    }
    health_http_ok(&String::from_utf8_lossy(&buf))
}

/// HTTP 200 plus JSON ``"ok": true`` (reject 401 bodies that lack ok).
pub fn health_http_ok(buf: &str) -> bool {
    let status = buf.lines().next().unwrap_or("").trim_end_matches('\r');
    let code_ok = status.contains(" 200 ") || status.ends_with(" 200");
    code_ok && health_body_ok(buf)
}

fn json_u64_field(obj: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let i = obj.find(&needle)?;
    let after = obj[i + needle.len()..].trim_start().strip_prefix(':')?;
    let digits: String = after
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Parse sidecar listen JSON ``{"port":N,"pid":N}``.
pub fn parse_listen_json(text: &str) -> Option<(u16, u32)> {
    let text = text.trim();
    let port = json_u64_field(text, "port")?;
    let pid = json_u64_field(text, "pid")?;
    if port == 0 || port > u64::from(u16::MAX) || pid == 0 || pid > u64::from(u32::MAX) {
        return None;
    }
    Some((port as u16, pid as u32))
}

/// Walk ``parent_of`` from ``owner`` until ``sidecar`` (Windows launcher→Python).
pub fn pid_is_sidecar_or_descendant(
    owner: u32,
    sidecar: u32,
    parent_of: &dyn Fn(u32) -> Option<u32>,
) -> bool {
    let mut cur = owner;
    for _ in 0..32 {
        if cur == sidecar {
            return true;
        }
        match parent_of(cur) {
            Some(p) if p != 0 && p != cur => cur = p,
            _ => return false,
        }
    }
    false
}

#[cfg(any(target_os = "linux", test))]
fn parse_proc_net_tcp_listen_inodes(table: &str, port: u16) -> Vec<u64> {
    let want = format!("0100007F:{port:04X}");
    let want_lc = format!("0100007F:{port:04x}");
    let mut inodes = Vec::new();
    for (i, line) in table.lines().enumerate() {
        if i == 0 {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 10 {
            continue;
        }
        let local = cols[1];
        let st = cols[3];
        if st != "0A" && st != "0a" {
            continue;
        }
        if local.eq_ignore_ascii_case(&want) || local.eq_ignore_ascii_case(&want_lc) {
            if let Ok(inode) = cols[9].parse::<u64>() {
                inodes.push(inode);
            }
        }
    }
    inodes
}

#[cfg(any(target_os = "linux", test))]
fn fd_link_is_socket_inode(target: &str, inodes: &[u64]) -> bool {
    let Some(rest) = target.strip_prefix("socket:[") else {
        return false;
    };
    let Some(num) = rest.strip_suffix(']') else {
        return false;
    };
    num.parse::<u64>().ok().is_some_and(|n| inodes.contains(&n))
}

#[cfg(any(windows, test))]
fn mib_tcp_row_port(local_port: u32) -> u16 {
    u16::from_be((local_port & 0xFFFF) as u16)
}

#[cfg(any(windows, test))]
fn tcp_owner_table_row_count(
    buf_len: usize,
    claimed_rows: u32,
    header_len: usize,
    row_len: usize,
) -> usize {
    if row_len == 0 || buf_len <= header_len {
        return 0;
    }
    let max = (buf_len - header_len) / row_len;
    (claimed_rows as usize).min(max)
}

#[cfg(target_os = "linux")]
fn pid_owns_loopback_listen(port: u16, pid: u32) -> bool {
    let table = std::fs::read_to_string("/proc/net/tcp").unwrap_or_default();
    let inodes = parse_proc_net_tcp_listen_inodes(&table, port);
    if inodes.is_empty() {
        return false;
    }
    let fd_dir = PathBuf::from(format!("/proc/{pid}/fd"));
    let Ok(fds) = std::fs::read_dir(fd_dir) else {
        return false;
    };
    for fd in fds.flatten() {
        let Ok(target) = std::fs::read_link(fd.path()) else {
            continue;
        };
        if fd_link_is_socket_inode(target.to_str().unwrap_or(""), &inodes) {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn command_output_deadline(
    program: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Instant;

    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

#[cfg(target_os = "macos")]
fn pid_owns_loopback_listen(port: u16, pid: u32) -> bool {
    let pid_s = pid.to_string();
    let spec = format!("-iTCP:{port}");
    let out = command_output_deadline(
        "lsof",
        &["-nP", "-a", "-p", &pid_s, &spec, "-sTCP:LISTEN", "-t"],
        std::time::Duration::from_millis(250),
    );
    let Some(out) = out else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|line| line.trim() == pid_s)
}

#[cfg(windows)]
fn pid_owns_loopback_listen(port: u16, pid: u32) -> bool {
    windows_tcp_listener_pids(port).contains(&pid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn pid_owns_loopback_listen(_port: u16, _pid: u32) -> bool {
    false
}

#[cfg(windows)]
fn windows_tcp_listener_pids(port: u16) -> Vec<u32> {
    use std::mem::size_of;

    #[repr(C)]
    struct Row {
        _state: u32,
        local_addr: u32,
        local_port: u32,
        _remote_addr: u32,
        _remote_port: u32,
        owning_pid: u32,
    }
    #[repr(C)]
    struct Table {
        num: u32,
        _rows: [Row; 1],
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            table: *mut core::ffi::c_void,
            size: *mut u32,
            order: i32,
            af: u32,
            class: u32,
            reserved: u32,
        ) -> u32;
    }

    const AF_INET: u32 = 2;
    const TCP_TABLE_OWNER_PID_LISTENER: u32 = 3;
    const LOOPBACK: u32 = 0x0100_007F;
    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    unsafe {
        let mut size: u32 = 0;
        let mut buf = Vec::new();
        for _ in 0..4 {
            let ptr = if buf.is_empty() {
                core::ptr::null_mut()
            } else {
                buf.as_mut_ptr() as *mut core::ffi::c_void
            };
            let rc =
                GetExtendedTcpTable(ptr, &mut size, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
            if rc == ERROR_INSUFFICIENT_BUFFER {
                if size == 0 {
                    return Vec::new();
                }
                buf.resize(size as usize, 0);
                continue;
            }
            if rc != NO_ERROR || buf.is_empty() {
                return Vec::new();
            }
            break;
        }
        if buf.is_empty() {
            return Vec::new();
        }
        let table = buf.as_ptr() as *const Table;
        let header = size_of::<u32>();
        let row_size = size_of::<Row>();
        let n = tcp_owner_table_row_count(buf.len(), (*table).num, header, row_size);
        let rows = (table as *const u8).add(header);
        let mut pids = Vec::new();
        for i in 0..n {
            let row = &*(rows.add(i * row_size) as *const Row);
            if row.local_addr == LOOPBACK && mib_tcp_row_port(row.local_port) == port {
                pids.push(row.owning_pid);
            }
        }
        pids
    }
}

#[cfg(target_os = "linux")]
fn os_parent_pid(pid: u32) -> Option<u32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm may contain spaces/parens; parent is the 4th field after ") ".
    let after = text.rsplit_once(") ")?.1;
    let mut parts = after.split_whitespace();
    let _state = parts.next()?;
    parts.next()?.parse().ok()
}

#[cfg(target_os = "macos")]
fn os_parent_pid(pid: u32) -> Option<u32> {
    let pid_s = pid.to_string();
    let out = command_output_deadline(
        "ps",
        &["-o", "ppid=", "-p", &pid_s],
        std::time::Duration::from_millis(250),
    )?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(windows)]
fn os_parent_pid(pid: u32) -> Option<u32> {
    windows_parent_pid(pid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn os_parent_pid(_pid: u32) -> Option<u32> {
    None
}

#[cfg(windows)]
fn windows_parent_pid(pid: u32) -> Option<u32> {
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        _cnt_usage: u32,
        process_id: u32,
        _default_heap: usize,
        _module_id: u32,
        _threads: u32,
        parent_pid: u32,
        _pri_class_base: i32,
        _flags: u32,
        _exe: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut core::ffi::c_void;
        fn Process32FirstW(snap: *mut core::ffi::c_void, pe: *mut ProcessEntry) -> i32;
        fn Process32NextW(snap: *mut core::ffi::c_void, pe: *mut ProcessEntry) -> i32;
        fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
    }

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const INVALID: isize = -1;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap as isize == INVALID {
            return None;
        }
        let mut pe: ProcessEntry = std::mem::zeroed();
        pe.size = std::mem::size_of::<ProcessEntry>() as u32;
        let mut found = None;
        if Process32FirstW(snap, &mut pe) != 0 {
            loop {
                if pe.process_id == pid {
                    found = Some(pe.parent_pid);
                    break;
                }
                if Process32NextW(snap, &mut pe) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// Listen-file PID must be the sidecar (or its child) and own ``127.0.0.1:port``.
pub fn sidecar_owns_listen(port: u16, sidecar_pid: u32, listen_pid: u32) -> bool {
    pid_is_sidecar_or_descendant(listen_pid, sidecar_pid, &os_parent_pid)
        && pid_owns_loopback_listen(port, listen_pid)
}

pub fn random_boot_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    fill_random(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(unix)]
fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(alg: *mut core::ffi::c_void, buf: *mut u8, len: u32, flags: u32) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x2;
    let rc = unsafe {
        BCryptGenRandom(
            core::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err("BCryptGenRandom failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("sharecut-sidecar-test-{nanos}"));
        fs::create_dir_all(&dir).expect("temp sidecar dir");
        dir
    }

    #[test]
    fn windows_lists_exe_before_cmd() {
        let names = sidecar_file_names(true);
        assert_eq!(names[0], "sharecut-sidecar.exe");
        assert!(names.contains(&"sharecut-sidecar.cmd"));
        assert!(names.contains(&"sharecut-sidecar"));
    }

    #[test]
    fn unix_uses_bare_name() {
        assert_eq!(sidecar_file_names(false), &["sharecut-sidecar"]);
    }

    #[test]
    fn picks_exe_when_present() {
        let dir = scratch_dir();
        let exe = dir.join("sharecut-sidecar.exe");
        fs::write(&exe, b"").expect("touch exe");
        fs::write(dir.join("sharecut-sidecar.cmd"), b"").expect("touch cmd");
        assert_eq!(
            bundled_sidecar_path(&dir, true).as_deref(),
            Some(exe.as_path())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn picks_cmd_when_exe_missing() {
        let dir = scratch_dir();
        let cmd = dir.join("sharecut-sidecar.cmd");
        fs::write(&cmd, b"").expect("touch cmd");
        assert_eq!(
            bundled_sidecar_path(&dir, true).as_deref(),
            Some(cmd.as_path())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn none_when_missing() {
        let dir = scratch_dir();
        assert_eq!(bundled_sidecar_path(&dir, true), None);
        assert_eq!(bundled_sidecar_path(&dir, false), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn health_body_ok_requires_json_ok() {
        assert!(health_body_ok("HTTP/1.0 200 OK\r\n\r\n{\"ok\": true}"));
        assert!(health_body_ok("HTTP/1.0 200 OK\r\n\r\n{\"ok\":true}"));
        assert!(!health_body_ok(
            "HTTP/1.0 200 OK\r\n\r\n{\"status\":\"ok\"}"
        ));
        assert!(!health_body_ok("HTTP/1.0 200 OK\r\n\r\nok"));
        assert!(!health_body_ok("connection refused"));
    }

    #[derive(Clone, Copy)]
    enum HealthReadStep {
        Data(&'static [u8]),
        Err(std::io::ErrorKind),
    }

    struct ScriptedReader {
        steps: Vec<HealthReadStep>,
        idx: usize,
    }

    impl std::io::Read for ScriptedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.idx >= self.steps.len() {
                return Ok(0);
            }
            match self.steps[self.idx] {
                HealthReadStep::Data(part) => {
                    self.idx += 1;
                    let n = part.len().min(buf.len());
                    buf[..n].copy_from_slice(&part[..n]);
                    Ok(n)
                }
                HealthReadStep::Err(kind) => {
                    self.idx += 1;
                    Err(std::io::Error::from(kind))
                }
            }
        }
    }

    const HEALTH_HEADERS: &[u8] =
        b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\ncontent-type: application/json\r\n\r\n";
    const HEALTH_OK_BODY: &[u8] = b"{\"ok\":true}";

    #[test]
    fn read_health_response_joins_split_tcp_segments() {
        // Matches observed Windows localhost uvicorn: headers, then body.
        let mut split = ScriptedReader {
            steps: vec![
                HealthReadStep::Data(HEALTH_HEADERS),
                HealthReadStep::Data(HEALTH_OK_BODY),
            ],
            idx: 0,
        };
        assert!(read_health_response(&mut split, 4096));
        let mut headers_only = ScriptedReader {
            steps: vec![HealthReadStep::Data(HEALTH_HEADERS)],
            idx: 0,
        };
        assert!(!read_health_response(&mut headers_only, 4096));
    }

    #[test]
    fn read_health_response_timeout_after_headers_is_unhealthy() {
        let mut timed_out = ScriptedReader {
            steps: vec![
                HealthReadStep::Data(HEALTH_HEADERS),
                HealthReadStep::Err(std::io::ErrorKind::TimedOut),
            ],
            idx: 0,
        };
        assert!(!read_health_response(&mut timed_out, 4096));
    }

    #[test]
    fn read_health_response_retries_interrupted_then_joins_body() {
        let mut interrupted = ScriptedReader {
            steps: vec![
                HealthReadStep::Data(HEALTH_HEADERS),
                HealthReadStep::Err(std::io::ErrorKind::Interrupted),
                HealthReadStep::Data(HEALTH_OK_BODY),
            ],
            idx: 0,
        };
        assert!(read_health_response(&mut interrupted, 4096));
    }

    #[test]
    fn read_health_response_stops_at_cap_without_ok() {
        let mut junk = ScriptedReader {
            steps: vec![HealthReadStep::Data(b"aaaaaaaaaaaaaaaaaaaa")],
            idx: 0,
        };
        assert!(!read_health_response(&mut junk, 8));
    }

    #[test]
    fn health_http_ok_requires_200_and_json() {
        assert!(health_http_ok("HTTP/1.0 200 OK\r\n\r\n{\"ok\": true}"));
        assert!(!health_http_ok(
            "HTTP/1.0 401 Unauthorized\r\n\r\n{\"ok\": true}"
        ));
        assert!(!health_http_ok("HTTP/1.0 200 OK\r\n\r\n{\"ok\": false}"));
    }

    #[test]
    fn parse_listen_json_reads_port_and_pid() {
        assert_eq!(
            parse_listen_json("{\"port\":54321,\"pid\":99}\n"),
            Some((54321, 99))
        );
        assert_eq!(parse_listen_json("{\"port\":0,\"pid\":1}"), None);
        assert_eq!(parse_listen_json("not json"), None);
    }

    #[test]
    fn pid_descendant_walks_parents() {
        let parent = |pid: u32| match pid {
            50 => Some(20),
            20 => Some(10),
            10 => Some(1),
            _ => None,
        };
        assert!(pid_is_sidecar_or_descendant(50, 10, &parent));
        assert!(pid_is_sidecar_or_descendant(10, 10, &parent));
        assert!(!pid_is_sidecar_or_descendant(50, 99, &parent));
    }

    #[test]
    fn proc_net_tcp_listen_inode_matches_loopback_port() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11111 1 0000000000000000 0 0 0 10 -1\n";
        assert_eq!(parse_proc_net_tcp_listen_inodes(table, 8765), vec![11111]);
        assert!(parse_proc_net_tcp_listen_inodes(table, 80).is_empty());
    }

    #[test]
    fn fd_link_matches_socket_inode() {
        assert!(fd_link_is_socket_inode("socket:[11111]", &[11111, 2]));
        assert!(!fd_link_is_socket_inode("socket:[9]", &[11111]));
        assert!(!fd_link_is_socket_inode("/dev/null", &[1]));
    }

    #[test]
    fn mib_tcp_row_port_decodes_network_order_low_word() {
        assert_eq!(mib_tcp_row_port(0x0000_3D22), 8765);
        assert_ne!(mib_tcp_row_port(u32::from(8765u16).to_be()), 8765);
    }

    #[test]
    fn tcp_owner_table_row_count_clamps_to_buffer() {
        assert_eq!(tcp_owner_table_row_count(4 + 20, 100, 4, 20), 1);
        assert_eq!(tcp_owner_table_row_count(4, 1, 4, 20), 0);
    }

    #[test]
    fn sidecar_listen_path_is_per_process() {
        let name = sidecar_listen_path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with("sidecar.listen."));
        assert!(name.ends_with(".json"));
        assert_ne!(name, "sidecar.listen.json");
        assert!(name.contains(&std::process::id().to_string()));
    }

    #[test]
    fn random_boot_token_is_64_hex() {
        let token = random_boot_token().expect("rng");
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
