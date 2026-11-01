# Segments

A segment is a reusable piece of audio: an intro, an outro, a sponsor read or a sting. It is the audio, how its clips sit relative to each other, a level, a lane role and a ducking flag, plus an optional chapter title and transcript. The library keeps segments per user, so any episode on this machine can use them. This is issue #1777: slice 1 is the library, its file format, the `.sharecutseg` file and the `podcast segment` commands; slice 2 is Insert, which puts a saved segment on an episode's timeline (see [Insert](#insert)). Saving, listing, exporting and importing change no episode project.

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
| `clips` | `audio` (a file in the segment), `offset_sec` from the segment start, `duration_sec`, `fade_in_ms`, `fade_out_ms`, `join_in_mode` and `lane`. |
| `transcript_words` | Optional words (`text`, `start`, `end`, seconds from the segment start). Capture does not write them yet. |
| `media` | For each audio file, its `sha256` and `bytes`. |

Unknown fields are refused. `content_sha256` is a hash of the sorted media hashes and the layout (everything except id, name and version). It is how an import recognises content it already has.

## Commands

| Command | What it does |
|---|---|
| `podcast segment save -p PROJECT --name NAME [--kind K] (--clips c1,c2 \| --range 0:00-0:22) [--role R] [--json]` | Cut the clips, or every clip overlapping the timeline range (trimmed to it), into the library as FLAC. Offsets count from the earliest selected clip, so a range that starts in silence loses its lead-in. The role and fader come from the first clip's track. A range that cuts a clip in the middle drops the fade and crossfade at the cut. Clips that overlap on one track get separate lanes. Without `--kind`: a selection starting in the first 120 s is an `intro`, one ending in the last 120 s of the timeline an `outro`, else `other`. The audio is each clip's source window with its mute regions and ignored words baked in, as the episode renders them. It is not the full episode render: track gain, the processing chain and the transcript gate are not applied, and clip fades and joins are stored in the layout, not in the audio (an insert applies them). Clips with room-tone fills, off-speaker mutes or bleed restore are refused with `segment_render_unsupported`, because the episode would sound different. Clips under 10 ms are refused with `segment_clip_too_short`. |
| `podcast segment list [--json]` | The newest version of each segment. List reports damage for the newest version of each segment; an older damaged version is not shown. A segment whose newest version is damaged is listed as `DAMAGED` (in `--json`, as `{"id", "version", "damaged": true, "problem", "code"}`), never hidden. |
| `podcast segment show ID [--json]` | Layout, level and versions of one segment. |
| `podcast segment remove ID` | Delete a segment and all its versions, damaged or not. |
| `podcast segment export ID -o FILE` | Write the newest version to a `.sharecutseg` file. |
| `podcast segment import FILE [--json]` | Add a `.sharecutseg` file to the library. |
| `podcast segment insert PROJECT SEGMENT --at SEC [--version N] [--json]` | Insert a segment into an episode (see [Insert](#insert)). |

`save` and `import` print one of `Saved`, `Saved a new version of` or `Already in the library`; with `--json` they print `{"status": "added" | "new_version" | "unchanged", "id", "version"}`. Failures print `Error: <message> (code <code>)` and exit 1.

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

`podcast segment insert PROJECT SEGMENT --at SEC` runs the `InsertSegment` document command (`segment_id`, `version?`, `at`), so the edit is journaled, synced and one undo step like every other timeline edit. It is host only: a share link never reaches the host's library. The code is `services/document/segment_insert.py` (audio copy and the command's service) and `edits/segment_insert.py` (the project edit).

1. The library version is read with its audio hashes checked (`segment_unknown`, `segment_hash_mismatch`). The newest version is used unless `--version` names one.
2. The position must be on the timeline, from 0 to its end inclusive (`segment_position_out_of_range`). A project with no clips accepts 0. A copy that cannot be made or read fails with `segment_write_failed`, audio shorter than the layout says (or a layout longer than a day) with `segment_media_invalid`.
3. Each audio file is copied to a temporary file, its hash is checked on that copy, it is probed, and only then it is renamed to `raw/segment-<full sha256>.flac`. A file changed after the library read it is refused (`segment_hash_mismatch`) and nothing is left behind. A file already at the final name is never trusted, probed or reused: it is replaced by the verified copy. The same audio inserted twice shares one source (`seg_<sha256>`).
4. In one undoable mutation the edit opens the segment's length at `at` with the ripple `insert_gap` and `paste_segment` use (every dialogue track, plus the tracks the segment lands on), moves chapters, review comments and pending edit decisions at or after the point (a comment the point falls inside grows to cover the segment), places the clips and rebuilds the combined transcript. A clip straddling the point is split, as an `insert_gap` does.
5. Each clip carries `segment_ref` (`segment_id`, `version`, `content_sha256` of the version inserted). Nothing reads it yet; a later slice compares it with the library to show drift. A clip split or moved later keeps its `segment_ref`; a copy made by duplicate or paste does not.

**Lanes and tracks.** Lane 0 of a segment whose role is not `dialogue` goes on the project's first track of that role (an intro on the intro track the episode already has), which keeps its own fader. Every other lane, and every dialogue segment, gets a new track named for the segment (`Name`, `Name 2`, ...) with the segment's role and `fader_db`. A new dialogue track has the segment name as its label and speaker, since a sponsor read is not one of the episode's speakers. If a track or speaker already goes by that name (compared ignoring case), the new track is called `Name (segment)` instead, so speaker-keyed edits never merge the segment into a real speaker. The new dialogue track still joins every dialogue ripple.

**What stays put.** Music and sfx tracks the segment does not land on do not ripple (the same scope as `insert_gap`), so a music bed spanning the point stays continuous. The inserted audio has no transcript words, so text-based edits see no words there. Project names, hashes and the copied audio live in the project, which a share guest receives; the library itself and the `InsertSegment` command stay host only.

**What is applied.** The clips' source windows, offsets, fades and join modes. The segment's `chapter_title`, when it has one, becomes a chapter marker at `at`. `duck_under_dialogue` is stored in the library but not applied: the project has no ducking model yet.

Project format: `Clip.segment_ref` is optional and absent from a clip that has none, so existing projects load and save unchanged. Under the [compatibility boundary](project-format.md#compatibility-boundary) the project version stays `2.0` and no upgrade tooling is needed before the first beta build; the shape lock is refreshed.

## Not built yet

- Ducking under dialogue, and detecting that a segment changed since it was inserted (`segment_ref` is recorded for it).
- A Studio, MCP or HTTP surface. Neither the library nor Insert has an MCP tool or a capabilities-manifest entry: an agent could insert by id but has no way to list or save, so the tools wait for a surface that does all three.
- Multi-segment kits (`.sharecutkit`).
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
