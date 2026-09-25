---
name: podcast-play-audition
description: >-
  Play podcast audio by transcript topic or time range: search what was said,
  audition raw or processed (FX + edits) segments on the user's speakers.
  Use when the user says play, listen, hear, or audition a moment, line, or topic.
---

# Play / audition audio

## Harness

**MCP (preferred for NL):**

| Tool | When |
|------|------|
| `audition_context_tool` | **Before play** when diagnosing overlap / desync — per-track captions, stem freshness, typed `hypotheses[]`, `suggested_listen[]` |
| `play_transcript_query_tool` | User names a topic or phrase — *"play where they talk about family"* |
| `search_transcript_tool` | Preview matches before playing (multiple hits) |
| `play_audio_tool` | Explicit time range or after you already have start/end |
| `play_compose_tool` | Simultaneous mix of a **subset** of tracks (e.g. host+guest, no music) for a timeline window |
| `play_audio_tool` (`follow_transcript=true`) | Gated mix or per-track audition after bleed suppress |
| `play_ab_tool` | **Before/after history A/B** — extract both snapshots first, hear A→~0.4s gap→B in one call |
| `play_ab_wavs_tool` | Replay two existing `play_cache` WAVs back-to-back (same concat) |
| `play_pending_preview_tool` | **Pending session remove** — Current / Suggested (skip the cut) / A/B; does not mutate |

**CLI:**

```bash
podcast play context --project episode.project.json --start 924 --end 930
podcast play --project episode.project.json --query "family"
podcast play --project ... --query "pricing" --match 1 --padding 2
podcast play --project ... --source processed:host --start 12 --end 25
podcast play --project ... --source track:host --start 0 --end 10   # raw, no FX
podcast play --project ... --source premix --start 30 --end 45 --rerender
podcast play --project ... --start 145 --end 176 --follow-transcript
podcast play --project ... --source processed:olga --start 145 --end 176 --follow-transcript
podcast play --project ... --start 145 --end 176 --follow-transcript --compare
podcast play compose --project ... --track-ids host,guest --tier processed --start 12 --end 18
# Before/after probe (history indices): one call, no long gap between takes
podcast play ab --project ... --before-index 53 --after-index 55 \
  --source processed:vicky --start 74 --end 83 --gap 0.4
# Pending session remove: Suggested concatenates pad-before + pad-after (cut gone)
podcast play pending-preview --project ... --edit-id cut1 --mode suggested
podcast play pending-preview --project ... --edit-id cut1 --mode ab --gap 0.4
```

## Audition context (captions before play)

When the user hears “two conversations at once,” overlap that isn’t simple crosstalk, or anything after ripple/tighten, call **`audition_context_tool`** (or `podcast play context`) **before** `play_audio_tool`:

1. Returns `schema: audition_context.v2` with per-track transcript text for the **timeline** window, `window.clock`, and per-span `clock: source`.
2. `hypotheses[]` are typed (`code`, `severity`, `confidence`, `evidence`, `next.fix.autonomy`). Treat `heuristic` as present-only. `auto_ok` is re-render / re-reconcile only; editorial/FX changes stay `needs_approval`. Windowed `hum_in_window` / `clipping_in_window` fire at **every** `detail` when the span is ≤60s (DSP on the span, not the whole stem). Longer windows emit `dsp_unavailable` instead of a full-file FFT. `detail=visual` is only for PNGs + `events[]`.
3. `suggested_listen[]` gives ready-to-call play args (`source` premix / `processed:<id>`, or `track_ids` for `play_compose_tool`). Use `hypotheses[].next.listen` instead of inventing ranges.
4. `clip_skew.pairs` may list source-clock deltas at window mid. Unequal per-track cuts make those clocks diverge — remaining-clip math, not recorder desync. Do **not** run `podcast-align-audio` from it. Captions come from each track's `source_spans`. `stale_render` is the mix-trust warning.
5. Flags **`stale_render`** / **`stale_reconciliation`** so you don’t trust a stale premix against current captions (`limits` includes `needs_rerender` when stale).
6. Includes **comments**, **active effects** (non-bypassed), and **pending/applied edits** overlapping the window. Each pending `filler:acoustic` edit adds an `acoustic_gap_filler` hypothesis (`needs_approval`; `evidence` carries the edit id and its own `timeline_start` / `timeline_end`) — audition that span with `play_pending_preview_tool` before approving, since it may be a breath, laugh, or missed word.
7. `detail="full"` expands edit/comment payloads; `detail="visual"` adds waveform/spectrogram PNGs plus `events[]` (word/comment/edit/hypothesis with `t` and plot-relative `x`). After visual, **Read** each PNG; `plot.read_for` is `degradation_not_asr` — do not try to read speech off the spectrogram. Hum/clip codes do **not** require visual — they are already in `hypotheses[]` on summary.
8. `summary` is a one-line caption dump for chat; `warnings[]` are one prose line per hypothesis (same count).
9. `limits` always includes `cannot_hear` — the model does not hear; play for the human.
10. Captions include **muted** dialogue tracks so `muted_track_speaking` can fire. The mix, play and bounce skip muted tracks; their stems still render, so an unmute plays in sync.

Do not skip this step when reviewing multitrack join quality or when the user reports disparate dialogue in the mix.

**Not in this payload (call other tools / later work):** LUFS, join scores, bleed maps, premix/stacked mix PNGs, MOS, hypothetical FX without a project mutation, share-guest compose. Share agents use `guest_audition_context`, not this host tool.

**`--follow-transcript`** — unmute each track only when that speaker has non-suppressed attributed words (uses processed stems). Default source `premix` → gated **mix** of all dialogue tracks. `processed:<id>` → single gated track. `--compare` → each gated track sequentially, then gated mix. Every follow-transcript take (single track, each `--compare` take, and the gated mix) plays each track at its output gain (same rule as `play_compose_tool`). Single and compare takes keep that level, unless the gain would push a take past full scale: then it is pulled back to just under full scale instead of hard-clipping. The gated mix then peak-normalises the sum, so it matches the premix's balance between tracks but not its loudness: moving every fader by the same amount, or the fader of the only audible track, doesn't change how loud the gated mix plays.

**`play_compose_tool` / `podcast play compose`** — simultaneous mix of named `track_ids` (processed or raw) for a timeline window, written to `play_cache`. Use when `suggested_listen` has `track_ids`, or when diagnosing bleed/overlap without music or a third mic. Does **not** mutate mute/solo/FX. Each track plays at its output gain (staging `gain_db` + saved `fader_db`, minus whatever a segment render already baked in).

## Default: simultaneous full mix

**When the user asks to play a section, moment, or time range, default to all tracks playing at once — the `premix` (full mix), not one track at a time.** Multitrack podcasts have crosstalk and back-and-forth; hearing every speaker together is almost always what the user means by "play that part."

- **Play a section / time range / "that part"** → `play_audio_tool` with `source="premix"` and timeline `start_sec` / `end_sec` (simultaneous mix of all dialogue tracks).
- **Single-track** (`processed:<id>` / `track:<id>`) and **sequential `--compare`** are opt-in only — use them when the user explicitly asks to isolate a speaker or check alignment/bleed, never as the default for "play the section."
- `play_transcript_query_tool` auditions the matched speaker's track by design (topic on the person who said it); when the user wants the whole moment rather than just that speaker, prefer `play_audio_tool` on `premix` over the matched-track query.

## Shared DAW session (bidirectional)

Agent, CLI, and DAW tabs are clients of `SessionSyncService` (typed commands → sqlite log → snapshot / WebSocket). See `docs/session-sync.md`. The only store is `artifacts/session/sync.db`; read it with `get_session_state_tool`.

| Tool | When |
|------|------|
| `get_session_state_tool` | Before “cut from here”, “what am I hearing?”, or any prompt that needs playhead/selection/region |
| `get_session_presence_tool` | Who is looking at what — cursor (time or chrome `anchor`), selection, viewport, transport, follow, and `ui` (tab, audition, mute/solo). Humans can follow the Agent avatar while it auditions. |
| `seek_session_tool` / `set_session_playing_tool` / `stop_session_tool` | Move or pause the DAW **without** OS `afplay` |
| `set_session_mode_tool` | Switch Mix / FX / Raw in the viewer |
| `set_session_region_tool` | Highlight a span; optional `playing=true` for browser-only audition |
| `play_*` tools | OS audio (`dry_run=false` → `PlayOsAudio`) **or** DAW browser (`dry_run=true` → `AuditionInViewer`); both seek/highlight. Real play does **not** start browser transport (avoids double audio). |

CLI: `podcast session status|seek|stop|mode|region`. Prefer real play (`dry_run=false`) when the user should hear speakers; the DAW follows visually. Use `set_session_playing` / `set_session_region(..., playing=true)` for browser-only audition.

## Workflow

1. Confirm `episode.project.json` path and that transcripts exist (`transcribe_track` or `get_transcript` — if empty, transcribe first).
2. **Section / time range** (default) → `play_audio_tool` with `source="premix"` and timeline `start_sec` / `end_sec` (run `render_preview` first if premix missing, or `rerender=true`). All tracks at once.
3. **Topic / quote request** → `play_transcript_query_tool(project_path, query="…")` when the user wants the speaker who said it; otherwise get `timeline_start`/`timeline_end` from `search_transcript_tool` and play that window on `premix`.
4. **Multiple matches** → `search_transcript_tool` → show snippets → `play_audio_tool` on the chosen `timeline_*` window (or `play_transcript_query_tool` with `match_index` for single-speaker audition).
5. Return the JSON `tier` field (`stem`, `segment_render`, `raw`, `premix`) so the user knows what they heard. After `history_goto` / undo without `--rerender`, expect `segment_render` until stems are reassembled. If the DAW is open, it will already show the same span. When the user refers to “here” / the playhead, call `get_session_state_tool` first. To play what a named person is hearing, call `get_session_presence_tool` then `seek_session_tool` / `set_session_region_tool` at their playhead.

## Rules

- **Clocks:** `play_audio_tool` `start_sec`/`end_sec` for `processed:<id>`, `premix`, and `export` are **timeline seconds** (the edited/deliverable clock). When you get times from `search_transcript_tool`, use the match's **`timeline_start`/`timeline_end`**, not `start`/`end` (those are source-media seconds for cut decisions). `play_transcript_query_tool` already resolves this for you. Raw `track:<id>` playback is the one exception — it takes source seconds on the untouched file. A `null` `timeline_start` means the span was cut away.
- Query search is **substring** on transcript text, not semantic embeddings — pick distinctive words from what the user said.
- Without transcripts, search/play by topic will fail; transcribe or seed canned transcript first.
- NL play does not modify the project; cuts still use edit tools + `approve_edits_tool`.
- For listen-after-edit, prefer `processed:<track_id>` or `play_transcript_query_tool` over raw `track:<id>` unless checking alignment.
- Do **not** use `--compare` (sequential per-track then mix) unless the user explicitly asks to compare tracks — default section playback is the simultaneous `premix`.
- For **before/after history probes** (keep/tweak/undo loops), use `play_ab_tool` / `podcast play ab` — never `history_goto` → play → `history_goto` → play (that inserts a long dead gap while stems rebuild). Default silence between A and B is **0.4s**. Replay cached extracts with `play_ab_wavs_tool` when you already have both WAVs.
- For a **pending session-wide remove**, use `play_pending_preview_tool` / `podcast play pending-preview` (`suggested` default, or `current` / `ab`). Suggested skips the pending band (pad-before + pad-after concat). Splits and track-scope punches are Current-only. Does not mutate. In Sharecut Studio, the pending inspector footer is the same skip (not a bounced sidecar).
- **Share / remote MCP:** do **not** call `play_pending_preview_tool` or `audition_context_tool` (host speakers / host paths). Use `guest_pending_preview` (`play`+`view`) for a pending session remove, and `guest_audition_context` (`play`+`view`) for an arbitrary timeline window (captions + hum/clip codes in `warnings[]`, not `hypotheses[]`; optional wave/spec PNG). Stream the returned share HTTP URLs. Skill: **podcast-remote-mcp**.

## Pair with editing

After proposing NL cuts, offer: *"Want to hear that section?"* → `play_pending_preview_tool` with the pending id (Suggested), or `play_transcript_query_tool` / `play_audio_tool` on the approved span. On a **review share**, use `guest_pending_preview` (pending cut) or `guest_audition_context` (arbitrary window) instead (HTTP URLs, not host speakers).

## Pair with cleanup analysis

After `analyze_cleanup_tool` or `gate_overreach_tool`, audition flagged spans:
- `play_audio_tool` with `source=processed:<track_id>` and `start_sec` / `end_sec` from the report
- Compare to `source=track:<track_id>` on the same range to hear raw vs processed
