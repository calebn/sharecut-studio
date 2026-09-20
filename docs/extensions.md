# Sharecut Studio Extensions API

Public extension SPI for Podcast MCP / Sharecut Studio. Optional features (share, accounts, community tools) load through the same mechanism — **absent = no mount / no MCP tool / no CLI mint / no UI render**.

## Security / trust

Extensions run **in-process** with the GUI and MCP server (full access to the episode project). Only install extensions you trust. Disable all extensions:

```bash
export PODCAST_EXTENSIONS=
podcast gui --project …/episode.project.json
```

Allowlist by entry-point name:

```bash
# FOSS self-hosted sharing
export PODCAST_EXTENSIONS=collaboration

# Independently installed provider plus the same FOSS collaboration surface
export PODCAST_EXTENSIONS=collaboration,online
```

Unset `PODCAST_EXTENSIONS` loads all discovered entry points plus the built-in
`collaboration` and example fallbacks for editable installs. The FOSS wheel
does not contain or register `podcast_online`; a provider build installs its
distribution and `online` entry point independently.
If multiple sources register the same backend name, the loader keeps the first
registration and logs a warning instead of mounting its surfaces twice.

`online` and `collaboration` are independent. A hosted build that needs both
surfaces must name both extensions explicitly.

## Authoring an extension

1. Implement `ExtensionBackend` (`api_version`, `name`, `compatible()`, `contribute(registry)`).
2. Register an entry point under group `podcast_mcp.extensions`.
3. Contribute only known feature IDs (unknown IDs are ignored).
4. MCP/CLI registrars **must** use the host `mcp` / Typer `app` instance passed into the registrar. The host wraps those objects for the shared progress framework ([progress.md](progress.md)); registering on a private `MCPServer()` bypasses progress and `progress-check`.

Example (shipped): [`podcast_mcp.extensions.example`](../src/podcast_mcp/extensions/example.py).

Shipped FOSS collaboration backend:
[`podcast_mcp.extensions.collaboration`](../src/podcast_mcp/extensions/collaboration.py).
It composes existing services and adapters; business logic remains in
`services/` and `edits/`.

The optional provider account/auth backend uses the same SPI and does not own
share minting, guest routes, or remote MCP.

## Feature / slot IDs (stable)

| ID | Purpose |
|----|---------|
| `share.routes` | FastAPI routers (review, record, remote MCP, host `/api/shares`) |
| `share.mcp_tools` | Share mint MCP tools |
| `share.cli` | Share mint CLI (`podcast review share*`, `backup-registry`) |
| `share.ui.menu` | Host Menu → Share… dialog |
| `share.ui.banner` | Guest/host share banner |
| `share.ui.routes` | Guest `/r/{token}` SPA |
| `tunnel.status` | Tunnel indicator |
| `online.account` | Provider account/auth surface |

Experimental: `extension.more.0`, `extension.status.0` (may change in minors).

Removing/renaming a stable slot = FOSS major version. Host API version: `podcast_mcp.extensions.api_version.HOST_API_VERSION`.

## Runtime surfaces

| Plane | Present | Absent |
|-------|---------|--------|
| GUI | Routers/middleware mounted; `GET /api/features` lists ids | Routes never registered |
| MCP | Extension registrars run after core tools | Tools never appear |
| CLI | Share mint commands on `podcast review` | Only FOSS review version cmds |
| UI | `<Slot id="…">` renders children | Slot returns `null` |

## Supported compositions

| `PODCAST_EXTENSIONS` | Result |
|----------------------|--------|
| empty string | Local editor only; no optional collaboration or provider surfaces |
| unset or `collaboration` | FOSS review/record shares, guest SPA, remote MCP, and tunnel status |
| `collaboration,online` | FOSS collaboration plus provider account/auth surfaces |
| `online` | Provider account/auth surfaces only; available only when the provider entry point is installed |

## Marketplace

Out of v1. No store, signing, or sandbox — see freemium split plan.

See also [extension-seams.md](extension-seams.md) for cross-package interaction tests.
