# UX onboarding pack

Shareable UX docs for Podcast MCP / Sharecut Studio, published at **https://ux.sharecut.studio/**.

API & contracts (document commands, share HTTP, remote MCP): **https://docs.sharecut.studio/** ([`docs-site/`](../docs-site/README.md)).

## Live site

**https://ux.sharecut.studio/**

The public UX contents live in this folder. Site deployment is operated
privately; contributors update and verify the contents locally.

| Page | Markdown source |
|------|-----------------|
| Home | [pages/home.md](pages/home.md) |
| Brief | [pages/brief.md](pages/brief.md) |
| Brand | [pages/brand.md](pages/brand.md) |
| See the UI | [pages/demo.md](pages/demo.md) |
| Screens | [pages/screen-inventory.md](pages/screen-inventory.md) |
| Guest journeys | [pages/guest-journeys.md](pages/guest-journeys.md) |
| Glossary | [pages/domain-glossary.md](pages/domain-glossary.md) |
| Keyboard shortcuts | [pages/shortcuts.md](pages/shortcuts.md) (auto from keymap — `make cheatsheet`) |
| Backlog | [pages/ux-backlog.md](pages/ux-backlog.md) |

Remote-agent / share MCP context for UX partners is in [Brief](pages/brief.md) (personas) and [Glossary](pages/domain-glossary.md) (partner terms). Guest chrome: [Screens → Guest / share](pages/screen-inventory.md) + [Guest / record](pages/screen-inventory.md) (lobby + keepers + mix-minus shipped) + [Guest journeys](pages/guest-journeys.md). Engineer depth: [docs/host-online-relay.md](../docs/host-online-relay.md), [docs/session-sync.md](../docs/session-sync.md), [docs/recording-session.md](../docs/recording-session.md). API contracts: [docs.sharecut.studio](https://docs.sharecut.studio/).

Each site view has **Copy Markdown** for pasting into Google Docs / Notion. Mermaid diagrams render on the site; paste the fenced `mermaid` blocks into a Mermaid-aware tool if Docs strips them.

**Shortcuts page:** regenerated from `KEYMAP_COMMANDS` / `COMMANDS` via `make cheatsheet`. Stale output fails `make test-web` / `make cheatsheet-check` and the `keymap-cheatsheet` pre-commit hook.

## Demo project (always-visible UI)

Canonical showcase fixture: [`tests/fixtures/sharecut_ux_demo/`](../tests/fixtures/sharecut_ux_demo/)

- Seeded pending edit, comments, chapters, transcript chips, FX/envelope, social clip
- Audio **symlinked** from `aligned_dialogue/raw` (no duplicate WAVs)
- Regenerate: `make ux-demo` / `python3 scripts/build_ux_demo_fixture.py`
- Open: `podcast gui --project tests/fixtures/sharecut_ux_demo/episode.project.json`
- Site gallery: [See the UI](https://ux.sharecut.studio/#/demo) (`make ux-demo-screens` refreshes PNGs under `assets/screens/`, including guest ReviewApp + Sharecut Studio)

## Local preview

```bash
cd ux && python3 -m http.server 8766
# open http://127.0.0.1:8766/
```

## Keeping docs accurate (anti-drift)

When Sharecut Studio shells, mobile IA docs, share/session-sync/recording-session docs, or the episode schema change in a way that affects what UX partners see:

1. Update the matching `ux/pages/*.md` (and demo fixture / screenshots if the UI changed).
2. Pre-commit hook **`ux-pack-sync`** (`.pre-commit-config.yaml`) fails the commit if trigger paths change without a staged UX pack update.
3. Agents: same rule in [AGENTS.md](../AGENTS.md) and [.agents/rules/engineering-standards.md](../.agents/rules/engineering-standards.md).

Install hooks once per clone (`./install.sh` does this too):

```bash
make hooks
cd gui/web && npm ci   # lint-staged (format-on-commit)
# optional, for schema / UX / capabilities check hooks:
uv tool install pre-commit   # or: pip install pre-commit
```

Rare bypass: `UX_PACK_SKIP=1` or commit message `[skip ux-pack]` (explain why in the PR).

## Edit guidelines

- Keep **partner-facing** copy in product language; put schema paths in the glossary Schema map (or link `docs/*.md`).
- Prefer Mermaid + the demo fixture over one-off mockups.
- Update [pages/ux-backlog.md](pages/ux-backlog.md) when design decisions ship.
