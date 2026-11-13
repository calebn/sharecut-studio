//! Engine helpers shared by the desktop sidecar loop and a later embedded host.
//! No Tauri and no process spawning.

use std::ffi::OsString;
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use crate::share_url::is_allowed_webview_navigation;
use crate::sidecar::read_health_response;

/// Port a `tauri dev` engine listens on when no listen file is in play.
pub const FALLBACK_PORT: u16 = 8765;

const HEALTH_IO_TIMEOUT: Duration = Duration::from_millis(400);
const HEALTH_READ_CAP: usize = 4096;

/// The probe could not connect, configure the socket or send the request.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct ProbeError;

/// GET `/api/health` on `127.0.0.1:{port}`; `Ok(true)` only for HTTP 200 with `"ok": true`.
pub fn probe_health(port: u16, boot_token: Option<&str>) -> Result<bool, ProbeError> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|_| ProbeError)?;
    stream
        .set_read_timeout(Some(HEALTH_IO_TIMEOUT))
        .map_err(|_| ProbeError)?;
    stream
        .set_write_timeout(Some(HEALTH_IO_TIMEOUT))
        .map_err(|_| ProbeError)?;
    // Connection: close helps the failure path finish with EOF after the body;
    // success still returns as soon as the buffer contains HTTP 200 + `"ok": true`.
    let mut req = String::from("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n");
    if let Some(token) = boot_token {
        req.push_str("X-Sharecut-Boot-Token: ");
        req.push_str(token);
        req.push_str("\r\n");
    }
    req.push_str("Connection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|_| ProbeError)?;
    Ok(read_health_response(&mut stream, HEALTH_READ_CAP))
}

/// Splash or the discovered engine; debug builds also allow the `tauri dev` port.
pub fn engine_navigation_allowed(url: &str, engine_port: Option<u16>) -> bool {
    if is_allowed_webview_navigation(url, engine_port) {
        return true;
    }
    cfg!(debug_assertions) && is_allowed_webview_navigation(url, Some(FALLBACK_PORT))
}

/// Variables that put a packaged engine on an ephemeral port behind a boot token.
pub fn engine_environment(
    boot_token: &str,
    listen_file: &Path,
    cdn_base: Option<&str>,
) -> Vec<(&'static str, OsString)> {
    let mut env = vec![
        ("PODCAST_SIDECAR_EPHEMERAL", OsString::from("1")),
        ("PODCAST_SIDECAR_BOOT_TOKEN", OsString::from(boot_token)),
        (
            "PODCAST_SIDECAR_LISTEN_FILE",
            listen_file.as_os_str().to_owned(),
        ),
        ("PODCAST_GUI_OPENAPI", OsString::from("0")),
    ];
    if let Some(base) = cdn_base {
        env.push(("PODCAST_BOOTSTRAP_CDN_BASE", OsString::from(base)));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;

    const OK_BODY: &str = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\": true}";
    const DENIED_BODY: &str = "HTTP/1.0 401 Unauthorized\r\n\r\n{\"detail\":\"denied\"}";

    /// Serve one connection: 200 when the request carries `token`, else 401.
    fn serve_health_once(token: &'static str) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            let mut seen = Vec::new();
            let mut chunk = [0u8; 256];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = conn.read(&mut chunk).expect("read request");
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&chunk[..n]);
            }
            let request = String::from_utf8_lossy(&seen);
            assert!(request.starts_with("GET /api/health HTTP/1.0\r\n"));
            let header = format!("X-Sharecut-Boot-Token: {token}\r\n");
            let reply = if request.contains(&header) {
                OK_BODY
            } else {
                DENIED_BODY
            };
            conn.write_all(reply.as_bytes()).expect("reply");
        });
        (port, handle)
    }

    #[test]
    fn probe_health_is_true_when_the_engine_accepts_the_token() {
        let (port, server) = serve_health_once("abc123");
        assert_eq!(probe_health(port, Some("abc123")), Ok(true));
        server.join().expect("server");
    }

    #[test]
    fn probe_health_is_false_when_the_engine_answers_401() {
        let (port, server) = serve_health_once("abc123");
        assert_eq!(probe_health(port, None), Ok(false));
        server.join().expect("server");
    }

    #[test]
    fn probe_health_errors_when_nothing_listens() {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        assert_eq!(probe_health(port, None), Err(ProbeError));
    }

    #[test]
    fn navigation_allows_splash_and_the_discovered_engine_only() {
        assert!(engine_navigation_allowed(
            "http://127.0.0.1:51234/",
            Some(51234)
        ));
        assert!(!engine_navigation_allowed(
            "http://127.0.0.1:51234/",
            Some(9)
        ));
        assert!(!engine_navigation_allowed(
            "https://example.com/",
            Some(51234)
        ));
        assert!(!engine_navigation_allowed("http://127.0.0.1:51234/", None));
    }

    #[test]
    fn navigation_allows_the_dev_port_only_in_debug_builds() {
        assert_eq!(
            engine_navigation_allowed("http://127.0.0.1:8765/", None),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn engine_environment_lists_ephemeral_bind_token_and_listen_file() {
        let env = engine_environment("tok", &PathBuf::from("/tmp/l.json"), None);
        assert_eq!(
            env,
            vec![
                ("PODCAST_SIDECAR_EPHEMERAL", OsString::from("1")),
                ("PODCAST_SIDECAR_BOOT_TOKEN", OsString::from("tok")),
                ("PODCAST_SIDECAR_LISTEN_FILE", OsString::from("/tmp/l.json")),
                ("PODCAST_GUI_OPENAPI", OsString::from("0")),
            ]
        );
    }

    #[test]
    fn engine_environment_appends_the_cdn_override_last() {
        let env = engine_environment("tok", Path::new("/l"), Some("https://cdn.example.test"));
        assert_eq!(
            env.last(),
            Some(&(
                "PODCAST_BOOTSTRAP_CDN_BASE",
                OsString::from("https://cdn.example.test")
            ))
        );
        assert_eq!(env.len(), 5);
    }
}
