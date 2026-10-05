# Lab tighten fixtures

Two 25-second windows from the pinned Sharecut Podcast Lab recording give
Tighten real multitrack speech with fillers and pauses. They are real
microphone recordings, not generated test audio. Each window holds all three
tracks (Caleb, Audra, Lana) as native stereo 48 kHz PCM16, losslessly encoded
as FLAC. Zoom locked the originals, so source offsets are zero. The generator
applies no gain or normalization.

The repository owner authorized publishing these short clips as Sharecut
Studio test fixtures (stated in chat, 2026-10-05). The source recording
revision and the original M4A and ASR hashes are recorded in
[`manifest.py`](manifest.py). This permission statement does not create or
claim a license for the source recordings. No full recording is included.

| Case | Source interval (s) | Filler labels | Pause labels |
| --- | --- | --- | --- |
| `lana_uh_cluster` | 1108.0 to 1133.0 | 5 (Lana) | 6 (3 Caleb, 3 Lana) |
| `caleb_um_pause` | 608.0 to 633.0 | 1 (Caleb) | 4 (Caleb) |

Each case directory is an openable v2 episode project. It has
`episode.project.json`, `raw/<track>.flac`, and the transcript mirrors under
`transcripts/`. The transcripts hold the lab's seeded ASR words that lie fully
inside the window, shifted to clip time.

## Labels are ASR, not ground truth

Every label has `label_source: "asr_seed"`. Labels come from the lab's
`source/asr/*.json`, a faster-whisper `base` dump with no reconcile or refine
pass. No person has listened to confirm them. A filler label is an ASR word
that reads `uh` or `um` once punctuation is dropped. A pause label is a gap of
at least 1.2 s between two consecutive ASR words on one track, both inside the
window.

The committed audio shows where the ASR is wrong. `tests/test_lab_tighten_fixtures.py`
measures each filler label's RMS on its own track.

- **Lana 1114.6 and 1124.56.** These "Uh" labels sit on digital silence. Lana's
  track is gated, and her only voiced audio in the window is at 1110.25 to
  1110.70 s and 1122.45 to 1122.95 s.
- **Lana 1125.96.** This "Uh" label has zero duration.
- **Lana "Uh" plus "-huh."** The ASR splits each backchannel "uh-huh" into these
  two words. The "Uh" labels may therefore mark acknowledgments, not hesitations.
- **Caleb 615.98.** The ASR token is `Um.`, with punctuation.

The labels are kept as the ASR wrote them. Tests that depend on them say which
ones fail and why.

## What the tests show

The tests run the Tighten Find hits path (the `analyze_fillers_pauses`
pipeline step at medium intensity) on a temporary copy of each case.

- **`lana_uh_cluster`.** Two Lana filler hits, overlapping the 1121.26 and
  1124.56 labels. Both hits remove digital silence on Lana's track, not her
  voiced audio. The labels at 1109.04 and 1114.6 are isolated fillers, which
  medium skips, and the zero-length 1125.96 label is skipped. No pause hit
  survives. Breath protection suppresses five of the six pause candidates, and
  the cross-track speech guard blocks the sixth.
- **`caleb_um_pause`.** One Caleb pause hit, at 625.46 to 627.83 s. The `Um.`
  label gets no hit, because the filler lexicon does not strip punctuation.

The misses and the silent hits are strict `xfail` tests with these reasons.
When a product fix changes the result, the strict marker fails and the test
must be updated.

## Open in Sharecut Studio

Copy a case first. Mutations must not touch the committed fixture. Find hits
also needs the transcript refine gate waived, because the seeded ASR has not
been refined.

```sh
cp -R tests/fixtures/lab_tighten/lana_uh_cluster /tmp/lab-tighten
podcast transcript refine-waive --project /tmp/lab-tighten/episode.project.json \
  --reason "lab_tighten fixture: seeded ASR"
podcast gui --project /tmp/lab-tighten/episode.project.json
```

## Regenerate

Install the repository development dependencies and check out the pinned lab
revision:

```sh
git clone https://github.com/calebn/sharecut-podcast-lab.git /path/to/ShareCut_Podcast_Test
git -C /path/to/ShareCut_Podcast_Test checkout 3b414c4c86aa46b058d0505d3e0fb2092a6a959f
```

Regenerate the fixture:

```sh
uv run --extra dev python tests/fixtures/lab_tighten/regenerate.py \
  --lab-root /path/to/ShareCut_Podcast_Test \
  --output-dir tests/fixtures/lab_tighten
```

To regenerate into a temporary directory and compare it with the committed
fixture, add `--verify-dir`:

```sh
uv run --extra dev python tests/fixtures/lab_tighten/regenerate.py \
  --lab-root /path/to/ShareCut_Podcast_Test \
  --output-dir /tmp/lab-tighten-regenerated \
  --verify-dir tests/fixtures/lab_tighten
```

The generator checks the lab revision and the M4A and ASR file hashes. It then
derives the labels from the ASR and fails if they differ from the manifest.
Audio extraction uses the shared [`../lab_clips.py`](../lab_clips.py), the same
code as `lab_bleed`. It decodes each original completely, slices native sample
frames, and verifies each FLAC by decoding it back to PCM. Projects are built
with the repository's track media and transcript helpers and are
deterministic. `--verify-dir` compares decoded PCM and project JSON with the
committed files. FLAC bytes can differ between encoder versions, so
`pcm_sha256` is the regeneration seal and `file_sha256` seals the committed
artifact.
