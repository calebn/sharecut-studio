# aligned_dialogue

Two-speaker, 60-second episode for E2E audio, transcript editing, and GUI tests.
Tracks remain `reference` and `guest`. Waveform pyramids build on demand.

## Audio and labels

The fixture places complete human-read LibriSpeech utterances from the checked-in
[word-boundary corpus](../word_boundary/README.md) on two silent tracks.
`reference` uses `6241-61943-0003` at 2 and 35 seconds.
`guest` uses `1988-147956-0023` at 8 and 43 seconds.
Utterances retain their natural rate and duration. No word is synthesized,
stretched, truncated, or moved independently of its recording.

The audio and derived alignment dataset are [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Attribute LibriSpeech to Panayotov, Chen, Povey, and Khudanpur, ICASSP 2015.
The source dataset is [LibriSpeech](https://www.openslr.org/12), and the word labels
come from [gilkeyio/librispeech-alignments](https://huggingface.co/datasets/gilkeyio/librispeech-alignments).
The corpus supplies reference text. Word boundaries are MFA-derived reference
alignments, not human-verified boundary gold. This composed audiobook fixture
also does not represent spontaneous podcast speech or natural conversational overlap.

`provenance.json` records source and output hashes and placements. Raw WAVs are
48 kHz mono PCM16 and exactly 60 seconds. `sources/` contains padded originals
of 90 and 180 seconds, with raw audio at ingest offsets 0 and 98 seconds.
Project transcripts, mirrors, and `../canned_transcript_aligned.json` all use the
published words shifted by the same placement offsets. Canned confidence is
seeded test metadata, not measured ASR confidence.

## Regenerate

```bash
uv run python scripts/build_aligned_dialogue_audio.py
uv run python scripts/build_ux_demo_fixture.py
```

The builder uses checked-in media and integer linear interpolation from 16 to
48 kHz. Original samples remain every third frame; intermediate frames round
to the nearest integer and the final endpoint is held. This preserves duration
and gives identical PCM across platforms without FFmpeg or floating-point
resampling. It needs no network or model.
It verifies input hashes before writing. Fixture tests independently reconstruct
the audio from the source recordings and verify the shifted labels.

## Exercise

```bash
PROJECT=tests/fixtures/aligned_dialogue/episode.project.json
podcast fixture seed-transcript --project "$PROJECT" \
  --from tests/fixtures/canned_transcript_aligned.json
podcast play --project "$PROJECT" --compare --start 2 --end 15 --rerender
podcast render-preview --project "$PROJECT"
```

Search for `uncle`, `delighted`, or `questioned`. The slow live-ASR test scores
complete reference text independently for each track, including omissions and
hallucinations in silence.

Mutating tests copy the tree into a relocated temporary workspace. Do not run
mutations against the committed project. `scripts/build_large_project_fixture.py`
uses its project shape as the seed for a disposable benchmark.
