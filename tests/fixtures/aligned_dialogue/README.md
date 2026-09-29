# aligned_dialogue

Two-speaker episode project (60s) for e2e tests, MCP tools, and skills.

**Project:** `episode.project.json`  
**Tracks:** `reference`, `guest`  
**Waveforms:** nothing is tracked under `artifacts/`; the viewer builds `.wfpk` pyramids on demand (`docs/waveform.md`)

## Quick commands

```bash
PROJECT=tests/fixtures/aligned_dialogue/episode.project.json

podcast fixture seed-transcript --project "$PROJECT" \
  --from tests/fixtures/canned_transcript_aligned.json

podcast play --project "$PROJECT" --compare --start 18 --end 28 --rerender
podcast propose-edits --project "$PROJECT"
podcast render-preview --project "$PROJECT"
```

**Transcript search terms:** `documented`, `people`, `today`, `going`, `great`

## Audio

`raw/{reference,guest}.wav` and `sources/{reference,guest}.wav` are Piper TTS speech
(`piper-tts` 1.8.0), not a recording: `reference` uses `en_US-norman-medium` (US male,
trained on LibriVox, public domain) and `guest` uses `en_US-ljspeech-medium` (US female,
trained on LJ Speech, public domain). Both voice models are MIT-licensed, from
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) pinned at revision
`c10ece1aade47bb51c153c893d14e5bf8e5b7117`.

The speech is placed at `tests/fixtures/canned_transcript_aligned.json`'s word start/end
times: a contiguous run of short words becomes one synthesized phrase, and slower
one-second-per-word slots each get their own segment, with digital silence between
segments (as before regeneration, so no noise floor is introduced). The canned transcript
is therefore real gold now — the audio says exactly what the transcript claims, at the
times it claims — and every canned-seeded test (NL cuts, social clips, play windows,
GUI ripple-delete ranges) keeps its existing timings unchanged. `sources/` still holds
zero-padded originals at the `ingest.yaml` offsets (`0 s` / `98 s`).

Regenerate with:

```bash
uv run --with piper-tts==1.8.0 python scripts/build_aligned_dialogue_audio.py
```

This is not a project dependency (like the ffmpeg-only bleed-fixture builder, it is a
one-off regeneration tool) and needs network access for the Piper wheel and the two voice
models (~60 MB each, cached by `huggingface_hub`). Regeneration is **not** bit-identical:
Piper's duration predictor samples noise, so re-running produces a different (but
similarly-timed) recording each time. Changing the canned word times means regenerating
this audio to match (#801).

E2e tests copy this tree into `tmp_path` and rewrite `workspace_dir` to the copy (`e2e_workspace`), so runs never write into these committed files. Prefer that copied workspace over this committed path when experimenting locally.

`scripts/build_large_project_fixture.py` derives its disposable two-hour benchmark project from this `episode.project.json` (it loads it read-only and writes elsewhere). Changing the tracks or sources here changes that benchmark; see [docs/testing.md](../../../docs/testing.md) § Large-project browser profile.
