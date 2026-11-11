# Segments

A segment is a reusable piece of audio: an intro, an outro, a sponsor read or a sting. It is the audio, how its clips sit relative to each other, a level, a lane role and a ducking flag, plus an optional chapter title and transcript. The library keeps segments per user, so any episode on this machine can use them. This is issue #1777: slice 1 is the library, its file format, the `.sharecutseg` file and the `podcast segment` commands; slice 2 is Insert, which puts a saved segment on an episode's timeline (see [Insert](#insert)); slice 3 is the headless surface: the host MCP tools, `--at start|end` and `--dry-run` on insert, and a `podcast doctor` check (see [Host MCP tools](#host-mcp-tools)); slice 4 is the show kit, a saved list of segments that an episode applies in one step (see [Show kit](#show-kit)). Saving, listing, exporting and importing change no episode project.

## Copy, not link

Saving a segment copies the audio out of the episode. Moving or deleting the episode never breaks the segment, and editing the segment later never touches the episode.

## Where it lives

`PODCAST_CONFIG_DIR/segments/` (default `~/.config/podcast_mcp/segments/`):

```
segments/
  .segments.lock
  warm-intro-1a2b3c4d/
    v1/segment.json, clip-01.flac
    v2/segment.json, clip-01.flac
```

The id is the name's ASCII slug plus eight hex digits of the exact name's sha256. One name always has one id. Each version is staged in a hidden folder and lands by one rename under the library lock, so a reader never sees half a version and two writers never lose each other's.

## `segment.json`

| Field | Meaning |
|---|---|
| `schema_version` | `1`. Any other value is refused with `segment_schema_unsupported`. |
| `id`, `name`, `version` | Identity. `version` starts at 1 and the store assigns it. |
| `kind` | `intro`, `outro`, `sponsor`, `sting` or `other`. |
| `role` | The lane role (`dialogue`, `music`, `sfx`, `intro`, `outro`). |
| `fader_db` | Level of the lane. |
| `duck_under_dialogue` | Whether the lane lowers under speech. Capture sets it to false. |
| `chapter_title` | Optional chapter marker text. |
| `clips` | `audio` (a file in the segment), `offset_sec` from the segment start, `duration_sec`, `fade_in_ms`, `fade_out_ms`, `join_in_mode` and `lane`. A saved segment keeps no fade curve: capture drops a clip's `fade_in_curve` / `fade_out_curve` and an insert creates linear fades (a documented limitation; storing them is a segment schema change). |
| `transcript_words` | Optional words (`text`, `start`, `end`, seconds from the segment start). Capture does not write them yet. |
| `media` | For each audio file, its `sha256` and `bytes`. |

Unknown fields are refused. `content_sha256` is a hash of the sorted media hashes and the layout (everything except id, name and version). It is how an import recognises content it already has.

## Commands

| Command | What it does |
|---|---|
| `podcast segment save -p PROJECT --name NAME [--kind K] (--clips c1,c2 \| --range 0:00-0:22) [--role R] [--json]` | Cut the clips, or every clip overlapping the timeline range (trimmed to it), into the library as FLAC. Offsets count from the earliest selected clip, so a range that starts in silence loses its lead-in. The role and fader come from the first clip's track. A range that cuts a clip in the middle drops the fade and crossfade at the cut. Clips that overlap on one track get separate lanes. Without `--kind`: a selection starting in the first 120 s is an `intro`, one ending in the last 120 s of the timeline an `outro`, else `other`. The audio is each clip's source window with its mute regions, ignored words and clip gain baked in, as the episode renders them. It is not the full episode render: track gain, the processing chain and the transcript gate are not applied, and clip fades and joins are stored in the layout, not in the audio (an insert applies them). Clips with room-tone fills, off-speaker mutes or bleed restore are refused with `segment_render_unsupported`, because the episode would sound different. Clips under 10 ms are refused with `segment_clip_too_short`. |
| `podcast segment list [--deep] [--json]` | The newest version of each segment. Checks the manifest and audio file presence and size without reading audio content. `--deep` also verifies audio hashes and detects same-size content changes. Damage found by these checks is listed as `DAMAGED` (in `--json`, as `{"id", "version", "damaged": true, "problem", "code"}`), never hidden. Older versions are not checked. |
| `podcast segment show ID [--json]` | Layout, level and versions of one segment. |
| `podcast segment remove ID` | Delete a segment and all its versions, damaged or not. |
| `podcast segment export ID -o FILE` | Write the newest version to a `.sharecutseg` file. |
| `podcast segment import FILE [--json]` | Add a `.sharecutseg` file to the library. |
| `podcast segment insert PROJECT SEGMENT --at start\|end\|SEC [--version N] [--dry-run] [--json]` | Insert a segment into an episode (see [Insert](#insert)). `--dry-run` reports what would move and changes nothing. |

`save` and `import` print one of `Saved`, `Saved a new version of` or `Already in the library`; with `--json` they print `{"status": "added" | "new_version" | "unchanged", "id", "version"}`. Failures print `Error: <message> (code <code>)` and exit 1.

The list command uses the same cheap checks with text and JSON output. `show`, import, export and insert still verify audio hashes. The host MCP `segment_list_tool` also verifies audio hashes.

## Conflict rules

- The same content as an intact stored version (same `content_sha256`, audio matching its hashes) is `unchanged`: nothing is written and the existing id and version are returned, even when the incoming file has another name. A stored version whose audio is damaged does not count: importing or saving the segment again lands as the next version and repairs the library (`segment remove` clears it for good).
- Re-importing older content after a newer version exists is `unchanged` too: any intact stored version with the same content counts, and the newer version stays the newest. The same content under a new name returns the existing id, not a new segment.
- The same name with different content is the next version. The id stays, and an earlier version is never overwritten.
- A different name with different content is a new segment at version 1.

## The `.sharecutseg` file

A zip of `segment.json`, the audio files and `MANIFEST.sha256` (`<sha256>  <name>` per other file). One segment per file. An import checks, before anything reaches the library:

- at most 64 entries and 2 GiB unpacked (checked against the headers and again while reading), 1 GiB per file, `segment.json` at most 1 MiB, the manifest at most 64 KiB, and no file compressed more than 100:1 once it is over 1 MiB;
- every entry name is a plain file name: no directories, no absolute path, no `..`, no symlinks, no repeats (names are compared ignoring case);
- the manifest lists exactly the files in the zip, and `segment.json` names exactly the audio files;
- every hash matches, and the schema version is known.

Errors: `segment_bundle_invalid` (bad zip, names, sizes or manifest), `segment_bundle_unsupported`, `segment_hash_mismatch`, `segment_schema_unsupported`, `segment_invalid` (`segment.json` is not valid or not a segment), `segment_busy` (the library lock is held), `segment_unreadable` (a file in the library cannot be read), `segment_unknown` (no such segment or version) and `segment_write_failed` (disk or permission errors). The manifest detects corruption, not forgery: anyone can repack a zip and recompute it, so an import is an integrity check, not a trust decision, and nothing is signed. Reading a stored segment (`get`, `show`, `export`) checks the audio hashes again and raises `segment_hash_mismatch` for a file that was changed or removed; `list` reports such a segment as damaged.

## Insert

`podcast segment insert PROJECT SEGMENT --at start|end|SEC` runs the `InsertSegment` document command (`segment_id`, `version?`, `at`), so the edit is journaled, synced and one undo step like every other timeline edit. It is host only: a share link never reaches the host's library. The code is `services/document/segment_insert.py` (audio copy and the command's service) and `edits/segment_insert.py` (the project edit).

1. The library version is read with its audio hashes checked (`segment_unknown`, `segment_hash_mismatch`). The newest version is used unless `--version` names one.
2. `--at` is `start` (0), `end` or a number of seconds, read by one parser (`segments/position.py`) for the CLI, the MCP tool and the command payload: the words ignore case and spaces, and anything else (`soon`, `1_0`, `0x10`, `nan`, `inf`, a bool) is `segment_position_out_of_range`. `end` travels in the command as the word and is resolved to the timeline end inside the document lock, so an edit saved a moment earlier is not split; a dry run resolves it the same way. The CLI and MCP always send the resolved `version` (an int), so the journal names the audio that went in; a replay inserts that version, not whichever is newest. A `--version` below 1 is `segment_version_invalid` on both paths. The `at` the journal keeps is the word `end` when `end` was asked; the result holds the second it became. The position must be on the timeline, from 0 to its end inclusive (`segment_position_out_of_range`). A project with no clips accepts 0. A copy that cannot be made or read fails with `segment_write_failed`, audio shorter than the layout says (or a layout longer than a day) with `segment_media_invalid`.
3. Each audio file is copied to a temporary file, its hash is checked on that copy, it is probed, and only then it is renamed to `raw/segment-<full sha256>.flac`. A file changed after the library read it is refused (`segment_hash_mismatch`) and nothing is left behind. A file already at the final name is never trusted, probed or reused: it is replaced by the verified copy. The same audio inserted twice shares one source (`seg_<sha256>`).
4. In one undoable mutation the edit opens the segment's length at `at` with the ripple `insert_gap` and `paste_segment` use (every dialogue track, plus the tracks the segment lands on), moves chapters, review comments and pending edit decisions at or after the point (a comment the point falls inside grows to cover the segment), places the clips and rebuilds the combined transcript. A clip straddling the point is split, as an `insert_gap` does.
5. Each clip carries `segment_ref` (`segment_id`, `version`, `content_sha256` of the version inserted). Nothing reads it yet; a later slice compares it with the library to show drift. A clip split or moved later keeps its `segment_ref`; a copy made by duplicate or paste does not.

**Lanes and tracks.** Lane 0 of a segment whose role is not `dialogue` goes on the project's first track of that role (an intro on the intro track the episode already has), which keeps its own fader. Every other lane, and every dialogue segment, gets a new track named for the segment (`Name`, `Name 2`, ...) with the segment's role and `fader_db`. A new dialogue track has the segment name as its label and speaker, since a sponsor read is not one of the episode's speakers. If a track or speaker already goes by that name (compared ignoring case), the new track is called `Name (segment)` instead, so speaker-keyed edits never merge the segment into a real speaker. The new dialogue track still joins every dialogue ripple.

**What stays put.** Music and sfx tracks the segment does not land on do not ripple (the same scope as `insert_gap`), so a music bed spanning the point stays continuous. The inserted audio has no transcript words, so text-based edits see no words there. Project names, hashes and the copied audio live in the project, which a share guest receives; the library itself and the `InsertSegment` command stay host only.

**What is applied.** The clips' source windows, offsets, fades and join modes. The segment's `chapter_title`, when it has one, becomes a chapter marker at `at`. `duck_under_dialogue` is stored in the library but not applied: the project has no ducking model yet.

Project format: `Clip.segment_ref` is optional and absent from a clip that has none, so existing projects load and save unchanged. Under the [compatibility boundary](project-format.md#compatibility-boundary) the project version stays `2.0` and no upgrade tooling is needed before the first beta build; the shape lock is refreshed.

## Host MCP tools

Four tools mirror the CLI for a host agent: `segment_list_tool`, `segment_show_tool`, `segment_save_tool` (`clip_ids` or `time_range`, plus `name`, `kind`, `role`) and `segment_insert_tool` (`project_path`, `segment_id`, `at` as `"start"`, `"end"` or seconds, `version`, `dry_run`). They live in `mcp/tools/segments.py` and use the same services as the CLI, so errors carry the same codes. They are host only: the guest share MCP has an explicit tool allowlist and none of these is on it, and `InsertSegment` stays out of every share role's document commands (`tests/test_segments_insert.py` covers both).

`segment_insert_tool` submits `InsertSegment` on the document plane as `mcp:host`, so the edit is journaled, reaches an open Studio tab and is one undo step. It is applied, not held as a pending proposal: pending proposals in this codebase are `EditDecision` records of type remove, mute or split, which the host approves or rejects, and an insert that opens time and adds tracks and sources has no such record. Call it with `dry_run=true` first. The report holds `timeline_duration_before_sec` and `timeline_duration_after_sec`, `clips_moved`, `clips_added` (split halves included), `chapters_moved`, `chapter_added`, `comments_moved`, `pending_edits_moved`, `tracks_added` and the lane to track map. It is computed on a copy of the project with the library audio hash-checked and probed in place (read-only), so a file shorter than its layout is refused as the real insert refuses it (`segment_media_invalid`), and nothing is written, journaled or added to `raw/`. The project is read where it is: a workspace still under its retired entry-file name (see `project-format.md`) is not renamed by a dry run, `segment_save_tool` or `podcast segment save`. The real insert result carries `dry_run: false`. A `time_range` such as `0:00-1:15` takes minutes and seconds below 60 and at most 24 hours (`segment_range_invalid`).

## Show kit

A kit is an ordered list of library segments with where each goes, for example an intro at the start and an outro at the end. A new episode applies it in one command. The kit is offered, never applied by itself: nothing in the app applies a kit unless someone runs `kit apply` or calls `kit_apply_tool`. Inserting at `start` ripples later audio, as every insert does.

**Where it lives.** `PODCAST_CONFIG_DIR/kits/` (default `~/.config/podcast_mcp/kits/`), beside the segment library, with the same conventions: `<id>/v<N>/kit.json`, an id that is the name's slug plus eight hex digits of the exact name's sha256, a version assigned by the store, a version staged in a hidden folder and landed by one rename under `.kits.lock`. The same name with other entries is the next version; entries equal to the newest version are `unchanged`. Only the newest version counts, because it is the one `kit apply` uses: saving an older list again is a new version, not a report of the old one. An earlier version is never overwritten. A name is at most 200 characters and a note 500. A kit holds no audio, only segment ids.

**`kit.json`.**

| Field | Meaning |
|---|---|
| `schema_version` | `1`. Any other value is refused with `kit_schema_unsupported`. |
| `id`, `name`, `version` | Identity, as for a segment. |
| `entries` | 1 to 32, in the order they are applied. Each: `segment_id`, `version` (a whole number pins that segment version; `null` means the newest when the kit is applied), `at` (`start`, `end` or seconds, read by `segments/position.py` like `--at`, never negative) and an optional `note`. |

Unknown fields are refused (`kit_invalid`). The content hash covers the entries only, so a rename is a new kit (a new id), the same as for segments.

**Commands.**

| Command | What it does |
|---|---|
| `podcast kit save NAME -s SEGMENT[@VERSION][:AT] ... [--json]` | Save a kit. `AT` is `start` (the default), `end` or a second. Every segment, and every pinned version, must be in the library (`kit_segment_missing` names each one that is not). |
| `podcast kit list [--json]` | The newest version of each kit, with how many of its segments are missing from the library. A kit whose newest version cannot be read is listed `DAMAGED`. |
| `podcast kit show ID [--json]` | The entries in order, with whether each segment is present. |
| `podcast kit remove ID` | Delete a kit and all its versions. Its segments stay. |
| `podcast kit export ID -o FILE` | Write the newest version and the segment versions it uses to a `.sharecutkit` file. |
| `podcast kit import FILE [--on-conflict skip\|new-version] [--json]` | Add the file's missing segments and its kit to the library. |
| `podcast kit apply ID PROJECT [--dry-run] [--json]` | Apply every entry to an episode (see below). |

**`.sharecutkit`.** A zip of `kit.json`, `MANIFEST.sha256` and, for each segment version the kit uses, that segment's `segment.json` and audio as flat entries named `segNN__<file>` (a segment version used by two entries is stored once; the issue's "segments plus the layout" is `kit.json`). Each segment id and version pair has exactly one bundled member, even when two members have identical content. Repeated kit entries can reference that shared member. An import refuses a duplicate pair with `kit_bundle_invalid` before audio unpacking or library writes. An import runs the `.sharecutseg` checks, with the cap raised from 64 to 290 files (`kit.json`, the manifest and 32 segments of a `segment.json` and up to 8 audio files each; more than that per segment is refused) and the compression-ratio check applied from 64 KiB instead of 1 MiB: plain entry names only (the only shape is `kit.json`, the manifest or `segNN__name`), no repeats ignoring case, no symlinks, sizes against the headers and while reading, 2 GiB unpacked, `kit.json` and each `segment.json` at most 1 MiB, no file over 100:1 compression once it is over 1 MiB, a manifest that lists exactly the files, every hash matching, each segment folder holding exactly the audio its `segment.json` names, and every kit entry naming a segment (and version) that is in the file. The order is: headers; then `kit.json`, the manifest and every `segment.json` are read straight from the zip and checked against each other (hashes, the kit id against its name, each segment id against its name, each segment's files against the audio it names, every kit entry against a bundled segment, and every bundled segment against a kit entry, so a file cannot carry segments the kit does not name); only then is audio unpacked, with a budget of the declared sizes, and hashed. These archive-admission checks finish before library writes. A later per-segment validation or library failure can leave earlier segments added. Errors: `kit_bundle_invalid`, `kit_hash_mismatch`, `kit_schema_unsupported`, `kit_invalid` (`kit.json` is not a kit), `kit_write_failed` and `kit_busy` (a segment-library lock or write failure during import is said in these), plus `kit_unknown`, `kit_unreadable`, `kit_name_invalid`, `kit_segment_missing` and `kit_on_conflict_invalid`. Like `.sharecutseg`, the manifest is an integrity check, not a signature.

**Import.** Each segment goes through the library's own dedupe (`added`, `unchanged` or `new_version`; the same audio under another name returns the existing id). A pinned `version` in the file is rewritten to the version the segment has in this library, because version numbers belong to a library. The kit is then stored under `--on-conflict`: `new-version` (the default) stores it as the next version when a kit of that id has other entries, `skip` leaves the existing kit as it is and reports `skipped`; the file's segments are still added, since they never overwrite anything. Importing the same file again changes nothing (every status is `unchanged`).

**Apply.** `podcast kit apply ID PROJECT` (and `kit_apply_tool`) first refuses, before anything is written: an unknown kit (`kit_unknown`); every entry whose segment or pinned version is not in the library, all named in one `kit_segment_missing` message; a segment whose audio changed (`segment_hash_mismatch`); and any refusal the whole kit meets when it is run on a copy of the project (`segment_position_out_of_range`, `segment_media_invalid`; the message says which entry and that nothing was changed). The copy does not run the document service's own write path, so that is not a guarantee against a failure of the write itself. Then each entry is an `InsertSegment` document command, in order, as `podcast segment insert` sends it, each with the version it resolved to. `start` and `end` are read when that entry runs, so `end` is the end of the timeline after the earlier entries have rippled (an intro at `start` and an outro at `end` on an 8 s episode with a 2 s intro and 2 s outro lands the outro at 10 s, ending at 12 s). Seconds are read the same way, on the timeline as the earlier entries left it. The result lists every entry's insert, the duration before and after, and `undo_steps`.

**Undo.** There is no compound document command, so a kit is one undo step per entry: undoing a three-entry kit takes three undos. A compound command would need a new payload, share-role handling and generated schemas for little gain at this size; it is listed under [Not built yet](#not-built-yet). A failure of the write itself after the first entry (a full disk, `project_write_failed`, a lock timeout, a document conflict) stops the apply with the same code and a message that names the entry (`Kit entry 2 of 3 (...) failed: ...`) and says how many earlier entries were applied; those stay applied, each its own undo step. Retrying the whole kit would insert them again, so undo them first or apply the rest by hand with `segment insert`. There is no resume argument yet.

An uncoded file failure during an entry stops the apply with `kit_apply_failed`. The message names the entry and counts earlier calls that completed. The failing entry may already have changed the episode, even when no earlier entries completed. Check the episode and History before retrying the kit; retrying can insert entries again. Raw filesystem diagnostics and paths are not included in this message.

**`--dry-run`.** Runs the same chain on a copy, entry by entry, so each report accounts for the ripples of the entries before it, and writes nothing: no journal row, no history step, no audio in `raw/`, and a project still under its retired entry-file name is not renamed. The project is read with `ProjectWorkspace.open(adopt=False)`.

**Host MCP tools.** `kit_list_tool`, `kit_show_tool`, `kit_save_tool` (`name`, `entries` as `{segment_id, at, version?, note?}`) and `kit_apply_tool` (`project_path`, `kit_id`, `dry_run`) call the same functions as the CLI (`segments/kit_summary.py`, `submit_kit_apply` in `services/document/kit_apply.py`), so the codes are the same, including for `kit save` input: one parser (`segments/kit_summary.py`) turns `ID[@VERSION][:AT]` on the CLI and `{segment_id, at, version?, note?}` in the tool into an entry, and a version that is not a whole number from 1 is `segment_version_invalid` on both. `note` is set through the tool only; the CLI has no flag for it. `submit_kit_apply` lives in `services/document/kit_apply.py`. They are host only: none is on the guest allowlist, and `InsertSegment` stays out of every share role's commands.

**Doctor.** `podcast doctor` warns for each kit (newest version) whose segments are missing from the library, naming up to five of them, and for a kit that cannot be read. It reads only `kit.json` files and segment folder names, so it stays cheap, and a segment that is present but damaged is reported by the segment check above, not by the kit line (`kit apply` refuses it with `segment_unreadable` or `segment_hash_mismatch`); the fix line says to import the segments or the kit's `.sharecutkit` file again.

## Doctor

`podcast doctor` checks the newest version of each segment in the library by looking at `segment.json` and each audio file's presence and size, without reading the audio, so the support bundle (which runs the same checks) stays cheap. `podcast doctor --deep` also hashes the audio. It prints a `[warn]` line for each damaged segment (at most five, then a count of the rest). The fix line is the same text `podcast segment list` prints: import the segment again, which stores a new version and keeps the older ones; `podcast segment remove ID` is named only when the segment has no older version, because it deletes every version. A segment removed while doctor runs is left out. An absent or intact library prints nothing. A damaged segment does not fail doctor. Older versions are not checked.

## Not built yet

- Ducking under dialogue, and detecting that a segment changed since it was inserted (`segment_ref` is recorded for it).
- A Studio or HTTP surface, and a capabilities-manifest entry for the library.
- A Studio or HTTP surface for kits (the offer to apply a kit to a new episode) and a compound document command that makes a whole kit one undo step.
- `podcast segment export ID... -o FILE.sharecutkit` and `segment import FILE.sharecutkit` (the kit commands do this, see the kit section above).
- Capturing a transcript or a chapter title.
- Setting `duck_under_dialogue` or `chapter_title` (no command writes them yet).
- Per-clip gain and mute-region data beyond what is rendered into the audio.

## Decisions

Settled with slice 2, each with its reason.

- **Name-derived id stays.** No rename operation exists, so a rename is deliberately a new segment, and `segment_ref` also holds the content hash, so a later slice can relink by content.
- **`schema_version` stays `Literal[1]` with unknown fields refused; a new field is schema 2 on purpose.** Beta has no libraries worth carrying, and a reserved extensions object would hide format changes from older builds. `content_sha256` is now pinned by a golden-hash test, so a field that changes every stored hash fails a test instead of passing unseen.
- **One role and one fader per segment.** Capture collapses a mixed selection to its first clip's track and Insert maps lanes by that role; a per-lane table is a schema 2 change when capture can write one.
- **No sample rate or channel count in `segment.json`.** Insert probes the copied file anyway to build its source, so declaring them would only add a second truth.
- **Trust is integrity only, with no signature.** Segments move between people as files the user chooses to import; a signature needs a key story that does not exist yet. Insert re-checks the hash on its own copy.
- **`capture.py` moved to `services/document/segment_capture.py`.** It imports engines and the workspace service, and `services/` is where the new Insert code lives.
- **Dedupe compares FLAC bytes and stays that way.** A different ffmpeg build making a new version is harmless, since each version has its own content hash and a `segment_ref` points at one version.
- **A kit names segments, it does not contain them.** The library stays the one home of audio, so editing a segment (a new version) reaches every kit that names it by id, and a pinned `version` is the way to freeze one. A bundle copies the audio in so a kit travels on its own.
- **Kit conflicts mirror segment versions.** There is no overwrite: the same name with other entries is the next version, and `--on-conflict skip` exists for the person who wants their own list kept.
- **One undo step per entry.** A compound `ApplyKit` document command was weighed and left out: it would add a payload, a capability row, share-role tests and generated schemas, and the per-entry steps are each journaled, visible in History and individually undoable.
