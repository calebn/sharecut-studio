# bleed_band_demo

One **automatic speaker-mute band** on a short clip, for driving the inspector's
"Automatic regions in this clip" list, the band's chooser and Restore on a phone,
tablet or desktop run. `sharecut_ux_demo` and `synthetic_bleed_60s` show
"No automatic regions in this clip".

Built from `aligned_dialogue` (audio symlinked, nothing duplicated). The
`reference` clip runs 0-20 s and carries exactly one band, 8-11 s; the `guest`
clip has none.

**Regenerate:**

```bash
python3 scripts/build_bleed_band_fixture.py
```

**Open the UI:**

```bash
podcast gui --project tests/fixtures/bleed_band_demo/episode.sharecut
```

Select the `reference` clip, then **Inspect automatic audio reduction**. Do not write
into this tree from mutating tests; copy it the way `e2e_workspace` copies
`aligned_dialogue`. The playback is the source audio: the band is project data, so
Restore and Undo work on it, but no bleed analysis has run.
