# Developer docs pack

Shareable API / contract docs for Podcast MCP, published at **https://docs.sharecut.studio/**.

**Local-first:** document-command contract is core Sharecut Studio. **Share HTTP** and
**remote MCP** pages describe surfaces mounted by the built-in FOSS `collaboration`
extension (optional FOSS relay for public URLs).

## Live site

**https://docs.sharecut.studio/**

The public documentation contents live in this folder. Site deployment is
operated privately; contributors update and verify the contents locally.

| Page | Markdown source |
|------|-----------------|
| Home | [pages/home.md](pages/home.md) (alpha banner) |
| Quickstart | [pages/quickstart.md](pages/quickstart.md) |
| Set up local MCP | [pages/mcp-setup.md](pages/mcp-setup.md) |
| Capabilities | [pages/capabilities.md](pages/capabilities.md) (auto from capability manifest — `make schema-export`) |
| Document commands | [pages/document-commands.md](pages/document-commands.md) (auto from schema — `make schema-export`) |
| Share HTTP | [pages/share-http.md](pages/share-http.md) (collaboration extension; routes auto from FastAPI) |
| Remote MCP | [pages/remote-mcp.md](pages/remote-mcp.md) (collaboration extension; tools auto from allowlist) |
| Errors & limits | [pages/errors.md](pages/errors.md) |
| Threat model | [pages/threat-model.md](pages/threat-model.md) |
| Capability schema | [schemas/capabilities.manifest.schema.json](schemas/capabilities.manifest.schema.json) |
| JSON Schema | [schemas/document-commands.schema.json](schemas/document-commands.schema.json) |
| Guest OpenAPI | [schemas/guest-share.openapi.json](schemas/guest-share.openapi.json) |
| Agents | [llms.txt](llms.txt), [.well-known/](.well-known/) |

Engineer depth stays under [`docs/`](../docs/). Product UX pack: [ux.sharecut.studio](https://ux.sharecut.studio/).
Seams: [docs/extensions.md](../docs/extensions.md), [docs/extension-seams.md](../docs/extension-seams.md).

**Generated artifacts:** `make schema-export` refreshes the capabilities catalog, document-command
catalog, share/MCP tables, and guest OpenAPI. Stale output fails `make schema-check` /
`make capabilities-check` / pre-commit / `make ci`.

Public API is **alpha** — no dated changelog yet; pin git SHAs if experimenting.

## Local preview

```bash
cd docs-site && python3 -m http.server 8767
# open http://127.0.0.1:8767/
```

## Keeping the contract accurate

1. Edit `contracts/capabilities.manifest.json` and/or `src/podcast_mcp/services/document_sync/payloads.py` and/or guest routes / `allowlist.py`.
2. Run `make schema-export` (and `make cheatsheet` when keys change).
3. Commit generated `docs-site/` outputs with the code change.
