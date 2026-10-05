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

| Case | Source interval (s) | Filler labels | Backchannel labels | Pause labels |
| --- | --- | --- | --- | --- |
| `lana_uh_cluster` | 1108.0 to 1133.0 | 0 | 5 (Lana) | 6 (3 Caleb, 3 Lana) |
| `caleb_um_pause` | 608.0 to 633.0 | 1 (Caleb) | 0 | 4 (Caleb) |

Each case directory is an openable v2 episode project. It has
`episode.project.json`, `raw/<track>.flac`, and the transcript mirrors under
`transcripts/`. The transcripts hold the lab's seeded ASR words that lie fully
inside the window, shifted to clip time.

## Labels are ASR

Every label has `label_source: "asr_seed"`. Labels come from the lab's
`source/asr/*.json`, a faster-whisper `base` dump with no reconcile or refine
pass. A filler label is an ASR word that reads `uh` or `um` once punctuation is
dropped. A backchannel label is such a word immediately followed by a `-huh` or
`-hmm` continuation token, which the ASR emits when it splits an "uh-huh"
acknowledgment in two. Its `text` holds both tokens and its `source_interval`
spans both. A pause label is a gap of at least 1.2 s between two consecutive
ASR words on one track, both inside the window.

The generator rewrites the labels on every run and fails if they differ from
the manifest. They are never the truth about what was said. The committed audio
shows where the ASR is wrong. `tests/test_lab_tighten_fixtures.py` measures
each filler and backchannel label's RMS on its own track.

- **Lana 1114.6, 1124.56 and 1125.96.** These backchannel labels sit on digital
  silence. Lana's track is gated, and her only voiced audio in the window is at
  1110.25 to 1110.70 s and 1122.45 to 1122.95 s.
- **Lana 1124.56 and 1125.96.** The first label's `-huh.` token and the second
  label's `Uh` token both have zero duration.
- **Caleb 615.98.** The ASR token is `Um.`, with punctuation.

## Owner listening

`OWNER_VERDICTS` in [`manifest.py`](manifest.py) holds what the repository owner
heard on 2026-10-05. It is a separate table keyed by case, track, label kind and
source start. The generator never rewrites it, and fails if a verdict key
matches no generated label.

| Label | Verdict | Heard clip (source s) |
| --- | --- | --- |
| Lana backchannel 1109.04 | keep | 1108.5 to 1111.5 |
| Lana backchannel 1121.26 | keep | 1120.5 to 1126.5 |
| Lana backchannel 1124.56 | keep | 1120.5 to 1126.5 |
| Lana backchannel 1125.96 | keep | 1120.5 to 1126.5 |
| Caleb filler 615.98 (`Um.`) | cut | 615.0 to 617.5 |
| Caleb pause 625.42 to 628.38 | cut | 624.5 to 628.5 |

Every Lana "Uh" in `lana_uh_cluster` is the first token of an ASR split `Uh`
plus `-huh.`. The owner confirmed the heard ones are "uh-huh" acknowledgments
that should be preserved. The Caleb `Um.` is a real filler to cut. The Caleb
pause verdict covers the pause Tighten proposes inside that label, at 625.46 to
627.83 s, which is also to be cut.

Every other label is unheard and stays ASR-only. That includes Lana
backchannel 1114.6, which the heard clips did not cover, and every other pause
label.

## What the tests show

The tests run the Tighten Find hits path (the `analyze_fillers_pauses`
pipeline step at medium intensity) on a temporary copy of each case and check
it against the owner verdicts.

- **Kept acknowledgments.** No proposed hit may overlap a `keep` backchannel.
  Today two Lana filler hits overlap the 1121.26 and 1124.56 labels, and both
  remove digital silence from Lana's gated track. This is a strict `xfail`
  citing calebn/sharecut-studio#977.
- **Cut fillers.** Each `cut` filler verdict needs a filler hit. The `Um.`
  token gets none, because the filler lexicon does not strip punctuation. This
  is a strict `xfail` citing calebn/sharecut-studio#975.
- **Cut pauses.** Each `cut` pause verdict needs a pause hit. Tighten proposes
  one at 625.46 to 627.83 s, and this test passes today.

When a product fix changes a result, the strict marker fails and the test must
be updated.

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
derives the labels from the ASR and fails if they differ from the manifest or
if an owner verdict matches no label.
Audio extraction uses the shared [`../lab_clips.py`](../lab_clips.py), the same
code as `lab_bleed`. It decodes each original completely, slices native sample
frames, and verifies each FLAC by decoding it back to PCM. Projects are built
with the repository's track media and transcript helpers and are
deterministic. `--verify-dir` compares decoded PCM and project JSON with the
committed files. FLAC bytes can differ between encoder versions, so
`pcm_sha256` is the regeneration seal and `file_sha256` seals the committed
artifact.
