# Compatibility paths

The beta keeps no alias, overload or fallback whose only job is to serve an old
caller (see [AGENTS.md § Beta interfaces](../AGENTS.md#beta-interfaces)). The one
standing exception is a project file that a shipped build wrote, which the
[upgrade rule](beta-plan.md#compatibility) keeps readable. This page lists every
old name, shape or route the docs still mention, what replaced it, and when its
code can go. Add a row in the same change that adds or removes one.

| Path or name | Replaced by | Status | Removal condition |
| --- | --- | --- | --- |
| `PODCAST_EXTENSIONS=online` loading the collaboration surface too | Name both: `collaboration,online` | Removed. `online` alone now loads provider surfaces only ([extensions.md § Supported compositions](extensions.md#supported-compositions)) | Done |
| `spaces:` block in the host runtime config | `object_store:` | Removed. No alias exists in `config/runtime.py`, and an unknown top-level key fails validation | Done |
| `dawshell://` deep-link scheme | The schemes in the distribution profile (`DEEP_LINK_SCHEMES`) | Removed. The desktop link parser rejects it (`share_url.rs` tests) | Done |
| Nested `open?url=` deep links | `<scheme>://r/<token>` and HTTPS share links | Removed. The desktop link parser rejects it (`share_url.rs` tests) | Done |
| Opaque share tokens outside the registry | Coolname slugs in the host registry ([share-tokens.md](share-tokens.md)) | Removed. A token resolves only through the registry | Done |
| `source_span_timeline_bounds` re-exported from `edits/timeline_span.py` | `util/source_spans.source_span_timeline_bounds` | Removed. Callers import `util/source_spans` ([layer-reference.md](layer-reference.md)) | Done |
| Project files at an older version | `load_project` moves them to the current version with the `STEPS` table ([project-format.md § Compatibility boundary](project-format.md#compatibility-boundary)) | Kept. The upgrade rule requires it | Never, for a version a shipped build wrote |
| Older shapes read inside a project: `"history": null` ([history.md](history.md)), applied-edit rows without `timeline_*` ([gui-viewer.md](gui-viewer.md)), publish-only history steps ([history.md](history.md)), timing choices without `media_key` ([episode-format-v2.md](episode-format-v2.md)) | The current fields | Kept. The readers accept both shapes | Move into a `STEPS` migration, or delete with its fixtures when no shipped build wrote the old shape |
| Export config with no `formats` list ([pipeline.md](pipeline.md)), and export results without `applied_settings` ([gui-integration.md](gui-integration.md)) | `formats` entries, and `applied_settings` when evidence exists | Kept. A config with no `formats` writes one MP3 at `mp3_bitrate_kbps`, and readers treat `applied_settings` as optional | A change that makes `formats` required |
| MCP clients that cancel with a separate `notifications/cancelled` POST ([mcp-setup.md](mcp-setup.md)) | Cancel by closing the original POST | Not provided. #151 tracks it, outside the beta | Not applicable |
