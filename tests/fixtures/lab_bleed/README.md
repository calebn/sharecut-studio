# Lab bleed fixtures

These 11 short clips come from the pinned Sharecut Podcast Lab recording. They
are real microphone recordings, not generated synthetic test audio. Each file
contains the reviewed source interval plus 50 ms of native stereo 48 kHz
context on each side. PCM16 samples are losslessly encoded as FLAC. The
generator keeps source offsets at zero and applies no gain or normalization.

The repository owner authorized publishing these short clips as Sharecut
Studio test fixtures. The source recording revision and original M4A hashes
are recorded in [`manifest.py`](manifest.py). This permission statement does
not create or claim a license for the source recordings. No full recording or
episode project JSON is included.

The manifest is the case table used by the regeneration script and
`tests/test_lab_bleed_fixtures.py`. It records source and reviewed timeline
intervals, per-track FLAC and decoded PCM hashes, literal human listening
labels, ownership confidence, and intended reviewed mute scope. The labels
preserve uncertainty. In particular, the earlier observation in
`observed_sound_not_to_keep` was corrected by the owner: the sounds were not
worth keeping, and removing them was the desired edit. That case is not a
confirmed or desirable owner-breath positive. No numeric breath onset truth
is claimed.

To regenerate clips, install the repository development dependencies and pass
the pinned lab checkout explicitly. Create that checkout with:

```sh
git clone https://github.com/calebn/sharecut-podcast-lab.git /path/to/ShareCut_Podcast_Test
git -C /path/to/ShareCut_Podcast_Test checkout 3b414c4c86aa46b058d0505d3e0fb2092a6a959f
```

Then regenerate the clips:

```sh
uv run --extra dev python tests/fixtures/lab_bleed/regenerate.py \
  --lab-root /path/to/ShareCut_Podcast_Test \
  --output-dir tests/fixtures/lab_bleed
```

To regenerate in a temporary directory and compare decoded PCM with the
committed clips, pass both directories:

```sh
uv run --extra dev python tests/fixtures/lab_bleed/regenerate.py \
  --lab-root /path/to/ShareCut_Podcast_Test \
  --output-dir /tmp/lab-bleed-regenerated \
  --verify-dir tests/fixtures/lab_bleed
```

The script checks the lab revision and original M4A file hashes before it
decodes each original completely to a temporary WAV. It then slices native
sample frames and verifies each FLAC by decoding it back to PCM. The extraction
code lives in [`../lab_clips.py`](../lab_clips.py), shared with the other lab
fixtures. The 50 ms
context lets mute tests compare real receiving audio immediately outside the
reviewed range. Verification compares decoded samples instead of FLAC bytes.
Encoder versions can write different lossless FLAC streams for identical PCM.
`file_sha256` in the manifest seals the committed FLAC artifact; `pcm_sha256` is the regeneration
and content seal.

An optional `--historical-dir` can compare every selected source interval
against `caleb.wav`, `audra.wav`, and `lana.wav` in a directory of historical
full-length audition WAVs. Those private audition files are not regeneration
dependencies and are not needed for ordinary tests. Fixture verification
compared all 11 clips, including their surrounding context, with the historical
audition WAVs and found exact PCM matches.

Ordinary tests read only these committed clips. Automatic stereo bleed
detection remains conservative and unresolved in [issue #945](https://github.com/calebn/sharecut-studio/issues/945).
The tests cover pending exact-range proposals, host-approved reviewed mutes,
native 5 ms edge fades, unchanged peer audio, unchanged raw files, and a
direct-Caleb mixed-speech control. The noisy and uncertain cases encode
manual owner intent. They do not prove that automation can identify foreign
speech or classify breath and microphone noise.
