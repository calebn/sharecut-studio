# podcast-relay

FOSS reverse-tunnel edge for host-online Sharecut Studio sharing.

- **Does:** opaque HTTP/WS proxy from guests to a host that opens a tunnel; rate limits; healthz
- **Does not:** user accounts, billing, episode file storage, Sharecut Studio UI

Protocol: `podcast_relay.protocol` (`PROTOCOL_VERSION`, frame helpers).

Deploy: [`deploy/relay/`](../../deploy/relay/).

Self-host docs: [docs/host-online-relay.md](../../docs/host-online-relay.md) (ops/protocol). Optional account providers install independently and are outside this package.

CLI entry: `podcast-relay` → `podcast_relay.app:main`.
