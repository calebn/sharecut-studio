---
name: podcast-mute-bleed
description: >-
  After transcript reconcile, mute or turn down another speaker's verified voice on
  a mic (auto: mute on a gated call track, 20 dB on a room mic) while preserving the
  mic owner's speech and uncertain audio,
  with local retained-bleed alignment where the gate abstains. Use when transcript bleed is fixed but wrong-mic
  audio is still audible in stems or premix — not for changing suppression flags
  (podcast-transcript-reconcile).
---

# Mute bleed (transcript-gated stems)

**Prerequisite:** [podcast-transcript-reconcile](../podcast-transcript-reconcile/SKILL.md) — `overlap_duplicates_tool` → `text_match_count == 0` on the pairs `echo_risk` names and combined transcript is clean. Identical words on a pair with no measured path, and words on a one-way pair whose onsets do not fit the measured lag, are two people talking and stay after reconcile (#774); they do not block this skill.

This skill applies **waveform** gating derived from reconciled transcript metadata. It does not change word text or suppression flags.

Reconcile can measure bleed from mapped raw media when stems are absent. Automatic attenuation still requires fresh rendered stems. Dry-run review discovery does not require a stem.

## When to use

- `audition_context_tool` / `podcast play context` reports **`echo_risk`**: one mic carries another speaker at a consistent lag above the same pair's time-shifted null. Reconcile may already tag those copies as suppressed `bleed`, but this acoustic operation verifies candidates independently from ungated selected media. A measured pair is a reason to inspect the gate preview, not permission to mute every untranscribed sample. Confirm the named relationship with `suggested_listen` or per-pair evidence, then inspect `attenuation_count` and `gate_reasons`.
- Transcript search/NL edits are clean but `play --compare` still shows bleed on the wrong mic.
- Pass-1 or post-FX stems exist under `artifacts/tracks/`.
- Reconcile has run and `suppressed` words mark bleed on the off-mic track.
- `analyze_cleanup_tool` reports `high_bleed_warning` on a track (`bleed_ratio` ≥ `analysis.heuristics.bleed_ratio_warn_threshold`, default `0.2`) — this is a strong signal the session has genuine multi-mic bleed (not isolated crosstalk), where transcript suppression alone leaves the wrong-mic audio audible. If the off-mic capture is *louder* than the direct mic on flagged words (compare `own_rms_db` vs the dominant track's RMS in `audibility_map_tool`), also flag mic gain-staging/placement to the user for future recordings — that's a source-side problem this workflow can't fully fix, only mask.

## Tools

| Tool | Use |
|------|-----|
| `apply_transcript_gate_tool` | Dry-run shows per-track `attenuation_count`, `bleed_reduction`, `bleed_bed_db` and `gate_reasons`; apply sets `transcript_gate` + rewrites stems (windowed when start/end given) |
| `align_retained_bleed_tool` | Preview or apply supported local corrections for retained bleed; select the bleed lane and timeline window |
| `set_retained_bleed_alignment_mode_tool` | Persist manual/declined timing decisions, including preview proposals; auto resets a decision |
| `overlap_duplicates_tool` | Confirm transcript bleed is already zero before muting audio |
| `play_audio_tool` | Audition gated vs raw in the bleed window |
| `play_compose_tool` | Hear the two-mic relationship at once (no music / extra mics) |

**CLI:** `podcast edit apply-bleed-mute` (`--dry-run` to preview; `--track` / `--speaker` to scope)

## Workflow

1. Confirm transcript reconcile: `overlap_duplicates_tool` → `text_match_count == 0` on the `echo_risk` pairs (co-speech elsewhere stays, #774).
2. Ensure stems are fresh **and not longer than the session timeline** (`render_dialogue_stems` or `assemble_timeline`). Bleed mute skips stems that fail `stem_is_fresh` (hash or overlong duration).
3. `apply_transcript_gate_tool` with `dry_run=true` — review `attenuation_count`, `bleed_reduction` (with the `bleed_bed_db` it was resolved from) and `gate_reasons` per track; check `skipped` for stale stems. `interval_count` is a compatibility count of retained transcript spans, not a measure of justified acoustic removal.
   If apply fails with "another render of this project is in progress", an export or Refresh holds the render lock: retry when it finishes.
4. Inspect the default `alignment` preview. The transcript-seeded planner skips copies the gate would already reduce, so it acts where the gate abstains. Preserve both speakers during overlap. Only supported complete direct phrases move; uncertain mixed audio stays intact. Unsupported regions remain in `skipped`. Explicit bleed-lane selection with finite start/end also discovers complete direct owner phrases without copy words. Other requests remain transcript-seeded. Both origins exclude owner seeds with bleed status, another dominant lane or another speaker-match lane; retaining foreign text manually does not authorize a timing move. Completed selected-source intervals also refuse foreign attribution in merged gaps or completion margins, even on suppressed/ignored rows included in raw evidence. Other-source or outside-interval attribution does not veto. The bounded planner keeps every active unmuted placed peer unless full-channel quiet evidence excludes an unknown peer; an unverified or conflicting peer vetoes the move. It builds no fresh whole-recording gate plan and never infers copy absence from weak evidence. `no_retained_bleed_candidate` means no permitted transcript or bounded owner-phrase candidate exists, so alignment remains unmeasured. Preserve the audio and review the mix; do not describe it as aligned or copy-free. Save a different user choice with `set_retained_bleed_alignment_mode_tool`, using the proposal's decision ID and the same window. Saved manual/declined choices survive reopening and take priority. Saved choices also follow the same recording when a track move pins it to an equivalent source reference. Manual recorder locks survive splitting and trimming the same recording; a scoped override leaves other fragments protected; `auto` releases the saved timing hold for future planning; it does not undo an applied move. An explicit scoped `override_placement_lock` permits correction past a legacy recorder lock but does not override a saved choice.
5. Apply on one track or both; audition with `play_compose_tool` (both mics at once) or `play --compare` in the bleed window.
6. Re-run mix/premix after gating (never pad gates to a longer source-length file).

## Design

- The acoustic gate defaults to unity gain. Where it acts it reduces the copy per `analysis.heuristics.bleed_handling` (#945): `auto` (default) turns it down by `bleed_attenuation_db` (20 dB) on a lane whose bed (median level away from its own speech and the copies) stays above the −90 dBFS 16-bit floor once turned down, keeping a room mic's bed steady, and mutes otherwise, as on a call app's gated track; `mute` and `attenuate` override it. On the lab tape every Zoom track resolves to `mute` (Caleb's quiet frames are 76% digital silence, room tone −80 dBFS median). Full level holds 40 ms before and 80 ms after the owner's speech, then a 20 ms ramp: with aligner word times, the level just outside the spans only reaches the mic's bed at that hold. Suppression alone never authorizes a reduction.
- Copies are found from the peers' own tracks, not from this lane's transcript. Both lanes' syllable contours (8 kHz level envelopes, 100 ms frames, less their half-second mean, any channel count) must show a copy path at one lag within ±300 ms, a peak at least one hop inside the search, that beats shifted nulls (`engines/envelope_lag.py`). The match must carry the evidence of correlation 0.4 over 30 s of the peer's speech (Fisher z times the square root of the frame count), so a short excerpt needs a stronger match, 0.48 over 20 s, and under 20 s the gate abstains. The copy's timbre must then confirm the lag: on the frames that carry the copy, the fine-spectrum likeness with the peer at the lag must beat the same frames against the peer's speech 1 and 2 s away by 0.15 (a null under 0 counts as 0). When the peer is silent at all of those (short bursts far apart), its speech 3 to 10 s away, pooled, is the comparison; with none there either the lag is not confirmed (`copy_timbre.confirmed_likeness`, shared with reconcile, #1070). So own sound at its own pitch that starts and stops with the peer's (laughing together, the same cadence) is no copy. Own sound that follows the peer's pitch (singing in unison, speaking along at the peer's pitch) still reads as a copy: from 20 s here, from 30 s on main (#1190). A copy of a near-monotone, sung or repeated-phrase peer can fail the check and keep its bleed (in synthetic trials a near-monotone peer's copy passes 30 to 34 of 100 from 30 s; main passes all). Otherwise `uncertain_foreign_ownership`. A remote speaker's own track can trail their in-room copy (140 ms on the lab tape). Every frame the peer's direct track reaches at that lag is foreign, whether or not a bleed word marks it.
- The lane's own speaker is never reduced. Own speech is judged against the **expected copy level**, not the peer's direct track: the direct track at the lag plus the measured coupling (the copy's median level against it, about −20.6 dB for Audra on Caleb's mic), plus the mic's noise floor. Sound more than the copy's spread over that (the 95th percentile of the copy's level over the coupling, 10.5 dB on the lab) is own voice whatever its timbre. Nearer it, each 0.2 s window is the copy only when the median fine-spectrum match (harmonics and formants) of its frames 2 dB over the expected level against the peer's direct track reaches the copy's likeness, the 40th percentile of that match on typical copy frames (0.36 on the lab). Own sound needs 50 ms more than 4 dB over the expected level and is held through dips up to 150 ms; it is protected with or without a transcript word. Unsuppressed own words and their connected voiced runs (stopping where a peer talks) and untranscribed placements stay protected too. Own sound less than about 4 dB over the copy (an "uh-huh" more than ~12 dB under the peer's direct track on the lab) cannot be told from it and is reduced with it. During crosstalk the owner's speech is protected, so its copy of the peer stays; alignment handles that.
- A direct track gated shut is no evidence either way. Where the owner's track gates open late, the copy is still reduced; bleed is never kept as the main audio for another speaker, so a late-gated onset can be quieter in the mix (#945).
- Apply sets `track.transcript_gate = true` and persists `transcript_gate_scope` in project history. Optional `start_sec`/`end_sec` selections map through `SessionTimeline` into source ranges and identities, follow selected media after edits, and survive reopening. Repeated applies rebuild from ungated media; they do not multiply an existing fade.
- The same absolute attenuation envelope drives full and segment renders. Fades lie inside verified foreign regions, so a segment boundary does not introduce a new fade. Source proxies abstain when the lane selects other media than its primary raw source.
- Crossfade layouts abstain from gate reconstruction and alignment when raw placements and rendered clocks can diverge. Inspect their explicit skip reason.
- Local correction uses each clip's selected recording and its matching transcript, including secondary recordings. Missing direct phrase evidence, implicit timelines without editable clips, and conflicting correction footprints produce explicit unresolved reasons. Delay measurement reads bounded local context for lag and shifted-null checks, rather than whole recordings.
- Batch corrections preserve every measured reference region. Interacting moves abstain, including reciprocal and secondary-reference dependencies. Duplicate seeds expanding into the same complete phrase produce one correction. Unsupported measured interior probes block whole-phrase approval.
- Local correction requires independent, consistent delay probes and quiet phrase boundaries. It never shifts a whole track to resolve one section or stretches voiced audio. Sampled residual agreement does not prove samplewise perfect alignment or a unique room path.
- A successful apply or enabled flag does not prove useful bleed reduction. Check `attenuation_count`, compare stem RMS before/after in passages where only the other speaker talks, and listen. Peer words that reconcile left unsuppressed on this lane count as its own speech, so their copies stay at full level; report that residual honestly.
- Do **not** run before reconcile: the peer's words on this lane would still read as the owner's own unsuppressed words, so their copies stay protected at full level.

See [docs/transcript-reconcile.md](../../../docs/transcript-reconcile.md#acoustic-follow-up-preserve-speech-while-reducing-verified-bleed).

## Reviewed fallback

Dry-run `review_candidates` are transcript-derived listening hypotheses, including on stereo or missing-stem refusals. Each names the receiving lane and foreign peer, exact source/timeline bounds and a serialized `target`. They do not prove owner absence. Listen to receiving raw audio, the named peer and the mix; never infer breath or thump absence from transcript words. Retained, all locked, ignored and uncertain word footprints, contradictory peers, unknown coverage and overlapping placements are excluded. Gaps and repeated occurrences remain separate.

Pass an independently reviewed row's unchanged `target` to `propose_range_mute_tool(project_path, target, command_id)`. Use a unique command ID per proposal; retry only the identical command with that ID. This creates pending exact MUTE. Only the interactive host can approve it. Rows cap at 16 and four seconds each, with `review_truncated` for omissions. Shared window-local exclusion diagnostics cap at 128 with `review_exclusions_truncated`; protection remains complete. Narrow the timeline request to inspect more.

Current geometry/stat seals neither hash media contents nor seal transcript metadata. Re-review after transcript changes. Use host processed playback or rendered pending previews: guest source-proxy timeline playback currently omits clip-local mute envelopes. See [reviewed bleed ranges](../../../docs/transcript-reconcile.md#reviewed-bleed-ranges) for undo, FX and mix normalization limits.
