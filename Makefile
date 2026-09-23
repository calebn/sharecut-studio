.PHONY: setup doctor hooks worktree-setup test test-fast test-quick test-e2e test-e2e-slow test-e2e-real test-web test-web-e2e test-desktop desktop-build desktop-linux-appimage-docker ci typecheck lint-py format-py format-py-check install ux-demo ux-demo-screens cheatsheet cheatsheet-check schema-export schema-check capabilities-check progress-check golden-ear

setup:
	./install.sh

# lint-staged formats staged Ruff/Biome files on commit, then check-only pre-commit.
hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit

# Idempotent per-checkout/worktree provisioning: hooks + venv (CI extras) + gui/web node_modules.
# The pre-commit hook runs this automatically in an unprovisioned worktree.
worktree-setup:
	sh scripts/worktree-setup.sh

doctor:
	uv run podcast doctor 2>/dev/null || .venv/bin/podcast doctor 2>/dev/null || podcast doctor

# Full coverage gate, parallelized across CPU cores (pytest-cov merges worker data).
# Matches CI: keep fast e2e for coverage; exclude HF/nightly e2e_slow and e2e_real.
# Use `uv run` only — `cmd || fallback` would treat coverage failures as "tool missing".
test:
	uv run pytest -n auto -m "not e2e_slow and not e2e_real"
	uv run coverage report --fail-under=95

# Fast inner-loop: parallel, no coverage, skips e2e/slow tiers. Use during development.
test-fast:
	uv run pytest -n auto --no-cov -m "not e2e and not slow" -q 2>/dev/null || .venv/bin/pytest -n auto --no-cov -m "not e2e and not slow" -q 2>/dev/null || pytest -n auto --no-cov -m "not e2e and not slow" -q

test-quick:
	uv run pytest --no-cov -q 2>/dev/null || .venv/bin/pytest --no-cov -q 2>/dev/null || pytest --no-cov -q

e2e:
	uv run pytest -m e2e --no-cov -q 2>/dev/null || .venv/bin/pytest -m e2e --no-cov -q 2>/dev/null || pytest -m e2e --no-cov -q

e2e-slow:
	uv run pytest -m "e2e and e2e_slow" --no-cov -q 2>/dev/null || .venv/bin/pytest -m "e2e and e2e_slow" --no-cov -q 2>/dev/null || pytest -m "e2e and e2e_slow" --no-cov -q

e2e-real:
	uv run pytest -m e2e_real --no-cov -q 2>/dev/null || .venv/bin/pytest -m e2e_real --no-cov -q 2>/dev/null || pytest -m e2e_real --no-cov -q

# Sharecut Studio frontend: oxlint + Stylelint + Biome format check + typecheck +
# vitest (component axe) + production build. Mirrors CI `frontend` job.
test-web:
	cd gui/web && npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npx vite-node scripts/generate-keymap-cheatsheet.ts --check

# Sharecut Studio Playwright smoke + full-page axe gate against aligned_dialogue
# (requires `[gui]` extra + Chromium). Mirrors CI `frontend-e2e` job.
test-web-e2e:
	cd gui/web && npm ci && npm run build && npx playwright install chromium && npm run test:e2e

# Tauri host: scaffold verify + rustfmt + clippy --lib --no-default-features +
# cargo test --lib --no-default-features (no GTK/WebKit). Mirrors path-filtered
# CI `desktop` → desktop-scaffold (needs rustup + rustfmt/clippy).
# Not part of `make ci` — desktop workflow is path-filtered and Rust is optional for Python-only work.
test-desktop:
	./scripts/check_desktop.sh

# Optional full installer build (needs platform WebView deps). Not CI.
# macOS signs+notarizes when APPLE_* env vars are set (see docs/desktop-packaging.md).
desktop-build:
	./scripts/build_desktop.sh

# Unsigned Linux AppImage in Ubuntu 22.04 Docker (iterate before GHA).
desktop-linux-appimage-docker:
	./scripts/build_linux_appimage_docker.sh

# Optional local mirror of required GitHub CI: Python quality + coverage +
# Sharecut Studio unit/a11y + Playwright axe. GitHub Actions remains the gate
# for public pushes and pull requests.
.PHONY: ci-body
ci:
	@$(MAKE) --no-print-directory ci-body

ci-body: lint-py format-py-check typecheck schema-check capabilities-check progress-check test test-web test-web-e2e

# Regenerate docs/daw-shortcuts.md + ux/pages/shortcuts.md from KEYMAP_COMMANDS.
cheatsheet:
	cd gui/web && npx vite-node scripts/generate-keymap-cheatsheet.ts

cheatsheet-check:
	cd gui/web && npx vite-node scripts/generate-keymap-cheatsheet.ts --check

# Capability manifest ↔ COMMANDS / keymap / MCP / skills (+ docs catalog stale check).
capabilities-check:
	uv run python scripts/check_capabilities_manifest.py
	uv run python scripts/export_capabilities_docs.py --check
	uv run python scripts/export_capabilities_copy.py --check

# Progress framework compliance (warn by default; PODCAST_PROGRESS_COMPLIANCE=error to hard-fail).
progress-check:
	uv run python scripts/check_progress.py

# Document-command JSON Schema + docs-site catalog / guest OpenAPI from code.
schema-export:
	uv run python scripts/export_document_command_schema.py
	uv run python scripts/export_docs_site_contract.py
	uv run python scripts/export_capabilities_docs.py
	uv run python scripts/export_capabilities_copy.py
	uv run python scripts/export_timeline_zoom.py

schema-check:
	uv run python scripts/export_document_command_schema.py --check
	uv run python scripts/export_docs_site_contract.py --check
	uv run python scripts/export_capabilities_docs.py --check
	uv run python scripts/export_capabilities_copy.py --check
	uv run python scripts/export_timeline_zoom.py --check

# Static type checks; timebase-critical modules run strict (see [tool.mypy]).
typecheck:
	uv run mypy 2>/dev/null || .venv/bin/mypy 2>/dev/null || mypy

# Python quality: Ruff lint, Bandit (medium+), Vulture, Deptry. Mirrors CI pytest job.
# Use `uv run` only — `cmd || fallback` would treat lint failures as "tool missing".
lint-py:
	uv run ruff check src tests scripts
	uv run bandit -c pyproject.toml -r src -ll
	uv run vulture
	uv run deptry .

format-py:
	uv run ruff format src tests scripts

format-py-check:
	uv run ruff format --check src tests scripts

install:
	uv sync --all-extras 2>/dev/null || .venv/bin/pip install -e ".[dev]" 2>/dev/null || pip install -e ".[dev]"

# Blind A/B golden-ear harness (leave-in vs edit). Example:
#   make golden-ear ARGS='build --project tests/fixtures/aligned_dialogue --out /tmp/golden --limit 8'
#   make golden-ear ARGS='score --dir /tmp/golden --answers listen/answers.csv'
# Untrusted args: uv run python scripts/golden_ear_harness.py …
golden-ear:
	uv run python scripts/golden_ear_harness.py $(ARGS)

# Rebuild UX showcase fixture (symlinked audio from aligned_dialogue).
ux-demo:
	uv run python scripts/build_ux_demo_fixture.py

# Capture Sharecut Studio screenshots into ux/assets/screens for the UX site.
# Uses port 8777 by default so a local :8766 GUI does not block Playwright.
# Prepares guest share tokens, captures host + guest PNGs, restores fixture JSON.
ux-demo-screens: ux-demo
	@rm -f /tmp/podcast_ux_demo_shares.sqlite /tmp/podcast_ux_demo_shares.sqlite-wal /tmp/podcast_ux_demo_shares.sqlite-shm
	PODCAST_SHARE_REGISTRY=/tmp/podcast_ux_demo_shares.sqlite \
		uv run python scripts/ux_demo_prepare_shares.py --base-url http://127.0.0.1:$(or $(DAW_E2E_PORT),8777)
	cd gui/web && npm run build && \
		PODCAST_SHARE_REGISTRY=/tmp/podcast_ux_demo_shares.sqlite \
		DAW_E2E_PORT=$(or $(DAW_E2E_PORT),8777) \
		UX_DEMO_SCREENSHOTS=1 \
		npx playwright test e2e/ux-demo-screenshots.spec.ts
	git checkout -- tests/fixtures/sharecut_ux_demo/episode.project.json
	@rm -f ux/assets/screens/.guest-tokens.json
