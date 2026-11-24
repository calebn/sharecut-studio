# podcast-relay

FOSS reverse-tunnel edge for host-online ShareCut Studio sharing.

- **Does:** opaque HTTP/WS proxy from guests to a host that opens a tunnel; rate limits; healthz
- **Does not:** user accounts, billing, episode file storage, ShareCut Studio UI

Protocol: `podcast_mcp.util.relay_protocol.protocol` (`PROTOCOL_VERSION`, frame helpers).

Deploy: [`deploy/relay/`](../../deploy/relay/).

Self-host docs: [docs/host-online-relay.md](../../docs/host-online-relay.md) (ops/protocol). Optional account providers install independently and are outside this package.

CLI entry: `podcast-relay` → `podcast_relay.app:main`.

Layout: `app.py` builds the shared `RelayState` (`state.py`, on `app.state.relay`) and includes one router per concern from `routes/` (`status`, `tunnel`, `proxy`, `guest_ws`) plus the `reports` router. When `PODCAST_RELAY_SIGNING_KEY` is set it also mounts `routes/enroll.py` (`build_enroll_router(policy)`), and `policy.py` holds `RelayPolicy`, the deny file watcher and the env loader; see [Access control](../../docs/host-online-relay.md#access-control). `caps.py` and `usage.py` meter each tunnel (shares, monthly bytes, byte rate, idle time; [Caps](../../docs/host-online-relay.md#caps)), `guest_headers.py` adds the guest page security headers and `notice.py` serves the first-visit notice for legacy-tier hosts. Each `routes/*` module exposes a `build_*_router(state)` factory, so handlers take their state explicitly instead of closing over `create_relay_app`.

### Public report intake

Set `PODCAST_REPORT_STORE` to a persistent writable directory,
`PODCAST_REPORT_PUBLIC_BASE_URL` to this relay's public HTTPS origin, and
`PODCAST_REPORT_GITHUB_TOKEN` to a server-only issue-writing token. The report
endpoint is disabled until all three are set. The background publisher retries
queued pre-publication reports, holds ambiguous publications for operator review,
and prunes public ZIPs after 30 days. Create the `beta-report` GitHub label before
enabling intake. See
`docs/host-online-relay.md` for caps and consent behavior.
