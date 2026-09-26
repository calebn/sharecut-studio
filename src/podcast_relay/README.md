# podcast-relay

FOSS reverse-tunnel edge for host-online Sharecut Studio sharing.

- **Does:** opaque HTTP/WS proxy from guests to a host that opens a tunnel; rate limits; healthz
- **Does not:** user accounts, billing, episode file storage, Sharecut Studio UI

Protocol: `podcast_relay.protocol` (`PROTOCOL_VERSION`, frame helpers).

Deploy: [`deploy/relay/`](../../deploy/relay/).

Self-host docs: [docs/host-online-relay.md](../../docs/host-online-relay.md) (ops/protocol). Optional account providers install independently and are outside this package.

CLI entry: `podcast-relay` → `podcast_relay.app:main`.

### Public report intake

Set `PODCAST_REPORT_STORE` to a persistent writable directory,
`PODCAST_REPORT_PUBLIC_BASE_URL` to this relay's public HTTPS origin, and
`PODCAST_REPORT_GITHUB_TOKEN` to a server-only issue-writing token. The report
endpoint is disabled until all three are set. The background publisher retries
queued pre-publication reports, holds ambiguous publications for operator review,
and prunes public ZIPs after 30 days. Create the `beta-report` GitHub label before
enabling intake. See
`docs/host-online-relay.md` for caps and consent behavior.
