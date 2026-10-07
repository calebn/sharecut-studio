# Transcript reconciliation and bleed detection

Operational guide for per-track audibility classification, bleed suppression, and overlap analysis. Complements the [podcast-transcript-reconcile](../.agents/skills/podcast-transcript-reconcile/SKILL.md) skill and [architecture.md](architecture.md).

For regression fixtures and CI thresholds, see [fixture-catalog.md](fixture-catalog.md).

---

## How bleed is detected

For each word window, reconciliation compares RMS on the word's own track against every other dialogue track at the same timeline position, or, for a mic with a measured bleed path into this one, at that path's copy lag ([below](#words-are-judged-at-the-copy-lag-1052); `compute_word_audibility_map` in `audio_audit.py`).

**Zero-duration / sub-5ms words** (ASR junk with `start == end`) cannot be RMS-measured. Isolated ones are tagged **`inaudible`** with `reason: zero_duration_word` so reconcile can suppress them out of `combined.json`. When the same track has **normal-duration neighbors** on both sides, the token is tagged **`deferred`** (`sandwiched_zero_duration_word`) and is **not** auto-suppressed — keeps glue words like `what` between `know` and `I'm`.

**Anomalously long words** (duration &gt; `max_word_audibility_sec`, default **2.0 s**) skip full-span mean RMS. `transcribe_tracks` already trims such spans onto their voiced audio ([transcript-workflow.md § Word-span plausibility](transcript-workflow.md)), so this guard sees only what the trim leaves: `overlong` words (more voice than one token, so missing words), words whose recording could not be decoded, and `ignored` words. Stretched Whisper tokens that cover speech + silence + peer talk would otherwise look like bleed/inaudible. They are tagged **`deferred`** with `reason: anomalous_word_duration` and are **not** auto-suppressed — neither mean-RMS nor identical-text overlap (`overlap_text_match_losers`).

A word is tagged **`bleed`** when another track's RMS exceeds the own-track RMS by at least **`bleed_dominance_db`** (default **6.0 dB**), the dominant track is above **`bleed_min_other_rms_db`** (default **−50 dB**), **and a bleed path from that track into this one is measured** ([below](#bleed-pairs-the-source-wins-by-lag-not-by-loudness-774)). On a pair with no measured path a quieter word is two people talking, not a copy: it keeps its own audibility (`audible`, or `inaudible` below `audibility_rms_db`) and `dominant_track` stays empty; the levels stay in the row's `track_rms_db` for review (#774). Measured on the lab tape: every acoustic bleed tag on a pair with the remote participant, and every tag of the co-host's mic as bleed of the host (no path that way; `bleed_echo` puts it below its null), was the speaker's own voice by pitch and spectrogram (caleb "hello", "Stay", "I"; audra "She's", "Keep", "Or", "beat", "Can"), so no `bleed` tag is written without a path. Reconcile uses rendered stems when available; when stems are absent, it projects raw media through `SessionTimeline` first. A missing raw source produces no measured path.

| Heuristic | Default | Meaning |
|-----------|---------|---------|
| `bleed_dominance_db` | 6.0 | Required RMS gap (other − own) for bleed |
| `bleed_min_other_rms_db` | −50 | Dominant track must be this loud or louder |
| `audibility_rms_db` | −42 | Own RMS below this → `inaudible` |
| `max_word_audibility_sec` | 2.0 | Longer ASR words → `deferred` (no mean-RMS suppress) |

Bleed uses **acoustic dominance**, not identical ASR text. Overlapping words with different transcripts are still bleed candidates when the other mic is louder.

When two tracks with a **measured bleed path** ([below](#bleed-pairs-the-source-wins-by-lag-not-by-loudness-774)) have **identical overlapping text** but dominance is below `bleed_dominance_db`, reconcile also applies **text-match suppression** (`overlap_text_match_losers` in `edits/bleed_text_match.py`). On a pair whose bleed runs one way the source mic wins by the path's lag. On a pair with bleed both ways the weaker mic’s word is marked `suppressed` with `reason: text_match_overlap`; winner selection uses audibility status, ASR confidence, then own-track RMS. Pairs where either word exceeds `max_word_audibility_sec` are skipped — a stretched token’s overlap is not a reliable duplicate. On a pair with **no measured path** identical words are two people saying the same thing, and both stay: on the lab tape every trunk text-match decision on a pair with the remote participant (8 Whisper, 4 aligned, 2 agent) was such a coincidence, with no true duplicate among them (#774).

**One target per word (#782).** Reconcile does not write the acoustic verdict and then the text-match verdict in turn. It computes one target per word — the acoustic verdict, overridden by `bleed` + the winner's track where the word loses an identical-text overlap — and `_reconcile_word` writes and reports only the fields that differ from the stored word. The text-match candidates are the words the acoustic verdict leaves unsuppressed, not the words currently stored as unsuppressed, so both verdicts derive from the audio and the text alone. A repeat run on unchanged audio and transcript therefore reports `0 suppressed, 0 unsuppressed, 0 reattributed, 0 status updates`; a non-zero count on a re-run means something upstream changed. `ignored` and `audibility_locked` words are outside both verdicts. The read-only `overlap_duplicates_tool` still excludes words by their stored `suppressed` flag.

**Scope bounds the write, not the target (#805).** `word_targets` (`engines/transcript_reconcile.py`) computes the target for every word in the project, whatever the pass's `track_id` / `start_sec` / `end_sec`. A track- or window-scoped pass writes only the words in its scope, but it judges each identical-text pair with the partner's *computed* target even when the partner is out of scope, never with the partner's stored `suppressed` flag. So the target a scoped pass reaches for an in-scope word is the one a full pass reaches, and alternating full and scoped passes (per-track auto-reconcile after an audio edit, then a pipeline or render reconcile) changes nothing after the first pass. Before this, a lana-scoped pass on the lab tape read the out-of-scope winner of lana "Bye." by its stored flag, found no winner, unsuppressed the word, and the next full pass suppressed it again. Computing every word's target costs no extra stem decoding: the acoustic map already covers every dialogue track because bleed needs the other mics' RMS. `word_targets` is the one place to read what reconcile would write, so previews and other readers cannot drift from the writer.

**Chain rule: a loser to a loser is still a loser.** Identical-text pairs on a bleed pair are judged independently. A word that loses its pair is suppressed even when its winner loses a different pair, because losing says only that this copy is the weaker recording of a word another mic already carries; the winner losing elsewhere does not make this copy the better one. On a chain A → B → C (A loses to B, B loses to C) the result is A and B suppressed, C kept. This rule only guarantees every pass, full or scoped, reaches the same answer. The lab tape's three-person sign-off (lana "Bye.", audra "Bye.", lana's second "Bye.") used to be such a chain and kept one "Bye." of three; those pairs have no bleed path, so all three now stay (#774).

**Preview equals apply (#791).** The one-target computation runs whether or not the call writes it. `reconcile_transcript_tool` with `dry_run=true` (and `podcast edit reconcile-transcript --dry-run`) folds in the text-match override the same as an apply, so a word that loses a text match is never listed as an `unsuppress` in the preview when the apply would keep it suppressed. `flag`/`suggest` mode (`update_status` without suppressing) tags a text-match loser's `audibility_status`/`dominant_track` as `bleed`/the winner's track too — the word is marked but not removed, matching what `reconcile` mode would do to it. Applying (`apply_suppression`) always writes `audibility_status`/`dominant_track` for every reconciled word in scope, even when a direct engine call passes `update_status=False`: a word is never left `suppressed` with a stale `audibility_status`/`dominant_track` from before the call.

| Heuristic | Default | Meaning |
|-----------|---------|---------|
| `bleed_text_match_enabled` | true | Suppress identical overlap dupes (loser verdict overrides the acoustic one) |
| `bleed_text_match_min_overlap_sec` | 0.02 | Minimum timeline overlap for text-match rule |

Configure under `analysis.heuristics` in pipeline defaults (workspace `pipeline.yaml` or `PODCAST_MCP_PIPELINE_DEFAULTS`).

**Success gate (transcript):** `overlap_duplicates` → `text_match_count == 0` after reconcile in the scoped window, ignoring remaining pairs that include an anomalously long ASR token, and ignoring pairs on a measured bleed pair whose onsets do not fit the path (next section): those are two people saying the same word, and both stay.

### Bleed pairs: the source wins by lag, not by loudness (#774)

Loudness cannot tell a same-room copy from the speaker on a Zoom-recorded host track. Measured on the lab tape: the host mic (caleb) carries the co-host (audra) about **150 ms before** her own track, because her stream reaches the recording host over the network while the room bleed reaches his mic at once; Zoom's gain often brings that copy to or above her own level. So the loudness tiebreak kept the copy and suppressed her word ("that's" at 1629.07 s), and a short copy 150 ms early no longer overlapped its source, so the overlap rule never saw it and the duplicate stayed.

Reconcile therefore measures the bleed path first. `TrackRmsCacheSet.echo_pairs` (`engines/audio_audit.py`) runs the [`echo_risk`](audio-engineering.md#agent-audition-context-v2) statistic (`engines/bleed_echo.py`, `echo_risk_pairs`) on the timeline-clock audio in the cache, once per cache set and shared by the acoustic verdict and the text rule. It uses rendered stems when present. Otherwise it decodes each selected source file once and maps current-lane clip spans through `SessionTimeline.lane_clip_spans`. Extra recordings retain their own file identity. Overlaps sum and gaps stay silent. If any selected file or required samples are unavailable, the whole lane supplies no raw acoustic evidence. Every directed pair that clears the same null-calibrated test as `audition_context_tool` is a **bleed pair**. On the lab tape that is audra → caleb and no pair with the remote participant.

For each bleed pair flagged in one direction, `echo_twin_paths` (`edits/bleed_text_match.py`) builds an `EchoTwinPath`: the transcript-side lag between a source word and the bleed mic's copy. With at least 6 identical-text twins within ±0.5 s it is the median onset delta around their densest 50 ms bin (−150 ms on the tape, with a 30–40 ms spread; the remote pairs have no such peak). With fewer twins the acoustic `lag_ms` stands in. The tolerance is ±150 ms, which covers ASR onset error plus the jitter of a network-delayed track. Then:

- A bleed-mic word with the same normalized text as a source-mic word, starting at the path's lag ± tolerance, is the copy. It loses (`audibility_status: bleed`, `dominant_track` = the source mic, `reason: echo_twin`) whatever its level or ASR confidence, and whether or not the two words overlap in time.
- Identical words on the pair at any other spacing are two people talking, for example a sign-off said together. Neither loses; the loudness rule is not applied to a one-way bleed pair at all.
- A source word the acoustic verdict already suppresses anchors no copy: its copy on the bleed mic is then the only place the word survives, so it stays (aligned run: audra "to" 804.87 and "who" 1629.47, both below the audibility floor). A source word the no-path rule restores anchors again: audra "Keep" 1661.02 was tagged bleed of lana with no lana path, so it is audible and caleb's "keep" 1660.82 loses to it.
- The acoustic verdict follows the same rule: `bleed` + `dominant_track` only along a measured direction. So on the lab's one-way pair caleb's words can be bleed of audra, audra's never bleed of caleb, and nobody's word is bleed of the remote participant.
- A pair flagged in both directions (no single source) keeps the loudness rule above. A pair with no measured path gets no text-match suppression at all.
- Stretched ASR tokens (`max_word_audibility_sec`) are skipped on both sides, as in the overlap rule. The acoustic verdict per word is unchanged: a copy the RMS rule already tags as `bleed` never reaches the text rule.

Measured and rejected: correcting the level by the path's `level_db` (−18 dB on the tape) does not work on a Zoom track, because its gain raises the copy to the speaker's level when the host is silent, so a corrected level would call every such copy the host's own speech.

Lab result (`pipeline run --only reconcile_transcript`, trunk → this rule): Whisper-timed run 12 audra words restored (incl. "that's"), 20 caleb copies suppressed, 12 caleb words that were 300–1200 ms from their twin restored, and the 8 coincidence words on pairs with the remote participant restored (incl. the three-person "Bye." at 1686–1687 s); forced-aligner run 7 audra words restored, 45 caleb copies suppressed, 4 coincidence words restored; agent-edited run 1 restored, 6 copies suppressed, the 2 "Bye."s restored.

With the acoustic verdict on the same rule (no path, no `bleed`): Whisper-timed run 95 words change, 70 restored (30 caleb, 15 audra, 25 lana) and 25 retagged `inaudible` and still suppressed; forced-aligner run 79 (59 restored, 19 retagged, caleb "keep" 1660.82 newly an echo twin of the restored audra "Keep"); agent-edited run 14 (9 restored, 5 retagged). Every changed word is one the rule names, lana's decisions change nowhere else, a dry run reports what the apply writes, and a second pass reports 0 on all three.

### Words are judged at the copy lag (#1052)

A remote participant's own track trails their voice on an in-room mic. Read at 0 lag, their copy on the host's mic looks like the host's word, because their own track has barely started. A host word just after them looks like theirs, because their track still carries the syllable they finished. So on a bleed pair the acoustic verdict reads the source mic at the pair's copy lag:

- **The lag.** `TrackRmsCacheSet.copy_path` measures it once per directed bleed pair with the bleed gate's estimator (`envelope_lag.copy_lag`, [below](#acoustic-follow-up-preserve-speech-while-reducing-verified-bleed)). It compares syllable contours over every frame within 300 ms of the source's open track, needs 20 s of them (and a stronger match under 30 s), and needs a peak inside ±300 ms that beats shifted nulls. The copy's timbre must then confirm the lag, as in the gate ([below](#acoustic-follow-up-preserve-speech-while-reducing-verified-bleed), #1070). It reads no transcript. When it abstains (too little of the source's speech, no clear peak, no timbre at the lag, mics on different sample clocks) the lag is 0 and every word gets its 0-lag verdict.
- **The rule.** The dominance rule is unchanged (`bleed_dominance_db`, `bleed_min_other_rms_db`, a measured path), with the source read at the lag. A word at the source's level stays its own speaker's.
- **Crosstalk.** The lag can take a word that the 0-lag reading leaves with its own speaker only if the word also sounds like the copy. The median fine-spectrum match of its frames with the source at the lag (`engines/copy_timbre.py`, the gate's timbre measure) must reach the copy's likeness. The likeness is the 40th percentile of that match where the source, at the lag, talks in its louder half and out-levels the open mic. A soft own word spoken over a louder peer sits under the peer at the lag but carries its own speaker's harmonics, so it keeps its 0-lag verdict with `reason: unlike_copy`. The check runs one way: a word that the 0-lag reading gave away and the lag gives back needs no timbre.
- `audibility_map_tool` rows report the levels the verdict used in `track_rms_db` and the lags in `copy_lag_ms`.

On a realigned episode the lag is about 0, so nothing changes. Lab evidence (rev 3b414c4c, seeded Zoom tracks at offset 0, not realigned, Whisper word times):

- The lag is 140 ms for Audra into Caleb, and the likeness is 0.34.
- Without the timbre check, 55 of Caleb's acoustic verdicts change. 12 of them are Caleb's own words during crosstalk, such as "also", "imagination", "probably", "Dolly" and "need", with match 0.03–0.25. The check keeps all 12.
- After the text-match rule, against main, 9 Caleb words move to Audra: "Oh," 504.94, "It's" 678.58, "We're" 686.82, "Or" 1046.82, "And" 1341.00, "raid" 1491.38, "No," 1610.36, "Always" 1663.24 and "Bye." 1686.74. Audra's transcript has each word at the lag, except "raid", which is her "the right"; the gold edit mutes Caleb there.
- 8 words return to Caleb: "to", "that.", "they", "that", "could", "We're" 1070.82, "The" 1086.98 and "your". Main's gate had turned down 63% of that "We're" and 43% of "The".
- "go." 1572.32 and "a" 1622.56 are Audra's copies that main gave her only by 0-lag accident. They now read as Caleb's acoustically, and the echo-twin rule still gives both to Audra.
- With the bleed gate on, 0 s of Caleb's unsuppressed words are turned down. His stem at 1483.84–1491.84 s goes from −10.7 to −14.4 dB against the ungated stem. At 1656.40–1664.40 s it stays at −1.2 dB.
- In that second passage the gate's own-voice check, not a transcript word, keeps most of the copy at full level: 2.81 s of 5.96 s, against 0.64 s kept by the two words left. "You're" 1658.58 is at Audra's level at the lag, and at "Keep" 1660.68 Audra's track is still gated shut. Handing both to Audra by hand takes the passage only to −1.5 dB.

---

## transcript_mode

| Mode | Use when |
|------|----------|
| `reconcile` | Production and bleed fixtures — updates metadata **and** suppresses bleed/inaudible words |
| `flag` | Smoke tests (`tests/fixtures/e2e_pipeline.yaml`) — tag only, keep short canned transcripts intact |
| `suggest` | Like flag; cleanup report includes suppression keys |
| `off` | Disable audibility analysis |

**E2e split:** `aligned_dialogue` uses `flag`; `synthetic_bleed_60s` uses `tests/fixtures/synthetic_bleed_e2e_pipeline.yaml` with `reconcile`.

---

## Debugging “no bleed words”

When `bleed_words_tool` or `audibility_map_tool` returns all `audible` during known cross-talk:

0. **Check the pair has a measured bleed path** — `audition_context_tool` reports `echo_risk` per directed pair. Without a path no word is tagged `bleed`, whatever the dominance gap (#774): a mic that carries no copy of the other voice has nothing to suppress. Zoom's per-participant suppression can leave a same-room pair with a path one way only.
1. **Check the dominance gap** — at the overlap midpoint, guest RMS minus host RMS must be ≥ `bleed_dominance_db`. A gap of ~5.8 dB will miss the 6.0 threshold.
2. **Confirm stem freshness when stems exist** — stale `artifacts/tracks/` can skip re-render and produce misleadingly quiet stems. After changing raw WAVs or FX, delete `artifacts/` or run `assemble_timeline` on a clean workspace copy.
3. **Pipeline order** — the normal path renders stems before audibility: `ingest_tracks` → `transcribe_tracks` → `merge_transcript` → `render_dialogue_stems` → `reconcile_transcript` (pass 1); pass 2 after `assemble_timeline`. Reconcile can measure from mapped raw media when stems are absent. See [transcript-workflow.md](transcript-workflow.md).
4. **Audition** — `play_audio_tool` on both tracks in the overlap window before changing heuristics.
5. **Last resort** — lower `bleed_dominance_db` slightly in workspace `pipeline.yaml` (e.g. 5.0) only after listening confirms real bleed is present but below threshold.

### Mix-side tuning (when audio sounds doubled)

Reconciliation fixes **transcript metadata**, not waveforms. When the premix is muddy and bleed is weakly detected:

- **Duck the primary speaker** in the overlap window so the off-mic track dominates on the wrong mic.
- **Increase cross-inject** (guest into host) in controlled tests.

The committed synthetic fixture recipe (validated in CI):

```yaml
# ground_truth/manifest.yaml bleed_events excerpt
window: {start: 12.0, end: 16.0}
duck: {into: host, gain_db: -30}
inject:
  - {from: guest, into: host, gain_db: -10}
  - {from: host, into: guest, gain_db: -32}
```

Regenerate and validate: `python3 scripts/build_synthetic_bleed_fixture.py` (fails if bleed count &lt; `expected_metrics.json` floors).

---

## Ship gate: staleness at export time

Reconciliation pass 2 runs after `assemble_timeline`, the last step that changes dialogue
audio. `mix_with_music` is not in `PipelineRunner.AUDIO_AFFECTING_STEPS`: it only writes
music/intro/outro envelopes and stems and mixes (#621). A clean full run therefore
exports with `reconciliation.stale: false`. `export_qc.json` still reports staleness if
anything changed dialogue audio after pass 2 (an edit, FX, a partial `--from` run).
Inline re-assembles outside the runner (`ensure_current_premix` before mastering,
`mix_with_music` when `track_outputs.json` is missing) do not set the flag: they
re-render the dialogue state `audio_state_fingerprint()` already hashes, so a real
dialogue change still reads stale via `last_reconciliation_hash`, and a music-only
remix does not.
`export_deliverables` writes
`artifacts/export_qc.json` with the current `reconciliation_status()` and an explicit
issue message when stale, specifically so this doesn't ship unnoticed. See
[podcast-master-export](../.agents/skills/podcast-master-export/SKILL.md#final-ship-gate-export_qcjson).
If you see `reconciliation.stale: true` there, re-run `reconcile_transcript_tool` and
re-export.

## Typical workflow

1. `reconciliation_status_tool` — stale after FX/edits?
2. `render_preview` or `assemble_timeline` if stems are stale.
3. `audibility_map_tool` or `bleed_words_tool` — scope with `start_sec` / `end_sec`.
4. `overlap_duplicates_tool` — overlapping pairs with text-match hints (read-only).
5. `reconcile_transcript_tool` with `dry_run=true` to preview suppressions, then apply.
6. Hand off to [transcript-precorrect.md](transcript-precorrect.md) for glossary and cross-track sync.

Reconcile updates **transcript metadata only** by default. For acoustic follow-up once transcript bleed is clean, see [podcast-mute-bleed](../.agents/skills/podcast-mute-bleed/SKILL.md). Suppressing bleed words never removes the doubled voice from the mix: `audition_context_tool` measures that doubling on the fresh stems and reports it as `echo_risk` (pair, lag, level; [audio-engineering.md](audio-engineering.md#agent-audition-context-v2)), which points at the same skill. Reconcile runs the same measurement to pick the source mic on such a pair ([above](#bleed-pairs-the-source-wins-by-lag-not-by-loudness-774)).

**User decisions survive reconcile (#768).** `set_word_suppressed_tool`, an applied `apply_bleed_suppression_tool` / `suppress-bleed` **with an explicit `words` list**, and `apply_low_audibility_suppression_tool` with an explicit `words` list all set the word's `audibility_locked: true` alongside `suppressed` — a named word list is a caller decision, not a heuristic pick. A locked word is skipped by every reconcile pass — acoustic and text-match — the same way an `ignored` word already is, so re-running reconcile (a re-render, pipeline pass 2, or a manual dry-run-then-apply) can't flip it back. Toggling `suppressed` again on the same word re-locks it at the new value.

**Return to automatic (#824).** `set_word_automatic_tool`, the `SetTranscriptWordAutomatic` document command, `podcast transcript suppress-word --automatic`, and Studio's word inspector "Return to automatic" button (shown next to the locked word's explanation) clear `audibility_locked` without touching `suppressed`. The word stays exactly as it was until the next reconcile pass runs — `reconcile_transcript_tool`, a pipeline `reconcile_transcript` step, or a render's pass 2 — which then computes and writes its target the same as any word that was never locked. All four surfaces route through `EditService.set_word_automatic` (`edits/transcript_correct.set_word_automatic`), go through `ProjectWorkspace.mutate` (undoable), and take the same optional `expected_text` stale-index guard as `set_word_suppressed_tool`.

**Heuristic picks never lock, and they honor an existing lock (#781).** A `suppress-bleed` or low-audibility apply run *without* an explicit word list recomputes reconcile's own bleed/audibility verdict, so it does not set `audibility_locked` — locking a heuristic guess would pin it forever instead of letting a later pass recompute it. Speaker attribution (`engines/speaker_id.py`: `label_window`, `label_track_home_speaker`, `run_speaker_attribution`) is heuristic the same way; every one of these automatic writers routes its `suppressed` decision through `TranscriptWord.resolve_auto_suppression`, which returns the word's current `suppressed` unchanged when it is already locked, so none of them can flip a word a person or agent locked unsuppressed. `suppress_bleed_words`' heuristic (no `word_keys`) preview follows the same preview-equals-apply rule #791 gives reconcile: a word already locked unsuppressed never appears in `candidates`, since apply would leave it alone anyway (#802 review).

---

## Acoustic follow-up: preserve speech while reducing verified bleed

After `text_match_count == 0` and combined transcript is clean:

1. Ensure stems are **fresh and not longer than the session timeline** (`assemble_timeline` / `render_dialogue_stems`). `stem_is_fresh` rejects source-length stems (wrong clock).
2. `podcast edit apply-bleed-mute --dry-run` — inspect `attenuation_count`, `bleed_reduction`, `bleed_bed_db` and `gate_reasons` per stem (skips stale/overlong stems). The compatibility field `interval_count` counts retained transcript spans, not justified attenuation.
3. `podcast edit apply-bleed-mute` — mute or turn down acoustically verified foreign copies in `artifacts/tracks/*.wav` per `analysis.heuristics.bleed_handling` (below). A suppressed word alone does not authorize a reduction; a verified copy path does.
4. Audition with `play --compare`; re-run mix/premix after gating.

MCP: `apply_transcript_gate_tool`. Transcript word flags are unchanged; this sets
`timeline.tracks[].transcript_gate` and `transcript_gate_scope` (both history-snapshotted).
Scoped selections store source identity and source ranges, so they follow selected audio
after timeline edits and survive reopening. A null scope means the whole lane; an empty
scope selects nothing. Apply rebuilds from ungated selected media before atomically
publishing a stem, so repeated applies do not multiply fade envelopes. Undo restores
both fields; processed playback and rerendering derive the same absolute envelope.

The gate defaults to unity gain. Where it acts it reduces the copy by
`analysis.heuristics.bleed_handling` (#945):

| `bleed_handling` | Inside a reduced span |
|---|---|
| `auto` (default) | `attenuate` on a lane whose bed stays above the 16-bit floor once turned down, else `mute` |
| `mute` | silence |
| `attenuate` | turned down by `bleed_attenuation_db` (default 20 dB) |

`auto` reads the lane's bed: the median of its level where it has media, away from
its own speech and hold and from the peers' copies. A room mic's bed that a mute
would make vanish and return at every span edge is kept steady by attenuating
instead, but only if it is still there once turned down: the bed less
`bleed_attenuation_db` must stay above the −90 dB level floor, about one 16-bit
step. Below it, attenuating leaves digital silence where the bed was, so the lane
is muted. A call app that gates each track to digital silence reads at that floor
most of the time, so its median is the floor. It is a median because copy tails and
the lane's breaths fill a few percent of those frames and would set a mean. On the
lab tape 3% of Caleb's frames beside the copies gave 97% of their power, so the
round-3 power mean (−57 dBFS) read a bed that is not there. On a fresh aligned lab
run every track resolves to `mute`: Caleb's quiet frames are 76% digital silence
and otherwise room tone at −80 dBFS (median), Audra's and Lana's 88%. A steady
−60 dBFS room bed resolves to `attenuate`. The plan and the apply preview report
each lane's `bleed_reduction` and `bleed_bed_db`.

Around the lane's own speech the gate holds full level for 40 ms before and 80 ms
after, then ramps over 20 ms. On the lab tape the level just outside Caleb's
reduced spans is his own onsets and tails until the hold covers them, then his
mic's bed. With forced-aligner word times it reads −42 dBFS with no hold, −48 dBFS
at 40/40 ms, and reaches its −57 dBFS power mean beside the copies at 40 ms before
and 80 ms after, where longer holds leave it; Whisper's looser word times reach it
at 20/40 ms. The hold also covers plosive bursts before a word's vowel (#978). It keeps 10 s of Audra's
280 s of speech at full level on Caleb's mic, half what 80/150 ms would.

The gate measures each lane against every other dialogue track's audio at 8 kHz
(100 ms level frames every 10 ms):

- **A copy path.** Over the peer's own speech (its track open above −60 dBFS), the
  lane's syllable contour (its level less the half-second mean) must follow the
  peer's at one lag within ±300 ms, with correlation at least 0.4 and 0.15 above the
  same lag shifted by ±1 s and ±2 s. The lag is found by the shared
  `engines/envelope_lag.py` estimator and must be a peak at least one hop inside the
  search (#1068). The contour drops the shared on/off timing of two people who start
  and stop talking together. The match must carry the evidence of 0.4 over 30 s of
  frames, counted as the correlation's Fisher z (atanh r) times the square root of
  the frame count. So from 30 s 0.4 is enough, and a shorter excerpt needs a
  stronger match: 0.48 over 20 s. Under 20 s the gate abstains (#1070). A remote
  speaker's own Zoom track can trail their voice on an in-room mic. On the lab tape
  Audra's track trails her copy on Caleb's mic by 140 ms.
- **The copy's timbre confirms the lag** (#1070). Level alone cannot tell a copy
  from own sound that starts and stops with the peer's: people laughing together,
  or a voice whose syllables fall on the peer's. Such sound follows the peer's
  syllable contour at the lag as a copy would. A copy is the peer's voice, so it
  also matches the peer's fine spectrum (the timbre measure below) at the lag, and
  not the peer's other syllables. Own sound at its own pitch matches both alike:
  another voice neither, a steady hum both. On the frames that carry the copy if
  there is one (the peer at the lag in its louder half, the lane at the copy's
  level), the copy's likeness, the 40th percentile of that match, must beat by
  0.15, the margin the level match must clear, the likeness of the same frames
  against the peer's speech 1 and 2 s away, read only where the peer talks as loud
  there. A null under 0 counts as 0. A peer that speaks in short bursts far apart
  can be silent at all four of those; its speech 3 to 10 s away, pooled over those
  shifts, is then the comparison, and with no peer speech there either the lag is
  not confirmed. Under half a second of frames at the copy's level (50) the lag is
  not confirmed either: true copies in the trials below had 90 or more, and one
  co-timed own voice passed on 6. The level lag is only as sharp as a 100 ms level
  frame, and a peer's gate opening late on every word moves it later (60 ms at
  180 ms late), so the likeness and its nulls are read at the lag up to 50 ms
  earlier where the likeness is highest; a gate never opens early. The likeness the
  gate then uses is the one at the level lag. Reconcile's copy path makes the same check
  (`copy_timbre.confirmed_likeness`). No confirmed path means
  `uncertain_foreign_ownership`.
  - **Limits** (#1190). Fine spectrum is mostly pitch. Own sound whose pitch
    follows the peer's (singing the peer's melody in unison or an octave apart,
    chanting a line together, speaking along at the peer's pitch) matches the peer
    at the lag and nowhere else, as a copy does, and still reads as a copy: from
    20 s of the peer's speech here, and from 30 s on main, whose level match alone
    passes it. The reverse costs true copies on the safe side: a copy of a peer
    whose other syllables share its spectrum matches those as well. In synthetic
    trials a near-monotone peer's copy (±0.15 semitone) passes 30 of 100 at 30 s and
    34 at 60 s, where main passes all; a sung melody's copy 90 and 97, a repeated
    phrase's almost never. That bleed is kept.
  - **Evidence** (synthetic trials through the gate's copy check, 100 per kind at
    each of 20, 25, 30 and 60 s of the peer's speech; the #1053 and #1070 harnesses
    plus an independent source-filter voice synth and adversarial cases built from
    lab voices). Own sound at its own pitch that switches on and off with the
    peer's passed the level match alone in 604 of 4,800 trials from 20 s: voices
    gated together word by word (22 and 28 of 400), the same cadence with 2%, 5% and
    10% tempo jitter (167, 21 and 1), and laughing together (8, and 357 of 400 at
    the same pulse rate and phase). Main's 30 s rule passed 213 of them at 30 and
    60 s. With the timbre check none pass at any length, nor do 17 more such kinds
    (6,762 trials) from the independent synth, and independent voices, real
    co-timed phrases, turn-taking, the same speaker at two times, and music on the
    peer only stay at 0. End to end, where such sound is untranscribed, the level
    match alone turned down 14 to 69 s of own sound per 6 excerpts; the check turns
    down none. Pitch-following own sound is the exception above: unison singing
    passes 97, 99, 99 and 100 of 100, pitch-following speech (±0.3 semitone) 96 to
    100, and the same with a sparse peer 92 to 100 (main: 0 under 30 s, 91 to 100
    from 30 s). True copies: Audra's lab copy against her own track passes 17, 49,
    54 and 68 of 100, and synthetic room copies 93, 296, 299 and 300 of 300; under
    30 s that is fewer than when the 20 to 30 s floor was mistakenly 0.40 (32 and
    51 lab, 93 and 300 synthetic). Copies of a sparse peer pass 99 to 100 of 100,
    nearly all against its speech 3 to 10 s away; abstaining whenever the near nulls are
    silent would have lost every one (main passes 94 and 100 from 30 s). One shared
    signal is left: the same music bed on both lanes is a real copy of the bed, and
    passes in 9 to 10 of 100 from 25 s (45 to 46 before, main 40 at 60 s; #1187).
  - **Lab coverage** (rev 3b414c4c, realigned, random excerpts cut from the
    project, 100 of each length): the gate acts on Caleb's lane in 49% of 2-minute
    windows (main 32%) and 94% of 5-minute windows (main 87%). Audra's copy left at
    full level falls from 53% to 37% and from 14% to 11%. Half of the 2-minute
    windows hold under 20 s of Audra's speech, which is what limits them. No
    unsuppressed Caleb word is touched, Audra's and Lana's lanes stay untouched, and
    the whole-episode plans match main exactly. The timbre check changes none of
    these plans: all 480 lane-windows of 160 two-minute excerpts match the level
    rule alone, and no sound of Caleb's with both peers closed is touched. The
    corrected 20 to 30 s floor leaves every one of these plans, 600 lane-windows of
    200 excerpts and both listening excerpts unchanged: no lab path in that band
    matches between 0.40 and its floor. No lab copy trial is silent at every near
    null, so the farther comparison never applies there.
  - **Not done.** Reusing the lag `align_tracks` measured, or measuring over the
    whole recording before the excerpt was cut, would cover excerpts cut inside a
    project but not short recordings or exported excerpts. The gate needs the lag
    where clips sit now, and alignment moves clips piece by piece.
- **Where the peer is talking.** Every frame the peer's open direct track, read at
  that lag, can reach on the lane is foreign, whether or not the lane's transcript
  has a word there. Spans used to grow only from suppressed `bleed` words on the
  lane, which on the lab tape left about 40 s of Audra's speech with no Caleb-track
  word at full level.
- **Where the lane's own speaker is silent.** Own speech is judged against the
  **expected copy level** on this mic, not the peer's direct track. With the path,
  the gate measures the coupling: the median of lane level minus direct level over
  the louder half of the peer's frames, away from the lane's own words (−20.6 dB for
  Audra on Caleb's mic, reading the direct track held ±50 ms and, where its gate is
  just opening, up to 200 ms ahead). The expected level is the direct track plus the
  coupling, power-summed over peers and with the mic's noise floor, read ahead of each
  opening only as far as the lane sounds up to it ([below](#read-ahead-per-opening-1131)).
  The copy's own level wanders with the peer's phonemes and the call's noise suppression, so the
  gate also measures its spread: the 95th percentile of lane-to-direct level over
  the same frames, less the coupling (10.5 dB for Audra on Caleb's mic; 10.6 dB on the
  owner-confirmed Audra-only passages). Sound more than the spread over the expected
  level is the lane's speaker, whatever its timbre, because the copy reaches that
  in only 5 of 100 loud frames. Nearer the expected level, level alone cannot
  decide, so each fifth of a second is judged by timbre: it is the copy when the
  median fine-spectrum match of its frames 2 dB or more over the expected level (the
  log spectrum less its smooth envelope, against the peer's direct track) reaches the
  copy's likeness, the 40th percentile of that match on frames at the copy's level
  (0.36 on the lab; the median is 0.41). Own sound is held through dips up to 150 ms,
  so a short "mm" is kept whole, and needs 50 ms more than 4 dB over the expected
  level to count. Round 3 judged whole held runs, which on the lab last 9–17 s. In
  the 12.6 s run of Caleb's speech from 828.9 s, the only frames that could be judged
  were the 32 where Audra's copy overlaps its start; their match (0.38) reached the
  likeness (0.36), so his "then" onset at 829.31 was turned down while it stood
  13–28 dB over the copy. Windows of a fifth of a second keep one side from outvoting
  a word beside it. In synthetic trials with a lab-like 10 dB copy spread, a 150 ms
  "mm" 4 or 6 dB over the copy was kept in 24 of 24 at 0.2 and 0.3 s windows and
  lost in 5 of 24 at 0.4 s. Kept sound is protected with or without a transcript
  word, so untranscribed backchannels, laughs, and own words reconcile gave to the
  peer stay at full level. Unsuppressed own words protect their connected voiced
  runs, which stop where a peer is talking, and untranscribed placements stay
  protected.

A direct track still gated shut is no evidence of the lane's speaker. Where the
owner's own track gates open late, the copy on this lane is still reduced. Bleed is
never kept as the main audio for another speaker, so the first moments of a
late-gated word can be quieter in the mix (#945). During crosstalk the lane's own
speech is protected and its copy of the peer stays with it; retained-bleed
alignment handles that. Own sound less than about 4 dB over the copy cannot be told
from it and is reduced with it. Words reconcile left unsuppressed on this lane stay
protected even when they are really the peer's, so those copies stay at full level.
A stereo or multichannel lane is judged one channel at a time, because a mixdown
halves sound on one channel against a copy that reaches them all: a "uh-huh" 10 dB
down on one channel read as copy there (#1094). A frame is reduced only where every
channel reads as copy, and the bed that picks mute or attenuate is the loudest
channel's. Channels are decoded as recorded, so a quad or other tagged layout keeps
every channel apart. A lane whose channels carry one signal, such as a call app's
dual-mono track, is judged once on ffmpeg's mono mixdown, as before. Lossy codecs
decode the two copies of one channel slightly apart, so "one signal" means that no
frame has a channel-to-first-channel difference that is both above the lane's noise
floor and within 7.7 dB of the loudest channel within 50 ms. A codec's noise follows
its transform block's level (AAC-LC's window is 43 ms), so the quiet frames either side
of a sound carry the loud block's noise; judged against their own level they read as a
second signal (#1159: Opus at 32k, 64k and 128k). Judging against the block's level
leaves the 7.7 dB rule as it was, and the worst codec difference measured sits 22 dB
under it. A mixdown then shifts own versus copy by under half the 4 dB own margin. A
short sound on one channel sits near that channel's own level, which is the loudest
there, and never passes. A channel whose copy
cannot be verified judges its own sound against its noise floor alone and reports
`uncertain_foreign_ownership`.
Unavailable evidence abstains and is reported in `gate_reasons`. Crossfade layouts abstain because their rendered
clock can diverge from raw placements. Applying the flag does not prove bleed was
reduced, so compare stems before and after.

### Read-ahead per opening (#1131)

Where the peer's track has just opened, its 100 ms level frames are diluted, and a
call app may open the peer's gate late, so the copy on this mic can start first. The
gate used to expect the copy at the next word's level for 200 ms before every
opening. Gaps between words are often shorter, so whole gaps got the next word's
level, and an own laugh or breath there was cut: 45.5% of an 800 ms laugh 4 dB over
the copy on a synthetic peer with 50–150 ms gaps (#1126).

The gate now keeps apart where the copy can be and how loud it is expected there:

- **Where the copy can be** still reaches 200 ms ahead of every opening. It decides
  which frames may be turned down and where own words' voiced runs stop, as before.
- **How loud the copy is expected**, when own sound is judged, reads ahead of each
  opening only as far as this lane has been sounding without a break up to it, at
  most 200 ms. Sounding means over the mic's own floor, the floor own-word protection
  uses, through dips shorter than the copy rings (50 ms). Each opening has its own
  read-ahead from its own evidence: there is no episode-wide number, and so no
  minimum count of openings and no fallback.
- **A lane quiet just before an opening** shows that the copy came with the track, so
  that opening reads nothing ahead, and sound near it is judged against what the
  track carries rather than its next word.
- **Sound running into an opening is not judged here.** It may be the start of a copy
  whose track opened late, or own sound, so the gate reads ahead from where it began,
  as far as before at most. The copy is never expected later than the lane heard it.
  A laugh lengthens the read-ahead only at the openings its sound runs into, and only
  from where that run began; at the other openings beside it the lane went quiet.

The coupling, spread and likeness are still read against the full 200 ms reach.
Re-reading them at the measured lead was tried and rejected: it moves own sound's
margin inside the peer's words, and a 100 ms breath 4 dB over the copy was cut whole.

Synthetic generality episodes (`tests/test_bleed_gate_generality.py`), share of each
own sound changed, main → read-ahead per opening:

| Own sound beside the copy | main | per opening |
|---|---|---|
| 800 ms laugh, +4 dB | 45.5% | 5.6% (a burst on a loud word) |
| 800 ms laugh, +6 / +8 dB | 40.0% / 13.2% | 0 |
| 250 ms laugh, +10 dB | 23.4% | 0 |
| 500 ms laugh, +8 / +10 dB | 33.3% | 0 |
| Six 800 ms laughs, +4 dB | 45.5 / 38.2 / 0 / 60.0 / 100 / 41.7% | 5.6 / 38.2 / 0 / 38.2 / 17.0 / 1.8% |
| 800 ms laugh, +6 dB, mic floor −70 or −60 dBFS | 40.0% | 0 |
| 500 ms laugh, +8 dB, peer's track opening 30–120 ms late | 33.3% | 0 |

Copy left at full level, seconds and pieces, on the same synthetic peer with no own
sound, away from the host's words:

| Peer's track | main | one episode lead (rejected) | per opening |
|---|---|---|---|
| 180 ms late on 2 of 74 words | 0.21 s / 1 | 0.65 s / 4 | 0.21 s / 1 |
| 180 ms late on 7 of 74 words | 1.60 s / 6 | 2.09 s / 12 | 1.60 s / 6 |
| 30–120 ms late on every word | 2.46 s / 12 | 2.46 s / 12 | 2.46 s / 12 |
| 30–120 ms late on every word, mic floor −75 / −70 / −60 dBFS | 10.00 / 10.06 / 10.58 s, 41–43 | | 10.69 / 10.82 / 11.26 s, 45–46 |
| 180 ms late on every word | 7.14 s / 34 | | 7.27 s / 37 |
| 250 ms late on 7 or 15 of 74 words | 2.17 s / 13, 5.07 s / 26 | | 2.23 s / 15, 5.17 s / 29 |
| on time, own breaths +4 dB ending 20 ms before 10 openings | 0.84 s / 12 | 1.36 s / 19 | 0.84 s / 12 |

**The trade (owner decision, #1134).** No placement of own sound is touched more than
on main: 600 random laughs, breaths, "mm"s and crosstalk beside on-time, late and
partly late peers, with and without a mic floor, touched 12.6 s less in total. The
cost is copy: where the lane sounds into a late opening, the copy's level is expected
only from where that sound began, while the peer's 100 ms level frame there is still
diluted, so the loud start of a late word can stand over the expected copy and be
kept as own sound. On a peer whose track opens late on every word, or 250 ms late on
several, 0.06–0.76 s more copy stays at full level per synthetic episode, in up to 5 more
pieces, at −13 to +2 dB against the lane. Beside own sound the kept copy is not
confined to the 40/80 ms holds: across 200 random synthetic episodes it reached up to
1.78 s in one, and a 250 ms laugh 8 dB over the copy kept the lane at full level from
150 ms before it to 230 ms after it. Nothing at a single opening was found that tells a
late copy's start from an own laugh, so 'never trim more own sound than main' and
'never leave more copy than main' cannot both hold. The owner chose to keep own laughs
and breaths whole and accept slightly more leak on peers whose call app opens their
gate late. The tests pin both sides: the laughs and breaths above, the late-word and
breath rows equal to main, and the −70 dBFS and 180 ms every-word rows capped at the
accepted cost. Frames near a −70 dBFS floor flip between platforms (10.82 s in 46
pieces on macOS arm64, 11.07 s in 47 on Linux x86-64), so that cap is 11.3 s in 48.

**Late-opening copy is not reduced further.** On the peer opening 30–120 ms late on
every word, 2.5 s of the copy stays at full level, as on main. It is whole words, not
onsets: the 200 ms reach lends the peer's openings their word's level while the copy
there is still rising, which reads the coupling 3.4 dB low and the spread at 5.1 dB
instead of 1.7 dB, so copy bodies stand over the spread and count as own sound.
Re-reading the copy's level at the measured lead removes that copy but cuts the 100 ms
breath 4 dB over the copy whole, and five of six laughs beside a late-opening peer lose
6–100% where main kept them.

**Rejected** (#1130, #1134):

- Deciding per copy whether it needs the read-ahead from the lane's level in the
  frames the read-ahead raises (#1130). Own laughs sit in those frames, so a host who
  laughed four to six times switched it off, and a −70 dBFS mic floor alone switched
  the hold back on.
- One lead per episode, the 95th percentile of the openings' leads, skipping sound
  louder before an opening than after it (#1134's first round). The skip also threw
  out real copy: a late word's cut-off start, its consonant and the top of its swell,
  is louder than what follows the opening. And a percentile ignores late openings
  rarer than 5% of an episode. With 2–7 of 74 words late it read 0 ms and left up to
  twice the copy in twice the pieces (table above).
- Telling a late copy's start from own sound at each opening. A census of the
  openings found nothing that separates them: the fine-spectrum match with the
  peer's track after the opening was −0.1 to 0.2 for both, and the lane was louder
  before the opening than after it at 6 of 7 late openings and at every breath.
- The full read-ahead from where the lane's sound begins, or inside the word's first
  level frame. Both brought back main's trimming of laughs 4 dB over the copy and of
  repeated laughs: what trims a laugh is how far into the peer's word the expected
  level looks, not where the read-ahead starts.
- Not bridging 40 ms dips in the lane's sound: a breath ending 20 ms before an
  opening then read nothing ahead, and the copy at full level rose from 0.84 s to
  1.03 s.
- Letting the measured lead also decide where the copy can be. Synthetic episodes
  were unchanged, but on the lab tape the lane was turned down later after Caleb's
  words (886.25 s instead of 886.18 s), so 0.04 s more of the lab's level frames held
  Audra's copy at full level, though no sample over −62.7 dBFS changed.

**Lab tape** (rev 3b414c4c, Caleb's lane, on the bare and the realigned runs; the same
plans before and after the rebase onto per-channel judging, #1094/#1159): Audra's
and Lana's lanes are byte-identical to main. Caleb's plan changes where his mic is
near silent: main turns down 0.53 s more, 0.03 s of it his own sound over the copy on
the bare run, and the fix turns down nothing main keeps. Copy at full level (48.31 s
bare, 48.54 s realigned), chatter (1, 2) and Caleb words touched (0) match main.
Every sample whose gain changes is −62.7 dBFS or quieter. Caleb's mic is sounding
into 529 of Audra's 598 openings, so they still read the full 200 ms ahead; 21 read
nothing ahead and 48 part of it.

For PCM16 output, gating streams one second of WAV frames at a time and preserves
all channels. Transitions lie inside justified attenuation regions; segment playback
does not invent fades at the requested window edges. Rewriting a stem in place first
writes a temporary WAV and replaces the original after the gate succeeds. Source
proxies abstain when a lane selects media other than its primary raw source.

### Rejected: per-frame pitch and voice (#1066)

Level and timbre keep some of a peer's copy at full level: a copy that runs over
its usual level for whole phrases, and copy whose spectral match overlaps the
speaker's own sound. Three rounds tried to tell that copy from own voice per 10 ms
frame. Each frame's YIN f0 on the lane was compared with the peer's own track at the
copy lag. With the `speaker` extra, ECAPA or Resemblyzer embeddings judged runs of
1.5 s or more. None shipped, and the gate is level and timbre only.

- Round 1 called unpitched frames between copy pitch the copy. It cut a laugh
  injected 10 dB over the copy whole, and 21.2 s of untranscribed sound that main
  keeps.
- Round 2 cut only audio whose every pitch reading followed the peer. It was safe,
  but the unpitched copy between its cuts stayed, so the copy came in and out.
- Round 3 kept a run as own only with a syllable off the copy's pitch, and withdrew
  any cut that left a piece under 0.3 s.

Caleb's lane on the realigned lab episode, pitch only. The speaker backends moved
the copy at full level by at most 0.4 s:

| Caleb's lane | main | round 1 | round 2 | round 3 |
|---|---|---|---|---|
| Copy at full level (of 215.3 s) | 77.3 s | 42.7 s | 73.8 s | 73.0 s |
| of it at Audra's pitch | 16.4 s | 4.2 s | 12.9 s | 13.6 s |
| Owner-confirmed passages (of 17.4 s) | 3.62 s | 0.08 s | 3.20 s | 3.31 s |
| Kept copy pieces under 0.3 s | 8 | 1 | 39 | 5 |
| Unsuppressed Caleb words touched (of 2,372) | 0 | 0 | 0 | 0 |
| Untranscribed sound off Audra's pitch cut where main keeps it | 0 | 21.2 s | 0.11 s | 1.55 s |

Round 3 gained 4.3 s. On the owner-flagged passage at 1656.4 s the stem changed
−2.9 dB against main's −2.8 dB. Laughs and breaths injected 4–12 dB over the copy
lost no more than main takes, but at 2–3 dB over it one laugh in 144 lost 4% where
main keeps it whole, which the rule that own sound is never touched forbids.

What limits it is the copy's own unvoiced sound. 74% of the copy main keeps has no
pitch the lane can read: the peer's sibilants, and the ring after the peer's gate
shuts. In the owner-confirmed Audra-only passages, 23% of the copy's 30 ms readings
off her pitch stand more than 4 dB over what her own track predicts at the lag, up
to 19 dB, likely because the call software suppresses and gates her own track
there. By level and pitch that sound is a breath or a laugh, so no per-frame rule
can take it without risking own sound.

What would help instead:

- Better alignment, so retained-bleed alignment rather than the gate handles more
  of the copy: a per-track timing map (#1089) and the piecewise-lag residuals
  (#1090).
- Transcript attribution that stops keeping a peer's words as the lane's own
  (#1052). Reconcile now judges words at the copy lag
  ([above](#words-are-judged-at-the-copy-lag-1052)). On the unaligned lab run it
  moved "raid" and "Always" to Audra, but the 1656.4 s passage stays at −1.2 dB:
  the own-voice check keeps most of that copy, not a transcript word.
- Source separation, which would take the peer out of the mic rather than choose
  per frame. A future option.

The synthetic cases from this work pin the level and timbre gate as protections in
`tests/test_bleed_gate_generality.py`: own sound over a voiced copy, laughs and
breaths 4–12 dB over the copy, peers in the speaker's own pitch range or barely
meeting it, and a speaker with too few words to learn a range from.

---

## Synthetic and AMI fixtures

| Fixture | What it validates |
|---------|-------------------|
| `synthetic_bleed_60s` | Deterministic bleed SNR, reconcile suppressions, precorrect cross-track. Each word is its own tone: one stationary tone per track matched `echo_risk`'s time-shifted null and no path was measured (#774) |
| `ami_bleed_60s` | AMI word timings + synthetic overlap audio (headset WAV URLs unavailable) |

Build scripts encode the bleed recipes above:

- `scripts/build_synthetic_bleed_fixture.py`
- `scripts/build_ami_bleed_fixture.py` (imports `import_ami_words.py`, overlap windows from word timings)

AMI overlap pairs can exist without bleed tags if dominance stays under threshold — use synthetic_bleed as the **primary gold** for reconcile assertions; AMI as realism check (`e2e_real`).

---

## Manual bleed debugging

Listen-through checklist and CLI commands for `synthetic_bleed_60s` (12–16 s window) and `ami_bleed_60s`:

```bash
./scripts/run_bleed_debug_battery.sh
```

See [e2e-fixture-manual.md](e2e-fixture-manual.md#bleed-debugging).

## Related

- [transcript-precorrect.md](transcript-precorrect.md) — cross-track text sync after reconcile
- [speaker-attribution.md](speaker-attribution.md) — bleed-gated speaker pass
- [testing.md](testing.md) — `make e2e`, `make e2e-real`

## Reviewed bleed ranges

A dry run of `apply_transcript_gate_tool` or `podcast edit apply-bleed-mute --dry-run` also returns `review_candidates`, including when automatic attenuation refuses stereo evidence or a missing stem. These are listening hypotheses from suppressed foreign-labelled words, not acoustic verification or authorization. Each row names the receiving and foreign tracks, source and timeline bounds, the automatic refusal, and an existing serialized `ExactRangeTarget`.

Discovery subtracts retained, locked (including suppressed), ignored and uncertain word footprints, contradictory foreign-peer footprints, unknown transcript coverage and overlapping receiving placements. It does not bridge transcript gaps or combine repeated occurrences. A word footprint can still contain owner speech, breath or a thump; listen to the receiving raw audio, named peer and mix before proposing it.

Each resulting interval requires complete, unambiguous receiving and named-peer placement coverage and source bounds within the declared first-audio-stream duration. Unknown, nonfinite or estimated audio extents refuse targets. The current probe also marks all multiple-audio-stream files as estimated, so they refuse even early intervals. Container duration never substitutes for selected audio coverage. A declared duration does not certify continuous or decodable PCM throughout the interval. Missing review media, peer gaps, overlapping peer placements and crossfade layouts refuse targets.

Each receiving-lane discovery call memoizes unavailable extents per resolved path. Successful probe metadata shares a process-local cache of up to 1024 resolved-path/file revisions with rendered-media duration checks. Failed probes are not stored in that shared cache and can retry on the next discovery call. Discovery does not probe media when metadata leaves no eligible intervals.

Targets are at most four seconds each, with at most 16 rows per request. `review_truncated` means additional targets were omitted. `review_exclusions` is shared, clipped to the requested window and capped at 128 diagnostics; `review_exclusions_truncated` reports omitted diagnostics. Protection still uses the complete exclusion union. Use a narrower timeline window to inspect omitted results.

After listening, pass one unchanged row's `target` object to `propose_range_mute_tool(project_path, target, command_id)`. Use a unique command ID for each proposal; retry the same command with the same ID and payload. This registered MCP adapter creates a pending exact MUTE through the existing document command path. It cannot approve or apply. The interactive host reviews the pending audio and approves it in the GUI; agent `approve_edits_tool` refuses exact proposals. An approved mute preserves timeline duration, source media and transcript words, and supports History undo.

Current seals check selected clip geometry and media file identity, size and modification time. They do not hash file content or seal transcript metadata. A transcript change after discovery requires renewed review; it is not automatically detected as stale. Changed geometry or media revisions reject approval atomically. Approved timeline renders preserve the original mute envelope when a segment begins inside its fade or muted body, on every channel. Fractional source seek and trim timestamps retain FFmpeg microsecond quantization; different render paths can differ by one endpoint sample even with matching envelopes. Stateful FX can change later output, and premix peak normalization can change overall mix gain. Compare the selected stem and listen to the actual mix. Guest source-proxy timeline playback currently omits clip-local mute envelopes; use the rendered pending preview or host processed playback to review these edits.
