# Transcript reconciliation and bleed detection

Operational guide for per-track audibility classification, bleed suppression, and overlap analysis. Complements the [podcast-transcript-reconcile](../.agents/skills/podcast-transcript-reconcile/SKILL.md) skill and [architecture.md](architecture.md).

For regression fixtures and CI thresholds, see [fixture-catalog.md](fixture-catalog.md).

---

## How bleed is detected

For each word window, reconciliation compares RMS on the word's own track against every other dialogue track at the same timeline position (`compute_word_audibility_map` in `audio_audit.py`).

**Zero-duration / sub-5ms words** (ASR junk with `start == end`) cannot be RMS-measured. Isolated ones are tagged **`inaudible`** with `reason: zero_duration_word` so reconcile can suppress them out of `combined.json`. When the same track has **normal-duration neighbors** on both sides, the token is tagged **`deferred`** (`sandwiched_zero_duration_word`) and is **not** auto-suppressed — keeps glue words like `what` between `know` and `I'm`.

**Anomalously long words** (duration &gt; `max_word_audibility_sec`, default **2.0 s**) skip full-span mean RMS. Stretched Whisper tokens that cover speech + silence + peer talk would otherwise look like bleed/inaudible. They are tagged **`deferred`** with `reason: anomalous_word_duration` and are **not** auto-suppressed — neither mean-RMS nor identical-text overlap (`overlap_text_match_losers`).

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

Reconcile therefore measures the bleed path first. `TrackRmsCacheSet.echo_pairs` (`engines/audio_audit.py`) runs the [`echo_risk`](audio-engineering.md#agent-audition-context-v2) statistic (`engines/bleed_echo.py`, `echo_risk_pairs`) on the timeline-clock audio in the cache, once per cache set and shared by the acoustic verdict and the text rule. It uses rendered stems when present. Otherwise it decodes raw media and maps surviving clip spans through `SessionTimeline`. Every directed pair that clears the same null-calibrated test as `audition_context_tool` is a **bleed pair**. On the lab tape that is audra → caleb and no pair with the remote participant.

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

**User decisions survive reconcile (#768).** `set_word_suppressed_tool`, an applied `apply_bleed_suppression_tool` / `suppress-bleed` **with an explicit `words_json` list**, and `apply_low_audibility_suppression_tool` with an explicit `words_json` list all set the word's `audibility_locked: true` alongside `suppressed` — a named word list is a caller decision, not a heuristic pick. A locked word is skipped by every reconcile pass — acoustic and text-match — the same way an `ignored` word already is, so re-running reconcile (a re-render, pipeline pass 2, or a manual dry-run-then-apply) can't flip it back. Nothing clears the lock automatically; toggle `suppressed` again on the same word if the decision changes.

**Heuristic picks never lock, and they honor an existing lock (#781).** A `suppress-bleed` or low-audibility apply run *without* an explicit word list recomputes reconcile's own bleed/audibility verdict, so it does not set `audibility_locked` — locking a heuristic guess would pin it forever instead of letting a later pass recompute it. Speaker attribution (`engines/speaker_id.py`: `label_window`, `label_track_home_speaker`, `run_speaker_attribution`) is heuristic the same way; every one of these automatic writers routes its `suppressed` decision through `TranscriptWord.resolve_auto_suppression`, which returns the word's current `suppressed` unchanged when it is already locked, so none of them can flip a word a person or agent locked unsuppressed. `suppress_bleed_words`' heuristic (no `word_keys`) preview follows the same preview-equals-apply rule #791 gives reconcile: a word already locked unsuppressed never appears in `candidates`, since apply would leave it alone anyway (#802 review).

---

## Acoustic follow-up: mute when not talking

After `text_match_count == 0` and combined transcript is clean:

1. Ensure stems are **fresh and not longer than the session timeline** (`assemble_timeline` / `render_dialogue_stems`). `stem_is_fresh` rejects source-length stems (wrong clock).
2. `podcast edit apply-bleed-mute --dry-run` — preview gate intervals per stem (skips stale/overlong stems).
3. `podcast edit apply-bleed-mute` — gate `artifacts/tracks/*.wav` to non-suppressed word spans.
4. Audition with `play --compare`; re-run mix/premix after gating.

MCP: `apply_transcript_gate_tool`. Transcript word flags are unchanged; this sets
`timeline.tracks[].transcript_gate` (history-snapshotted) and rewrites stem WAVs
in the requested window. Undo restores the flag; `play processed:*` re-applies the
gate via segment/stem render when the flag is set.
For PCM16 stems, windowed gating streams one second of WAV frames at a time,
indexes word intervals once and checks only intervals overlapping each chunk,
preserves all channels, and copies frames outside the window unchanged.
Unsupported WAV formats raise an error. Rewriting a stem in place first writes a temporary WAV and
replaces the original after the gate succeeds.

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
