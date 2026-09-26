# Waveform peak pyramids (`.wfpk`)

A **peak pyramid** is a multi-resolution min/max/RMS summary of one media file.
The DAW viewer draws waveforms from it at any zoom without decoding audio.
The engine lives in
[`engines/waveform_pyramid.py`](../src/podcast_mcp/engines/waveform_pyramid.py),
and its knobs live in the `waveform` block of
[`contracts/timeline-zoom.json`](../contracts/timeline-zoom.json).

> **Status:** the engine (format, build, decode, I/O and job pool), the
> HTTP API (status, tiles, PCM windows; host and guest), the client data
> layer, the raster worker and the timeline renderer (§ Client) are in place.
> Pyramids are the only waveform format: the uint8 overview JSON
> (`artifacts/peaks/{track}.json` and its HTTP route) is gone, and `gc_pyramids`
> deletes leftover `artifacts/peaks/*.json` once it is 7 days old.
> Zoom clamps to `effectiveMaxZoomPxPerSec(sessionSec)` (§ Deep zoom).

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

`max_content_px` (15,000,000) at the top level caps timeline content width;
`min_viewport_span_sec` (0.001) is the shortest presence viewport span, and
`snap_tick_decimals` (6, 1 µs) is the precision snap ticks round to, both read
by Python and the GUI. The
generated TS exports `effectiveMaxZoomPxPerSec(sessionSec) =
min(MAX_ZOOM_PX_PER_SEC, MAX_CONTENT_PX / max(sessionSec, 1))` and
`paintDpr(dpr) = clamp(round(dpr·8)/8, 1, PAINT_DPR_CAP)`, so `512·paintDpr` is
always an integer. `paintDpr` is client-only: `paint_dpr_cap` has no Python getter
and reaches TS as `PAINT_DPR_CAP` via `scripts/export_timeline_zoom.py`. Python
reads only the keys it needs, through
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

## Media refs and status

A **media ref** names one media file the viewer draws
([`engines/waveform_media.py`](../src/podcast_mcp/engines/waveform_media.py)):

| Ref | Source | Listed when | Kind |
| --- | --- | --- | --- |
| `track:<id>` | `track.media` | The track has media | `raw` |
| `source:<id>` | `project.sources[]`, resolved like `engines/timeline_render.resolve_clip_audio_path` | At least one clip references it | `raw` |
| `stem:<id>` | `artifacts/tracks/<id>.wav` | `stem_is_fresh(project, id)`; ids must match `SAFE_TRACK_ID` | `stem` |

Paths stay under the workspace (`resolve_under_workspace` / `resolve_within`);
a ref whose path escapes is skipped. A cross-lane clip that pins another lane's
file through `source_id` gets its own `source:` ref, whose key matches the
`track:` ref of the same file, so its pyramid is hard-linked instead of rebuilt.

[`services/waveform.py`](../src/podcast_mcp/services/waveform.py) adds:

- **`media_index(project_path)`:** the refs of one project, cached in an LRU
  of 16 keyed by the project JSON's `file_revision`. Each entry also stores a
  stat signature (size and mtime, or missing) of the files that decide
  availability without touching the project JSON: each track's media, each
  clip-referenced source, and each track's stem WAV and `.hash` sidecar
  (`media_watch_paths`, derived from the same ref walk as
  `collect_media_refs`). A hit whose signature changed is re-parsed, so media
  that appears later or a re-rendered stem shows up on the next call. A parse
  is cached only when the revision is the same before and after it. Keys are
  recomputed with `stat()` on every call, so media edits that do not touch the
  project JSON still change the key.
- **`waveform_status(project_path, kind)`:** `{"format_version": 1, "media": {ref: entry}}`.

  | State | Entry |
  | --- | --- |
  | Ready | `{"status": "ready", "key", "sample_rate", "channels", "total_frames", "base_spp", "level_factor", "bins_per_tile", "levels": [{"spp", "bins"}]}` |
  | Building | `{"status": "generating"}` (a missing pyramid that is not pending is queued) |
  | Failed | `{"status": "unavailable", "reason": "no-media" \| "decode-failed" \| "unsafe-id"}` |

  A pending build is checked before the file (#421). A pyramid that fails
  `read_meta` is deleted and rebuilt. `read_meta` results are cached per
  pyramid file. A tile read shorter than the cached header promises (the file
  changed under the cache) counts as corrupt too: the file and its cached
  header are dropped, the request gets a 404 with `no-store`, and the next
  status call rebuilds it.
- **Hooks** (engine functions, re-exported by the service):
  `schedule_track_waveforms(project, track)` queues the track ref plus the
  source refs of that track's clips; `ensure_track_waveforms(project, track)`
  builds them inline and returns how many are on disk;
  `ensure_project_waveforms(project, *, sources=True)` runs it for every track with
  media (`sources=False` builds only the `track:<id>` refs);
  `schedule_stem_waveforms(project, track_ids)` queues just-rendered stems.
  They run after `add_track`, `set_track_media`, ingest consolidate, record
  landing, stem renders (`_render_track_stems`) and `PlayService.ensure_stem`;
  the pipeline's `ingest_tracks` step builds inline with
  `ensure_project_waveforms` (its summary reports "N waveforms").
- **`gc_pyramids(project_path)`:** once per process per project, deletes
  pyramids whose ref slug is no longer listed and that are older than 7 days
  (per-ref pruning never reaches deleted refs), plus legacy
  `artifacts/peaks/*.json` overview files older than 7 days (an older app build
  may still write them, and a guest status poll can trigger the pass). A failed
  pass is retried on a later status call and never fails the status request.
- **Social clip energy:** `ClipService.propose` first builds any missing
  `track:<id>` pyramids inline with
  `ensure_project_waveforms(project, sources=False)` (clip-source refs are not
  built here), so the ranking does not depend on background builds.
  `clips/social.py` then reads each track's pyramid once per call through `engines/waveform_media.track_pyramid` and
  `engines/waveform_pyramid.pyramid_peak`, at the coarsest level with
  `spp ≤ sample_rate / 16`. It never builds itself and falls back to 0.5 when
  no pyramid is readable.

## API

Host routes ([`gui/routes/waveform.py`](../src/podcast_mcp/gui/routes/waveform.py))
need the host role (`require_host`) and a project path (`resolve_project`);
`/api/waveform` is a host-binding protected prefix.

| Route | Response | Rules |
| --- | --- | --- |
| `GET /api/waveform/status?path=&kind=raw\|stem` | JSON | `Cache-Control: no-store` |
| `GET /api/waveform/tiles/{key}?path=&ref=&level=&start=&count=` | octet-stream: the concatenated bins of data tiles `[start, start+count)`, clipped at the end of the level | Validates the ref grammar, `key` (`^[0-9a-f]{20}$`), that the file exists, the level, `start`, and `1 ≤ count ≤ max_tiles_per_request`. No index and no project parse. `Cache-Control: private, max-age=31536000, immutable` (no ETag: the URL carries the key) |
| `GET /api/waveform/pcm/{key}?path=&ref=&block=` | octet-stream: int16 `(min, max)` pairs for frames `[block·B, min((block+1)·B, total))`, `B = pcm_block_frames` | **409** when `key` is not the ref's current key, checked before and after the read. Immutable |

Errors map bad input to 400, missing refs or pyramids, and media that cannot be
read or decoded, to 404, stale keys to 409 and anything else to 500, and always send `Cache-Control: no-store`. Tile bytes are
`i16 min, i16 max, i16 rms` per bin, as in the file.

Guest routes (`gui/routes/review_share.py`, services
`share_daw_waveform_status` / `share_daw_waveform_tiles` in
`services/share.py`) need the `view` capability and only cover `kind=raw`:

- `GET /api/review/{token}/daw/waveform/status`: read rate class.
  Like the host status, it queues missing pyramids. It is the only builder for
  media that predates the eager hooks, and the viewer polls it. The build pool
  dedupes by `(slug, key)` with two workers, so a guest can cause at most one
  build per missing ref. A failed key reports `decode-failed` and is not retried
  in that process. GC runs once per process per project and deletes only
  week-old orphans.
- `GET /api/review/{token}/daw/waveform/tiles/{key}?ref=&level=&start=&count=`:
  only `track:` / `source:` refs, and only the ref's live key (404 otherwise).
  Audio rate class on the relay and the host (no RPM; the request takes an
  audio concurrency slot before any disk work and holds it until the response is sent).

There is **never** a guest PCM route: raw samples never go to guests.

Guest tiles are cached `private, max-age=31536000, immutable` under their
content-addressed key, so revoking a share does not remove tiles a guest's
browser already downloaded.
Revocation stops new requests only.

## Client

`gui/web/src/waveform/` holds the viewer's data layer and rasterizer, and
`timeline/WaveformLayer.tsx` draws each clip from it. Each module has a
`*.test.ts`.

- **Refs and status.**
  - `mediaRef.ts`: `clipMediaRef(clip, laneTrack, kind)` returns
    `stem:<lane>` while the lane's stem is fresh in FX mode, otherwise
    `source:<source_id>` or `track:<origin track>`.
    `clipMediaStartSec` returns the media time at the clip's left edge: the
    live source start, or the timeline clock for stems.
    `mediaSignature(project)` covers the inputs that decide the listed refs.
  - `statusStore.ts`: one poller per (project, kind), through
    `api.ts` `loadWaveformStatus` (host route, or the share route for
    `share:` keys). It polls again after 1, 2, then 4 s while anything is
    generating, and stops otherwise. A failed poll backs off the same way, except that a
    4xx other than 408/429 stops polling until the next refresh, or until a subscriber arrives at least 5 s later (STOPPED_RETRY_MS). It polls at once on a media-signature
    change (the `WaveformStatusSync` leaf) and after a tile 404 (once per
    key, until a poll no longer lists that key as ready). `useWaveformStatus(projectPath, kind, ref)` returns one entry,
    with the same object identity while it is unchanged.
- **Data** (budgets in `budgets.ts`: bitmaps 128 MB, or 48 MB on the phone
  shell; tiles 64 or 32 MB; PCM 32 MB; 4 fetches in flight on the host and
  3 through a share, tiles and PCM combined; the caches re-trim when the
  shell breakpoint changes; a slot freed by either store
  wakes both, via `waveformFetchGate.onRelease`).
  - `pyramidStore.ts`: missing data tiles are queued by priority (visible,
    overscan, prefetch), deduplicated, and fetched in runs of up to
    `max_tiles_per_request`. A 429 holds the run back until `Retry-After` and then re-queues it. Any
    other failure holds it back for 5 s. A 404, or tiles missing from a short
    response, are skipped until their key is ready again or for 30 s. Zoom and
    scroll never abort a fetch; only leaving the project does. When a ref
    becomes ready, the store prefetches the coarsest level and the next two
    levels when each has at most 8 tiles. `getBins` returns a copy, and
    missing bins have `rms = -1`.
  - `pcmStore.ts` (host only): block-aligned `(min, max)` frames. A 409 or 404
    polls status again. Failed blocks are held back the same way (429: until
    `Retry-After`, then re-queued; otherwise 5 s).
  - `pyramidMath.ts`: `levelFor` and the pyramid and PCM envelope
    reductions (the PCM one is the envelope of the piecewise-linear
    interpolant).
- **Rendering.**
  - `renderTiles.ts` holds the tile geometry. Tile `k` covers media seconds
    `[k·512/zoom, (k+1)·512/zoom)`, at paint DPR `d = paintDpr(dpr)`. The
    module also computes the origin snapped to device pixels, the visible
    range with ±512 px overscan, the canvas rectangle clipped to the clip,
    the tile keys, and the mode: pyramid, pcm, or pcm drawn as a line.
  - `shade.ts` turns an envelope into per-column geometry: the peak span and
    the RMS body in device rows. Silence and columns with no data are
    skipped, and thin columns are widened to 1 row (pyramid) or 1.5 rows
    (PCM). It also holds the row-coverage formula. `rasterCpu.ts` and
    `rasterGl.ts` both draw from this geometry, so the two cannot drift
    apart. Each pixel is `core·rc + edge·(pc − rc)`, premultiplied.
  - The WebGL2 path uploads the geometry as a `cols × 1` RGBA32F texture and
    draws one full-screen triangle.
  - `raster.worker.ts` uses WebGL2 on an `OffscreenCanvas` when it can, and
    otherwise the CPU rasterizer plus `createImageBitmap`. It falls back to
    the CPU after a context loss.
  - `rasterClient.ts` keeps at most 4 jobs outstanding. It drops queued jobs
    that are no longer wanted, but caches results that arrive late. A provisional request never
    replaces a queued exact one. A `postMessage` that throws frees its slot and reports the key,
    and a result whose job is gone is closed. Pending `rasterParity()` calls
    settle with null on a reset or a worker crash. Its
    backend is `none` without `Worker` (jsdom). A worker that crashes
    (`onerror`, e.g. out of memory, or `onmessageerror`, whose lost reply would
    hold its slot forever) is restarted up to `RASTER_WORKER_RESTARTS` (2)
    times; `RASTER_RESTART_REARM_TILES` (64) finished tiles after a crash re-arm
    that budget. Queued jobs go to the new worker, and the reported backend
    stays until it is ready. `rasterWorkerRestarts()` (E2E hook
    `workerRestarts`) counts restarts since load, so a restart can be told
    apart from normal running. Once the budget is spent the backend is `none`
    until reload. `subscribeRasterFailed` reports the keys of jobs that died: a
    render that threw (an `error` reply), a `postMessage` that threw, those in
    flight at a crash, and on the last crash the queued ones. A key is reported
    at most `RASTER_JOB_RETRIES` (1) time; its next failure retires it until
    reload (`requestRaster` refuses it and `hasRaster` is true), so a poison
    tile cannot loop. A key in flight at repeated crashes is retired the same
    way, so a poison tile cannot spend the restart budget. A worker that cannot
    be constructed means `none` at once. The listener sets use `listenerSet.ts`
    (emit over a snapshot).
  - `bitmapCache.ts` holds the finished bitmaps and calls `close()` on
    every one it evicts. While a tile's exact bitmap is pending, it offers
    the nearest-zoom bitmap that overlaps as a stand-in. A bitmap rendered
    from a coarser level is kept only as a stand-in, never as the exact hit.
- **Colours:** `timeline/waveformTheme.ts` `waveformStyle(layer, colorVar,
  theme)` returns the lane's core and edge tints as RGBA floats. Without a
  readable fill it falls back to `--color-waveform-peak` (resolved through a probe element,
  since the token is `color-mix()`), with the edge at
  0.6 alpha.
- **E2E hook:** `waveform/e2eHook.ts` sets `window.__SHARECUT_E2E_WAVEFORM`
  to `{backend, tilesRendered, tilesByMode, rasterParity()}` (`tilesByMode`
  counts finished tiles per mode: `pyramid`, `pcm`, `line`), in test and
  `VITE_SHARECUT_E2E=1` builds only. `rasterParity()` renders a fixed tile
  in the worker through WebGL2 and through the CPU, and returns the largest
  difference, `max(|Δa|, |Δ(rgb·a)|/255)`.

### Renderer

`timeline/WaveformLayer.tsx` is a `memo` component with primitive props:
`{mediaRef, kind, mediaStartSec, clipLeftCss, clipWidthCss, zoom, colorVar}`.
`ClipBlock` renders one for the clip, and a second for the trim ghost, which
starts at the ghost's source start and has the ghost's width.

- **Subscriptions.** The layer subscribes to its ref's status entry, the DPR,
  the amp zoom, the theme and its visible tile range. The range comes from a
  selector over `scrollLeft` and `timelineViewportWidth` that returns a
  string (`"k0:k1"`), so scrolling re-renders the layer only when tiles come
  or go.
- **Geometry (S5).** `origin` puts media time 0 on a device pixel. Tile
  `k`'s canvas (`canvas.clip-waveform-tile`) covers only the part of
  `[k·512 + origin, +512)` inside the clip, and its backing store is
  `sw × round(height·d)` device px. The layer's height is measured with a
  `ResizeObserver`, never read during render. Clips narrower than
  `min_clip_css_px` (6) get no layer.
- **Draw.** The layer draws the cached bitmap for the tile key
  (`mediaKey|zoom|d|heightDev|style|ampZoom|k`) with `drawImage` on a 2D
  context. Without one, it draws a stand-in (the nearest zoom that overlaps,
  or a render from a coarser level that is already loaded) and asks for the
  data and a raster. A tile whose render is already queued or in flight is
  skipped (`rasterClient.hasRaster`), so data events do not rebuild its job. If the queue later drops that job as unwanted (`subscribeRasterDropped`), or the job dies (a render or post that threw, or a crashed worker: `subscribeRasterFailed`), any layer that still wants the key asks again.
  The mode is pyramid, or host PCM below level 0, drawn as
  a line under 4 frames per device column. Guests use level 0 bins
  stretched over several pixels.
- **Hold the old ref.** A new ref (for example, a cross-lane `source_id` flip)
  replaces the old pyramid only once it is ready. Data requests use the held
  ref. `unavailable` or a project change hides the waveform.
- **Quiet wash.** The wash comes from max-pooled column peaks, at 8 px/s
  and above (`timeline/quietWash.ts` `quietBandsInView`). A quiet run is
  judged over the mounted tile range plus `quiet_min_duration_sec` on each
  side (within the clip), then clipped to the mounted range, so a long pause
  still washes when a deep zoom shows only milliseconds of it. Columns are
  one CSS px, but never finer than a level-0 bin. It is memoized, and
  recomputed only when the range, the geometry or the loaded pyramid tiles
  change.
- **Move ghosts.** Ghosts carry `origin_track_id` and always draw raw media.
- **Lane hint.** `laneWaveformStatus` returns generating when any ref of the
  lane is generating. It returns unavailable only when every ref is known
  and none is ready.
- **Backend.** `TimelineView` mounts `WaveformStatusSync`, which also starts
  the worker and installs the E2E hook. It renders `data-waveform-backend`
  on `.timeline-area`.

### Deep zoom

Zoom runs from `min_zoom_px_per_sec` (0.05) to `max_zoom_px_per_sec`
(48,000 px/s: about one CSS px per sample at 48 kHz), and the ceiling is
session-aware: `effectiveMaxZoomPxPerSec(sessionSec)` keeps
`sessionSec × zoom ≤ max_content_px` (15,000,000 px), so a one-hour session
tops out near 4,167 px/s. `utils/zoom.ts` `clampZoomPxPerSec(zoom,
sessionSec)` applies it to every zoom path (keys, pinch, wheel, Fit,
`setZoomPxPerSec`, follow). When the session length changes (`setProject`,
`hydrate`, document updates), `state/dawStore.ts` `zoomReclampPatch`
re-clamps the zoom, keeping the time at the view centre, and is merged into
the same store update as the new project, so no frame shows an over-ceiling
zoom.

The ceiling was chosen under every engine's layout limit. Blink and WebKit store layout coordinates as `LayoutUnit`, a 32-bit fixed-point value in 1/64 px, so they saturate at 2³¹ / 64 ≈ 33.5 M px (Blink `platform/geometry/layout_unit.h`, WebKit `platform/LayoutUnit.h`). Gecko stores `nscoord` in app units, 60 per CSS px, capped at `nscoord_MAX` = 2³⁰, so about 17.9 M px (`gfx/src/nsCoord.h`). These figures come from the engine sources, and no test here measures them. `gui/web/e2e-compat/deep-zoom.spec.ts` checks the 15 M px ceiling itself on Chromium and WebKit (ruler ticks, tiles, envelope and scroll range within 1 px).

- **Modes.** While a device column spans at least a level-0 bin
  (`base_samples_per_bin`, 64 frames) the layer draws the pyramid. Below
  that, the host draws `(min, max)` PCM blocks from `/api/waveform/pcm/`,
  and under `line_mode_max_samples_per_px` (4) frames per device column it
  draws them as a line (the envelope of the piecewise-linear interpolant).
  Guests have no PCM route: they stop at level 0, whose bins stretch over
  several pixels.
- **Precision.** Tile geometry stays source-anchored (`t = k·512/zoom`, no
  accumulation), snap ticks round to 1 µs on client and server (`snap_tick_decimals`), presence
  x-fractions carry 6 decimals, and drag thresholds are in pixels (roll
  commit 0.5 px, move no-op 0.5 px or 0.1 ms, whichever is smaller, social-clip drag 3 px, ruler comment
  span 4 px), so edits work at any zoom. Domain minimums (0.05 s spans,
  integer-ms fades) are unchanged.
- **Bounded DOM.** The ruler, the Levels envelope and the waveform tiles
  mount only what meets the viewport: the ruler and envelope in 2048 px
  chunks (`utils/timelineViewport.ts` `viewportChunkRange`, a selector that
  returns a string), the tiles in 512 px tiles plus overscan. A ruler never
  mounts more than `ceil((viewport + 4096) / 70) + 1` ticks. A Levels point being dragged, selected or focused stays mounted outside the chunks, so pointer capture and focus survive a scroll.

**Budgets:** the bitmap cache holds 128 MB (48 MB on the phone shell), data
tiles 64 MB (32 MB on the phone shell) and PCM 32 MB. There are 4 fetches in
flight on the host and 3 through a share, and 4 raster jobs outstanding.
**Desktop webviews:** WebGL2 in a worker needs `OffscreenCanvas`. Where a
webview lacks it (older WKWebView, some WebKitGTK builds), or a GPU context
is lost, the CPU worker draws the same pixels
([desktop-packaging.md](desktop-packaging.md)).
