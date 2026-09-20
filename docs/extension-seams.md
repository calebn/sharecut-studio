# Extension seams (cross-package interactions)

Living checklist of interactions between `podcast-mcp` (FOSS DAW plus collaboration extension), `podcast-relay` (edge), and an optional independently installed provider extension. Each public seam must have a contract/unit/integration test; e2e sparingly.

| ID | Interaction | Test layer | Status |
|----|-------------|------------|--------|
| A1 | Extension discovery + api_version | unit | `tests/test_extensions.py` |
| A2 | collaboration contributes share routes/MCP/CLI/UI; an installed `online` provider contributes account/auth only | integration | provider distribution test suite |
| A2b | MCP/CLI registrars use host `mcp`/`app` (progress wrap) | unit | progress install + [docs/progress.md](progress.md) |
| A3 | Absent extensions (`PODCAST_EXTENSIONS=`) | unit + guard | `tests/test_extensions.py` (GUI routes, MCP mint, CLI share) |
| A4 | Example community extension | unit | example + test |
| B1 | Host OpenAPI + `/api/features` | integration | `tests/test_extensions.py` |
| B2 | Session/document command schemas | contract | FOSS schemas (existing) |
| B3 | Guest routes only with collaboration | integration | create_app with/without extensions |
| B4 | UI Slot / feature manifest | Vitest | `gui/web/src/extensions/Slot.test.tsx` |
| C1 | Episode schema | contract | `schemas/episode.project.schema.json` |
| C2 | Review mix versions vs shares | integration | existing review tests |
| D1 | Cap enum | contract | `extensions/caps.py` + `contracts/caps.json` |
| D2 | Document allowlist by cap | contract | FOSS schemas and existing tests |
| D3 | Remote MCP cap→tool matrix | contract | FOSS generated catalog and tests |
| E1 | Tunnel protocol frames | contract + unit | `podcast_relay.protocol` |
| E2 | protocol_version | unit | `tests/test_extensions.py` |
| E3 | Proxy path allowlist | contract | `util/proxy_paths.py` |
| G1–G3 | Guest HTTP/WS/object storage | integration | existing share tests (with extension on) |
| H1–H3 | Relay proxy / WS / offline | integration | `tests/test_relay*.py` |

## Locked hole decisions

1. **FOSS share without a provider:** FOSS ships share **mint** + guest ReviewApp/Sharecut Studio + tunnel **client**. Users point the tunnel at **any** self-hosted `podcast-relay` (generic Compose under `deploy/relay`). Provider defaults, accounts, quotas, and branded downloads are outside this repository and are not required to edit or to share.
2. **Tunnel client:** stays in FOSS (`podcast tunnel`) as protocol-only; a provider integration may add its own account or quota workflow.
3. **Guest SPA:** separate `/r/{token}` entry served only when `share.ui.routes` is contributed; host chrome uses Slots.
4. **LAN shares:** no public share URLs in default FOSS path without a relay; LAN bind remains for local Sharecut Studio only.
5. **Hybrid utils:** FOSS keeps `rate_limit` / `body_limits` / local `proxy_media`; object-store provider integration and hosted defaults stay outside the collaboration composer.
6. **Caps:** FOSS exports frozen names (`extensions/caps.py`) and the link-share role→cap policy. An optional provider may add account policy through a narrow hook; it does not replace anonymous link identity.

## Temporary split guards

- `PODCAST_EXTENSIONS=` → no `/api/review`, no share MCP mint tool, no `podcast review share*` CLI, empty `/api/features`.
- `PODCAST_EXTENSIONS=collaboration` → all self-hosted share/record/remote-MCP surfaces and no `online.account`.
- With an installed `online` provider, `PODCAST_EXTENSIONS=collaboration,online` → the same collaboration surfaces exactly once plus provider account/auth.
- With an installed `online` provider, `PODCAST_EXTENSIONS=online` → provider account/auth only; it never implies collaboration.
- FOSS always keeps: Sharecut Studio core routes, `podcast review publish-version|list-versions|set-active`, `podcast tunnel`, document commands.
- Prefer contract/integration over browser e2e for collab seams (nightly e2e budget only).
