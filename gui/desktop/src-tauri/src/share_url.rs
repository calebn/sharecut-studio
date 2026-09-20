//! Share deep-link parse/allowlist (no Tauri) and packaged WebView origin checks.
//!
//! Open adapters stay elsewhere: desktop `shell.open`, future mobile in-app guest.

use std::net::{Ipv4Addr, Ipv6Addr};

use url::Url;

use crate::distribution::{ALLOWED_HTTPS_SHARE_ORIGINS, DEEP_LINK_SCHEMES};

// Guest remote-MCP path alias: /r/{token}/mcp
const KNOWN_EXTRA: &[&str] = &["mcp"];

/// Guest share intent parsed from a custom scheme, HTTPS share, or loopback URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareDeepLink {
    pub token: String,
    /// `"r"` (review) or `"rec"` (record).
    pub prefix: &'static str,
    pub extra_path: Option<String>,
    /// Canonical configured HTTPS share URL (+ extra), or the loopback URL in dev-only builds.
    pub canonical_https: String,
    /// Desktop adapter destination: production HTTPS, or the original loopback HTTP URL.
    pub open_url: String,
}

impl ShareDeepLink {
    pub fn canonical_https_string(&self) -> &str {
        &self.canonical_https
    }
}

/// Rejected custom scheme, host, path, or token value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShareDeepLinkError;

/// Parse a share deep link into a guest-review intent.
pub fn parse_share_deep_link(raw: &str) -> Result<ShareDeepLink, ShareDeepLinkError> {
    let url = Url::parse(raw.trim()).map_err(|_| ShareDeepLinkError)?;
    if has_userinfo(&url) {
        return Err(ShareDeepLinkError);
    }
    match url.scheme() {
        scheme if DEEP_LINK_SCHEMES.contains(&scheme) => parse_custom_scheme(&url),
        "https" | "http" => parse_http_share(&url),
        _ => Err(ShareDeepLinkError),
    }
}

/// True when [`parse_share_deep_link`] succeeds.
pub fn is_allowed_share_url(url: &str) -> bool {
    parse_share_deep_link(url).is_ok()
}

fn has_userinfo(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

fn parse_custom_scheme(url: &Url) -> Result<ShareDeepLink, ShareDeepLinkError> {
    let segs = custom_segments(url);
    parse_share_segments(&segs, None, None)
}

fn parse_http_share(url: &Url) -> Result<ShareDeepLink, ShareDeepLinkError> {
    let segs = http_path_segments(url).ok_or(ShareDeepLinkError)?;
    if url.scheme() == "https" {
        return parse_https_share(url, &segs, ALLOWED_HTTPS_SHARE_ORIGINS);
    }
    if url.scheme() != "http" || !is_loopback_url(url) {
        return Err(ShareDeepLinkError);
    }
    parse_share_segments(&segs, Some(url), None)
}

fn parse_https_share(
    url: &Url,
    segs: &[String],
    allowed_origins: &[&str],
) -> Result<ShareDeepLink, ShareDeepLinkError> {
    if url.port().is_some() {
        return Err(ShareDeepLinkError);
    }
    let host = url.host_str().ok_or(ShareDeepLinkError)?;
    let origin = format!("https://{}", host.to_ascii_lowercase());
    if !allowed_origins.contains(&origin.as_str()) {
        return Err(ShareDeepLinkError);
    }
    parse_share_segments(segs, None, Some(&origin))
}

fn parse_share_segments(
    segs: &[String],
    loopback: Option<&Url>,
    canonical_origin: Option<&str>,
) -> Result<ShareDeepLink, ShareDeepLinkError> {
    if segs.len() < 2 {
        return Err(ShareDeepLinkError);
    }
    let prefix: &'static str = match segs[0].as_str() {
        "r" => "r",
        "rec" => "rec",
        _ => return Err(ShareDeepLinkError),
    };
    let token = segs[1].as_str();
    if !is_share_token(token) {
        return Err(ShareDeepLinkError);
    }
    let extra_path = match segs.len() {
        2 => None,
        3 if prefix == "r" && KNOWN_EXTRA.contains(&segs[2].as_str()) => Some(segs[2].clone()),
        _ => return Err(ShareDeepLinkError),
    };
    Ok(build_link(
        prefix,
        token,
        extra_path,
        loopback,
        canonical_origin,
    ))
}

fn build_link(
    prefix: &'static str,
    token: &str,
    extra_path: Option<String>,
    loopback: Option<&Url>,
    canonical_origin: Option<&str>,
) -> ShareDeepLink {
    let base = canonical_origin
        .map(str::to_string)
        .or_else(|| {
            ALLOWED_HTTPS_SHARE_ORIGINS
                .first()
                .copied()
                .map(str::to_string)
        })
        .or_else(|| loopback.map(|url| url.origin().ascii_serialization()))
        .unwrap_or_default();
    let mut canonical_https = format!("{base}/{prefix}/{token}");
    if let Some(extra) = extra_path.as_deref() {
        canonical_https.push('/');
        canonical_https.push_str(extra);
    }
    let open_url = match loopback {
        Some(src) => loopback_open_url(src, prefix, token, extra_path.as_deref()),
        None => canonical_https.clone(),
    };
    ShareDeepLink {
        token: token.to_string(),
        prefix,
        extra_path,
        canonical_https,
        open_url,
    }
}

fn is_loopback_url(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(addr)) => addr == Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(addr)) => addr == Ipv6Addr::LOCALHOST,
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn loopback_open_url(src: &Url, prefix: &str, token: &str, extra: Option<&str>) -> String {
    let mut out = String::from("http://");
    match src.host() {
        Some(url::Host::Ipv6(addr)) => {
            out.push('[');
            out.push_str(&addr.to_string());
            out.push(']');
        }
        Some(url::Host::Ipv4(addr)) => out.push_str(&addr.to_string()),
        Some(url::Host::Domain(d)) => out.push_str(d),
        None => out.push_str("127.0.0.1"),
    }
    if let Some(port) = src.port() {
        out.push(':');
        out.push_str(&port.to_string());
    }
    out.push('/');
    out.push_str(prefix);
    out.push('/');
    out.push_str(token);
    if let Some(extra) = extra {
        out.push('/');
        out.push_str(extra);
    }
    out
}

fn custom_segments(url: &Url) -> Vec<String> {
    let mut segs = Vec::new();
    if let Some(host) = url.host_str() {
        if !host.is_empty() {
            segs.push(host.to_string());
        }
    }
    if let Some(path) = url.path_segments() {
        segs.extend(path.filter(|s| !s.is_empty()).map(ToString::to_string));
    }
    segs
}

fn http_path_segments(url: &Url) -> Option<Vec<String>> {
    Some(
        url.path_segments()?
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .collect(),
    )
}

fn is_share_token(token: &str) -> bool {
    let words = token.split('-').collect::<Vec<_>>();
    words.len() >= 3
        && words
            .iter()
            .all(|word| !word.is_empty() && word.bytes().all(|byte| byte.is_ascii_lowercase()))
}

fn http_url_host_port(url: &str) -> Option<(&str, Option<u16>)> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if authority.is_empty() {
        return None;
    }
    if let Some(end) = authority.strip_prefix('[') {
        let close = end.find(']')?;
        let host = &end[..close];
        let after = &end[close + 1..];
        let port = if let Some(p) = after.strip_prefix(':') {
            Some(p.parse().ok()?)
        } else if after.is_empty() {
            None
        } else {
            return None;
        };
        return Some((host, port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && !host.contains(']') => {
            Some((host, Some(port.parse().ok()?)))
        }
        _ => Some((authority, None)),
    }
}

fn custom_scheme_host<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    let rest = url.strip_prefix(scheme)?;
    Some(rest.split(['/', '?', '#']).next().unwrap_or(rest))
}

fn is_splash_origin(url: &str) -> bool {
    if url == "about:blank" {
        return true;
    }
    if let Some(host) = custom_scheme_host(url, "tauri://") {
        return host.is_empty() || host.eq_ignore_ascii_case("localhost");
    }
    if let Some(host) = custom_scheme_host(url, "asset://") {
        return host.is_empty()
            || host.eq_ignore_ascii_case("localhost")
            || host.eq_ignore_ascii_case("asset.localhost");
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        if let Some((host, _)) = http_url_host_port(url) {
            let host = host.to_ascii_lowercase();
            return host == "asset.localhost" || host == "tauri.localhost";
        }
    }
    false
}

/// Packaged WebView may stay on the splash asset origin or the discovered engine.
pub fn is_allowed_webview_navigation(url: &str, engine_port: Option<u16>) -> bool {
    let u = url.trim();
    if is_splash_origin(u) {
        return true;
    }
    is_discovered_engine_origin(u, engine_port)
}

/// True when `url` is the packaged engine (`http://127.0.0.1:{port}`).
///
/// Splash / `tauri://` / `localhost` / `[::1]` are not engine origins.
fn is_discovered_engine_origin(url: &str, engine_port: Option<u16>) -> bool {
    let Some(port) = engine_port else {
        return false;
    };
    let u = url.trim();
    let Some((host, url_port)) = http_url_host_port(u) else {
        return false;
    };
    u.starts_with("http://") && host == "127.0.0.1" && url_port == Some(port)
}

/// WebView media kinds we distinguish for the loopback microphone allowlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebviewMediaKind {
    Microphone,
    Other,
}

/// Allow / deny decision for a WebView permission request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebviewMediaDecision {
    Allow,
    Deny,
}

/// True when `origin` is the packaged engine (`http://127.0.0.1:{port}`).
///
/// Splash / `tauri://` / `localhost` / `[::1]` are denied — microphone is only
/// for the discovered sidecar origin (same host:port rule as navigation).
pub fn allow_engine_microphone(origin: &str, engine_port: Option<u16>) -> bool {
    is_discovered_engine_origin(origin, engine_port)
}

/// Allow microphone only for the loopback engine origin; deny every other kind.
pub fn decide_webview_media(
    kind: WebviewMediaKind,
    origin: &str,
    engine_port: Option<u16>,
) -> WebviewMediaDecision {
    if kind == WebviewMediaKind::Microphone && allow_engine_microphone(origin, engine_port) {
        WebviewMediaDecision::Allow
    } else {
        WebviewMediaDecision::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_share_links() {
        let link = parse_share_deep_link("https://share.example.test/r/witty-red-rabbit").unwrap();
        assert_eq!(link.token, "witty-red-rabbit");
        assert_eq!(link.prefix, "r");
        assert_eq!(link.extra_path, None);
        assert_eq!(
            link.canonical_https_string(),
            "https://share.example.test/r/witty-red-rabbit"
        );
        assert_eq!(link.open_url, link.canonical_https);
        assert!(is_allowed_share_url(
            "https://share.example.test/r/witty-red-rabbit/"
        ));
        assert!(is_allowed_share_url(
            "https://share.example.test/r/witty-red-rabbit/mcp"
        ));
    }

    #[test]
    fn preserves_the_matched_https_origin_when_multiple_origins_are_allowed() {
        let url = Url::parse("https://second.example.test/r/witty-red-rabbit").unwrap();
        let segs = http_path_segments(&url).unwrap();
        let link = parse_https_share(
            &url,
            &segs,
            &["https://first.example.test", "https://second.example.test"],
        )
        .unwrap();
        assert_eq!(
            link.canonical_https_string(),
            "https://second.example.test/r/witty-red-rabbit"
        );
        assert_eq!(link.open_url, link.canonical_https);
    }

    #[test]
    fn requires_current_coolname_token_shape() {
        assert!(is_allowed_share_url(
            "https://share.example.test/r/bright-blue-whale"
        ));
        assert!(is_allowed_share_url(
            "https://share.example.test/r/spiffy-urchin-of-forgiveness"
        ));
        assert!(!is_allowed_share_url(
            "https://share.example.test/r/AbC_123-xyZ"
        ));
        assert!(!is_allowed_share_url(
            "https://share.example.test/r/two-words"
        ));
        assert!(!is_allowed_share_url(
            "https://share.example.test/r/-leading-words"
        ));
        assert!(!is_allowed_share_url(
            "https://share.example.test/r/trailing-words-"
        ));
        assert!(!is_allowed_share_url("https://share.example.test/r/."));
        assert!(!is_allowed_share_url("https://share.example.test/r/.."));
        assert!(!is_allowed_share_url(
            "https://share.example.test/r/has.dot"
        ));
        assert!(!is_allowed_share_url(
            "https://share.example.test/r/has/slash"
        ));
    }

    #[test]
    fn parses_rec_https() {
        let link =
            parse_share_deep_link("https://share.example.test/rec/witty-red-rabbit").unwrap();
        assert_eq!(link.token, "witty-red-rabbit");
        assert_eq!(link.prefix, "rec");
        assert_eq!(link.extra_path, None);
        assert_eq!(
            link.canonical_https_string(),
            "https://share.example.test/rec/witty-red-rabbit"
        );
    }

    #[test]
    fn parses_configured_rec_scheme() {
        let link = parse_share_deep_link("sharecut-dev://rec/witty-red-rabbit").unwrap();
        assert_eq!(link.prefix, "rec");
        assert_eq!(
            link.open_url,
            "https://share.example.test/rec/witty-red-rabbit"
        );
        assert!(is_allowed_share_url("sharecut-dev:///rec/witty-red-rabbit"));
    }

    #[test]
    fn rejects_unknown_prefix() {
        assert!(!is_allowed_share_url(
            "https://share.example.test/studio/witty-red-rabbit"
        ));
        assert!(!is_allowed_share_url(
            "https://share.example.test/rec/witty-red-rabbit/mcp"
        ));
    }

    #[test]
    fn loopback_preserves_rec_prefix() {
        let link = parse_share_deep_link("http://127.0.0.1:8765/rec/quiet-red-fox").unwrap();
        assert_eq!(link.prefix, "rec");
        assert_eq!(
            link.canonical_https,
            "https://share.example.test/rec/quiet-red-fox"
        );
        assert_eq!(link.open_url, "http://127.0.0.1:8765/rec/quiet-red-fox");
    }

    #[test]
    fn allows_localhost_http() {
        let link = parse_share_deep_link("http://127.0.0.1:8765/r/quiet-red-fox").unwrap();
        assert_eq!(link.token, "quiet-red-fox");
        assert_eq!(
            link.canonical_https,
            "https://share.example.test/r/quiet-red-fox"
        );
        assert_eq!(link.open_url, "http://127.0.0.1:8765/r/quiet-red-fox");
        assert!(is_allowed_share_url(
            "http://localhost:8765/r/quiet-red-fox"
        ));
        assert!(is_allowed_share_url("http://[::1]:8765/r/quiet-red-fox"));
        assert!(!is_allowed_share_url("http://127.0.0.2:8765/r/x"));
        assert!(!is_allowed_share_url("http://127.1.1.1:8765/r/x"));
    }

    #[test]
    fn rejects_prefix_confused_loopback() {
        assert!(!is_allowed_share_url("http://127.0.0.1.evil.example/r/x"));
        assert!(!is_allowed_share_url("http://127.0.0.1:8765.evil.example/"));
    }

    #[test]
    fn prefers_token_shaped_custom_scheme() {
        let link = parse_share_deep_link("sharecut-dev://r/witty-red-rabbit").unwrap();
        assert_eq!(link.token, "witty-red-rabbit");
        assert_eq!(
            link.open_url,
            "https://share.example.test/r/witty-red-rabbit"
        );
        assert!(is_allowed_share_url("sharecut-dev:///r/witty-red-rabbit"));
        assert!(!is_allowed_share_url("dawshell://r/witty-red-rabbit"));
    }

    #[test]
    fn rejects_other_schemes_and_hosts() {
        assert!(!is_allowed_share_url("http://evil.example/"));
        assert!(!is_allowed_share_url("https://sudo.science/r/token"));
        assert!(!is_allowed_share_url("https://example.com/r/x"));
        assert!(!is_allowed_share_url("file:///etc/passwd"));
        assert!(!is_allowed_share_url("javascript:alert(1)"));
        assert!(!is_allowed_share_url("sharecut-dev://open"));
        assert!(!is_allowed_share_url("https://share.example.test/"));
        assert!(!is_allowed_share_url("https://share.example.test/r/"));
        assert!(!is_allowed_share_url("https://www.share.example.test/r/x"));
    }

    #[test]
    fn rejects_parser_attacks() {
        assert!(!is_allowed_share_url(
            "https://share.example.test@evil.example/r/x"
        ));
        assert!(!is_allowed_share_url(
            "https://share.example.test.evil.example/r/x"
        ));
        assert!(!is_allowed_share_url("sharecut-dev://open?url=/r/token"));
        assert!(!is_allowed_share_url(
            "https://share.example.test/r/x/../../../"
        ));
        assert!(!is_allowed_share_url("https://share.example.test:8443/r/x"));
        assert!(!is_allowed_share_url("https://127.0.0.1/r/x"));
    }

    #[test]
    fn webview_allows_splash_without_engine_port() {
        assert!(is_allowed_webview_navigation(
            "https://asset.localhost/index.html",
            None
        ));
        assert!(is_allowed_webview_navigation("tauri://localhost/", None));
        assert!(!is_allowed_webview_navigation(
            "http://127.0.0.1:8765/",
            None
        ));
        assert!(!is_allowed_webview_navigation(
            "https://evil.example/",
            None
        ));
    }

    #[test]
    fn webview_allows_only_discovered_engine_port() {
        assert!(is_allowed_webview_navigation(
            "http://127.0.0.1:54321/",
            Some(54321)
        ));
        assert!(is_allowed_webview_navigation(
            "http://127.0.0.1:54321/daw",
            Some(54321)
        ));
        assert!(!is_allowed_webview_navigation(
            "http://127.0.0.1:8765/",
            Some(54321)
        ));
        assert!(!is_allowed_webview_navigation(
            "http://127.0.0.1.evil.example:54321/",
            Some(54321)
        ));
        assert!(!is_allowed_webview_navigation(
            "file:///etc/passwd",
            Some(54321)
        ));
        assert!(!is_allowed_webview_navigation(
            "javascript:alert(1)",
            Some(54321)
        ));
        assert!(!is_allowed_webview_navigation(
            "http://asset.localhost.evil.example/",
            None
        ));
        assert!(!is_allowed_webview_navigation(
            "https://tauri.localhost.evil.example/",
            None
        ));
        assert!(!is_allowed_webview_navigation(
            "http://localhost:54321/",
            Some(54321)
        ));
        assert!(!is_allowed_webview_navigation(
            "http://[::1]:54321/",
            Some(54321)
        ));
    }

    #[test]
    fn microphone_allows_only_discovered_loopback_engine() {
        assert!(allow_engine_microphone(
            "http://127.0.0.1:54321/",
            Some(54321)
        ));
        assert!(allow_engine_microphone(
            "http://127.0.0.1:54321",
            Some(54321)
        ));
        assert!(allow_engine_microphone(
            "http://127.0.0.1:54321/rec/token",
            Some(54321)
        ));
        assert!(!allow_engine_microphone(
            "http://127.0.0.1:54321/",
            Some(8765)
        ));
        assert!(!allow_engine_microphone("http://127.0.0.1:54321/", None));
        assert!(!allow_engine_microphone(
            "http://localhost:54321/",
            Some(54321)
        ));
        assert!(!allow_engine_microphone("http://[::1]:54321/", Some(54321)));
        assert!(!allow_engine_microphone(
            "https://asset.localhost/index.html",
            Some(54321)
        ));
        assert!(!allow_engine_microphone("tauri://localhost/", Some(54321)));
        assert!(!allow_engine_microphone(
            "http://127.0.0.1.evil.example:54321/",
            Some(54321)
        ));
        assert_eq!(
            decide_webview_media(
                WebviewMediaKind::Microphone,
                "http://127.0.0.1:54321/",
                Some(54321)
            ),
            WebviewMediaDecision::Allow
        );
        assert_eq!(
            decide_webview_media(
                WebviewMediaKind::Other,
                "http://127.0.0.1:54321/",
                Some(54321)
            ),
            WebviewMediaDecision::Deny
        );
        assert_eq!(
            decide_webview_media(
                WebviewMediaKind::Microphone,
                "https://evil.example/",
                Some(54321)
            ),
            WebviewMediaDecision::Deny
        );
    }

    #[test]
    fn tauri_conf_deep_link_schemes_are_allowed() {
        let conf = include_str!("../tauri.conf.json");
        let marker = "\"schemes\"";
        let from = conf
            .find(marker)
            .and_then(|i| conf[i..].find('[').map(|j| i + j))
            .expect("tauri.conf.json plugins.deep-link.desktop.schemes");
        let inner = conf[from + 1..]
            .split(']')
            .next()
            .expect("schemes array close");
        let mut n = 0;
        for part in inner.split(',') {
            let scheme = part.trim().trim_matches('"');
            if scheme.is_empty() {
                continue;
            }
            n += 1;
            assert!(
                is_allowed_share_url(&format!("{scheme}://r/witty-red-rabbit")),
                "scheme {scheme} from tauri.conf.json must parse its configured share URL"
            );
        }
        assert!(n >= 1, "expected at least one deep-link scheme");
        assert!(
            ALLOWED_HTTPS_SHARE_ORIGINS.iter().all(|origin| {
                Url::parse(origin)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_string))
                    .is_some_and(|host| conf.contains(&format!("\"host\": \"{host}\"")))
            }),
            "plugins.deep-link.mobile hosts must match the distribution profile"
        );
        assert!(
            conf.contains("\"infoPlist\": \"Info.plist\""),
            "bundle.macOS.infoPlist must merge src-tauri/Info.plist"
        );
        let plist = include_str!("../Info.plist");
        assert!(
            plist.contains("NSMicrophoneUsageDescription"),
            "Info.plist must declare the microphone usage string"
        );
        assert!(
            !plist.contains("NSCameraUsageDescription"),
            "camera usage stays omitted until video v1"
        );
    }
}
