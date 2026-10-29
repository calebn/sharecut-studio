# Episode project format

**Canonical spec:** [episode-format-v2.md](episode-format-v2.md) (version `2.0` only — no backward compatibility yet).

Primary file: `episode.sharecut` in the episode workspace directory.

The file is the same version `2.0` JSON document. `EPISODE_PROJECT_FILENAME` (`src/podcast_mcp/models/episode.py`, mirrored in `gui/web/src/utils/projectFile.ts`) is the source for engine code. The previous name `episode.project.json` has no fallback: opening that file, or a folder that holds it but no `episode.sharecut`, returns the coded error `project_old_filename` from every entry point (Home, `--project`, MCP and the GUI data routes). The fix is to rename the file to `episode.sharecut`.

## Layout

```
my_episode/
├── episode.sharecut
├── raw/                 # Source recordings (never overwritten)
├── transcripts/         # Per-track and combined JSON
├── history/             # Undo/redo snapshots (editable state only)
├── artifacts/           # Renders, waveform pyramids (peaks/*.wfpk), pipeline logs
└── export/              # Final audio (WAV + configured formats), SRT, MD
```

## Key entities

- **tracks** — Logical lanes (`host`, `guest_1`, `music_bed`, `intro`, …)
- **edit_decisions** — Non-destructive cuts (remove ranges with crossfade ms)
- **automation_envelopes** — Volume keyframes per track
- **processing_chains** — FFmpeg effect params per track
- **pipeline_runs** — Step execution history
- **history** — Undo/redo cursor and snapshot index (see [history.md](history.md))

Schema: [schemas/episode.project.schema.json](../schemas/episode.project.schema.json)

## Compatibility boundary

Before the first beta tester build ships, format changes need no migration.
After that delivery, every structural persisted-shape change requires a project
version bump and a tested, one-shot CLI upgrade of every older released fixture.
This includes additive fields and history-only changes. A version bump without
a shape change also requires the upgrade tests. Ordinary loading rejects old
versions. Runtime code keeps no old-format branches.

`scripts/project_compat.py` owns the developer guard. Its generated
`schemas/episode.project.shape.lock.json` records both validation and serialization
schemas, defaults, aliases, constraints, and model unknown-field policies.
Concrete snapshot sections come from the current episode models because
`ProjectStateSnapshot` alone has broad dictionary fields. The guard checks the
snapshot extractor's field coverage. It omits schema titles, descriptions,
examples, and comments. Persisted fields with those names and literal defaults
remain in the lock. The public schema version, model default, and runtime
supported version must agree.

The release ledger is `tests/fixtures/project_compat/releases.json`. It starts
empty. An empty ledger means no released-format compatibility has been tested.
The development workspace is generated coverage of today's format, with a tiny
raw WAV stub. It is never a released fixture or evidence of historical support.

After the first capture, the trusted Git base protects each ledger entry, its
producer metadata, and the complete frozen file inventory. A PR cannot clear the
ledger, remove frozen files, or refresh a released version's lock to bypass the
rule. A newly captured release using the current version must also match the
current shape, including when the base ledger was empty. Missing or unreadable
Git base objects fail the guard. Initial adoption permits a base with neither
lock nor ledger.

## Check or refresh the lock

Use the PR target branch as the trusted base. Before the first delivery, refresh
the lock after a format edit:

```bash
uv run python scripts/project_compat.py lock --base origin/main
uv run python scripts/project_compat.py check --base origin/main
uv run pytest -q --no-cov tests/test_project_compat.py
```

The updater applies the same release policy and replay checks as CI before it
writes. After a release, update the supported version, model default, and public
schema version together. Add the real upgrade command and migration-specific
expected-value tests in the same change as the first break.

The guard validates original canonical/index/current-snapshot agreement before
history adoption can repair it. It validates every indexed snapshot, including
the redo side, and every retained snapshot file outside the index. Each snapshot
is applied to a fresh project copy and saved again. The guard checks all raw
fields, including explicit null and empty values, and the render completion
marker. It also exercises history navigation, undo, and redo through current
runtime readers and writers. Source media remains unchanged.

Existing development project fixtures outside `project_compat` supply only
project save/load checks. Their historical `history: null` value is normalized
to the current empty history for that check. In particular, `ami_bleed_60s`
references three snapshots that are absent from its fixture. It provides no
history compatibility evidence. Complete history is mandatory in the dedicated
corpus; missing files there fail.

## Capture a tester build

Capture a miniature workspace saved by the actual build before delivery. Include
populated editable sections, at least one undo and one redo state, all retained
snapshots, and small source files under `raw/`. Stop edits before capture. Use
non-sensitive source material. Do not fabricate a fixture for an older version
or recreate saved JSON with current models.

Run the capture from the unchanged checkout that produced the build. Its lock
must already be committed and match its runtime models. Record the actual build
identifier or receipt in `--build`, the full producer commit in `--source-commit`,
and the capture time in `--captured-at`:

```bash
uv run python scripts/freeze_project_fixture.py \
	--source /path/to/saved-miniature \
	--id beta-first-tester \
	--build 'actual installer identifier and build receipt' \
	--source-commit "$(git rev-parse HEAD)" \
	--captured-at 'actual UTC capture time'
```

The script copies saved project, history, and raw bytes unchanged. It adds the
producer's shape lock and hashes every file in the frozen directory. It rejects
symlinks and external snapshot references. Copy failures leave no published
fixture. Review and commit the capture and ledger before delivering the build.
The script verifies the producer checkout and records the supplied build receipt;
it cannot attest that a private installer was delivered. Follow the
[tester-delivery checklist](desktop-packaging.md#freeze-the-project-format-before-tester-delivery).

## Upgrade after a real format break

There is no production upgrade command until a real post-delivery break requires
one. The guard already invokes this fixed command for every unsupported released
fixture:

```bash
python -m podcast_mcp.cli.main --no-progress episode upgrade \
	--project /path/to/old/episode.sharecut \
	--output /path/to/new-workspace
```

`--project` names a file called `episode.sharecut`. A workspace saved before the
rename holds `episode.project.json`: rename it first, or the command refuses with
`project_old_filename`. `--output` names a new workspace directory. The command
must publish its current `episode.sharecut`, history index, every retained upgraded snapshot, and
unchanged raw media there. It must leave the source unchanged. The guard first
requires ordinary loading to reject the source version. A missing command,
nonzero exit, absent output, discarded history, changed media, or failed current
replay fails CI. History cursor, entry order, ids, labels, timestamps, operations,
params, and snapshot references must survive; additive index fields are allowed.
An intentional renamed history field needs explicit semantic proof in that
migration change.

Read old JSON directly in a future upgrader. Do not open it through
`ProjectWorkspace` or a normal mutation. Its locking must preserve the existing
in-process then file-lock order; the current commit lock requires a current
`EpisodeProject`. Add a path-based entry only when that real command needs it.

A schema lock and finite fixtures cannot prove semantic compatibility. Validators,
default factories, path behavior, and meaning can change without a schema diff.
Review those changes and add migration-specific expected-value assertions.
Synthetic guard tests prove enforcement plumbing, never a historical upgrade.
