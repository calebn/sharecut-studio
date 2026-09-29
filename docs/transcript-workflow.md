# Transcript workflow

Canonical guide for transcript quality: when each layer runs, what it fixes, and how it fits the pipeline.

Deep dives: [transcript-reconcile.md](transcript-reconcile.md), [transcript-precorrect.md](transcript-precorrect.md).

Agent skill hub: [.agents/skills/podcast-transcript-workflow/SKILL.md](../.agents/skills/podcast-transcript-workflow/SKILL.md).

## Four layers

| Layer | What it does | Changes text? | Changes audio? | Skill |
|-------|----------------|---------------|----------------|-------|
| **1. Acoustic** | Word-level RMS; tag bleed (only along a measured bleed path, #774) / inaudible; suppress in combined | No | No | `podcast-transcript-reconcile` |
| **2. Rules** | Glossary, homophones, cross-track sync | Yes (rules) | No | `podcast-transcript-precorrect` |
| **3. Refine** | Agent context/grammar fixes from deferred queue | Yes (reviewed) | No | `podcast-transcript-refine` |
| **4. Escalate** | Listen-first single-span decisions | Yes (one span) | No | `podcast-transcript-audition` |

## Pipeline order

```text
ingest_tracks
transcribe_tracks
merge_transcript
render_dialogue_stems          # pass 1 stems (raw-ish, for audibility)
reconcile_transcript           # pass 1 — suppress bleed/inaudible
precorrect_transcript          # glossary + cross-track + report
require_transcript_refine      # agent: refine-done / waive; --unattended auto-waives
analyze_focus_cuts
focus_from_transcript
analyze_fillers_pauses
tighten_from_transcript
clean_audio
compress_tracks
balance_tracks
assemble_timeline              # final stems (edits + FX)
reconcile_transcript           # pass 2 — post-FX audibility refresh
mix_with_music
master_loudness
export_deliverables
```

`precorrect_transcript` runs **once** (after pass 1 reconcile). Pass 2 reconcile updates suppression metadata only. Precorrect apply resets `artifacts/transcript_refine_status.json` to **pending**.

After a successful unattended pipeline run that executes an active refine gate,
the gate's current `source: unattended` waiver is refreshed if later steps
change suppression metadata without changing transcript text or word structure.
The status must still be the same gate decision at completion; a newer explicit
refine decision wins. Partial runs that skip the gate, runs with refine mode
`off`, pending, done, and explicit user/agent/CLI/MCP waivers remain stale and
require a new intentional refine decision. A lock beside the status file
coordinates status writers across local processes. The post-run refresh is
best effort: if that lock stays busy past its 30 s limit, the run still
succeeds, logs a warning and leaves the waiver stale.

In the host GUI, an approval blocked by this gate offers a **Waive with
reason** recovery form. The waiver is recorded as a user decision; it does not
retry or automatically approve the edit. Review the transcript, enter a
non-empty reason, then retry approval intentionally.

Resume examples:

```bash
podcast pipeline run --project episode.project.json --from precorrect_transcript
podcast pipeline run --project episode.project.json --from assemble_timeline   # includes pass 2 reconcile
podcast pipeline run --project episode.project.json --unattended              # auto-waive refine gate
```

## What reconcile fixes (and does not)

**Fixes:** Words tagged `bleed` or `inaudible` get `suppressed: true` and are **omitted** from `combined.json` and search/play gating. Raw per-track JSON still retains all words.

The reconciliation engine applies status, suppression, and reattribution together for each word, from one target per word (acoustic verdict, overridden by the identical-text loser verdict on a mic pair with a measured bleed path, #774), and reports only the fields that differ from the stored word. A repeat run on an unchanged project reports zero changes (#782). A track or time-window scope leaves out-of-scope words untouched but still judges in-scope words against out-of-scope partners by their computed target, so a scoped pass reaches the same target as a full pass (#805); dry runs report proposed changes without applying suppression.

**Does not:** Revert a word's `suppressed` once a person or agent set it directly (`audibility_locked: true`, #768). `set_word_suppressed_tool`, `apply_bleed_suppression_tool` / `suppress-bleed` called with an explicit word list, and `apply_low_audibility_suppression_tool` called with an explicit `words_json` list all lock the word the same way `ignored` already does; reconcile — including pass 2 after `assemble_timeline` and the text-match overlap pass — skips a locked word entirely instead of recomputing its audibility over the decision. A heuristic `suppress-bleed` or low-audibility apply (no explicit list) does not lock, since it is just reconcile's own verdict recomputed (#781). Speaker attribution's automatic suppression (`run_speaker_attribution`, the home-speaker gate) also leaves a locked word's `suppressed` value alone. See [episode-format-v2.md](episode-format-v2.md) for the field.

Word times stay in **source-media seconds** at every layer — reconcile, precorrect, and refine never rewrite them onto the edited clock. Audibility maps word spans to the timeline through `SessionTimeline`; when rendered stems are absent, it also places raw samples on that same clock before measuring directed bleed paths. Follow-transcript gating still reads rendered stems (see [episode-format-v2.md § Timebase invariant](episode-format-v2.md#timebase-invariant)).

**ASR timing flags:** After `transcribe_tracks`, words longer than `analysis.heuristics.max_word_audibility_sec` (default **2.0 s**) are soft-marked `audibility_status: deferred` and listed in `artifacts/transcript_timing.json`. Timestamps are **not** clamped — a stretched Whisper token often covers real under-transcribed speech. Precorrect copies those into `deferred_queue` (`kind: anomalous_word_duration`) for refine/audition. With `transcribe.forced_alignment.enabled`, the flag runs on the aligned spans; a re-timed word loses Whisper's `deferred` status and is re-judged. A word the aligner cannot place (a numeral or symbol) keeps Whisper's times clamped between its re-timed neighbours; one the clamp collapses is flagged `deferred`.

**Threshold (#715):** `DEFAULT_MAX_WORD_DURATION_SEC` (`engines/asr_timing.py`) also
sets `analysis.heuristics.max_word_audibility_sec`'s default, since both the
aligner-off path and the audibility/bleed/precorrect checks share one constant.
The rule, fixed before measuring: let L be the longest word the shipped forced
aligner placed on the scored LibriSpeech clips, plus the worst `|duration
error|` against MFA gold on those same clips (`word_boundary_metrics.
duration_errors_sec` over `matched_word_pairs`). Keep the default only while
`L + 0.5 <= DEFAULT_MAX_WORD_DURATION_SEC`; otherwise raise it to
`ceil((L + 0.5) * 4) / 4`, and never lower it — real long words run 1-1.5 s,
and nothing measured supports a smaller cap for unaligned words. Measured
2026-09-28: L = 0.76 s (longest aligned word) + 0.22 s (worst duration error)
= 0.98 s, so `0.98 + 0.5 = 1.48 <= 2.0` and the cap stays at **2.0 s**. See
[docs/testing.md § Shipped pass results (#715)](testing.md#shipped-pass-results-715)
for the full measured tables, including the 1.0-2.5 s lab duration-count
sensitivity table this rule leans on.

**Word-boundary benchmark:** `scripts/benchmark_word_boundaries.py` compares native
Whisper or supplied candidate timestamps against the same real-audio reference
fixture under `tests/fixtures/word_boundary/`. The reference times are published
MFA alignments, not hand-checked truth. Only matching normalized words are
scored; the report also counts missed reference and extra predicted words.
Boundary MAE averages absolute start and end errors over matched words. The
`words_over_150ms_fraction` counts a word when either boundary differs by more
than 150 ms. The initial three-clip faster-whisper `base` CPU/int8 baseline is
**82.3 ms** MAE over 42/48 reference words, with **15/42 (35.7%)** matched
words over 150 ms; six reference words were missed and four predictions were
extra. This read-speech baseline cannot establish accuracy on conversational
podcast audio. See [testing.md](testing.md#word-boundary-benchmark) for the
reproduction command and fixture provenance. The metric also reports a signed
bias, `mean_start_error_ms`/`mean_end_error_ms` (prediction minus reference),
for tuning boundary padding. `scripts/benchmark_forced_aligners.py` runs
pinned CTC forced-aligner candidates (an ONNX wav2vec2-base and a
WhisperX-style torch wav2vec2-large) over the same fixtures and the lab tape.
[#641](https://github.com/calebn/sharecut-studio/issues/641) measured them and
recommends `onnx-base`: 42.98 ms MAE and 4.8% of matched words over 150 ms on
LibriSpeech, against native's 82.3 ms / 35.7%, at an RTF of 0.044.
`transcribe.forced_alignment.enabled` runs it in the pipeline (opt-in,
[#714](https://github.com/calebn/sharecut-studio/issues/714)); measured
pipeline results are [#715](https://github.com/calebn/sharecut-studio/issues/715).
See [testing.md § Lab tape: alignment testing grounds](testing.md#lab-tape-alignment-testing-grounds).

**Does not fix:**

- ASR mishearings on words still marked `audible` (e.g. “Budapest” for “Puro Pinché Party”)
- Wrong speaker attribution when both tracks are loud (dominance below `bleed_dominance_db`)
- Grammar or proper nouns — use precorrect + refine

## Workspace files

| File | Purpose |
|------|---------|
| `{workspace}/show_glossary.yaml` | Show title, recurring terms, replacements |
| `{workspace}/transcript_context.yaml` | Guest names, skip spans, episode overrides |
| `artifacts/transcript_timing.json` | Stretched ASR word flags from transcribe (no time rewrite) + `forced_alignment` per-job outcomes (each freshly-aligned job also carries `align_sec`, the wall time `WordAligner.align` took; a cache hit or a kept-Whisper failure has no `align_sec`; `no_evidence_words` counts words below `min_word_score` when the floor is on, #195) |
| `artifacts/transcript_precorrect_report.json` | Glossary/cross-track fixes, `deferred_queue`, `garble_hits` |
| `artifacts/transcript_refine_status.json` | Gate: `pending` / `done` / `waived` + precorrect fingerprint; successful unattended runs that execute the gate refresh only its stale waivers |

The Studio Pipeline tab edits per-project **Terms** and **Guest names** in
`transcript_context.yaml`. These values join the show title in Whisper's
initial prompt (`TranscriptContext.initial_prompt_text()`, read by the
faster-whisper engine that `transcribe_tracks` actually calls; the
`whisper.cpp` engine (`engines/whisper_cpp.py`) accepts the same kind of
prompt but has no caller in the transcribe pipeline today — tests and
`scripts/benchmark_transcribe_backends.py` are the only callers, and neither
passes one). Saving a change marks the vocabulary as needing transcription;
**Re-transcribe** runs the pipeline from `transcribe_tracks` through downstream
steps. Each transcript stores the vocabulary revision it was produced with. Studio
asks for re-transcription when any transcript differs from the revision in
`transcript_context.yaml`: single-track runs update only that track, a concurrent
edit stays stale, and a project without transcripts never asks. ASR caches
include model, language, prompt, and the VAD / decode options (`transcribe.vad`,
`transcribe.decode`). The prompt
has a 400-character limit by default (shared with the punctuation primer below),
and Studio rejects terms that would be truncated. This changes future ASR
output, not existing transcript words.

**Punctuation priming (#769).** A project with no show title, terms or guest
names used to send Whisper no prompt at all. For some tracks (rambling,
filler-heavy speech Whisper finds ambiguous) that let its first decode window
come out with no sentence punctuation or capitals; with
`condition_on_previous_text` on, that style then carried through the entire
track, because every later window conditions on the previous one's own
unpunctuated output rather than resetting each time. Lab evidence: one Zoom
track's first window decoded with 0 capitals and 0 end-punctuated words with no
prompt, at every temperature and VAD setting tried; any short, properly
punctuated prompt fixed it end to end (29/2995 capitalized, 1/2995 punctuated
before, comparable to its peers after — see the PR for exact figures). So
`TranscriptContext.initial_prompt_text()` (`transcript_context.py`) now always
sends a fixed punctuation-priming sentence (`DEFAULT_PROMPT_PRIMER`, currently
"Podcast episode transcript."), followed by any Terms/Guest names/show title,
whenever `transcribe.initial_prompt` is not turned off. This is a real change
to future ASR output for every project, not only ones with a saved vocabulary;
re-transcribe (or a changed-audio run) is needed to apply it to existing
transcripts. Because a prompt is now sent by default, the legacy
`transcripts/{track}_{audio}.json` cache (below) is only read when
`transcribe.initial_prompt: false` is set explicitly. `transcribe_tracks` also
flags a dialogue track whose punctuation rate lands far below its peers'
average (`collect_punctuation_outlier_flags`, needs at least two dialogue
tracks with 100+ words each so a short clip or a two-word peer can't trip it;
punctuation counts a trailing CJK/full-width mark (`。！？`) the same as
`.`/`!`/`?`, after stripping a closing quote or bracket first, so `word."` or
`你好。` both count; `artifacts/transcript_timing.json` → `punctuation_flags`,
step summary "low punctuation rate on `<track>`"), catching a case the primer
does not fully fix without needing a redecode to notice.

The primer is never cut mid-word to fit `transcribe.initial_prompt_max_chars`:
below the primer's own length (27 characters), the prompt falls back to
vocabulary alone (still comma-truncated to fit at a term boundary, dropped
entirely rather than split mid-word if not even the first term fits), never a
partial primer sentence; above it, vocabulary is truncated the same way (or
dropped entirely if none fits) to leave the primer whole. Saving vocabulary is
rejected only when the prompt actually has to cut some of it to fit — never
merely because the limit is below the primer's length, which just drops an
empty or already-cut vocabulary and sends the primer alone (#804). A
vocabulary already saved close to the 400-character default can now lose its
last term to the added primer even though it fit before #769;
`run_transcribe_plan` logs a warning
(`TranscriptContext.initial_prompt_vocabulary_truncated()`) the next time that
project transcribes, rather than failing silently — shorten the saved terms
or guest names, or raise `transcribe.initial_prompt_max_chars`, to clear it.

**Re-time words on a pre-#769 project.** `podcast_mcp/edits/transcript_reuse.py`'s
`plan_retime` looks up a reused track's ASR cache under the *current* primed
prompt first; a track whose transcript predates this change has its cache keyed
by the older, unprimed prompt (`full_prompt_text() or None`) instead, so that
lookup misses. `plan_retime` retries with that fallback prompt before giving up,
and records which jobs needed it (`TranscribePlan.retime_fallback`) so
`run_transcribe_plan` tries them under that same fallback prompt on the real
run. Because the cache file it found could be evicted or cleaned up between
planning and running, `run_transcribe_plan` re-checks each of those jobs'
cache under the fallback prompt again at run time (`#804`): a job whose cache
still hits reuses the fallback prompt as before; a job whose cache no longer
exists falls through to the current primed prompt instead, so a real Whisper
decode never runs unprimed (which would recreate #769 for that track). Re-time
only reuses cached words, so which prompt produced them does not matter as
long as the audio and model still match.

ASR also reads an older
`transcripts/{track}_{audio}.json` cache (which does not encode model, prompt or
decode options) when the new-name cache misses, caches are in use (not forced), no
prompt is set, **and** the decode options equal faster-whisper's own defaults (VAD off,
its default temperatures); with the shipped defaults (VAD on) or the default prompt
(above) that legacy file is ignored; it never migrates or rewrites that file.

With `transcribe.forced_alignment.enabled`, alignment results get their own
cache beside the ASR cache: `transcripts/{id}_{audio16}_{inputs16}.word_align_{key16}.json`,
keyed by the aligner identity (repo, revision, file, window settings, the score method,
plus the directory, size and mtime of a `PODCAST_MCP_WORD_ALIGNER_MODEL` override) and
a hash of Whisper's words. A forced run (`--force`) skips it. `transcribe.forced_alignment`
is not an ASR cache input, so toggling the flag never re-runs Whisper. The sidecar also
stores per-word `scores` alongside the aligned spans, and the aligner identity includes
the score method, so older sidecars miss once. The cache write is
best-effort: a failed write logs a warning and keeps the aligned spans. Writing a new
alignment cache deletes older ones for the same ASR cache.

The run-only `retime_words` flag (Studio **Re-time words** next to the Pipeline tab's
Precise word boundaries field, CLI `pipeline run --retime-words`, MCP
`pipeline_run(retime_words=true)`) re-times stored transcripts without re-running Whisper:
it reads Whisper's cached words for the track's current model, language, vocabulary prompt
and decode options (`TranscriptionEngine.read_asr_cache`, the same lookup `transcribe_job`
uses), then aligns them and replaces the stored transcript, going through the alignment
cache above like any other alignment. Reused transcripts with no ASR cache for the current
inputs are skipped and reported; only Re-transcribe can rebuild them. Hand-edited transcripts
are re-timed only with the same `overwrite_edited` confirmation Re-transcribe uses; CLI and
MCP never send that confirmation, so they always skip edited transcripts and report them.
The run fails before changing any transcript when the word aligner cannot load. A track
whose alignment fails is listed under `forced_alignment.retime.failed` in
`transcript_timing.json`, not under `retimed`.

**Silence hallucinations (#521).** Whisper invents words over silent stretches (mostly
low-volume bleed tracks). ASR runs Silero VAD first (`transcribe.vad.enabled`, default on)
and decodes with `hallucination_silence_threshold`. VAD keeps quiet speech down to about
40 dB below the talker (measured on `tests/fixtures/asr_gold` with `base.en`). Fainter bleed
is dropped, so bleed-phrase alignment on very quiet bleed falls back to gap alignment; for
such episodes lower `transcribe.vad.threshold` or turn `transcribe.vad.enabled` off. After
ASR, each word whose own-track peak (native sample rate, all channels) is below
`transcribe.silence_filter.peak_dbfs` (-60 dBFS) gets `suspect_hallucination: true`. ASR
cache files store unflagged words; the flags are recomputed from the current
`transcribe.silence_filter` settings after every ASR run or cache read, so the filter is not
a cache input. `transcribe_tracks` re-flags a reused transcript when its audio identity, silence filter settings, word spans or flag state differ from its stored `silence_filter_fingerprint` (only a peak envelope is decoded; Whisper does not re-run). This also rechecks a same-span phrase correction that clears a flag. The fingerprint is stored after reflagging, so unchanged runs reuse the stored flags without decoding the audio. Legacy transcripts without a fingerprint are checked once. A new `peak_dbfs` or turning the filter off applies on the next pipeline run without Re-transcribe. When a track cannot be decoded its silence flags stay cleared (aligner-evidence flags, below, still apply and are then the only flags on that track), a warning is logged, the step summary adds "silence filter skipped on N track(s)", and no fingerprint is stored, so the next run retries the decode (for example once ffmpeg is fixed).

**Aligner evidence (#195).** With `transcribe.forced_alignment.enabled`, each word the aligner
places gets `alignment_score`, the mean posterior of the frames it used. A score below
`transcribe.forced_alignment.min_word_score` (default 0.01, 0 = off) also sets
`suspect_hallucination`. It is flag-only, reviewed the same way, and catches hallucinations over
room noise or bleed that the -60 dBFS peak test cannot; words the aligner could not place have no
score and are judged by the silence filter alone. `transcript_timing.json` →
`forced_alignment.jobs[].no_evidence_words` counts them, and the step summary adds "N aligned
word(s) with no acoustic evidence". A person's or agent's text correction drops the word's stale
score: `correct_word` clears `alignment_score` and the flag when the text changes, and
`correct_phrase` writes new unscored words, so the evidence flag does not come back on a corrected
word (the silence filter still re-checks its span on the next run, because the flag-state term of
the fingerprint changes). Automated `precorrect_transcript` rewrites (glossary and cross-track
sync) keep the evidence, since the audio under the word is unchanged: a word rewrite keeps its
score and flag, and a phrase rewrite gives each new word the lowest old score and the flag if any
old word had it. A changed floor re-flags reused transcripts without
decoding Whisper; turning `forced_alignment.enabled` off does not remove scores already stored on
reused transcripts, so they keep flagging until `min_word_score` is 0 or the track is
re-transcribed; transcripts re-timed before scores existed, or scored under an older
`alignment_score_method`, show as "not re-timed" until Re-time words runs.

The flag is informational and nothing filters on it. Reconcile, merge, tighten and exports
treat a flagged word like any other (reconcile's inaudible pass often suppresses it anyway).
Review flagged words with `transcript_refine_brief_tool` (`suspect_hallucination_open_words`,
`suspect_hallucination_sample`, limited to the first ten records) or Studio's Annotate view (dotted underline, tooltip "Possible transcription with no matching speech" and screen reader status on unsuppressed flagged words), and suppress real
hallucinations with `set_word_suppressed_tool`. If a track still loops, set
`transcribe.decode.condition_on_previous_text: false`.

`podcast transcribe` / `transcribe_track` read the same `transcribe.*` settings as
`pipeline_run`: the project's staged working set (Studio Pipeline pane,
`pipeline_set_config_tool`), or the shipped defaults when nothing is staged. The CLI has no
working set, so it always uses the shipped defaults. Reading them never stages a working set for the project.

**Reuse policy:** `transcribe_tracks` never re-runs ASR over a transcript that
already exists for the same audio. Studio's **Re-transcribe** (`force_transcribe`),
CLI `--force`, or `transcribe.overwrite: true` replace it explicitly; forcing skips
the ASR disk cache (both cache names) and re-runs Whisper. Changed
media re-transcribes automatically. Transcripts edited through `correct_word`,
`correct_phrase`, `set_word_suppressed`, `set_words_ignored`, `verify_transcript` or transcript
cleanup are flagged `user_edited`. An unattended (Batch) run refuses to replace one, before
any ASR, both when overwrite was requested and when its audio changed (its word
times are stale); the error names each track and reason. Run attended to replace
them with a warning, or use Studio Re-transcribe, which names the edited tracks and asks before replacing them.

**What counts as an edit:** `user_edited` is set by `EditService` (`correct_word`,
`correct_phrase`, `set_word_suppressed`, `set_words_ignored`, `verify_transcript`, transcript cleanup),
which MCP tools, CLI (`podcast transcript correct`, `correct-phrase`, `suppress-word`,
`cleanup-batch`) and Studio document commands all
use, and only when the words actually changed. Automated passes stay unmarked on
purpose because re-running the pipeline re-derives them: precorrect (glossary and
cross-track), reconciliation, speaker attribution, audio-quality and bleed
suppression, and transcript sync. Editing `episode.project.json` by hand is not
detected; set `"user_edited": true` on that transcript to protect it.

**Stale-index guard (#650, #744):** the `CorrectTranscriptWord` / `CorrectTranscriptPhrase` /
`SetTranscriptWordSuppressed` / `SetTranscriptWordsIgnored` document commands and the
`correct_transcript_tool` / `correct_transcript_phrase_tool` / `set_word_suppressed_tool` /
`set_words_ignored_tool` MCP tools take an optional `expected_text` — the word (or
space-joined phrase) text the caller read at those indices. `EditService` checks it inside
the same transaction as the mutation, for all four via the shared
`_guarded_transcript_edit` helper (`edits/transcript_correct.require_word_text`),
comparing whitespace-collapsed, case-sensitive text; indices that no longer exist count as
a mismatch too; a mismatch means another edit (a
remote host, a guest, or an agent) shifted or changed those words since the caller last
read them. A document command mismatch is a 409 conflict, same shape as other stale-state
conflicts, and nothing is applied; an MCP tool mismatch is a `ValueError` tool error. In Studio the
inline editor always sends the text it opened with; the Correct inspector sends the span
text captured when the word was selected or End index last changed, and only when every
word in that range is loaded and its loaded copies agree (otherwise it sends none and
shows a hint under Apply); Suppress and Ignore send the word's currently rendered text,
or no guard when that text can't be confirmed (a word in the range isn't loaded, or two
loaded copies of an index disagree), same as Apply. When Select-mode Ignore/Restore or the
hover Restore sends no guard, its status message says "text not verified".
The Correct inspector captures once per word (#746): the draft is seeded when the
word first loads (a different word remounts the inspector), never on a text change, so a
peer's edit to the word under correction (including its own successful Apply) does not
reset what the user is typing. A successful Apply re-captures from the words the host
returned — the End index moves to match a phrase's applied word count — so the next Apply
guards against the correction just made; if those words do not read as the applied text,
it sends none and shows the hint under Apply. An Undo or Redo of the inspector's own Apply
(the words go back to a span it applied or replaced) moves the captured text and End index
with them, so the next Apply does not conflict. An Undo of an Apply that went out without
span text (the hint was showing) returns the inspector to sending none, with the hint under
Apply, rather than a stale baseline. After a 409, Studio loads the host's
current transcript words (the `detail` phase) before reporting the refusal; the inspector
keeps the typed draft, re-captures the span text from them, and, when that text differs from
the refused text, says Apply again retries against the current text. If the load failed and
no live update has arrived yet, it keeps the host's re-read wording instead.
Once any Studio correction of the same word (same track and start index) lands, live or
replayed from the offline queue, earlier refusals of it leave **Needs attention**.
`podcast transcript correct` / `correct-phrase` / `suppress-word` all take it as
`--expected-text`; the batch cleanup (`apply_transcript_cleanup_tool` /
`podcast transcript cleanup-batch`) / `verify_transcript` paths do not send it, and
omitting it keeps the edit unguarded.
MCP/CLI callers (`correct_transcript_tool`, `correct_transcript_phrase_tool`,
`podcast transcript correct --expected-text`), the inline chip editor, and Suppress /
Ignore do not re-capture: the fix for a rejected edit there is to re-read the transcript
and redo it against its current text.

**Ignore vs. suppress (#633):** `set_words_ignored_tool` (MCP), the Select-mode
Ignore/Restore button, and the Correct word inspector's Ignore action all call
`set_words_ignored` — a text-and-audio hide for review passes. The word (or word
range) stays struck through in the transcript and in `combined.json`; only its
audio is muted, computed from the transcript at render time and never written to
`Clip.mute_regions`, so restore always un-mutes exactly what ignore muted and
never an unrelated tighten mute. This is different from `set_word_suppressed`,
which is text-only: a suppressed word is dropped from the combined transcript but
its audio is untouched. When that drop would otherwise take the word out of every
same-track utterance's `[start, end)` window — its utterance's first or last word,
or a run between two utterances — Sharecut Studio's view mapper still lists it as
a chip, attached to the nearest same-track utterance (`_edge_suppressed_word_indices`,
#752); `combined.json` itself is unaffected, so Correct still opens the word and
Unsuppress brings it back into the combined text. A track whose words are all
suppressed has no combined utterance to attach to. The mapper instead lists its
words on dimmed, view-only `suppressed_only` rows (one per gap-run), so
Correct → Unsuppress still reaches them (#758). Reconcile and speaker attribution
never flip `ignored` automatically. No `EditDecision`, cut, or `edit_log` record is
created either way, but ignore additionally creates none of the mute-region
bookkeeping that a `tighten.edit_mode: mute` cut would.

**Low-confidence walkthrough (#634):** it uses the same 0.7 threshold as
`low_confidence_words_tool`; Sharecut Studio walks those words Next/Previous
under Annotate; a corrected word (confidence set to 1.0) leaves the list and
the walk continues with the nearest flagged word after (Next) or before
(Previous) it in transcript order, even when an agent batch-corrects several.

CLI `podcast transcribe` and MCP `transcribe_track` are the explicit re-transcribe
path: they run ASR even when a transcript exists (the ASR disk cache still counts),
replace only the transcripts they produce, keeping other tracks and extra-source
transcripts, and log a warning when they replace a `user_edited` one.

Set context before transcribe when possible:

```bash
podcast transcript context set --project episode.project.json \
  --show-title "Shot of Truth Podcast" --guest-name "Olga Araceli" --term "Puro Pinché Party"
```

### Example `show_glossary.yaml`

```yaml
show_title: Shot of Truth Podcast
replacements:
  - match: Budapest Party
    replace: Puro Pinché Party
  - match: shot shoot podcast
    replace: Shot of Truth Podcast
  - match: in sight fear
    replace: inciting fear
  - match: wazoo
    replace: Wazzu
  - match: port the weather
    replace: port de verdad
garble_patterns:
  - Buddha Pachan
  - Charter Truth
```

Show-specific names belong here, not in global `.agents/defaults/transcript_glossary.yaml`.

## Agent gate (`require_transcript_refine`)

After `precorrect_transcript`, the pipeline step **`require_transcript_refine`** blocks until status is **done** or **waived** (fingerprint must match the latest precorrect apply).

1. `transcript refine-brief` / `transcript_refine_brief_tool`
2. Whole-episode context pass + `deferred_queue` / `garble_hits` (skill **podcast-transcript-refine**)
3. Apply high-confidence fixes; batch ambiguous items for user
4. Escalate listen-first spans to **podcast-transcript-audition**
5. `transcript refine-done` (or user `refine-waive --reason …`)

Mode (`analysis.transcript_refine.mode` in pipeline.yaml):

| Mode | Behavior |
|------|----------|
| `waive_unattended` (default) | Hard-fail interactive/MCP; auto-waive when `PODCAST_BATCH=1` or `--unattended` |
| `require` | Always hard-fail until done/waived |
| `off` | Skip the gate step |

Focus/tighten/NL service entry points also call the same assert so agents cannot bypass via direct tools.

Applied cuts (ripple deletes, approved removes, punches) drop the removed words, which changes the fingerprint. A `done` or `waived` status therefore goes stale after a structural edit. Re-waive (`refine-waive --reason …`) or run `refine-done` before the next edit. See [pipeline.md § Long raw sessions](pipeline.md#long-raw-sessions-content-cut-before-tighten).

## Decision tree

| Symptom | Layer |
|---------|-------|
| Wrong speaker’s words on a track | Reconcile (bleed suppress); audition if dominance ambiguous |
| Same moment, different words on two tracks | Precorrect cross-track sync, then refine |
| Garbled proper noun / episode title | `show_glossary.yaml` → precorrect → refine |
| Low-confidence word, grammar unclear | Refine batch → audition |
| Single ambiguous span | Audition only |

## Captions (SRT/VTT)

`transcript export-srt` / `export-vtt` and the pipeline's `export_deliverables` step both
build cues through `export/transcript.py` (`utterances_to_srt` / `utterances_to_vtt`), the
one place SRT/VTT cues are built. Cues are word-timed: kept (non-suppressed) words are
grouped per track the same way `merge_transcripts` groups a combined utterance
(`engines/utterance_runs.transcript_word_runs`), each word is mapped source → timeline
clock (`SessionTimeline.map_word_spans`), and a run is then greedily split into cues that
respect `CaptionLimits` — never splitting inside a word, preferring a sentence-ending
(`.!?…`) break over a phrase (`,;:`) break over a hard cutoff, and wrapping each cue's
text onto up to `max_lines` lines of at most `max_chars_per_line` characters. A single
word longer than `max_chars_per_line` still gets its own (overlong) line rather than being
split. A run that already fits the limits whole stays one cue even if it contains
internal sentence/phrase punctuation (`"Yeah, totally."` is one cue, not two): a break is
only taken when the remainder does not fit, and never when it would leave a one-word lead
cue (`"Anyway,"` alone) — the break must leave at least two words behind it. The final cue
list across every track is sorted by start, so a shorter run on one track that starts
partway through a longer run on another interleaves correctly instead of trailing it. The
markdown transcript (`combined_transcript_markdown`) is unaffected: it stays whole
utterances.

**Minimum on-screen time (#790, cross-track guards #816).** A cue under
`min_duration_sec` first tries to merge into its nearest same-track neighbour (smaller
gap first) when the gap between them is at most `merge_max_gap_sec`, the merged cue still
fits every other limit, and no other track has a *word* timed inside the gap being
bridged — checked at word granularity, not cue granularity, since another track's cue can
start before the gap and still have a later word land inside it (an interjection
mid-utterance). A qualifying merge can pull in a neighbour from a different utterance
run, not just a different split of the same run. Any cue still under `min_duration_sec`
after that is held to that duration by extending its end, capped at the start of the next
cue on the *same* track and at the start of the next cue on *any other* track that begins
at or after this cue's own (pre-hold) end — a track already mid-utterance when this cue
starts isn't a "next" cue to cap against, but one that starts once this cue is naturally
done is. Neither pass can violate `max_duration_sec`, `max_chars_per_line`, or
`max_lines`; the hold-to-minimum pass does not re-check `max_duration_sec` since it only
affects display time, not text.

Defaults (common caption guidance — about 2 lines of about 42 characters, at most 7s):

| Limit | Default | Config path |
|-------|---------|-------------|
| Max cue duration | 7.0s | `export.captions.max_duration_sec` |
| Max characters per line | 42 | `export.captions.max_chars_per_line` |
| Max lines per cue | 2 | `export.captions.max_lines` |
| Min cue duration | 1.0s | `export.captions.min_duration_sec` |
| Max gap to merge a short cue across | 1.5s | `export.captions.merge_max_gap_sec` |

Set them in [`.agents/defaults/pipeline.yaml`](../.agents/defaults/pipeline.yaml)
(`export.captions`, used by `export_deliverables`), or per invocation with
`podcast transcript export-srt --max-duration-sec … --max-chars-per-line … --max-lines …`
(same flags on `export-vtt`); unset CLI flags fall back to the pipeline defaults.
`min_duration_sec` / `merge_max_gap_sec` are yaml-only (no CLI flags). `--max-lines` must
be at least 1 and `--max-duration-sec` must be greater than 0 — the CLI rejects a bad flag
value with a usage error (exit 2). `export.captions` yaml values are checked the same way
at load, but as a domain error (exit 1), since they aren't CLI flags: `min_duration_sec`
must be greater than 0 and at most `max_duration_sec` (a longer minimum than the duration
cap would hold cues past the cap it's supposed to respect), and `merge_max_gap_sec` must
be at least 0.

## Troubleshooting

**Zero bleed words during known cross-talk** — See [transcript-reconcile.md](transcript-reconcile.md#debugging-no-bleed-words). Check stem freshness after `render_dialogue_stems`.

**Focus theme wrong / “Budapest” in outline** — Precorrect + agent refine were skipped or `show_glossary.yaml` missing.

**Reconciliation stale** — Run `assemble_timeline` or `render_preview` after FX/edits; pass 2 reconcile runs automatically in full pipeline.

**Optional second precorrect** — Only if FX materially changes cross-track overlap text; not part of default pipeline.

The home-speaker gate and track enrollment reuse one bounded PCM WAV reader per
track. Each window keeps the same frame rounding and resampling as the standard
decoder, without loading the whole stem. The gate indexes bleed windows while
retaining the first window in scan order when several overlap a word.
