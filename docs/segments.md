# Segments

A segment is a reusable piece of audio: an intro, an outro, a sponsor read or a sting. It is the audio, how its clips sit relative to each other, a level, a lane role and a ducking flag, plus an optional chapter title and transcript. The library keeps segments per user, so any episode on this machine can use them. This is slice 1 of issue #1777: the library, its file format, the `.sharecutseg` file and the `podcast segment` commands. Nothing here changes an episode project.

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

## Not built yet

- Using a segment in an episode (inserting it on the timeline, ducking, the chapter marker). Slice 1 has no Studio, MCP or HTTP surface.
- Multi-segment kits (`.sharecutkit`).
- Capturing a transcript or a chapter title.
- Setting `duck_under_dialogue` or `chapter_title` (no command writes them yet).
- Per-clip gain and mute-region data beyond what is rendered into the audio.

## Open design points for the owner

Found in review and left as they are for slice 1. Each is cheap now and costly once testers hold libraries:

- The id is derived from the name (slug plus a hash of the exact name), so a rename is a new segment and an episode cannot refer to a segment across a rename. An opaque id minted on first save would fix that.
- `schema_version` is `Literal[1]` with unknown fields refused, so any added field is a schema 2 that older builds reject. Reserve an extensions object or accept the bump on purpose. `content_sha256` is built from the serialized model, so a new field with a default changes every stored hash; a golden-hash test and an explicit encoder would pin it.
- One role and one fader per segment, while clips carry a lane. A selection across dialogue and music collapses to the first clip's role. A per-lane table would fit an insert better.
- No sample rate or channel count is declared; an insert has to probe the FLAC.
- Trust is integrity only (see above); there is no signature.
- `capture.py` lives in `segments/` but imports engines and the workspace service. It belongs in `services/` once Studio or MCP call it.
- Dedupe compares FLAC bytes, so a different ffmpeg build can turn the same capture into a new version.
