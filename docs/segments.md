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
| `podcast segment save -p PROJECT --name NAME [--kind K] (--clips c1,c2 \| --range 0:00-0:22) [--role R] [--json]` | Cut the clips, or every clip overlapping the timeline range (trimmed to it), into the library as FLAC. Offsets count from the earliest clip. The role and fader come from the first clip's track. Without `--kind`: a selection starting in the first 120 s is an `intro`, one ending in the last 120 s of the timeline an `outro`, else `other`. Mute regions on the clips are rendered into the audio. |
| `podcast segment list [--json]` | The newest version of each segment. |
| `podcast segment show ID [--json]` | Layout, level and versions of one segment. |
| `podcast segment export ID -o FILE` | Write the newest version to a `.sharecutseg` file. |
| `podcast segment import FILE [--json]` | Add a `.sharecutseg` file to the library. |

`save` and `import` print one of `Saved`, `Saved a new version of` or `Already in the library`; with `--json` they print `{"status": "added" | "new_version" | "unchanged", "id", "version"}`. Failures print `Error: <message> (code <code>)` and exit 1.

## Conflict rules

- The same content as any stored version (same `content_sha256`) is `unchanged`: nothing is written and the existing id and version are returned, even when the incoming file has another name.
- The same name with different content is the next version. The id stays, and an earlier version is never overwritten.
- A different name with different content is a new segment at version 1.

## The `.sharecutseg` file

A zip of `segment.json`, the audio files and `MANIFEST.sha256` (`<sha256>  <name>` per other file). One segment per file. An import checks, before anything reaches the library:

- at most 64 entries and 2 GiB unpacked, counted from what is actually read, not only from the headers;
- every entry name is a plain file name: no directories, no absolute path, no `..`, no symlinks, no repeats;
- the manifest lists exactly the files in the zip, and `segment.json` names exactly the audio files;
- every hash matches, and the schema version is known.

Errors: `segment_bundle_invalid`, `segment_hash_mismatch`, `segment_schema_unsupported`. Reading a stored segment checks the audio hashes again and raises `segment_hash_mismatch` for a file that was changed or removed.

## Not built yet

- Using a segment in an episode (inserting it on the timeline, ducking, the chapter marker). Slice 1 has no Studio, MCP or HTTP surface.
- Multi-segment kits (`.sharecutkit`).
- Capturing a transcript or a chapter title.
- Removing a segment from the CLI (the store has `remove`).
- Per-clip gain and mute-region data beyond what is rendered into the audio.
