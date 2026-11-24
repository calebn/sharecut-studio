# Owner identity scan

These checks run inside the public-tree secret scan described in [testing.md](testing.md) (`tests/test_secret_scan_workflow.py`).

Three more owner-identity checks run in the same scan; each failure names the file and line and
never echoes the value:

- **Apple Team ID.** A 10-character uppercase alphanumeric token (exactly 10, at least one letter and
  one digit, not glued to more alphanumerics) fails in these contexts: a key, flag or variable whose
  name contains `team` (`teamID`, `TeamIdentifier`, `DEVELOPMENT_TEAM`, `DEV_TEAM`, `APPLE_TEAM`,
  `--team-id X`, fastlane `team_id "X"` / `team_id("X")` / `team:`), including `${A:-${B:-<id>}}`
  defaults and plist `<key>`/`<string>` pairs; a signing identity such as
  `Developer ID Application: Name (<id>)`; `group.<id>`; and `<id>.<tld>.<name>` identifiers
  (`<id>.com.acme.app`; `<id>.app.tar` does not match). Generic `appId`/`app_id` keys are not a
  context. Scanned files: under `config/`, `distribution/`, `scripts/`, `.github/` or any
  `gui/*/src-tauri/` the suffixes `.yml .yaml .json .sh .py .toml .pbxproj .xcconfig .ps1 .rb .swift
  .cfg .ini .mjs .js`; anywhere in the tree `*.plist`, `*.entitlements`, `apple-app-site-association*`
  and `.env*` / `*.env`; and a root `project.yml`. Binary and UTF-16 plists are decoded first (a NUL
  never skips a file). Placeholders (`AAAAAAAAAA`, `TEAMID`, `${{ secrets.X }}`, `{{template}}`) and
  bare 10-character tokens such as hashes never match, and tests and docs are not scanned. A third-party
  id under a `*team*` key with the same shape (a Slack `TEAM_ID`) is a false positive: rename it or
  keep it out of the scanned files. Keep the real Team ID in the private overlay or secrets.
- **Owner container image.** `ghcr.io/<owner>/` fails anywhere in the tree unless the owner is exactly
  `example` (or `example-*`, `example_*`, `example.*`) or is listed in `_UPSTREAM_IMAGE_OWNERS`
  (lowercase key) with a reason. Placeholders such as `ghcr.io/<owner>/` and
  `ghcr.io/${{ github.repository }}` do not match; `examplecorp` fails.
- **Owner host as a test fixture.** `sudo.science` and `cdn.sharecut.studio` fail, case-insensitively and
  on a host boundary (`xsudo.science` does not match), in test sources: anything under a `tests/`,
  `__tests__/` or `e2e/` directory (`.py .rs .ts .tsx .js .jsx .mjs .json .sh`), `test_*`, `*.test.*` and
  `*.spec.*` code files, and Rust only from the first `#[cfg(test)]` line onward (a file with no such
  module is not a test source). Use `*.example.test`. A test that must pin a production URL is listed in
  `_OWNER_HOST_FIXTURE_ALLOWLIST` by (file, host) with a reason; a test asserts every entry still
  matches its file. Limits: host rules do not scan docs, README or schemas, and a Rust file whose test
  module is not trailing is scanned from the marker to the end.
