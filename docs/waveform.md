# Waveform peak pyramids (`.wfpk`)

A **peak pyramid** is a multi-resolution min/max/RMS summary of one media file.
The DAW viewer draws waveforms from it at any zoom without decoding audio.
The engine lives in
[`engines/waveform_pyramid.py`](../src/podcast_mcp/engines/waveform_pyramid.py),
and its knobs live in the `waveform` block of
[`contracts/timeline-zoom.json`](../contracts/timeline-zoom.json).

> **Status:** the engine (format, build, decode, I/O and job pool) is in place,
> but nothing calls it yet. The viewer still paints from the legacy overview JSON
> (`artifacts/peaks/{track}.json`, [gui-integration.md § Waveforms](gui-integration.md))
> until the pyramid is served and rendered. The rest of #429 lands in stacked PRs:
>
> - #440 (part 2) serves pyramids from `services/waveform.py`. It adds the
>   `.wfpk` store to [persistence.md](persistence.md) and the HTTP routes to
>   [gui-integration.md § Waveforms](gui-integration.md).
> - #444 (part 6) moves `gui/web/src/timeline/quietWash.ts` off its local
>   `QUIET_AMP` / `MIN_DURATION_SEC` onto the generated `QUIET_*` constants.
> - #446 (part 8) wires `effectiveMaxZoomPxPerSec` / `MAX_CONTENT_PX` into
>   `clampZoomPxPerSec`. Until then, zoom still clamps to the flat
>   `MAX_ZOOM_PX_PER_SEC`.

## Contract knobs

`contracts/timeline-zoom.json` → `waveform` is mirrored at
`src/podcast_mcp/util/timeline-zoom.json` and in the generated
`gui/web/src/utils/timelineZoom.generated.ts` (`uv run python scripts/export_timeline_zoom.py`;
CI's `frontend` job runs it with `--check`).

| Key | Value | Used by |
| --- | --- | --- |
| `format_version` | 1 | File header, pyramid key |
| `base_samples_per_bin` | 64 | Level 0 frames per bin (`base_spp`) |
| `level_factor` | 4 | Each level has `factor`× the frames per bin of the level below |
| `bins_per_data_tile` | 4096 | Tile size; levels are added while a level has more bins than this |
| `max_tiles_per_request` | 16 | Tile request cap |
| `pcm_block_frames` | 65536 | Host deep-zoom PCM block size |
| `render_tile_css_px`, `overscan_css_px`, `paint_dpr_cap`, `min_clip_css_px`, `line_mode_max_samples_per_px` | 512, 512, 2, 6, 4 | Client rendering |
| `quiet_amp`, `quiet_min_duration_sec`, `quiet_wash_min_zoom_px_per_sec` | 0.04, 0.12, 8 | Quiet wash |

`max_content_px` (15,000,000) at the top level caps timeline content width. The
generated TS exports `effectiveMaxZoomPxPerSec(sessionSec) =
min(MAX_ZOOM_PX_PER_SEC, MAX_CONTENT_PX / max(sessionSec, 1))` and
`paintDpr(dpr) = clamp(round(dpr·8)/8, 1, PAINT_DPR_CAP)` (Python mirrors it as
`util/timeline_zoom.paint_dpr()`, and `detail_bins_per_sec` uses it), so `512·paintDpr`
is always an integer. Python reads only the keys it needs, through
`util/timeline_zoom.py` getters (`waveform_format_version()`,
`base_samples_per_bin()`, `level_factor()`, `bins_per_data_tile()`,
`max_tiles_per_request()`, `pcm_block_frames()`). `max_tiles_per_request()` is
for the tile route that a later part of #429 adds.

## Format

All integers are little-endian. A file is a header, a level table, then the
level data.

**Header** (64 bytes, `struct` `<4sHHIIQIHHIHH24x`):

| Offset | Type | Field | Value |
| --- | --- | --- | --- |
| 0 | `char[4]` | magic | `"WFPK"` |
| 4 | `u16` | version | 1 |
| 6 | `u16` | header_bytes | `64 + 16·L` (header plus level table) |
| 8 | `u32` | sample_rate | Decoded sample rate |
| 12 | `u32` | channels | Decoded channel count |
| 16 | `u64` | total_frames | Frames in the media |
| 24 | `u32` | base_spp | Frames per bin at level 0 (64) |
| 28 | `u16` | level_factor | 4 |
| 30 | `u16` | level_count | `L` |
| 32 | `u32` | bins_per_tile | 4096 |
| 36 | `u16` | bin_bytes | 6 |
| 38 | `u16` | flags | 0 |
| 40 | — | reserved | 24 zero bytes |

**Level table:** `L` entries of `{u32 spp, u32 bins, u64 data_offset}` (16 bytes each).

**Data:** the levels are stored one after another. Each bin is
`i16 min, i16 max, i16 rms` (6 bytes). `min`/`max` are in ±32767, and `rms`
is in 0..32767.

**Levels:** level ℓ has `spp = base_spp · factor^ℓ` and
`bins = ceil(total_frames / spp)`. Bin `i` covers frames
`[i·spp, min((i+1)·spp, total_frames))`, so only the last bin can be short.
Levels are added while the coarsest level has more than `bins_per_tile` bins.
Empty media has one level with 0 bins.

**Determinism:** the file holds no timestamps or paths. The same input gives
the same bytes.

`read_meta(path)` rejects a file with bad magic, an unsupported version, a
wrong `bin_bytes`, a `header_bytes` that disagrees with `level_count`, bad
header fields, a truncated header or table, `spp` that does not increase per
level or whose level 0 value is not `base_spp`, a bin count that disagrees with
`total_frames`, or level data outside the file. `read_bins(path, meta, level,
start_bin, count)` reads raw bins with one seek and one read, clipped at the
end of the level.

## Build

`build_levels(chunks, *, sample_rate, channels)` is pure numpy. It takes an
iterable of float32 `(frames, channels)` chunks and returns
`(total_frames, levels)`, with one int16 `(bins, 3)` array per level.

1. **Level 0:** it cuts 64-frame slices and carries the remainder into the
   next chunk. Per bin it computes the min and max over frames×channels, and
   `sumsq` in float64 over every sample. The sample count per bin is
   `64·channels`, except for the tail bin. NaN input counts as 0.
2. **Coarser levels:** it folds `level_factor` bins at a time, padding the last
   group with neutral values (`+inf`, `−inf`, `0`).
3. **Quantize:** `min = floor(mn·32767)`, `max = ceil(mx·32767)` and
   `rms = round(sqrt(sumsq/count)·32767)`. Min and max are clipped to ±32767,
   and RMS to 0..32767. Rounding goes outward, so the envelope never
   under-reports the decoded samples.

`write_pyramid(out, …)` writes to a unique sibling temp file
(`.{name}.XXXX.tmp`), fsyncs it, moves it into place with `os.replace`, then
fsyncs the directory. An existing `out` is replaced: pyramids are
content-addressed, so a valid file gets identical bytes and a corrupt one is
repaired.

`write_synthetic_pyramid(out, *, sample_rate, total_frames, seed, silent=False)`
writes a deterministic, mono, speech-like pyramid without decoding: phrases
alternate with pauses. It uses the same level reduction. Large-project
fixtures use it.

### Decode

`decode_media(path)` returns `(sample_rate, channels, chunks)`, with chunks of
1,048,576 frames. Each chunk read loops until the chunk is full or the input
hits EOF.

- **WAV fast path:** stdlib `wave` reads uncompressed integer PCM of 8, 16, 24
  or 32 bits. Samples are scaled by `2^(bits−1)`; 8-bit samples are unsigned
  (`(v−128)/128`), and 24-bit samples are unpacked by hand.
  The header's data size must fit the file; a WAV that declares 0, `0xFFFFFFFF`
  or more bytes than it holds (streamed or truncated) goes to the ffmpeg path
  instead. An empty `data` chunk followed only by whole RIFF chunks (`LIST`, `id3 `)
  is still read on the fast path.
- **ffmpeg fallback:** anything `wave` rejects (float or `WAVE_FORMAT_EXTENSIBLE`
  WAVs on Python 3.11, compressed media) streams through
  `FFmpegEngine.stream_pcm_f32`. That method probes with
  `probe(path, untrusted=True)`, then runs ffmpeg with the same
  `-protocol_whitelist file,crypto,data`, `-threads 1`, `-f f32le -ac <ch>
  -ar <sr> pipe:1`. A 600 s watchdog kills a stuck process. It is armed only while waiting on
  ffmpeg for each chunk, so time the consumer spends between chunks never
  counts, and a long episode decodes as long as ffmpeg keeps producing output.
  Each chunk's watchdog carries its own generation, so a timer that fires after
  its chunk's read (and, at end of input, the wait for ffmpeg's exit) has
  finished is ignored, even once the next chunk has armed a new one. Only a
  timer that fires at the deadline, just as a full read returns, can still
  kill ffmpeg; the next read then reports the watchdog kill.
  Closing the generator kills ffmpeg too. A non-zero exit raises with the last
  2 KB of ffmpeg's stderr and says whether the watchdog fired. Because the command
  passes `-ac <ch>`, ffmpeg remaps inputs with more than two channels whose
  layout is not its default for that count; mono and stereo are unchanged.

`read_pcm_minmax(path, start_frame, frames)` returns int16 `(n, 2)` per-frame
min/max across channels, for host deep zoom. `n` is clipped at the end of the
media. NaN samples count as 0 and ±inf as ±1, as in `build_levels`, so a NaN in one
channel never hides another channel's peak. `frames` is capped at 4 × `pcm_block_frames` (262,144); a larger
window raises `ValueError`. WAVs use a bounded `setpos`/`readframes`. Other media use
`FFmpegEngine.decode_window_f32`, which puts `-ss` before `-i`, stops reading
at exactly `frames` frames, and has a 30 s watchdog. `-frames:a` is not used,
because ffmpeg counts it in decoder packets, not samples.

### Keys, files and jobs

- **Key:** `media_key(rel_posix, size, mtime_ns)` is
  `sha256("{format_version}|{rel}|{size}|{mtime_ns}")[:20]`, where `rel` is
  the workspace-relative POSIX path. When the media changes, the key changes,
  so a pyramid is never stale. Device and inode (`file_revision`) are left out
  on purpose, so the key survives a copied or restored workspace.
- **File:** `pyramid_path(peaks_dir, slug, key)` is
  `artifacts/peaks/{slug}.{key}.wfpk`, resolved with `resolve_within`.
  `ref_slug(kind, id)` is `{kind}-{id}` for ids matching `SAFE_TRACK_ID`, and
  otherwise `{kind}-h{sha1(id)[:12]}`. The hash, rather than `slug_track_id`, keeps
  distinct ids from colliding.
- **Reuse:** before a build, `reuse_existing_pyramid` hard-links any
  `*.{key}.wfpk` that passes `read_meta` to the new name, or copies it when
  linking fails. An existing target that fails `read_meta` is never deleted: a
  valid candidate is copied over it, or the caller's rebuild replaces it, both
  through an atomic `os.replace`, so a valid file that another build publishes
  meanwhile is never removed. A corrupt candidate is skipped.
- **Prune:** after a build, `prune_ref_pyramids` keeps the live key plus the
  newest other key for the slug, and deletes `.tmp` files older than one day.
- **Jobs:** `schedule_pyramid_build(ref, key, audio, out)` queues a build on a
  two-worker pool (`waveform` threads). It dedupes pending `(slug, key)` jobs,
  and it refuses a key whose build failed in this process while that key's
  retry window is open, then retries it, because failures can be transient
  (ffmpeg missing until bootstrap, a full disk, a watchdog kill). The window
  starts at `FAILED_RETRY_SEC` (300 s) and doubles with each consecutive
  failure of the key, up to `FAILED_RETRY_MAX_SEC` (1 h), so media that never
  decodes stops costing a decode every few minutes. A key's first failure is
  logged at WARNING and repeats at DEBUG; a successful build forgets the key. Failed-key memory is an LRU of 4,096 keys; changed media
  gets a new key and is retried at once. A job
  leaves the pending set only after `os.replace`, so a key that is not pending
  either has its file or is marked failed until its retry window ends (#421).
  - `pyramid_build_pending(slug, key)` and `pyramid_build_failed(key)` report
    job state.
  - `wait_pyramid_jobs()` blocks until builds finish. It is used by tests and
    at `atexit`.
  - `build_pyramid(...)` is the synchronous build. It runs inside
    `progress_task("waveform.build", …)`.
