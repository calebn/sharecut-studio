# Inaudible cut boundaries

Cut-producing operations run a shared boundary optimizer by default so joins stay smooth: word-safe anchors on dialogue, waveform snapping on all tracks, and micro-fades at clip edges.

Implementation: `edits/inaudible_cuts.py`. Defaults: `.agents/defaults/pipeline.yaml` → `inaudible_cuts`.

This is **not** effect/plugin smoothing — it only moves cut boundaries and fade lengths at timeline joins. Cleanup analysis and FFmpeg presets are separate (see `.agents/skills/podcast-audio-cleanup/SKILL.md` and `analysis.heuristics` in defaults).

## Behavior

For a valid timeline range, `optimize_timeline_cut_range` preserves the requested
timeline endpoints when optimization is disabled by configuration or an explicit
`force_enabled=False` override. Source normalization and result diagnostics
still run; `shifted_start_ms` and `shifted_end_ms` remain source-clock values and
can be nonzero even when the returned timeline geometry is exact.

- **Dialogue tracks** — anchor to legal transcript word boundaries, then search locally for low-energy / near-zero-cross points. `min_word_margin_ms` prevents snaps from landing too close to retained words.
- **Short filler / NL cuts** (`duration ≤ short_cut_max_sec`) — if the cut end still sits in hot / non-quiet waveform energy (ASR often ends “um” early while the voiced blob continues), extend `end` to the **quietest** RMS hop between the naive end and the start of the next transcript word, capped by `trailing_energy_extend_ms`. This skips shallow local troughs inside a nasal coda. When that window is still hot (filler overlaps the next word’s onset), chew further within the extend budget to clear the blob. Room-tone pacing still inserts `replace_gap_sec`, but does **not** clamp away a trailing-energy extend past the next word’s ASR start.
- **Trailing silence absorb** — after boundary snap, if the next transcript word is within `absorb_trailing_silence_max_sec` and the intervening audio is quiet, extend `end` to `next_word_start − absorb_trailing_silence_retain_sec` (default 0.4s breath). Prevents restart/ripple joins from leaving a double-breath of leftover dead air. Distant next words are skipped so multitrack ripple medians stay safe.
- **Retained breaths in Tighten proposals** — after pacing, clamps and voiced nudges, `protect_cut_breaths` preserves confirmed complete breaths at both final edges of a cut without a paced pad by shrinking the cut (a padded filler cut fades each edge against silence and is checked for the next word's onset and whole kept words instead; [filler cut quality](filler-cut-quality.md#policy) § Padded cuts). Completion includes quiet onset and tail with measured floor separators and the unchanged speech/kept-word/sibilance gates. Relevant protected or incomplete connected activity, and unavailable acoustic evidence, suppress the proposal. A pause trim does not take this path. It shrinks to the longest stretch of air inside it, measured against each recording's room tone (read once, where nobody in the session is speaking, and how far it spreads), so no edge sits inside a sound that rises out of the room on any track the ripple cuts; a pause trim that passes the current filler checks can apply, and one that moved off the span pacing proposed says `:air_edges` ([filler cut quality](filler-cut-quality.md#proposed-decision-pause-trims-cut-only-air), #1055). Silence and unrelated rejected activity stay clear. Kept-word eligibility and final scope/voice checks are revalidated before risk, pad, join and fade; the pad is paced from the final span, so an edge that moves resizes it (#1074). Exact breath endpoints stay unchanged. See [filler cut quality](filler-cut-quality.md#policy) for the bounded detection contract and listening limits.
- **Applying optimized proposals** — automatic prefix application uses the stored range when `boundary_mode` records prior optimization. It does not snap those guarded edges again. Unsnapped pending edits still use the workflow's `inaudible_opt` setting; explicit approval already consumes the saved range. Coalescing keeps decisions with different boundary modes separate, preserving each row's optimization policy.
- **Cuts across recordings** — if timeline endpoints map to a missing or non-increasing source range, the optimizer preserves the requested timeline boundaries. It cannot optimize across different recording clocks as one source interval. Applied removals retain cut transcript words in their matching source archive for later boundary restoration (see [DAW editing](daw-editing.md)).
- **Non-dialogue tracks** (music, sfx, intro, outro) — waveform-only snapping; no transcript dependency.
- **Joins** — per-clip `join_in_mode` controls render behavior (see **Fade vs crossfade** below).

## DAW snap overlay

Sharecut Studio paints a **quiet wash** from the loaded peak-pyramid tiles (max-pooled per CSS pixel over the mounted tile range, at 8 px/s and above) and **snap ticks** from `GET /api/waveform-snap` / guest `daw/waveform-snap` (`EditService.waveform_snap_window`). That reuses `preview_inaudible_cut` and windowed `silence_islands_from_hops` — not a second snapper. Blade/trim/pending-edge drag magnets to those ticks (`snap=true` on `UpdatePendingEdit` is the same optimizer). Viewers get the wash; Commenters and Editors get ticks + magnet. Ticks load around the dragged trim edge, else the blade hover inside the clip, else the paused playhead inside it, after an 80 ms debounce; a playing playhead does not fetch ticks. Overlay fetches abort when that focus moves and must not stall pointer or play.

## Fade vs crossfade

Each clip stores `join_in_mode` for how it meets the previous clip on the same track:

| Mode | `join_in_mode` | Render | Timeline cost |
|------|----------------|--------|---------------|
| Fade (default dialogue) | `fade` | Hard concat; per-segment `afade` declick | 0 |
| Crossfade (opt-in overlap) | `crossfade` | FFmpeg `acrossfade` blend | Consumes overlap |
| Hard cut | `cut` | Plain concat; the fades at this join (left clip's fade-out, this clip's fade-in) are ignored (a track's first clip has no join, so a leftover cut mode there changes nothing) | 0 |

Normal dialogue **ripple** cuts from tighten, NL, and focus set `join_in_mode=fade`. Mute-in-place (`tighten.edit_mode: mute`) does not split clips or change joins — it writes `Clip.mute_regions` and fades the clip out into each region and back in after it with the padded cut's fades (`filler_pre_pad_fade_out_ms`, then `recommend_post_pad_fade_in_ms`), over room tone (the default `filler_pad_mode: room_tone`) or, with `filler_pad_mode: silence`, silence (see [filler-cut-quality.md](filler-cut-quality.md) § Mute vs cut).

**When to use which:**

| Situation | Tool / behavior |
|-----------|-----------------|
| Normal dialogue cuts (tighten, focus, ripple, NL) | Automatic — `join_in_mode=fade`; no extra call |
| Cuts still clicky | `fade_joins_tool` / `podcast edit fade-joins` / Sharecut Studio clip inspector |
| Per-clip join mode **and fades** | `set_clip_join_tool` / `podcast edit set-clip-join` / Sharecut Studio join control (`fade` \| `crossfade` \| `cut`; crossfade sets left fade-out and right fade-in to `length_ms`, default `tighten.crossfade_ms`; cut zeroes both, so a later Fade/Crossfade reseeds the defaults; undo restores the earlier fades). `set_join_mode_tool` sets the mode only, so a crossfade with no fades renders as a plain join (its result reports `join_crossfade_blocked`) |
| Re-render old project / fix multitrack sync | `fade_joins_tool` then `assemble_timeline` |
| Music bed, intro/outro blend, explicit overlap soften | `crossfade_joins_tool` / `podcast edit crossfade-joins` |
| Harsh boundaries from analyze | `recommend_fades_tool` → `apply_fade_recommendations_tool` (fade mode) |

Crossfade curve for overlap mode only: `render.crossfade_curve` (default `tri`).
The saved predecessor is the partner. Native sequential crossfades extend only
that connected component, including when a short middle clip lets the next
transition reach earlier connected audio. An unrelated enclosing clip remains
an independent actor. The overlap is capped by half the first retained right
source piece, with the existing 1 ms minimum, rather than the whole right body.
For an authored playback window, that cap uses the selected first piece.

Clips selecting different recordings use the same fade, cut, crossfade, gap, and
overlap assembly graph as clips sharing one source. Segment playback preserves
fades at real clip boundaries; seeking into the middle of a clip adds no fade at
the playback window edge. Transcript gating runs once on the assembled segment.

Future cuts only — existing committed edits are not retroactively re-optimized.

If a waveform window cannot be decoded while optimizing a cut or scoring an optional neural join, the safe fallback remains in effect and the failure is recorded at debug level for diagnosis.

Ordinary clip bodies that meet at their effective component ends use native
concatenation, preserving submillisecond CUT sample boundaries. Independently
placed overlapping actors stay outside the saved predecessor crossfade chain.

## Covered operations

- Transcript cuts: `cut_time_range`, `cut_text_match`, `cut_utterance`, `cut_words`, `apply_edit_plan`.
- **Filler/pause tighten** — proposals and apply both use waveform optimization when `tighten.inaudible_opt: true` (default). Lexicon membership is in [filler-cut-quality.md](filler-cut-quality.md); discourse markers (`like`, `you know`, …) are demoted there and are not cut from fluent speech.
- Timeline cuts: `ripple_delete`, `ripple_delete_text`, `shorten_gaps`, clip split/rejoin. `shorten_gaps` maps word gaps in batches against one clip snapshot, then applies each merged removal right to left with `ripple_delete` so clip holes, fades, edit records, and regional render invalidations retain their usual behavior.
- `strip_silence` rebuilds speech islands from silence detection (padding from silence interiors). It does **not** run `optimize_source_cut_range`; `--inaudible-opt` / `use_inaudible_opt` on strip are accepted for API compatibility and ignored. Joins still get micro-fades via `recommend_micro_fades`.

NL editing tools and CLI commands are listed in [nl-editing.md](nl-editing.md).

## Narrative handoffs

For narrative handoffs, omit track and speaker on `suggest_handoff_cut_tool` or CLI `suggest-handoff-cut` to require quiet across every dialogue lane, including saved-muted dialogue. Music is excluded. Explicit track or speaker selects one lane. The domain receives an explicit track collection and builds RMS caches once for the scan. Each common timeline hop uses the maximum lane RMS, so any audible lane blocks that hop. Missing measurements or incomplete cache coverage cannot qualify a hop as quiet. Each proposed boundary must lie in a shared measured quiet island; the suggestion does not certify audio coverage throughout the removed interval. Intentional zero-filled timeline gaps remain silence. Results include `track_ids`, with `track_id` populated for one lane and null for multiple lanes. Lock approved bounds with `use_inaudible_opt=false`, then audition the join.

The default optimizer is a **local** boundary tool — not a multi-second transition planner:

| Mechanism | Behavior | Wrong for handoffs because… |
|-----------|----------|------------------------------|
| `preview_inaudible_cut` / default opt | Snap within ~`max_shift_ms` + word-safe anchors | Does not search silence islands or plan a beat |
| `absorb_trailing_silence` | Extends cut end through quiet air, **retaining ~0.4s** before the next word | Actively removes the room-tone beat between punchline and closing pivot |
| Word-aligned OUT/IN | OUT at soft-coda start, IN at pivot word start | Can nick quiet “um” blobs; feels abrupt |

**Prefer:** keep about 1s of existing air after the punchline and before the pivot (`keep_left + retain` / `keep_right − retain`, snapped to local quiet), then lock bounds with `use_inaudible_opt=false`.

Helper: `edits/silence_islands.py` → `suggest_handoff_cut` / MCP `suggest_handoff_cut_tool` / CLI `podcast edit suggest-handoff-cut`. Given timeline `keep_left_end` + `keep_right_start`, it places `cut_start` / `cut_end` at the requested beat on each keep (clamped if the gap is shorter) and snaps onto a **measured RMS silence island** across the selected lanes. Transcript word gaps are not silence — um, chair noise, and bleed with no token still block a join if they sit at the retain target. Audible junk *between* the bounds is removed with the ripple. If a bound is still in energy after snap, the suggestion is not ok.

For the single-lane workflow, pass `--track host` or `--speaker Host`. A session handoff should omit both selectors.

**Tune the beat with `retain_sec` / `--retain-sec`** (default `1.0`, applied on *both* sides, so a default call leaves ~2s of air at the join). That is fine for a punchline beat but too long for a tight conversational handoff; a real run needed `0.3`–`0.6` to keep the join snappy. Nothing tunes this automatically — pass it explicitly per join.

Do **not** loosen global `absorb_trailing_silence_retain_sec` for this — handoffs opt out by locking suggested silence bounds.

Audition ~10–15s around the join before resolving review comments. Prefer existing room tone over `insert_gap` of pure silence unless the user asks.

**Pad source order** with the default `filler_pad_mode: room_tone` (an approved mute's fill uses the same order): (1) recorded `track.room_tone` bed from the lobby capture (abutting tiles if the pad is longer than the bed: fade-in on the first tile, fade-out on the last); (2) a steady stretch of the track's own audio at its noise floor, at least 30 dB under its speech level and voice-free, nearest the cut, chosen from the audio and not from word times (#1054; rules in [filler-cut-quality.md](filler-cut-quality.md) § Where room tone comes from); (3) skip the pad rather than tiling dialogue, bleed, or digital silence. Set `filler_pad_mode: silence` for a hard silent gap instead. A digitally silent recorded bed is treated as missing. The bed check reads the registered source path that clips render. Manual gap fill, MUTE, and nonpause filler/NL pads retain their existing sample and unfilled-gap behavior. A pause-floor shortfall never generates a pad, including when silence is configured. Missing media, decode failure, digital silence, gated live audio, absent/short/excluded runs, CHECKS failures, unreadable windows and the nearest-sixteen limit remain distinct measurement facts. Mixed failures retain actual rejection names and unreadable-window counts; absent VAD keeps the existing level checks.

Pause retention counts current once-only original quiet on both sides of the final
removal. Complete placed flanking words and actual sound activity bound the query.
Exact paired mappings qualify source pieces across abutting clips, including retained
inner pieces beside deleted source interior. Mutes, ignored regions, replay, foreign
media, registered beds, and known pad samples earn no duration. Renderer-selected paths
resolve aliases of the same recording. Current clip fields cannot prove the history
of an indistinguishable replacement. A small set of right, left, and bilateral
contractions reruns every ordinary preparation gate and finish with both bounds pinned.
The first fully finished attempt is selected and the caller finishes it again.
If no attempt retains enough original quiet, the pending pause holds unchanged.

Pause removal still uses guarded whole sounds. Recording observations refine each
outer edge independently with its measured voice anchor and adjacent original pause.
The complete release-to-onset corridor is filtered and smoothed once per measurement
with native DSP. Every frame of an outer collar, at least five complete frames,
must lie at or below the corresponding original reach in both bands. Missing, nongrid,
nonfinite or clipped corridor or full-guard samples preserve the guard. Refinement
also requires one full current guard placement and no extra same-media image
touching it. Deleted interior and replay confined to the corridor interior do not
invalidate the measurement or supply retained duration.

The final plan owns finite per-lane source fades for splices and pads. Consumption
assigns those exact effects after the kernel instead of maxing the scalar
recommendation onto survivors. Safe authored fades remain, while provisional split
fades are replaced. The existing archive carries actual edge footprints and
inserted sample tiles. See [filler cut quality](filler-cut-quality.md#policy).

## Configuration

| Key | Role |
|-----|------|
| `enabled` | Master switch (default `true`) |
| `search_window_ms` | Local search radius around each boundary |
| `max_shift_ms` | Maximum allowed boundary shift |
| `min_word_margin_ms` | Minimum distance from retained word boundaries after snap |
| `micro_fade_ms` | Default fade length at optimized joins |
| `short_cut_max_sec` | Only apply trailing-energy end extend when cut ≤ this (default `1.2`) |
| `trailing_energy_extend_ms` | Max forward search / chew when end is mid-filler energy (default `350`) |
| `trailing_energy_hot_db` / `trailing_energy_quiet_db` | RMS thresholds for “still speaking” vs quiet enough to stop / skip |
| `absorb_trailing_silence` | Extend cut end through quiet air before the next word (default `true`) |
| `absorb_trailing_silence_retain_sec` | Breath left before the next word (default `0.4`) |
| `absorb_trailing_silence_max_sec` | Only absorb when next word is within this gap (default `2.0`) |
| `absorb_trailing_silence_quiet_db` | Max RMS in the gap to treat as absorbable silence (default `-45`) |
| `weights.energy` / `zero_cross` / `continuity` | Candidate scoring weights |

## CLI

```bash
podcast edit preview-cut --project episode.project.json --track host --start 32.4 --end 34.8
podcast edit suggest-handoff-cut --project ... --keep-left-end 2154.0 --keep-right-start 2167.0
podcast edit suggest-handoff-cut --project ... --keep-left-end 2154.0 --keep-right-start 2167.0 --retain-sec 0.4  # tighter conversational join
podcast edit join-quality --project ... --track host --join 12.5 --timebase timeline
podcast edit join-sweep --project ...
podcast edit cut-range --project ... --track host --start 32.4 --end 34.8   # optimized by default
podcast edit cut-range --project ... --no-inaudible-opt                    # exact requested boundaries
```

Cut-producing commands that accept `--inaudible-opt` / `--no-inaudible-opt`: `cut-range`, `cut-text`, `cut-utterance`, `ripple-delete`, `shorten-gaps`. (`strip-silence` still accepts the flag for compatibility but ignores it.)

## Join continuity (perceptual splice QA)

Join detection shares one 50 ms tolerance (`JOIN_GAP_TOLERANCE_SEC`) and one
predicate (`clips_abut` / `abutting_pairs` in `edits/clips_ops.py`) across
clip editing, audio audit, and timeline rendering. Gaps at or below the
tolerance are treated as joins; larger gaps remain intentional timeline space.
Render-side consequences (gap closing, crossfade overlap) are in
[filler-cut-quality.md § Render joins](filler-cut-quality.md#render-joins).

FOSS multi-detector join scoring (`edits/join_continuity.py` + paper reimpl in
`edits/join_cost_spectral.py`): click, level, spectral flux, MFCC/LSF/MCA join
costs (Vepa & King), noise floor, F0, onset, bicoherence proxy, late-energy /
RIR proxy. Optional neural layer (`joinqc` extra: NISQA discontinuity + WavLM
continuity) may only elevate risk. Explicit A/B labels → numpy ranker; tighten
gate (`tighten.join_continuity_gate`) skips proposed cuts with verdict `fail`.
The gate scores a butt splice, so Tighten runs it only on cuts that approve as
one (no `replace_gap_sec`). A filler cut with a paced pad never abuts its two
edges: each fades against silence, and the owner heard such cuts as clean that
this gate failed (0.49–0.68 on the four lab cuts in #978), so it is skipped for them.
The spectral and optional neural scorers keep their native score formats;
adapters implement `JoinDetector.detect()` and return weighted `DetectorHit`
values to the fusion step. This keeps detector policy in one place while the
published report format stays stable.
An existing join is scored on the audio the render abuts: a timeline join that
sits on a clip splice (`clips_ops.splice_joins`: the right clip does not resume
where the left clip's source stopped) reads the source before the left clip's
`source_end` and after the right clip's `source_start` (`SplicePoints`); any
other instant reads both sides of that one point. Before #775 the sweep mapped
the join to the resume point alone and scored raw source continuity there, which
passed a cut that resumed inside a phrase. A splice whose two sides are both below
`join_continuity.inaudible_floor_db` (-60 dBFS RMS over the 45 ms side windows, e.g.
room tone against Zoom's gated digital silence) is an **inaudible splice**: risk 0,
verdict `pass`, one `inaudible_splice` detector carrying both levels, instead of a
level-jump `fail` nobody can hear. On the lab tape that turned 7 of 8 sweep fails
into passes and left the one real clipped onset. That floor is the only level rule:
a "masked by a louder stem" pass was tried and removed, because the sweep reads raw
source levels and what the mix plays depends on staging gain, fader, mute and the
transcript gate (the mixer's job, not a second copy of it). The lab's caleb join at
106.02 s (room tone at -59.5 dBFS into digital silence, 0.5 dB above the floor)
therefore still fails after the Lana fix; the skill's loop ends there with one
listen, then accept or waive. Each sweep row also carries `speech`
(`edits/join_speech.py` crossings at that join: clipped onset or tail, voice
edge, `removed_ms`, `suggested_source_sec`, `asr_disagrees`) and the report a
`speech_cross_count`. A row with a `speech` crossing is never a `pass`: the
continuity detectors score the splice's texture, and a cut through the track's own
voice is a defect whatever they score, so such a row reads at least `review` with
the reason `voiced speech cut through this join (see speech); never a pass`. The
audition context raises the same crossings as
`speech_crosses_cut` (see [audio-engineering.md](audio-engineering.md#agent-audition-context-v2)).
The gate measures splice texture, not content: a cut that starts inside a word at
-10 dBFS and resumes inside the untranscribed onset of the next word reads as
continuous (audra 1485.417 s on the aligned lab run scores 0.28 `review`), while
the same cut started in the gap reads as a level and spectral jump (0.61 `fail`),
although the second is the shape of every natural word onset. Tighten proposals
therefore settle their edges before the gate sees them (`fillers._check_voiced_speech`
over `edits/voiced_runs.py`, [filler-cut-quality.md § Voiced edges](filler-cut-quality.md#policy)):
an edge inside a kept word's voice is moved out of it or the cut is reviewed, so the
gate never gets to bless an in-speech edge for texture. The gate's verdict still
flips at its 0.48 threshold on 3–6 ms edge shifts; that sensitivity is unchanged
here and tracked in #815.
The project join sweep reuses each track's decoded waveform, natural-join
calibration, and high-rate source reader across its joins. PCM WAV checks seek
bounded windows through one open reader. Other containers use FFmpeg to seek
independent short source windows, two per join (one per splice side), in
batches of at most 16 joins; temporary PCM output is discarded after each
batch, so a long source is never decoded wholesale for click checks. If a batch
fails, each affected join is retried with the individual short-window decoder.
Individual join scoring reads only a short window around its join.
MFCC scoring shares an immutable mel filterbank for equal sample rates and FFT sizes.

Every report includes a disclaimer — not PEAQ/POLQA and not a human-ear guarantee.
Fusion rule of thumb: ≥2 detectors with score ≥ 0.65 → at least `review`.
Verdict bands (`join_continuity.pass_below` 0.28, `review_below` 0.48): risk below
0.28 is `pass`, below 0.48 `review`, else `fail`.

**Edge tolerance (#822).** Several detectors read very short windows (the click
detector 2 ms, onset 10 ms, spectral flux one 16 ms frame), so a point score moves
by a few hundredths when an edge moves a few milliseconds, and 16% of the lab's
tighten candidates sat within ±0.02 of the fail line. A verdict is therefore taken
over every edge placement within `join_continuity.edge_tolerance_ms` (3 ms): each
edge is scored at −tol, 0 and +tol (nine placements for a proposed cut or a clip
splice, three for a single point) and the riskiest placement decides. That fails
closed and roughly halves the verdict flips a nudge or a re-timed word inside the
tolerance causes; it does not remove them, since the score stays a continuous
statistic against a hard threshold. Measured with the real gate on the lab tape,
shifting every gated candidate's edges by ±3 and ±6 ms (left, right, both): point
scoring flips 147 of 1296 shifted scorings on the Whisper run (41 of 108
candidates) and 643 of 5712 on the aligned run (184 of 476); the 3 ms tolerance
flips 74 of 1296 (26 of 108) and 285 of 5712 (94 of 476). The report carries the
worst placement's detectors and, when it is not the edges as proposed, the reason
`worst edge placement +0/+3 ms within +-3 ms`.
Inaudibility is decided at the proposed edges only: a splice both of whose sides
sit below `inaudible_floor_db` there passes, whatever a placement 3 ms away reads,
because the floor is a hard threshold and taking the worst placement across it
would fail a clean quiet-air cut whose 45 ms window happens to catch a few louder
samples when moved (caleb 1339.500 on the aligned lab run: −62.1 dBFS at the edge,
−59.8 at −3 ms). Quiet air just above the floor has a second problem: the
spectral-shape detectors (flux, MFCC / LSF / MCA join costs, F0, bicoherence)
compare level-normalised spectra, so two windows of −48 dBFS room tone read as a
full mismatch and a clean solo-pause cut scored 0.47 on trunk, which the worst
placement pushed past 0.48. Their weight therefore ramps from 0 at
`inaudible_floor_db` to full `join_continuity.spectral_audibility_db` (30 dB) above
it, judged on the splice's louder side, while the level, noise-floor, click and
onset detectors keep full weight (a −46 dBFS room tone cut into digital silence
still fails on its level jump). On the aligned lab run stacked with PR #821, the
combined changes increased decisions from 102 to 137. Of 34 same-key proposals that
had previously been dropped, 23 graded clean, six marginal and five bad under the
reviewer's rule; five same-key proposals disappeared and all five graded bad.
Candidate keys also changed between runs (12 old-only and 15 new-only), so these
are comparisons of matching keys rather than a claim that every proposal is
unchanged. `0` keeps full spectral weight everywhere. The natural-join baseline
below is scored the same way so calibration compares like with like. Cost: the
complete three-by-three grid requires up to nine detector passes per splice; the
proposed-cut report uses that full grid so its risk and detector list describe the
same worst placement. `edge_tolerance_ms: 0` restores single-point scoring.

**Determinism (#812).** Calibration scores `calibrate_n` natural (uncut) points
drawn from a fixed-seed generator over the track's samples, so a sweep repeated over
the same project reads identical verdicts and risks; there is no wall-clock or
process state in a verdict. The run-to-run variance #812 reported came from
comparing sweeps taken at different heads of PR #787 (the module changed between
its review rounds), not from the baseline: five trunk sweeps over the same clone
were byte-identical.

**Audio for harvest / demos:** use the in-repo short fixture
`tests/fixtures/join_continuity/` (~3 s stems). Do not point tools at huge
external episode trees; copy short clips into that fixture’s `raw/` if needed.
`scripts/harvest_join_labels.py` refuses paths outside the podcast_mcp repo root.

See also [filler-cut-quality.md](filler-cut-quality.md) for gate + re-enable criteria.

## MCP

- `preview_inaudible_cut_tool` — dry-run: shifted boundaries, mode, confidence.
- `suggest_handoff_cut_tool` — retain ~1s on each keep, snap to quiet, for narrative handoffs (timeline clock); prefer with `use_inaudible_opt=false`.
- `join_quality_tool` / `join_qa_sweep_tool` — score one join or sweep every splice (default timebase `timeline`); sweep rows carry `speech` (voiced speech cut through at the join) and the report `speech_cross_count`.
- `audition_context_tool` — `speech_crosses_cut` for every splice in the window plus `echo_risk` and `clip_skew`; its `evidence.fix` names the `trim_clip_edge_tool` call (`mode=ripple` for a session-wide cut, so every track's edge moves and the episode stays in sync; `mode=gap` for a track-local punch, so only that clip's edge moves).
- `join_label_tool` — record explicit pass/fail A/B labels into `artifacts/join_labels.jsonl`.
- `update_pending_edit_tool` — nudge a pending decision’s source range; `snap=true` (default) runs `optimize_source_cut_range` before save (Sharecut Studio drag/inspector uses the same path via `UpdatePendingEdit`).
- Cut tools accept optional `use_inaudible_opt=false` to skip optimization for one call.

## Skills

- Tighten / NL cuts: `.agents/skills/podcast-tighten-dialogue/SKILL.md`, `.agents/skills/podcast-edit-natural-language/SKILL.md`
- Join QA: `.agents/skills/podcast-inaudible-cuts/SKILL.md`
Tighten proposals build a read-only word index per track before parallel cut
analysis. Boundary snapping and next-word lookups reuse it, including the
original transcript order when words are unsorted. Candidate-specific retained
boundary exclusions use a nearest-valid lookup against that span. The pause
floor reads a per-proposal peer-word overlap index; acoustic gap checks read the
peer tracks' voiced runs from the shared audio caches instead.
