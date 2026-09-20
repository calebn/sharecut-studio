# sharecut_ux_demo

Canonical **Sharecut Studio UX showcase** fixture for the [UX Pages pack](../../../ux/README.md).

Built from `aligned_dialogue` plus seeded pending edits, comments, chapters, transcript
chips, mix/FX, and a social clip — so phone Listen / Timeline / Text / More and desktop
inspectors have something to show.

**Regenerate (keeps audio symlinked to `aligned_dialogue/raw`):**

```bash
python3 scripts/build_ux_demo_fixture.py
```

**Open the UI:**

```bash
podcast gui --project tests/fixtures/sharecut_ux_demo/episode.project.json
```

Do not write into this tree from mutating tests — copy via `e2e_workspace` patterns if needed.
Screenshots for the UX site: `make ux-demo-screens`.
